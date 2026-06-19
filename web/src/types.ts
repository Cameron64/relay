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
export type NotifySource = 'notification' | 'stop' | 'cli' | 'mcp' | 'card' | 'unknown';

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
}
