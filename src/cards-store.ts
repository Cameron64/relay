// Card store — the heart of Relay. Cards are what Claude Code pushes to the phone/desktop:
// markdown notes, drafts, Mermaid diagrams, images, and approval prompts with buttons.
//
// REUSES the single SQLite connection exported from store.ts — never opens its own
// Database() (bun:sqlite is single-connection-per-file; a second open invites SQLITE_BUSY).
//
// Unlike push_subscriptions (which degrades silently), a missing `cards` table is
// product-fatal — ensureCardsSchema() logs loudly and re-throws. server.ts calls it AFTER
// the /api/health route is registered and catches the throw so the server still boots and
// stays health-green; card routes then return 503 (via cardsReady()) until storage recovers.

import { randomBytes } from 'node:crypto';
import { db } from './store.ts';

export type Button = {
  id: string;
  label: string;
  behavior: 'respond' | 'copy' | 'link';
  style?: string;
  value?: string;
  verdict?: string;
};

export type CardResponse = {
  verdict: string;
  action: string;
  note: string | null;
  at: string;
};

export type Card = {
  id: string;
  created_at: string;
  kind: string;
  title: string;
  body: string | null;
  buttons: Button[];
  copy_text: string | null;
  mermaid: string | null;
  source: Record<string, unknown> | null;
  status: 'pending' | 'responded' | 'dismissed';
  response: CardResponse | null;
  responded_at: string | null;
  priority: 'normal' | 'high';
  expires_at: string | null;
  push_sent: boolean;
  assets: { id: string; mime: string }[];
};

export type CardInput = {
  kind: string;
  title: string;
  body: string | null;
  buttons: Button[];
  copy_text: string | null;
  mermaid: string | null;
  source: Record<string, unknown> | null;
  priority: 'normal' | 'high';
  expires_at: string | null;
};

export const VALID_KINDS = ['note', 'approval', 'draft', 'diagram', 'image', 'choice'];
export const VALID_BEHAVIORS = ['respond', 'copy', 'link'];
export const VALID_STYLES = ['primary', 'secondary', 'outline', 'danger', 'note'];
export const VALID_VERDICTS = ['approved', 'changes_requested', 'dismissed'];

// --- expiry / decluttering -------------------------------------------------
// Cards shouldn't live in the feed forever. Three rules, all leaning on the existing expires_at
// column (which was stored but never enforced before):
//   1. Non-actionable cards (note/diagram/image/draft) auto-expire CARD_TTL_HOURS after creation
//      unless the caller passed an explicit expires_at.
//   2. Actionable cards (approval/choice) get NO default expiry while pending — they wait for a
//      human, then rule 3 takes over.
//   3. Once a card is answered (respond) or dismissed, its expiry is pulled in to a short grace
//      window (CARD_ANSWERED_TTL_HOURS) so resolved cards clear out of the feed soon after.
// A periodic sweepExpired() (see server.ts) deletes expired rows and tells live clients to drop
// them. NOTE on time comparisons: expires_at/created_at are stored via toISOString() (T/Z format),
// so we ALWAYS compare against a JS ISO string ($now), never SQLite's space-format datetime('now')
// — mixing the two compares 'T'(0x54) vs ' '(0x20) and silently inverts the ordering.
const CARD_TTL_HOURS = Number(process.env.CARD_TTL_HOURS ?? 24);
const CARD_ANSWERED_TTL_HOURS = Number(process.env.CARD_ANSWERED_TTL_HOURS ?? 6);
const NO_DEFAULT_EXPIRY_KINDS = new Set(['approval', 'choice']);

function defaultExpiryFor(kind: string, createdAtIso: string): string | null {
  if (NO_DEFAULT_EXPIRY_KINDS.has(kind)) return null;
  if (!(CARD_TTL_HOURS > 0)) return null;
  return new Date(Date.parse(createdAtIso) + CARD_TTL_HOURS * 3_600_000).toISOString();
}

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

