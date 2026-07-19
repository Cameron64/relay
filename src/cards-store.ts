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

// A rich choice option (kind: 'choice'). Unlike a Button (which is just a label + action), an
// option can carry its own description, markdown body, diagram, and reference link — so a choice
// card can present real content per option, not just a one-word button. Selecting an option
// responds with its id (which becomes the verdict, reusing the normal respond/--wait path).
export type Option = {
  id: string;
  label: string;
  description?: string;
  body?: string; // markdown
  mermaid?: string;
  link?: string;
};

export type CardResponse = {
  verdict: string;
  action: string;
  note: string | null;
  at: string;
};

// Files the USER attached to their reply (kind "reply with an image/file"). Distinct from the
// `assets` on a Card, which are images the AGENT sent DOWN to the phone — these travel UP with a
// response and are surfaced to the waiting agent (the MCP downloads them to temp files). Stored in
// their own table so a reply image never renders as if the agent had attached it to the card.
export type ResponseAssetMeta = { id: string; filename: string; mime: string };

// Decoded, size-checked reply upload ready to persist (bytes materialized) — see decodeResponseAssets.
export type ResponseAsset = { filename: string; mime: string; bytes: Uint8Array };

export type Card = {
  id: string;
  created_at: string;
  kind: string;
  title: string;
  body: string | null;
  buttons: Button[];
  options: Option[];
  copy_text: string | null;
  mermaid: string | null;
  page_html: string | null;
  // Plan 05 (page-submit bridge): when true, this card is treated like an approval for expiry
  // purposes (no default TTL while pending — a question shouldn't vanish before it's answered)
  // and its push is flagged response-soliciting (routes-cards.ts). Set at create time only; the
  // PWA's runtime 'ready'/expectsResponse handshake is a SEPARATE, purely client-side signal for
  // the "waiting for your input" banner and does not write back to this column.
  expects_response: boolean;
  source: Record<string, unknown> | null;
  status: 'pending' | 'responded' | 'dismissed';
  response: CardResponse | null;
  responded_at: string | null;
  priority: 'normal' | 'high';
  expires_at: string | null;
  // "Agent is still listening" heartbeat — stamped (toISOString) every time the write-side
  // GET /api/cards/:id/response long-poll is hit (see touchLastPoll). NULL until the first poll.
  // The UI uses the gap since this stamp to flag cards whose agent probably stopped waiting.
  last_poll_at: string | null;
  push_sent: boolean;
  assets: { id: string; mime: string }[];
  // Files the user attached when they replied (empty until responded-with-attachments). Rendered
  // back on the resolved card so the user sees what they sent; surfaced to the agent via the MCP.
  response_assets: ResponseAssetMeta[];
  // Cheap COUNT(*) of this card's card_events, attached ONLY by getCard (single-card fetch) —
  // NEVER by listCards, so the feed payload doesn't pay for a join/subquery per card just to
  // show a thread badge nobody asked for yet (see Plan 00's "Gotchas").
  event_count?: number;
};

// card_events — an append-only, ordered channel attached to a card, richer than the frozen
// single-verdict `response` (respond/wait stays exactly as-is; see the master roadmap doc §4).
// 'message' events are thread text (Plan 04); 'payload' events are structured JSON (Plan 05's
// page-submit bridge). role:'agent' rows come from the write-token side (CLI/MCP/hooks/runner);
// role:'user' rows come from the browser. Both share this one shape so a listener never needs to
// know which side wrote a given event.
export type CardEventRole = 'agent' | 'user';
export type CardEventType = 'message' | 'payload';

export type CardEvent = {
  card_id: string;
  seq: number;
  role: CardEventRole;
  type: CardEventType;
  body: string;
  at: string;
};

// The part of a CardEvent the caller supplies; seq/at are always server-assigned.
export type CardEventInput = {
  role: CardEventRole;
  type: CardEventType;
  body: string;
};

// Caps mirror the page_html cap above: keep a single event, and a whole card's event thread, from
// bloating the SQLite row / the SSE `card-event` broadcast.
export const CARD_EVENT_BODY_MAX = { message: 16 * 1024, payload: 64 * 1024 } as const;
export const CARD_EVENT_MAX_PER_CARD = 200;

