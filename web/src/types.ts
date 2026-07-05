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

export interface CardSource {
  editable?: boolean;
  cwd?: string;
  host?: string | null;
  placeholder?: string; // prompt cards: composer placeholder text (set by `relay ask --placeholder`)
  [key: string]: unknown;
}

// One row of the notification audit trail (mirrors src/notify-log.ts NotifyLogEntry). Read back
// by the Activity drawer to answer "why did I get that push, and which session sent it?".
export type NotifySource = 'notification' | 'stop' | 'cli' | 'mcp' | 'card' | 'dispatch' | 'unknown';

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
  buttons?: CardButton[];
  options?: CardOption[];
  mermaid?: string | null;
  copy_text?: string | null;
  page_html?: string | null; // kind:'page' — full HTML+JS doc rendered in a sandboxed iframe
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
}

// One entry of GET /api/dispatch-targets — an {id,label} pair a runner announced on startup. The
// compose picker's <Select> options; never carries a path (see dispatch-store.ts).
export interface DispatchTarget {
  id: string;
  label: string;
}