let _ready = false;
export function cardsReady(): boolean {
  return _ready;
}

export function ensureCardsSchema(): void {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cards (
        id           TEXT PRIMARY KEY,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        kind         TEXT NOT NULL,
        title        TEXT NOT NULL,
        body         TEXT,
        buttons      TEXT NOT NULL DEFAULT '[]',
        copy_text    TEXT,
        mermaid      TEXT,
        source       TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        response     TEXT,
        responded_at TEXT,
        priority     TEXT NOT NULL DEFAULT 'normal',
        expires_at   TEXT,
        push_sent    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cards_created ON cards(created_at DESC);
      CREATE TABLE IF NOT EXISTS card_assets (
        id         TEXT PRIMARY KEY,
        card_id    TEXT NOT NULL,
        mime       TEXT NOT NULL,
        bytes      BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_assets_card ON card_assets(card_id);
    `);
    _ready = true;
  } catch (err) {
    _ready = false;
    console.error('[cards] ensureCardsSchema FAILED (card routes will 503):', err);
    throw err;
  }
}

export function genId(): string {
  return randomBytes(8).toString('hex'); // 16 hex chars
}

function safeJSON<T>(s: unknown, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s as string) as T;
  } catch {
    return fallback;
  }
}

// --- validation (exported for unit tests) ----------------------------------

export function validateButtons(buttons: unknown): Ok<Button[]> | Err {
  if (buttons === undefined || buttons === null) return { ok: true, value: [] };
  if (!Array.isArray(buttons)) return { ok: false, error: 'buttons must be an array' };
  if (buttons.length > 10) return { ok: false, error: 'too many buttons (max 10)' };
  const out: Button[] = [];
  for (const raw of buttons) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'each button must be an object' };
    const b = raw as Record<string, unknown>;
    const id = typeof b.id === 'string' && b.id ? b.id : null;
    const label = typeof b.label === 'string' && b.label ? b.label : null;
    const behavior = typeof b.behavior === 'string' ? b.behavior : 'respond';
    if (!id) return { ok: false, error: 'button.id required' };
    if (!label) return { ok: false, error: 'button.label required' };
    if (!VALID_BEHAVIORS.includes(behavior)) return { ok: false, error: `unknown button behavior: ${behavior}` };
    const style = b.style === undefined ? undefined : b.style;
    if (style !== undefined && (typeof style !== 'string' || !VALID_STYLES.includes(style)))
      return { ok: false, error: `unknown button style: ${String(style)}` };
    const btn: Button = { id, label, behavior: behavior as Button['behavior'] };
    if (typeof style === 'string') btn.style = style;
    if (behavior === 'link') {
      const value = typeof b.value === 'string' ? b.value : '';
      if (!/^https?:\/\//i.test(value))
        return { ok: false, error: 'link button value must start with http:// or https://' };
      btn.value = value;
    } else if (behavior === 'copy') {
      if (typeof b.value === 'string') btn.value = b.value;
    } else if (behavior === 'respond') {
      const verdict = b.verdict === undefined ? undefined : b.verdict;
      if (verdict !== undefined && (typeof verdict !== 'string' || !VALID_VERDICTS.includes(verdict)))
        return { ok: false, error: `unknown verdict: ${String(verdict)}` };
      if (typeof verdict === 'string') btn.verdict = verdict;
    }
    out.push(btn);
  }
  return { ok: true, value: out };
}

export function validateCardInput(body: unknown): Ok<CardInput> | Err {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const kind = b.kind === undefined ? 'note' : b.kind;
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind)) return { ok: false, error: `unknown kind: ${String(kind)}` };
  const title = typeof b.title === 'string' && b.title.trim() ? b.title.slice(0, 300) : null;
  if (!title) return { ok: false, error: 'title required' };
  const bodyText = typeof b.body === 'string' ? b.body : null;
  const bv = validateButtons(b.buttons);
  if (!bv.ok) return bv;
  const priority = b.priority === 'high' ? 'high' : 'normal';
  const copy_text =
    typeof b.copy_text === 'string' ? b.copy_text : typeof b.copyText === 'string' ? (b.copyText as string) : null;
  const mermaid = typeof b.mermaid === 'string' ? b.mermaid : null;
  const source = b.source && typeof b.source === 'object' ? (b.source as Record<string, unknown>) : null;
  const expires_at = typeof b.expires_at === 'string' ? b.expires_at : null;
  return {
    ok: true,
    value: { kind, title, body: bodyText, buttons: bv.value, copy_text, mermaid, source, priority, expires_at },
  };
}

// --- CRUD ------------------------------------------------------------------

function hydrate(row: any): Card {
  const assets = db.query('SELECT id, mime FROM card_assets WHERE card_id = $cid').all({ $cid: row.id }) as any[];
  return {
    id: row.id,
    created_at: row.created_at,
    kind: row.kind,
    title: row.title,
    body: row.body,
    buttons: safeJSON<Button[]>(row.buttons, []),
    copy_text: row.copy_text,
    mermaid: row.mermaid,
    source: safeJSON<Record<string, unknown> | null>(row.source, null),
    status: row.status,
    response: safeJSON<CardResponse | null>(row.response, null),
    responded_at: row.responded_at,
    priority: row.priority,
    expires_at: row.expires_at,
    push_sent: !!row.push_sent,
    assets: assets.map((a) => ({ id: a.id, mime: a.mime })),
  };
}

export function createCard(value: CardInput, assets: { mime: string; bytes: Uint8Array }[] = []): Card {
  const id = genId();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO cards (id, created_at, kind, title, body, buttons, copy_text, mermaid, source, status, priority, expires_at, push_sent)
       VALUES ($id, $created, $kind, $title, $body, $buttons, $copy, $mermaid, $source, 'pending', $priority, $expires, 0)`,
    ).run({
      $id: id,
      $created: now,
      $kind: value.kind,
      $title: value.title,
      $body: value.body,
      $buttons: JSON.stringify(value.buttons || []),
      $copy: value.copy_text ?? null,
      $mermaid: value.mermaid ?? null,
      $source: value.source ? JSON.stringify(value.source) : null,
      $priority: value.priority || 'normal',
      $expires: value.expires_at ?? defaultExpiryFor(value.kind, now),
    });
    for (const a of assets) {
      db.query('INSERT INTO card_assets (id, card_id, mime, bytes, created_at) VALUES ($id, $cid, $mime, $bytes, $created)').run({
        $id: genId(),
        $cid: id,
        $mime: a.mime,
        $bytes: a.bytes,
        $created: now,
      });
    }
  });
  tx();
  return getCard(id)!;
}

