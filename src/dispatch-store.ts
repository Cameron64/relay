// Dispatch store — the durable queue behind the phone-brainstorm → desktop-runner bridge
// (relay-roadmap Plan 02). A dispatch is a piece of TEXT plus a runner-local TARGET ID; the
// phone composes one with its UI cookie, an always-on desktop runner (bin/relay-runner.mjs)
// long-polls for it with the write token, claims it, spawns a headless `claude -p` in a
// pre-approved project directory, and reports status back.
//
// SECURITY INVARIANT (relay-roadmap 00-master.md §7): a dispatch row carries a target *id*
// ONLY — never a cwd, command, or argv. The runner resolves ids against its own LOCAL
// ~/.relay/runner.json. A compromised server/DB can therefore never make the runner execute
// an arbitrary command or leave its pre-approved directories; worst case it feeds odd *text*
// to a Claude session in a project the runner's owner already approved. Do not add fields
// here that would weaken this — see dispatch_targets below, which stores {id,label} pairs
// pushed by the runner itself, never a filesystem path.
//
// REUSES the single SQLite connection exported from store.ts — never opens its own
// Database() (bun:sqlite is single-connection-per-file; a second open invites SQLITE_BUSY).
//
// Like cards (and unlike push_subscriptions/notify_log), a missing `dispatches` table is
// product-fatal for this feature — ensureDispatchSchema() logs loudly and re-throws; routes
// 503 via dispatchReady() until storage recovers (mirrors cards-store.ts exactly).

import { randomBytes } from 'node:crypto';
import { db } from './store.ts';

export type DispatchStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';

export type Dispatch = {
  id: string;
  created_at: string;
  title: string | null;
  body: string;
  target: string;
  status: DispatchStatus;
  runner_host: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  resume_of: string | null;
  claude_session: string | null;
  result_summary: string | null;
  result_card_id: string | null;
};

export type DispatchInput = {
  title: string | null;
  body: string;
  target: string;
  resume_of: string | null;
};

export type DispatchTarget = { id: string; label: string };

export type StatusUpdateInput = {
  status: 'running' | 'done' | 'failed';
  claude_session: string | null;
  result_summary: string | null;
  result_card_id: string | null;
};

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

// Body cap mirrors cards-store's page_html cap pattern: keep a single dispatch (and thus the
// SQLite row + the dispatch-updated SSE broadcast) from growing without bound. Default 256 KB —
// generous for a phone brainstorm, small enough to never threaten the row/broadcast size.
export const DISPATCH_BODY_MAX = Number(process.env.DISPATCH_BODY_MAX ?? 256 * 1024);
const TITLE_MAX = 300;
const TARGET_MAX = 200;
const RESULT_SUMMARY_MAX = 2000;
const RESULT_CARD_ID_MAX = 64;
const CLAUDE_SESSION_MAX = 200;
const MAX_TARGETS_PER_HOST = 50;
const TARGET_ID_MAX = 100;
const TARGET_LABEL_MAX = 200;
const HOST_MAX = 200;

let _ready = false;
export function dispatchReady(): boolean {
  return _ready;
}

