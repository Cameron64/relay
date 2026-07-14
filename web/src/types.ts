// Mirrors the backend card JSON (src/cards-store.ts / src/routes-cards.ts). This is the FROZEN
// integration contract — the React app consumes it, the backend is not changing.

export type Kind = 'note' | 'approval' | 'draft' | 'diagram' | 'image' | 'choice' | 'prompt' | 'page';
export type Behavior = 'respond' | 'copy' | 'link';
export type ButtonStyle = 'primary' | 'secondary' | 'outline' | 'danger' | 'note';
export type Verdict = 'approved' | 'changes_requested' | 'dismissed' | (string & {});

export interface CardButton {
  id: string;
  label: string;
  behavior: Behavior;
  value?: string;
  style?: ButtonStyle;
  sendLabel?: string;
}

// A rich choice option (kind: 'choice'). Selecting it responds with its id (-> verdict).
export interface CardOption {
  id: string;
  label: string;
  description?: string;
  body?: string; // markdown
  mermaid?: string;
  link?: string;
}

export interface Asset {
  id: string;
  mime?: string;
}

export interface CardResponse {
  verdict: Verdict;
  note?: string | null;
}

// Files the user attached to their reply (mirrors src/cards-store.ts's ResponseAssetMeta). Bytes
// served at GET /api/cards/:id/response-asset/:aid. Distinct from `Asset` (agent-sent card images).
export interface ResponseAsset {
  id: string;
  filename: string;
  mime: string;
}

export interface CardSource {
  editable?: boolean;
  sessionId?: string | null; // canonical attribution (master doc §3) — used by the Sessions dashboard
  cwd?: string;
  host?: string | null;
  placeholder?: string; // prompt cards: composer placeholder text (set by `relay ask --placeholder`)
  [key: string]: unknown;
}

// One row of the notification audit trail (mirrors src/notify-log.ts NotifyLogEntry). Read back
// by the Activity drawer to answer "why did I get that push, and which session sent it?". 'session'
// is the SessionStart/SessionEnd hooks (relay-roadmap Plan 03) — always deliver:false.
export type NotifySource = 'notification' | 'stop' | 'cli' | 'mcp' | 'card' | 'dispatch' | 'session' | 'unknown';

export interface NotifyLogEntry {
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
  event: string | null; // 'idle' | 'permission' | 'done' | 'other' | a card kind
  card_id: string | null; // present ⇒ actionable (the tap leads to a card)
  sent: number;
  failed: number;
  subscribers: number;
  delivered: number; // 1 = pushed to devices; 0 = logged-but-silenced (e.g. an idle nudge)
}

export interface Card {
  id: string;
  title: string;
  kind: Kind;
  body?: string | null;
  source?: CardSource | null;
  assets?: Asset[];
  response_assets?: ResponseAsset[];
  buttons?: CardButton[];
  options?: CardOption[];
  mermaid?: string | null;
  copy_text?: string | null;
  page_html?: string | null; // kind:'page' — full HTML+JS doc rendered in a sandboxed iframe
  // Plan 05 (page-submit bridge): set at create time when a page card asks a question rather
  // than just displaying one — see PageFrame.tsx's postMessage handshake and cards-store.ts's
  // matching field. Absent/false ⇒ a plain view-only page, unchanged from before this plan.
  expects_response?: boolean;
  status: 'pending' | 'responded' | 'dismissed';
  response?: CardResponse | null;
  created_at: string;
  expires_at?: string | null;
  // COUNT(*) of this card's card_events — present on GET /api/cards/:id (single-card fetch) only,
  // NEVER on the feed list (see cards-store.ts's getCard). Absent = not fetched yet, not "zero".
  event_count?: number;
}

// One row of a card's append-only event thread (mirrors src/cards-store.ts CardEvent), fetched via
// GET /api/cards/:id/events (UI) or /api/cards/:id/agent-events (write) — separate from the frozen
// single-verdict `response` above. No UI renders these yet; Plan 04 builds the thread view and
// Plan 05 uses type:'payload' for structured page-submit results.
export interface CardEvent {
  card_id: string;
  seq: number;
  role: 'agent' | 'user';
  type: 'message' | 'payload';
  body: string;
  at: string;
}

// Mirrors src/dispatch-store.ts's Dispatch — the phone-brainstorm -> queued-job -> desktop-runner
// bridge (relay-roadmap Plan 02). Composed with the UI cookie, claimed/run/reported by the runner
// with the write token. Carries a runner-local TARGET ID only — never a cwd/command (see the
// security invariant in dispatch-store.ts) — so the phone never learns real filesystem paths.
export type DispatchStatus = 'queued' | 'claimed' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Dispatch {
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
  assets?: DispatchAsset[];
}

// Metadata for a file the phone attached to a dispatch (mirrors src/dispatch-store.ts's
// DispatchAssetMeta). Bytes are served separately at GET /api/dispatches/:id/asset/:aid.
export interface DispatchAsset {
  id: string;
  filename: string;
  mime: string;
}

// One entry of GET /api/dispatch-targets — a target a runner announced on startup, unioned/de-duped
// by id across hosts (see src/dispatch-store.ts's listTargets). The compose picker's <Select>
// options; never carries a path, only id/label/host/timestamps (see the security invariant in
// dispatch-store.ts). `host` + `updatedAt` (ISO string, ms epoch also fine to compare) let the
// picker flag a target whose runner hasn't re-announced recently — runners now heartbeat every 5
// minutes, so `updatedAt` doubles as a "host last seen" signal.
export interface DispatchTarget {
  id: string;
  label: string;
  host?: string;
  updatedAt?: string;
}

// One row of GET /api/sessions (mirrors src/notify-log.ts's SessionSummary — relay-roadmap Plan
// 03). Event-derived, not process-level truth: a killed terminal never flips to 'ended' unless the
// SessionEnd hook fired; until then it degrades to 'stale' after the active window.
export type SessionStatus = 'active' | 'needs-input' | 'ended' | 'stale';

export interface SessionSummary {
  sessionId: string | null;
  project: string | null;
  cwd: string | null;
  host: string | null;
  lastEvent: string;
  lastAt: string;
  status: SessionStatus;
  // Set when this session was spawned by the runner (dispatches.claude_session match) — links the
  // row to its job actions (Cancel while queued / Follow-up once done).
  dispatchId?: string;
}