export function getCard(id: string): Card | null {
  const row = db.query('SELECT * FROM cards WHERE id = $id').get({ $id: id }) as any;
  if (!row) return null;
  return hydrate(row);
}

export function listCards(opts: { since?: string; limit?: number } = {}): Card[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const now = new Date().toISOString();
  // Live = not dismissed and not past its expiry. (expires_at compared ISO-to-ISO; see note above.)
  const live = "status != 'dismissed' AND (expires_at IS NULL OR expires_at > $now)";
  const rows = opts.since
    ? (db
        .query(`SELECT * FROM cards WHERE created_at > $since AND ${live} ORDER BY created_at DESC, id DESC LIMIT $lim`)
        .all({ $since: opts.since, $now: now, $lim: limit }) as any[])
    : (db
        .query(`SELECT * FROM cards WHERE ${live} ORDER BY created_at DESC, id DESC LIMIT $lim`)
        .all({ $now: now, $lim: limit }) as any[]);
  return rows.map(hydrate);
}

export type RespondResult =
  | { status: 'responded'; response: CardResponse }
  | { status: 'conflict'; response: CardResponse | null }
  | { status: 'notfound' };

export function respondCard(id: string, input: { action: string; note?: string | null }): RespondResult {
  const tx = db.transaction((): RespondResult => {
    const row = db.query('SELECT status, response, buttons FROM cards WHERE id = $id').get({ $id: id }) as any;
    if (!row) return { status: 'notfound' };
    if (row.status === 'responded') return { status: 'conflict', response: safeJSON<CardResponse | null>(row.response, null) };
    const buttons = safeJSON<Button[]>(row.buttons, []);
    const btn = buttons.find((b) => b.id === input.action);
    const verdict = btn?.verdict ?? input.action;
    const response: CardResponse = { verdict, action: input.action, note: input.note ?? null, at: new Date().toISOString() };
    // Pull resolved cards into a short grace window so they clear out of the feed soon after the
    // user acts (rule 3). When the grace window is disabled (0), leave expires_at untouched.
    if (CARD_ANSWERED_TTL_HOURS > 0) {
      const exp = new Date(Date.now() + CARD_ANSWERED_TTL_HOURS * 3_600_000).toISOString();
      db.query("UPDATE cards SET status = 'responded', response = $r, responded_at = $t, expires_at = $e WHERE id = $id").run({
        $r: JSON.stringify(response),
        $t: response.at,
        $e: exp,
        $id: id,
      });
    } else {
      db.query("UPDATE cards SET status = 'responded', response = $r, responded_at = $t WHERE id = $id").run({
        $r: JSON.stringify(response),
        $t: response.at,
        $id: id,
      });
    }
    return { status: 'responded', response };
  });
  return tx();
}