export function ensureDispatchSchema(): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatches (
        id             TEXT PRIMARY KEY,
        created_at     TEXT NOT NULL,
        title          TEXT,
        body           TEXT NOT NULL,
        target         TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'queued',
        runner_host    TEXT,
        claimed_at     TEXT,
        finished_at    TEXT,
        resume_of      TEXT,
        claude_session TEXT,
        result_summary TEXT,
        result_card_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatches(status, created_at);
      CREATE TABLE IF NOT EXISTS dispatch_targets (
        host       TEXT NOT NULL,
        id         TEXT NOT NULL,
        label      TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (host, id)
      );
    `);
    // No ALTER-COLUMN migrations yet (this table is new) — future column additions follow the
    // cards pattern (PRAGMA table_info + ALTER TABLE ... ADD COLUMN), never a separate runner.
    _ready = true;
  } catch (err) {
    _ready = false;
    console.error('[dispatch] ensureDispatchSchema FAILED (dispatch routes will 503):', err);
    throw err;
  }
}

function genId(): string {
  return randomBytes(8).toString('hex'); // 16 hex chars
}

// --- validation (exported for unit tests) ----------------------------------

export function validateDispatchInput(body: unknown): Ok<DispatchInput> | Err {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.slice(0, TITLE_MAX) : null;
  const text = typeof b.body === 'string' ? b.body : null;
  if (!text || !text.trim()) return { ok: false, error: 'body required' };
  if (text.length > DISPATCH_BODY_MAX) return { ok: false, error: `body exceeds ${DISPATCH_BODY_MAX} bytes` };
  const targetRaw = typeof b.target === 'string' ? b.target.trim() : '';
  if (!targetRaw) return { ok: false, error: 'target required' };
  if (targetRaw.length > TARGET_MAX) return { ok: false, error: `target exceeds ${TARGET_MAX} bytes` };
  const resume_of = typeof b.resume_of === 'string' && b.resume_of.trim() ? b.resume_of.trim() : null;
  return { ok: true, value: { title, body: text, target: targetRaw, resume_of } };
}

export function validateStatusUpdate(body: unknown): Ok<StatusUpdateInput> | Err {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const status = b.status;
  if (status !== 'running' && status !== 'done' && status !== 'failed')
    return { ok: false, error: 'status must be "running", "done", or "failed"' };
  const claude_session = typeof b.claude_session === 'string' && b.claude_session ? b.claude_session.slice(0, CLAUDE_SESSION_MAX) : null;
  const result_summary = typeof b.result_summary === 'string' ? b.result_summary.slice(0, RESULT_SUMMARY_MAX) : null;
  const result_card_id = typeof b.result_card_id === 'string' && b.result_card_id ? b.result_card_id.slice(0, RESULT_CARD_ID_MAX) : null;
  return { ok: true, value: { status, claude_session, result_summary, result_card_id } };
}

export function validateTargetsInput(body: unknown): Ok<{ host: string; targets: DispatchTarget[] }> | Err {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const host = typeof b.host === 'string' && b.host.trim() ? b.host.trim().slice(0, HOST_MAX) : null;
  if (!host) return { ok: false, error: 'host required' };
  if (!Array.isArray(b.targets)) return { ok: false, error: 'targets must be an array' };
  if (b.targets.length > MAX_TARGETS_PER_HOST) return { ok: false, error: `too many targets (max ${MAX_TARGETS_PER_HOST})` };
  const out: DispatchTarget[] = [];
  const seen = new Set<string>();
  for (const raw of b.targets) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'each target must be an object' };
    const t = raw as Record<string, unknown>;
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim().slice(0, TARGET_ID_MAX) : null;
    const label = typeof t.label === 'string' && t.label.trim() ? t.label.trim().slice(0, TARGET_LABEL_MAX) : null;
    if (!id) return { ok: false, error: 'target.id required' };
    if (!label) return { ok: false, error: 'target.label required' };
    if (seen.has(id)) return { ok: false, error: `duplicate target id: ${id}` };
    seen.add(id);
    out.push({ id, label });
  }
  return { ok: true, value: { host, targets: out } };
}

// --- CRUD --------------------------------------------------------------------

function hydrate(row: any): Dispatch {
  return {
    id: row.id,
    created_at: row.created_at,
    title: row.title,
    body: row.body,
    target: row.target,
    status: row.status,
    runner_host: row.runner_host,
    claimed_at: row.claimed_at,
    finished_at: row.finished_at,
    resume_of: row.resume_of,
    claude_session: row.claude_session,
    result_summary: row.result_summary,
    result_card_id: row.result_card_id,
  };
}

// Follow-up dispatches (resume_of set) copy the parent's claude_session at CREATE time — this is
// the "prefer the latter" option from the plan (rather than a separate write-auth read of a UI-
// owned row): the child row is self-contained, and the runner never needs to fetch the parent.
// Only a `done` parent with a recorded session can be resumed; anything else is rejected so the
// UI's "Follow-up" affordance (only shown when done) can't be raced by a stale/parallel request.
export function createDispatch(value: DispatchInput): Ok<Dispatch> | Err {
  const tx = db.transaction((): Ok<Dispatch> | Err => {
    let claudeSession: string | null = null;
    if (value.resume_of) {
      const parent = db.query('SELECT status, claude_session FROM dispatches WHERE id = $id').get({ $id: value.resume_of }) as any;
      if (!parent) return { ok: false, error: 'resume_of dispatch not found' };
      if (parent.status !== 'done' || !parent.claude_session) {
        return { ok: false, error: 'resume_of dispatch has not finished with a session to resume' };
      }
      claudeSession = parent.claude_session;
    }
    const id = genId();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO dispatches (id, created_at, title, body, target, status, resume_of, claude_session)
       VALUES ($id, $created, $title, $body, $target, 'queued', $resume_of, $claude_session)`,
    ).run({
      $id: id,
      $created: now,
      $title: value.title,
      $body: value.body,
      $target: value.target,
      $resume_of: value.resume_of,
      $claude_session: claudeSession,
    });
    return { ok: true, value: hydrate(db.query('SELECT * FROM dispatches WHERE id = $id').get({ $id: id })) };
  });
  return tx();
}

