import type { Card, CardEvent, CardResponse, Dispatch, DispatchTarget, NotifyLogEntry, SessionSummary } from './types';

// All UI-side calls carry the relay_session httpOnly cookie (set at /api/unlock).
export function api(path: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(path, { credentials: 'include', ...opts });
}

export function assetUrl(cardId: string, assetId: string): string {
  return `/api/cards/${cardId}/asset/${assetId}`;
}

export type FeedResult =
  | { status: 'ok'; cards: Card[] }
  | { status: 'unauth' }
  | { status: 'warming' }
  | { status: 'error' };

export async function fetchCards(since?: string | null): Promise<FeedResult> {
  const path = '/api/cards' + (since ? '?since=' + encodeURIComponent(since) : '');
  let res: Response;
  try {
    res = await api(path);
  } catch {
    return { status: 'error' };
  }
  if (res.status === 401) return { status: 'unauth' };
  if (res.status === 503) return { status: 'warming' };
  if (!res.ok) return { status: 'error' };
  const data = await res.json().catch(() => ({ cards: [] }));
  return { status: 'ok', cards: data.cards || [] };
}

export type NotificationsResult =
  | { status: 'ok'; notifications: NotifyLogEntry[] }
  | { status: 'unauth' }
  | { status: 'warming' }
  | { status: 'error' };

// The notification audit trail (GET /api/notifications), newest first. 503 = log table still
// warming; the Activity drawer shows that as a transient state, distinct from a hard error.
export async function fetchNotifications(limit = 100): Promise<NotificationsResult> {
  let res: Response;
  try {
    res = await api('/api/notifications?limit=' + limit);
  } catch {
    return { status: 'error' };
  }
  if (res.status === 401) return { status: 'unauth' };
  if (res.status === 503) return { status: 'warming' };
  if (!res.ok) return { status: 'error' };
  const data = await res.json().catch(() => ({ notifications: [] }));
  return { status: 'ok', notifications: data.notifications || [] };
}

export type SessionsResult =
  | { status: 'ok'; sessions: SessionSummary[]; window_hours: number }
  | { status: 'unauth' }
  | { status: 'warming' }
  | { status: 'error' };

// GET /api/sessions (relay-roadmap Plan 03) — the Sessions dashboard's one aggregation read, folded
// server-side from notify-log + the dispatch runner's claude_session linkage. 503 = notify-log still
// warming, same "warming" treatment as fetchNotifications.
export async function fetchSessions(windowHours?: number): Promise<SessionsResult> {
  const path = '/api/sessions' + (windowHours ? '?window_hours=' + encodeURIComponent(windowHours) : '');
  let res: Response;
  try {
    res = await api(path);
  } catch {
    return { status: 'error' };
  }
  if (res.status === 401) return { status: 'unauth' };
  if (res.status === 503) return { status: 'warming' };
  if (!res.ok) return { status: 'error' };
  const data = await res.json().catch(() => ({ sessions: [], window_hours: 24 }));
  return { status: 'ok', sessions: data.sessions || [], window_hours: Number(data.window_hours) || 24 };
}

export async function unlock(token: string): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await api('/api/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export type RespondResult =
  | { status: 'ok'; response: CardResponse }
  | { status: 'conflict'; response?: CardResponse }
  | { status: 'error' };

// `payload`, when given, is a JSON string recorded as a card_event ATOMICALLY with this respond
// (Plan 05's page-submit bridge) — see respondCard in cards-store.ts. Passing it here (rather than
// a separate postCardEvent call before respond) is load-bearing: it guarantees that a losing
// client in a cross-tab submit race never gets its payload persisted at all, so the highest-seq
// 'payload' row for a card is always the one that belongs to the respond() call that actually won.
export async function respond(cardId: string, action: string, note: string | null, payload?: string): Promise<RespondResult> {
  let res: Response;
  try {
    res = await api(`/api/cards/${cardId}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload === undefined ? { action, note } : { action, note, payload }),
    });
  } catch {
    return { status: 'error' };
  }
  if (res.status === 409) {
    const d = await res.json().catch(() => ({}));
    return { status: 'conflict', response: d.response };
  }
  if (!res.ok) return { status: 'error' };
  const d = await res.json().catch(() => ({}));
  return { status: 'ok', response: d.response };
}

// Append a card_events row from the UI side (role:'user', fixed by the route — never sent here).
// Used by PageFrame's postMessage bridge (Plan 05) to stash a page-submit payload BEFORE calling
// respond(), so the payload's permanent home (the event row) exists before the verdict resolves —
// see the ordering note in cards-store.ts / master doc §4 (the frozen `response` never carries
// JSON, only a bare verdict).
export type PostEventResult =
  | { status: 'ok'; event: CardEvent }
  | { status: 'notfound' }
  | { status: 'conflict' }
  | { status: 'error' };

export async function postCardEvent(cardId: string, type: 'message' | 'payload', body: string): Promise<PostEventResult> {
  let res: Response;
  try {
    res = await api(`/api/cards/${cardId}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, body }),
    });
  } catch {
    return { status: 'error' };
  }
  if (res.status === 404) return { status: 'notfound' };
  if (res.status === 409) return { status: 'conflict' };
  if (!res.ok) return { status: 'error' };
  const d = await res.json().catch(() => ({}));
  return { status: 'ok', event: d.event };
}

