// Notification audit log — the answer to "why did I get this push, and who sent it?".
//
// Every push Relay sends (the Notification/Stop hooks, `relay notify`, the MCP relay_notify
// tool, AND each card push) is appended here with its origin: which Claude Code session, in
// which project (cwd) on which host, what kind of event, and how many devices it reached. The
// PWA's Activity drawer reads it back so a "Claude is waiting for your input" push that leads
// nowhere can be traced to the exact session that fired it.
//
// REUSES the single SQLite connection exported from store.ts — never opens its own Database()
// (bun:sqlite is single-connection-per-file; a second open invites SQLITE_BUSY).
//
// Like push_subscriptions (and UNLIKE cards), a missing notify_log table degrades SILENTLY: an
// audit trail is a diagnostic aid, not a product-fatal dependency. ensureNotifyLogSchema() logs
// and swallows, recordNotify() is best-effort, and a write failure must NEVER break delivery of
// the push it is trying to log.

import { randomBytes } from 'node:crypto';
import { db } from './store.ts';

// Where a push originated. 'notification'/'stop' are the global Claude Code hooks; 'cli' is
// `relay notify`; 'mcp' is the relay_notify tool; 'card' is a card push (/api/cards); 'dispatch'
// is the server's own "your queued job failed" push (see routes-dispatch.ts — a runner *success*
// posts a result card, source 'card'; only *failure* has no card behind it, hence this source).
// 'session' is the new SessionStart/SessionEnd hooks (relay-roadmap Plan 03) — always
// deliver:false, audit-trail-only rows that feed aggregateSessions() below. 'unknown' is the
// fallback for a caller that sent no source.
export type NotifySource = 'notification' | 'stop' | 'cli' | 'mcp' | 'card' | 'dispatch' | 'session' | 'unknown';

export type NotifyLogEntry = {
  id: string;
  created_at: string;
  source: NotifySource;
  title: string;
  body: string;
  tag: string | null;
  url: string | null;
  session_id: string | null;
  cwd: string | null;
  project: string | null;
  host: string | null;
  // Coarse classification of WHY the push fired — for hook pushes: 'idle' (Claude is waiting for
  // input), 'permission' (needs approval), 'done' (Stop hook), or 'other'. Lets the UI flag the
  // low-value idle nudges that prompted this feature.
  event: string | null;
  // Set when this push is backed by a card (source='card'), so the UI can deep-link to it and mark
  // the push as actionable. A bare notify (no card_id) is the "tap leads nowhere" case.
  card_id: string | null;
  sent: number;
  failed: number;
  subscribers: number;
  // 1 = actually pushed to devices; 0 = recorded-but-silenced (e.g. an 'idle' nudge the hook
  // logs for the trail but deliberately does NOT buzz the phone). Lets the UI show "silenced".
  delivered: number;
};

export type RecordNotifyInput = {
  source?: string | null;
  title: string;
  body: string;
  tag?: string | null;
  url?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  project?: string | null;
  host?: string | null;
  event?: string | null;
  cardId?: string | null;
  sent?: number;
  failed?: number;
  subscribers?: number;
  delivered?: boolean | number; // default true (1); pass false for a logged-but-not-pushed row
};

const VALID_SOURCES = new Set<NotifySource>(['notification', 'stop', 'cli', 'mcp', 'card', 'dispatch', 'session', 'unknown']);

let _ready = false;
export function notifyLogReady(): boolean {
  return _ready;
}