export function getDispatch(id: string): Dispatch | null {
  const row = db.query('SELECT * FROM dispatches WHERE id = $id').get({ $id: id }) as any;
  return row ? hydrate(row) : null;
}

export function listDispatches(opts: { status?: string; since?: string; limit?: number } = {}): Dispatch[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const clauses: string[] = [];
  const params: Record<string, string | number> = { $lim: limit };
  if (opts.status) {
    clauses.push('status = $status');
    params.$status = opts.status;
  }
  if (opts.since) {
    clauses.push('created_at > $since');
    params.$since = opts.since;
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.query(`SELECT * FROM dispatches ${where} ORDER BY created_at DESC, id DESC LIMIT $lim`).all(params) as any[];
  return rows.map(hydrate);
}

/** Oldest queued dispatch, or null. Used both by the runner's next?wait long-poll and its re-poll
 * after a woken/timed-out wait — the DB row is always the source of truth (master doc §8). */
export function nextQueued(): Dispatch | null {
  const row = db.query("SELECT * FROM dispatches WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1").get() as any;
  return row ? hydrate(row) : null;
}

export type ClaimResult = { status: 'claimed'; dispatch: Dispatch } | { status: 'conflict' } | { status: 'notfound' };

// Atomic claim: only one concurrent claim on the same row can win (master doc §8's "first claim
// wins", scoped here to one dispatch — see the plan's claim-atomicity acceptance test).
export function claimDispatch(id: string, runnerHost: string): ClaimResult {
  const now = new Date().toISOString();
  const res = db
    .query("UPDATE dispatches SET status = 'claimed', runner_host = $host, claimed_at = $t WHERE id = $id AND status = 'queued'")
    .run({ $host: runnerHost, $t: now, $id: id });
  if (res.changes > 0) return { status: 'claimed', dispatch: getDispatch(id)! };
  return getDispatch(id) ? { status: 'conflict' } : { status: 'notfound' };
}

// Legal transitions only — mirrors respondCard's "answer once" discipline. queued only exits via
// claim() or cancel(); done/failed/cancelled are terminal.
const LEGAL_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  queued: [],
  claimed: ['running', 'failed'], // 'failed' direct-from-claimed covers "unknown target" (no run started)
  running: ['done', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
};

export function updateDispatchStatus(id: string, input: StatusUpdateInput): Ok<Dispatch> | Err {
  const tx = db.transaction((): Ok<Dispatch> | Err => {
    const row = db.query('SELECT status FROM dispatches WHERE id = $id').get({ $id: id }) as any;
    if (!row) return { ok: false, error: 'not found' };
    const allowed = LEGAL_TRANSITIONS[row.status as DispatchStatus] ?? [];
    if (!allowed.includes(input.status)) return { ok: false, error: `illegal transition from "${row.status}" to "${input.status}"` };
    const now = new Date().toISOString();
    const finishedAt = input.status === 'done' || input.status === 'failed' ? now : null;
    // COALESCE on the optional fields: a 'running' update (which carries none of these yet) must
    // never null out a value a later 'done'/'failed' update sets — and vice versa, an update that
    // omits a field it already set previously must not blank it back out.
    db.query(
      `UPDATE dispatches SET
         status = $status,
         finished_at = COALESCE($finished, finished_at),
         claude_session = COALESCE($session, claude_session),
         result_summary = COALESCE($summary, result_summary),
         result_card_id = COALESCE($card, result_card_id)
       WHERE id = $id`,
    ).run({
      $status: input.status,
      $finished: finishedAt,
      $session: input.claude_session,
      $summary: input.result_summary,
      $card: input.result_card_id,
      $id: id,
    });
    return { ok: true, value: hydrate(db.query('SELECT * FROM dispatches WHERE id = $id').get({ $id: id })) };
  });
  return tx();
}

export type CancelResult = { status: 'cancelled' } | { status: 'notcancellable' } | { status: 'notfound' };

// v1 simplification (documented in the plan's Gotchas): only a still-queued dispatch is
// cancellable. A claimed/running job has already handed its text to a live `claude -p` process
// the server has no channel to interrupt — cancelling those is a later plan's problem.
export function cancelDispatch(id: string): CancelResult {
  const now = new Date().toISOString();
  const res = db
    .query("UPDATE dispatches SET status = 'cancelled', finished_at = $t WHERE id = $id AND status = 'queued'")
    .run({ $t: now, $id: id });
  if (res.changes > 0) return { status: 'cancelled' };
  return getDispatch(id) ? { status: 'notcancellable' } : { status: 'notfound' };
}

// --- targets (runner-pushed {id,label} pairs — NEVER a path; see the security invariant above) --

// Replace-wholesale-per-host, exactly as the plan specifies: a runner restart re-announces its
// full target list, and any target it dropped disappears from that host's rows immediately.
export function replaceTargetsForHost(host: string, targets: DispatchTarget[]): void {
  const tx = db.transaction(() => {
    db.query('DELETE FROM dispatch_targets WHERE host = $host').run({ $host: host });
    const now = new Date().toISOString();
    for (const t of targets) {
      db.query('INSERT INTO dispatch_targets (host, id, label, updated_at) VALUES ($host, $id, $label, $now)').run({
        $host: host,
        $id: t.id,
        $label: t.label,
        $now: now,
      });
    }
  });
  tx();
}

// Union across hosts, de-duped by target id. SQLite's documented MAX()-aggregate behavior picks
// the bare `label` column from the SAME row as the winning MAX(updated_at) for each group, so ties
// resolve to "whichever host announced this id most recently" rather than an arbitrary row.
export function listTargets(): DispatchTarget[] {
  return db
    .query('SELECT id, label, MAX(updated_at) AS updated_at FROM dispatch_targets GROUP BY id ORDER BY label ASC')
    .all() as DispatchTarget[];
}

// --- retention ---------------------------------------------------------------

/**
 * Delete terminal (done/failed/cancelled) dispatches older than DISPATCH_RETENTION_DAYS (default
 * 14), compared ISO-to-ISO against finished_at (see the master doc's time-comparison warning —
 * never mix toISOString() with SQLite's datetime('now')). Mirrors pruneNotifyLog/pruneCards; run
 * on the server's existing sweep interval, not a separate scheduler.
 */
export function pruneDispatches(): void {
  const days = Number(process.env.DISPATCH_RETENTION_DAYS ?? 14);
  if (!(days > 0)) return;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  db.query("DELETE FROM dispatches WHERE status IN ('done','failed','cancelled') AND finished_at IS NOT NULL AND finished_at < $cutoff").run({
    $cutoff: cutoff,
  });
}

/** Test-only: wipe both dispatch tables. Guarded the same way cards-store's reset is. */
export function __resetForTests(): void {
  db.exec('DELETE FROM dispatch_targets; DELETE FROM dispatches;');
}