// Fetch a card's full thread (UI side, GET /api/cards/:id/events — no wait, one-shot). Used by
// Thread.tsx (Plan 04) to hydrate a card's events slice the first time it's needed; after that,
// the SSE 'card-event' broadcast (see useSSE.ts) keeps it live without re-fetching.
export type CardEventsResult = { status: 'ok'; events: CardEvent[] } | { status: 'notfound' } | { status: 'error' };

export async function fetchCardEvents(cardId: string): Promise<CardEventsResult> {
  let res: Response;
  try {
    res = await api(`/api/cards/${cardId}/events`);
  } catch {
    return { status: 'error' };
  }
  if (res.status === 404) return { status: 'notfound' };
  if (!res.ok) return { status: 'error' };
  const data = await res.json().catch(() => ({ events: [] }));
  return { status: 'ok', events: data.events || [] };
}

// Clear a card from the feed. Fire-and-forget from the UI's perspective: the optimistic local
// remove already happened, and a card-removed SSE will reconcile other tabs.
export async function dismiss(cardId: string): Promise<boolean> {
  try {
    const res = await api(`/api/cards/${cardId}/dismiss`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

// --- dispatches (Plan 02: phone -> queued job -> desktop runner) -----------

export type DispatchesResult =
  | { status: 'ok'; dispatches: Dispatch[] }
  | { status: 'unauth' }
  | { status: 'warming' }
  | { status: 'error' };

export async function fetchDispatches(since?: string | null): Promise<DispatchesResult> {
  const path = '/api/dispatches' + (since ? '?since=' + encodeURIComponent(since) : '');
  let res: Response;
  try {
    res = await api(path);
  } catch {
    return { status: 'error' };
  }
  if (res.status === 401) return { status: 'unauth' };
  if (res.status === 503) return { status: 'warming' };
  if (!res.ok) return { status: 'error' };
  const data = await res.json().catch(() => ({ dispatches: [] }));
  return { status: 'ok', dispatches: data.dispatches || [] };
}

export type TargetsResult = { status: 'ok'; targets: DispatchTarget[] } | { status: 'warming' } | { status: 'error' };

export async function fetchDispatchTargets(): Promise<TargetsResult> {
  let res: Response;
  try {
    res = await api('/api/dispatch-targets');
  } catch {
    return { status: 'error' };
  }
  if (res.status === 503) return { status: 'warming' };
  if (!res.ok) return { status: 'error' };
  const data = await res.json().catch(() => ({ targets: [] }));
  return { status: 'ok', targets: data.targets || [] };
}

export type ComposeResult = { status: 'ok'; dispatch: Dispatch } | { status: 'error'; error: string };

export async function composeDispatch(input: { title?: string | null; body: string; target: string; resume_of?: string | null }): Promise<ComposeResult> {
  let res: Response;
  try {
    res = await api('/api/dispatches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    return { status: 'error', error: 'network error' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: 'error', error: data.error || `HTTP ${res.status}` };
  return { status: 'ok', dispatch: data.dispatch as Dispatch };
}

export type CancelDispatchResult = { status: 'ok'; dispatch: Dispatch } | { status: 'error'; error: string };

export async function cancelDispatch(id: string): Promise<CancelDispatchResult> {
  let res: Response;
  try {
    res = await api(`/api/dispatches/${id}/cancel`, { method: 'POST' });
  } catch {
    return { status: 'error', error: 'network error' };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { status: 'error', error: data.error || `HTTP ${res.status}` };
  return { status: 'ok', dispatch: data.dispatch as Dispatch };
}
