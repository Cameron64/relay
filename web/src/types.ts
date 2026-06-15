// Mirrors the backend card JSON (src/cards-store.ts / src/routes-cards.ts). This is the FROZEN
// integration contract — the React app consumes it, the backend is not changing.

export type Kind = 'note' | 'approval' | 'draft' | 'diagram' | 'image' | 'choice';
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
  [key: string]: unknown;
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
  status: 'pending' | 'responded' | 'dismissed';
  response?: CardResponse | null;
  created_at: string;
  expires_at?: string | null;
}