export function ensureNotifyLogSchema(): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notify_log (
        id          TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        source      TEXT NOT NULL DEFAULT 'unknown',
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        tag         TEXT,
        url         TEXT,
        session_id  TEXT,
        cwd         TEXT,
        project     TEXT,
        host        TEXT,
        event       TEXT,
        card_id     TEXT,
        sent        INTEGER NOT NULL DEFAULT 0,
        failed      INTEGER NOT NULL DEFAULT 0,
        subscribers INTEGER NOT NULL DEFAULT 0,
        delivered   INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_notify_log_created ON notify_log(created_at DESC);
    `);
    // Migration: `delivered` was added after the table first shipped (the 'suppress idle pings'
    // change). CREATE TABLE IF NOT EXISTS won't add it to the already-deployed prod table, so add
    // it idempotently — existing rows backfill to 1 (they were all really delivered).
    const cols = db.query('PRAGMA table_info(notify_log)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'delivered')) {
      db.exec('ALTER TABLE notify_log ADD COLUMN delivered INTEGER NOT NULL DEFAULT 1');
    }
    _ready = true;
  } catch (err) {
    _ready = false;
    // Non-fatal: the audit log is a diagnostic, not a hard dependency. Push delivery and the
    // card feed keep working; the Activity drawer just returns 503 until storage recovers.
    console.error('[notify-log] ensureNotifyLogSchema failed (continuing degraded):', err);
  }
}

function genId(): string {
  return randomBytes(8).toString('hex'); // 16 hex chars
}

function clampStr(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.length > max ? v.slice(0, max) : v;
}

function coerceSource(v: unknown): NotifySource {
  return typeof v === 'string' && VALID_SOURCES.has(v as NotifySource) ? (v as NotifySource) : 'unknown';
}

function coerceCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Append one push to the audit log. Best-effort: returns the new row id, or null if the log is
 * unavailable or the insert throws — the CALLER MUST NOT let a logging failure abort the push it
 * just sent. The title falls back to '(untitled)' and body to '' so a malformed caller still
 * produces a traceable row rather than a constraint error.
 */
export function recordNotify(input: RecordNotifyInput): string | null {
  if (!_ready) return null;
  try {
    const id = genId();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO notify_log
         (id, created_at, source, title, body, tag, url, session_id, cwd, project, host, event, card_id, sent, failed, subscribers, delivered)
       VALUES
         ($id, $created, $source, $title, $body, $tag, $url, $session, $cwd, $project, $host, $event, $card, $sent, $failed, $subs, $delivered)`,
    ).run({
      $id: id,
      $created: now,
      $source: coerceSource(input.source),
      $title: clampStr(input.title, 300) ?? '(untitled)',
      $body: clampStr(input.body, 2000) ?? '',
      $tag: clampStr(input.tag, 200),
      $url: clampStr(input.url, 500),
      $session: clampStr(input.sessionId, 200),
      $cwd: clampStr(input.cwd, 500),
      $project: clampStr(input.project, 200),
      $host: clampStr(input.host, 200),
      $event: clampStr(input.event, 60),
      $card: clampStr(input.cardId, 64),
      $sent: coerceCount(input.sent),
      $failed: coerceCount(input.failed),
      $subs: coerceCount(input.subscribers),
      $delivered: input.delivered === false || input.delivered === 0 ? 0 : 1,
    });
    return id;
  } catch (err) {
    console.error('[notify-log] recordNotify failed (push already sent; ignoring):', err);
    return null;
  }
}

export function listNotifications(opts: { limit?: number; since?: string } = {}): NotifyLogEntry[] {
  if (!_ready) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = opts.since
    ? (db
        .query('SELECT * FROM notify_log WHERE created_at > $since ORDER BY created_at DESC, id DESC LIMIT $lim')
        .all({ $since: opts.since, $lim: limit }) as any[])
    : (db
        .query('SELECT * FROM notify_log ORDER BY created_at DESC, id DESC LIMIT $lim')
        .all({ $lim: limit }) as any[]);
  return rows as NotifyLogEntry[];
}

/**
 * Cap the log so it can't grow without bound on the volume. Deletes rows older than
 * NOTIFY_LOG_RETENTION_DAYS (default 30) and trims to the most recent NOTIFY_LOG_MAX rows
 * (default 4000 — bumped from 2000 in Plan 03: SessionStart/SessionEnd hooks roughly double the
 * write rate, but these rows are tiny so a bigger cap is cheap). Cheap to call after each insert;
 * mirrors pruneCards().
 */
export function pruneNotifyLog(): void {
  if (!_ready) return;
  const days = Number(process.env.NOTIFY_LOG_RETENTION_DAYS ?? 30);
  const max = Number(process.env.NOTIFY_LOG_MAX ?? 4000);
  try {
    const tx = db.transaction(() => {
      if (days > 0) {
        db.query("DELETE FROM notify_log WHERE created_at < datetime('now', $age)").run({ $age: `-${days} days` });
      }
      db.query(
        'DELETE FROM notify_log WHERE id NOT IN (SELECT id FROM notify_log ORDER BY created_at DESC, id DESC LIMIT $max)',
      ).run({ $max: max });
    });
    tx();
  } catch (err) {
    console.error('[notify-log] pruneNotifyLog failed (ignoring):', err);
  }
}

// --- session aggregation (relay-roadmap Plan 03) ----------------------------
//
// The Sessions dashboard is built ENTIRELY from this table (plus a caller-supplied dispatch
// linkage — see the dispatchBySession param) — no new table, per the plan's "pure read" design.
// Every push AND every silent session-start/session-end row already carries the canonical
// attribution (session_id/cwd/project/host — master doc §3), so folding notify_log by session is
// sufficient to answer "which sessions exist, what project, what state".

export type SessionStatus = 'active' | 'needs-input' | 'ended' | 'stale';

export type SessionSummary = {
  sessionId: string | null;
  project: string | null;
  cwd: string | null;
  host: string | null;
  lastEvent: string;
  lastAt: string;
  status: SessionStatus;
  dispatchId?: string;
};