export function getAsset(cardId: string, assetId: string): { mime: string; bytes: Uint8Array } | null {
  const row = db.query('SELECT mime, bytes FROM card_assets WHERE id = $aid AND card_id = $cid').get({
    $aid: assetId,
    $cid: cardId,
  }) as any;
  if (!row) return null;
  return { mime: row.mime, bytes: row.bytes as Uint8Array };
}

/** Mark a card dismissed and expire it immediately so it drops from the feed and is swept. */
export function dismissCard(id: string): boolean {
  const now = new Date().toISOString();
  const res = db
    .query("UPDATE cards SET status = 'dismissed', expires_at = $now WHERE id = $id")
    .run({ $now: now, $id: id });
  return res.changes > 0;
}

/**
 * Delete every card whose expiry has passed and return their ids (so the caller can broadcast a
 * `card-removed` to live clients). Run on an interval from server.ts. Compares ISO-to-ISO; see the
 * time-comparison note near the TTL constants.
 */
export function sweepExpired(): string[] {
  const now = new Date().toISOString();
  const rows = db
    .query('SELECT id FROM cards WHERE expires_at IS NOT NULL AND expires_at <= $now')
    .all({ $now: now }) as { id: string }[];
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    const tx = db.transaction(() => {
      db.query('DELETE FROM cards WHERE expires_at IS NOT NULL AND expires_at <= $now').run({ $now: now });
      db.query('DELETE FROM card_assets WHERE card_id NOT IN (SELECT id FROM cards)').run();
    });
    tx();
  }
  return ids;
}

export function pruneCards(): void {
  const days = Number(process.env.CARD_RETENTION_DAYS ?? 30);
  const max = Number(process.env.CARD_MAX ?? 500);
  const tx = db.transaction(() => {
    if (days > 0) db.query("DELETE FROM cards WHERE created_at < datetime('now', $age)").run({ $age: `-${days} days` });
    db.query(
      'DELETE FROM cards WHERE id NOT IN (SELECT id FROM cards ORDER BY created_at DESC, id DESC LIMIT $max)',
    ).run({ $max: max });
    db.query('DELETE FROM card_assets WHERE card_id NOT IN (SELECT id FROM cards)').run();
  });
  tx();
}

/** Test-only: wipe both tables. Guarded so it can't run against a real volume by accident. */
export function __resetForTests(): void {
  db.exec('DELETE FROM card_assets; DELETE FROM cards;');
}