// Reply-attachment caps — mirror the dispatch upload path (any mime, not just images; a reply may
// be a screenshot, a log, a PDF). Count cap matches card_assets' MAX_ASSETS.
export const MAX_RESPONSE_ASSETS = 8;
export const RESPONSE_ASSET_MAX_BYTES = Number(process.env.RESPONSE_ASSET_MAX_BYTES ?? 10 * 1024 * 1024); // 10 MB/file
const RESPONSE_ASSET_FILENAME_MAX = 255;
const RESPONSE_ASSET_MIME_MAX = 200;

export type CardInput = {
  kind: string;
  title: string;
  body: string | null;
  buttons: Button[];
  options: Option[];
  copy_text: string | null;
  mermaid: string | null;
  page_html: string | null;
  // Optional; defaults to false when omitted (existing callers/tests that build a CardInput
  // literal without this field are unaffected — see createCard's `?? false`).
  expects_response?: boolean;
  source: Record<string, unknown> | null;
  priority: 'normal' | 'high';
  expires_at: string | null;
};

export const VALID_KINDS = ['note', 'approval', 'draft', 'diagram', 'image', 'choice', 'prompt', 'page'];
export const VALID_BEHAVIORS = ['respond', 'copy', 'link'];
export const VALID_STYLES = ['primary', 'secondary', 'outline', 'danger', 'note'];
export const VALID_VERDICTS = ['approved', 'changes_requested', 'dismissed'];

// kind:'page' carries a full agent-authored HTML+JS document (page_html) rendered in a sandboxed
// iframe (web/.../PageFrame.tsx). Cap the stored doc so it can't bloat the SQLite row, the SSE
// card-created broadcast, or the feed payload. CDN-loaded libraries don't count — only the inline
// document does. Env-overridable; default 512 KB.
export const PAGE_HTML_MAX = Number(process.env.RELAY_PAGE_HTML_MAX ?? 512 * 1024);

// --- expiry / decluttering -------------------------------------------------
// Cards shouldn't live in the feed forever. Three rules, all leaning on the existing expires_at
// column (which was stored but never enforced before):
//   1. Non-actionable cards (note/diagram/image/draft) auto-expire CARD_TTL_HOURS after creation
//      unless the caller passed an explicit expires_at.
//   2. Actionable cards (approval/choice/prompt, or expects_response:true) get a LONGER default
//      expiry while pending — CARD_PENDING_TTL_HOURS (default 24) — so an abandoned question
//      doesn't sit in the feed forever, then rule 3 takes over once answered. (They previously got
//      NO default expiry at all; every card now always carries a non-null expires_at.)
//   3. Once a card is answered (respond) or dismissed, its expiry is pulled in to a short grace
//      window (CARD_ANSWERED_TTL_HOURS) so resolved cards clear out of the feed soon after.
// A periodic sweepExpired() (see server.ts) deletes expired rows and tells live clients to drop
// them. NOTE on time comparisons: expires_at/created_at are stored via toISOString() (T/Z format),
// so we ALWAYS compare against a JS ISO string ($now), never SQLite's space-format datetime('now')
// — mixing the two compares 'T'(0x54) vs ' '(0x20) and silently inverts the ordering.
const CARD_TTL_HOURS = Number(process.env.CARD_TTL_HOURS ?? 24);
const CARD_ANSWERED_TTL_HOURS = Number(process.env.CARD_ANSWERED_TTL_HOURS ?? 6);
const ACTIONABLE_KINDS = new Set(['approval', 'choice', 'prompt']);