const SESSION_WINDOW_HOURS_DEFAULT = Number(process.env.SESSION_WINDOW_HOURS ?? 24);
const SESSION_ACTIVE_WINDOW_MINUTES_DEFAULT = Number(process.env.SESSION_ACTIVE_WINDOW_MINUTES ?? 30);

// The status vocabulary this folds on is `event`, and `event` is NOT one uniform enum — it's
// whatever the writer of that particular row set (see the gotcha in relay-roadmap 03's plan doc):
//   - classifyNotification's own output ('idle' | 'permission' | 'other') for Notification-hook rows
//   - a literal string set directly by a hook/route: 'done' (Stop), 'failed' (dispatch failure),
//     'session-start' / 'session-end' (the new hooks below)
//   - a card's `kind` for card-push rows (routes-cards.ts: `event: card.kind`) — approval/prompt/
//     choice cards always carry respond buttons or options, so their push IS a needs-attention
//     notification exactly like a permission prompt.
// This set is deliberately the ONLY place that vocabulary is interpreted for status inference.
const NEEDS_INPUT_EVENTS = new Set(['permission', 'approval', 'prompt', 'choice']);

/**
 * Pure fold: group notify_log rows into one summary per session (fallback key `cwd|host` when
 * session_id is null — master doc §3) and derive a best-effort status from each group's newest
 * row. Exported (and take rows as a plain argument, not a DB query) so the status-inference
 * matrix — the only real logic in this plan — is unit-testable with synthetic rows.
 */
export function foldSessionRows(
  rows: NotifyLogEntry[],
  opts: { now?: Date; activeWindowMinutes?: number; dispatchBySession?: Map<string, string> } = {},
): SessionSummary[] {
  const now = opts.now ?? new Date();
  const activeWindowMs = (opts.activeWindowMinutes ?? SESSION_ACTIVE_WINDOW_MINUTES_DEFAULT) * 60_000;

  const groups = new Map<string, NotifyLogEntry[]>();
  for (const row of rows) {
    const key = row.session_id ? `sid:${row.session_id}` : `key:${row.cwd ?? ''}|${row.host ?? ''}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const out: SessionSummary[] = [];
  for (const list of groups.values()) {
    // Newest first within the group. Callers typically already pass rows created_at DESC (the DB
    // query below does), but don't rely on caller order — synthetic test rows may not be sorted.
    const sorted = [...list].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const newest = sorted[0];
    const lastEvent = newest.event ?? 'other';
    const ageMs = now.getTime() - Date.parse(newest.created_at);

    let status: SessionStatus;
    if (lastEvent === 'session-end') status = 'ended';
    else if (NEEDS_INPUT_EVENTS.has(lastEvent)) status = 'needs-input';
    else if (Number.isFinite(ageMs) && ageMs <= activeWindowMs) status = 'active';
    else status = 'stale';

    const dispatchId = newest.session_id ? opts.dispatchBySession?.get(newest.session_id) : undefined;

    out.push({
      sessionId: newest.session_id,
      project: newest.project,
      cwd: newest.cwd,
      host: newest.host,
      lastEvent,
      lastAt: newest.created_at,
      status,
      ...(dispatchId ? { dispatchId } : {}),
    });
  }

  // needs-input first, then active, then stale, then ended; newest lastAt first within each bucket.
  const RANK: Record<SessionStatus, number> = { 'needs-input': 0, active: 1, stale: 2, ended: 3 };
  return out.sort((a, b) => {
    const r = RANK[a.status] - RANK[b.status];
    if (r !== 0) return r;
    return a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0;
  });
}

/**
 * DB-backed convenience wrapper the /api/sessions route calls: reads notify_log rows from the
 * last `windowHours` (default SESSION_WINDOW_HOURS, 24) and folds them. No LIMIT on the query —
 * the time window is the bound, and notify_log itself is already capped at NOTIFY_LOG_MAX rows
 * total by pruneNotifyLog, so this can never run away even over a generous window. Returns []
 * (rather than throwing) when the log isn't ready, mirroring listNotifications.
 */
export function aggregateSessions(
  opts: { windowHours?: number; activeWindowMinutes?: number; dispatchBySession?: Map<string, string>; now?: Date } = {},
): SessionSummary[] {
  if (!_ready) return [];
  const windowHours = opts.windowHours ?? SESSION_WINDOW_HOURS_DEFAULT;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  const rows = db
    .query('SELECT * FROM notify_log WHERE created_at > $since ORDER BY created_at DESC, id DESC')
    .all({ $since: cutoff }) as NotifyLogEntry[];
  return foldSessionRows(rows, { now, activeWindowMinutes: opts.activeWindowMinutes, dispatchBySession: opts.dispatchBySession });
}

/** Test-only: wipe the log. Guarded the same way cards-store's reset is. */
export function __resetForTests(): void {
  db.exec('DELETE FROM notify_log;');
}