// expectsResponse (Plan 05) gets the same pending-TTL treatment as the actionable kinds above,
// applied per-card rather than per-kind — a plain `page` gets the CARD_TTL_HOURS bucket, but a
// page created with expects_response:true (a question, not a view-only viz) waits for its answer
// on the same clock as an approval/choice/prompt. Env read at call time so tests can override.
function defaultExpiryFor(kind: string, createdAtIso: string, expectsResponse = false): string | null {
  if (ACTIONABLE_KINDS.has(kind) || expectsResponse) {
    const pendingTtlHours = Number(process.env.CARD_PENDING_TTL_HOURS ?? 24);
    if (!(pendingTtlHours > 0)) return null;
    return new Date(Date.parse(createdAtIso) + pendingTtlHours * 3_600_000).toISOString();
  }
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
        options      TEXT NOT NULL DEFAULT '[]',
        copy_text    TEXT,
        mermaid      TEXT,
        page_html    TEXT,
        expects_response INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS card_response_assets (
        id         TEXT PRIMARY KEY,
        card_id    TEXT NOT NULL,
        filename   TEXT NOT NULL,
        mime       TEXT NOT NULL,
        bytes      BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_response_assets_card ON card_response_assets(card_id);
      CREATE TABLE IF NOT EXISTS card_events (
        card_id  TEXT NOT NULL,
        seq      INTEGER NOT NULL,
        role     TEXT NOT NULL,
        type     TEXT NOT NULL,
        body     TEXT NOT NULL,
        at       TEXT NOT NULL,
        PRIMARY KEY (card_id, seq)
      );
    `);
    // Migration: `options` was added after the table shipped. CREATE TABLE IF NOT EXISTS won't add
    // it to an existing prod DB, so add it idempotently (SQLite allows ADD COLUMN with NOT NULL when
    // a DEFAULT is given; existing rows backfill to '[]').
    const cols = db.query('PRAGMA table_info(cards)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'options')) {
      db.exec("ALTER TABLE cards ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
    }
    // Migration: `page_html` (kind:'page') was added after the table shipped. Nullable TEXT, so
    // existing rows backfill to NULL — safe on the live prod volume (no DEFAULT needed).
    if (!cols.some((c) => c.name === 'page_html')) {
      db.exec('ALTER TABLE cards ADD COLUMN page_html TEXT');
    }
    // Migration: `expects_response` (Plan 05's page-submit bridge) was added after the table
    // shipped. NOT NULL with a DEFAULT backfills existing rows to 0 (unaffected — expiry/push
    // behavior is only conditioned on this column being explicitly true).
    if (!cols.some((c) => c.name === 'expects_response')) {
      db.exec('ALTER TABLE cards ADD COLUMN expects_response INTEGER NOT NULL DEFAULT 0');
    }
    // Migration: `last_poll_at` (agent long-poll heartbeat) was added after the table shipped.
    // Nullable TEXT (ISO string via toISOString, never datetime('now') — see the time-comparison
    // note near the TTL constants); existing rows backfill to NULL ("never polled").
    if (!cols.some((c) => c.name === 'last_poll_at')) {
      db.exec('ALTER TABLE cards ADD COLUMN last_poll_at TEXT');
    }
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

export function validateOptions(options: unknown): Ok<Option[]> | Err {
  if (options === undefined || options === null) return { ok: true, value: [] };
  if (!Array.isArray(options)) return { ok: false, error: 'options must be an array' };
  if (options.length > 10) return { ok: false, error: 'too many options (max 10)' };
  const out: Option[] = [];
  const seen = new Set<string>();
  for (const raw of options) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'each option must be an object' };
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string' && o.id ? o.id : null;
    const label = typeof o.label === 'string' && o.label ? o.label : null;
    if (!id) return { ok: false, error: 'option.id required' };
    if (!label) return { ok: false, error: 'option.label required' };
    if (seen.has(id)) return { ok: false, error: `duplicate option id: ${id}` };
    seen.add(id);
    const opt: Option = { id, label };
    if (typeof o.description === 'string') opt.description = o.description;
    if (typeof o.body === 'string') opt.body = o.body;
    if (typeof o.mermaid === 'string') opt.mermaid = o.mermaid;
    if (typeof o.link === 'string') {
      if (!/^https?:\/\//i.test(o.link)) return { ok: false, error: 'option.link must start with http:// or https://' };
      opt.link = o.link;
    }
    out.push(opt);
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
  const ov = validateOptions(b.options);
  if (!ov.ok) return ov;
  const priority = b.priority === 'high' ? 'high' : 'normal';
  const copy_text =
    typeof b.copy_text === 'string' ? b.copy_text : typeof b.copyText === 'string' ? (b.copyText as string) : null;
  const mermaid = typeof b.mermaid === 'string' ? b.mermaid : null;
  // page_html: required + size-capped for kind:'page'; ignored (stored null) for every other kind so
  // a stray html field can't ride along on a note/approval/etc.
  const pageHtmlRaw = typeof b.page_html === 'string' ? b.page_html : null;
  let page_html: string | null = null;
  if (kind === 'page') {
    if (!pageHtmlRaw || !pageHtmlRaw.trim()) return { ok: false, error: 'page_html required for kind "page"' };
    if (pageHtmlRaw.length > PAGE_HTML_MAX) return { ok: false, error: `page_html exceeds ${PAGE_HTML_MAX} bytes` };
    page_html = pageHtmlRaw;
  }
  const source = b.source && typeof b.source === 'object' ? (b.source as Record<string, unknown>) : null;
  const expiresRaw = typeof b.expires_at === 'string' ? b.expires_at : null;
  // A provided expires_at must be a real date — expiry comparisons are ISO-string ordering, and an
  // unparseable value would either never expire or expire instantly depending on how it collates.
  if (expiresRaw !== null && Number.isNaN(new Date(expiresRaw).getTime()))
    return { ok: false, error: `expires_at is not a valid date: ${expiresRaw}` };
  // Normalize to toISOString before storing — a parseable-but-non-ISO form ('2026-07-19 18:00:00',
  // or an offset like '...T20:00:00+02:00') would pass the check above yet collate wrongly against
  // the toISOString() timestamps the liveness predicate and sweep compare with.
  const expires_at = expiresRaw === null ? null : new Date(expiresRaw).toISOString();
  // expects_response: a plain boolean flag (Plan 05). Not restricted to kind:'page' — the effect
  // (no default expiry while pending + response-soliciting push) is harmless on any kind, and
  // scoping it here would just be one more branch to keep in sync with VALID_KINDS.
  const expects_response = b.expects_response === true;
  return {
    ok: true,
    value: { kind, title, body: bodyText, buttons: bv.value, options: ov.value, copy_text, mermaid, page_html, expects_response, source, priority, expires_at },
  };
}

// --- card_events validation (exported for unit tests) ----------------------
// Only `type`/`body` come from the request body — `role` is decided by the ROUTE (which auth
// header matched: write -> 'agent', UI cookie -> 'agent-events' vs 'events' path), never trusted
// from client input. See routes-cards.ts's two-path split (master doc §6: never merge the auth
// middlewares).
export function validateCardEventInput(body: unknown): Ok<{ type: CardEventType; body: string }> | Err {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const type = b.type === undefined ? 'message' : b.type;
  if (type !== 'message' && type !== 'payload') return { ok: false, error: 'type must be "message" or "payload"' };
  const text = typeof b.body === 'string' ? b.body : null;
  if (!text) return { ok: false, error: 'body required' };
  const max = CARD_EVENT_BODY_MAX[type];
  if (text.length > max) return { ok: false, error: `event body exceeds ${max} bytes for type "${type}"` };
  return { ok: true, value: { type, body: text } };
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
    options: safeJSON<Option[]>(row.options, []),
    copy_text: row.copy_text,
    mermaid: row.mermaid,
    page_html: row.page_html ?? null,
    expects_response: !!row.expects_response,
    source: safeJSON<Record<string, unknown> | null>(row.source, null),
    status: row.status,
    response: safeJSON<CardResponse | null>(row.response, null),
    responded_at: row.responded_at,
    priority: row.priority,
    expires_at: row.expires_at,
    last_poll_at: row.last_poll_at ?? null,
    push_sent: !!row.push_sent,
    assets: assets.map((a) => ({ id: a.id, mime: a.mime })),
    response_assets: listResponseAssets(row.id),
  };
}

export function createCard(value: CardInput, assets: { mime: string; bytes: Uint8Array }[] = []): Card {
  const id = genId();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const expectsResponse = value.expects_response ?? false;
    db.query(
      `INSERT INTO cards (id, created_at, kind, title, body, buttons, options, copy_text, mermaid, page_html, expects_response, source, status, priority, expires_at, push_sent)
       VALUES ($id, $created, $kind, $title, $body, $buttons, $options, $copy, $mermaid, $page_html, $expects_response, $source, 'pending', $priority, $expires, 0)`,
    ).run({
      $id: id,
      $created: now,
      $kind: value.kind,
      $title: value.title,
      $body: value.body,
      $buttons: JSON.stringify(value.buttons || []),
      $options: JSON.stringify(value.options || []),
      $copy: value.copy_text ?? null,
      $mermaid: value.mermaid ?? null,
      $page_html: value.page_html ?? null,
      $expects_response: expectsResponse ? 1 : 0,
      $source: value.source ? JSON.stringify(value.source) : null,
      $priority: value.priority || 'normal',
      $expires: value.expires_at ?? defaultExpiryFor(value.kind, now, expectsResponse),
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
  const card = hydrate(row);
  const countRow = db.query('SELECT COUNT(*) AS n FROM card_events WHERE card_id = $id').get({ $id: id }) as { n: number };
  card.event_count = countRow.n;
  return card;
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
  | { status: 'responded'; response: CardResponse; event?: CardEvent }
  | { status: 'conflict'; response: CardResponse | null }
  | { status: 'reserved' }
  | { status: 'notfound' }
  | { status: 'payload_cap' };

// `payload`, when provided, is a pre-validated (size-checked by the caller, via
// validateCardEventInput) JSON string to record as a 'payload' card_event IN THE SAME
// TRANSACTION as the responded-status flip (Plan 05's page-submit bridge). This is the fix for
// the cross-tab/cross-client race: two clients racing to submit the same page card could
// previously each write their own 'payload' event via the separate events endpoint BEFORE either
// respond() call landed, so the highest-seq payload row picked up by relay-mcp's withPagePayload
// was not necessarily the one that belonged to the respond() call that actually won. Folding the
// payload write into respondCard's own transaction means only the WINNING call — the one that
// actually flips status from 'pending' to 'responded' — ever inserts a payload event; a losing
// call sees `status === 'responded'` already and returns 'conflict' without touching card_events
// at all, exactly mirroring the semantics of a losing respond(). See PageFrame.tsx's submitPayload.
// Decode + size-check the optional inline uploads on a respond request. Mirrors dispatch-store's
// decodeDispatchAssets: any mime (a reply may be a photo, a log, a PDF), a filename is required so
// the MCP can materialize a sensibly-named local file for the agent, and bytes are materialized
// here. The filename is stored UNSANITIZED — the MCP is the only thing that writes these to a
// filesystem and it sanitizes at write time (see safeFilename in relay-lib.mjs).
type OkAssets = { ok: true; value: ResponseAsset[] };
type ErrAssets = { ok: false; error: string };
export function decodeResponseAssets(raw: unknown): OkAssets | ErrAssets {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'assets must be an array' };
  if (raw.length > MAX_RESPONSE_ASSETS) return { ok: false, error: `too many assets (max ${MAX_RESPONSE_ASSETS})` };
  const out: ResponseAsset[] = [];
  for (const a of raw) {
    if (typeof a !== 'object' || a === null) return { ok: false, error: 'each asset must be an object' };
    const rec = a as Record<string, unknown>;
    const mime = typeof rec.mime === 'string' && rec.mime.trim() ? rec.mime.trim().slice(0, RESPONSE_ASSET_MIME_MAX) : null;
    const filename = typeof rec.filename === 'string' && rec.filename.trim() ? rec.filename.trim().slice(0, RESPONSE_ASSET_FILENAME_MAX) : null;
    const dataB64 = typeof rec.data === 'string' ? rec.data : null;
    if (!mime) return { ok: false, error: 'asset mime required' };
    if (!filename) return { ok: false, error: 'asset filename required' };
    if (!dataB64) return { ok: false, error: 'asset data (base64) required' };
    let buf: Buffer;
    try {
      buf = Buffer.from(dataB64, 'base64');
    } catch {
      return { ok: false, error: 'invalid base64 asset' };
    }
    if (buf.length === 0) return { ok: false, error: 'empty asset' };
    if (buf.length > RESPONSE_ASSET_MAX_BYTES) return { ok: false, error: `asset exceeds ${RESPONSE_ASSET_MAX_BYTES} bytes` };
    out.push({ filename, mime, bytes: new Uint8Array(buf) });
  }
  return { ok: true, value: out };
}

/** Metadata for a card's reply attachments (bytes fetched separately via getResponseAsset). */
export function listResponseAssets(cardId: string): ResponseAssetMeta[] {
  return db
    .query('SELECT id, filename, mime FROM card_response_assets WHERE card_id = $cid ORDER BY created_at ASC, rowid ASC')
    .all({ $cid: cardId }) as ResponseAssetMeta[];
}

/** One reply attachment's bytes (MCP download + phone preview). Scoped by card_id. */
export function getResponseAsset(cardId: string, assetId: string): { filename: string; mime: string; bytes: Uint8Array } | null {
  const row = db
    .query('SELECT filename, mime, bytes FROM card_response_assets WHERE id = $aid AND card_id = $cid')
    .get({ $aid: assetId, $cid: cardId }) as any;
  if (!row) return null;
  return { filename: row.filename, mime: row.mime, bytes: row.bytes as Uint8Array };
}

export function respondCard(
  id: string,
  input: { action: string; note?: string | null; payload?: string },
  assets: ResponseAsset[] = [],
): RespondResult {
  // Reserved-namespace guard: action ids starting with '__' are internal sentinels — notably the
  // notification "Reply" button (prompt cards) posts '__reply' from an OUT-OF-DATE service worker
  // that predates this feature. They must never be recorded as a verdict. Rejecting here also makes
  // such an old SW's respondInBackground fall back to opening the app at the reply composer (its
  // non-OK branch), so the feature works gracefully across the SW upgrade without a "reopen first".
  if (input.action.startsWith('__')) return { status: 'reserved' };
  const tx = db.transaction((): RespondResult => {
    const row = db.query('SELECT status, response, buttons FROM cards WHERE id = $id').get({ $id: id }) as any;
    if (!row) return { status: 'notfound' };
    if (row.status === 'responded') return { status: 'conflict', response: safeJSON<CardResponse | null>(row.response, null) };
    // Per-card event cap, checked BEFORE the status flip so a losing/edge-case cap hit never
    // leaves the card responded with no payload recorded (all-or-nothing, same transaction).
    if (input.payload !== undefined) {
      const countRow = db.query('SELECT COUNT(*) AS n FROM card_events WHERE card_id = $cid').get({ $cid: id }) as { n: number };
      if (countRow.n >= CARD_EVENT_MAX_PER_CARD) return { status: 'payload_cap' };
    }
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
    let event: CardEvent | undefined;
    if (input.payload !== undefined) {
      const seqRow = db.query('SELECT COALESCE(MAX(seq), 0) AS m FROM card_events WHERE card_id = $cid').get({ $cid: id }) as { m: number };
      const seq = seqRow.m + 1;
      db.query('INSERT INTO card_events (card_id, seq, role, type, body, at) VALUES ($cid, $seq, $role, $type, $body, $at)').run({
        $cid: id,
        $seq: seq,
        $role: 'user',
        $type: 'payload',
        $body: input.payload,
        $at: response.at,
      });
      event = { card_id: id, seq, role: 'user', type: 'payload', body: input.payload, at: response.at };
    }
    // Reply attachments persist in the SAME transaction as the verdict flip — a losing/racing
    // respond() sees status==='responded' above and returns 'conflict' before reaching here, so a
    // card's stored reply assets always belong to the response that actually won (mirrors payload).
    for (const a of assets) {
      db.query('INSERT INTO card_response_assets (id, card_id, filename, mime, bytes, created_at) VALUES ($id, $cid, $filename, $mime, $bytes, $created)').run({
        $id: genId(),
        $cid: id,
        $filename: a.filename,
        $mime: a.mime,
        $bytes: a.bytes,
        $created: response.at,
      });
    }
    return { status: 'responded', response, event };
  });
  return tx();
}

// Append one event to a card's thread. Transaction so the existence/status check, the per-card cap
// count, and the seq computation ("next free slot") can't race a concurrent append onto the same
// card. role:'user' appends are gated to pending cards (mirrors the intent of respondCard: once the
// human has moved on, a UI-side event shouldn't reopen the thread); role:'agent' appends are allowed
// on any status ("got it, thanks" after the human already answered is fine).
export function appendCardEvent(cardId: string, input: CardEventInput): Ok<CardEvent> | Err {
  const max = CARD_EVENT_BODY_MAX[input.type];
  if (input.body.length > max) return { ok: false, error: `event body exceeds ${max} bytes for type "${input.type}"` };
  const tx = db.transaction((): Ok<CardEvent> | Err => {
    const row = db.query('SELECT status FROM cards WHERE id = $id').get({ $id: cardId }) as any;
    if (!row) return { ok: false, error: 'card not found' };
    if (input.role === 'user' && row.status !== 'pending') return { ok: false, error: 'card is not pending' };
    const countRow = db.query('SELECT COUNT(*) AS n FROM card_events WHERE card_id = $cid').get({ $cid: cardId }) as { n: number };
    if (countRow.n >= CARD_EVENT_MAX_PER_CARD) return { ok: false, error: `card has reached the max of ${CARD_EVENT_MAX_PER_CARD} events` };
    const seqRow = db.query('SELECT COALESCE(MAX(seq), 0) AS m FROM card_events WHERE card_id = $cid').get({ $cid: cardId }) as { m: number };
    const seq = seqRow.m + 1;
    const at = new Date().toISOString();
    db.query('INSERT INTO card_events (card_id, seq, role, type, body, at) VALUES ($cid, $seq, $role, $type, $body, $at)').run({
      $cid: cardId,
      $seq: seq,
      $role: input.role,
      $type: input.type,
      $body: input.body,
      $at: at,
    });
    return { ok: true, value: { card_id: cardId, seq, role: input.role, type: input.type, body: input.body, at } };
  });
  return tx();
}

export function listCardEvents(cardId: string, opts: { sinceSeq?: number } = {}): CardEvent[] {
  const rows = opts.sinceSeq
    ? (db
        .query('SELECT card_id, seq, role, type, body, at FROM card_events WHERE card_id = $cid AND seq > $since ORDER BY seq ASC')
        .all({ $cid: cardId, $since: opts.sinceSeq }) as CardEvent[])
    : (db
        .query('SELECT card_id, seq, role, type, body, at FROM card_events WHERE card_id = $cid ORDER BY seq ASC')
        .all({ $cid: cardId }) as CardEvent[]);
  return rows;
}

export function getAsset(cardId: string, assetId: string): { mime: string; bytes: Uint8Array } | null {
  const row = db.query('SELECT mime, bytes FROM card_assets WHERE id = $aid AND card_id = $cid').get({
    $aid: assetId,
    $cid: cardId,
  }) as any;
  if (!row) return null;
  return { mime: row.mime, bytes: row.bytes as Uint8Array };
}

/**
 * Stamp the agent long-poll heartbeat (see Card.last_poll_at). Called by the write-side
 * GET /api/cards/:id/response handler at request arrival, BEFORE parking the waiter — poll waits
 * are ~50s loops, so a stamp older than a few minutes means no agent is listening anymore.
 * toISOString, never datetime('now') (time-comparison note near the TTL constants).
 */
export function touchLastPoll(id: string): void {
  db.query('UPDATE cards SET last_poll_at = $now WHERE id = $id').run({
    $now: new Date().toISOString(),
    $id: id,
  });
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
      db.query('DELETE FROM card_response_assets WHERE card_id NOT IN (SELECT id FROM cards)').run();
      db.query('DELETE FROM card_events WHERE card_id NOT IN (SELECT id FROM cards)').run();
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
    db.query('DELETE FROM card_response_assets WHERE card_id NOT IN (SELECT id FROM cards)').run();
    db.query('DELETE FROM card_events WHERE card_id NOT IN (SELECT id FROM cards)').run();
  });
  tx();
}

/** Test-only: wipe all cards tables. Guarded so it can't run against a real volume by accident. */
export function __resetForTests(): void {
  db.exec('DELETE FROM card_response_assets; DELETE FROM card_assets; DELETE FROM card_events; DELETE FROM cards;');
}
