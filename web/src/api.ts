import type { Card, CardResponse, Dispatch, DispatchTarget, NotifyLogEntry } from './types';

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

export async function respond(cardId: string, action: string, note: string | null): Promise<RespondResult> {
  let res: Response;
  try {
    res = await api(`/api/cards/${cardId}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, note }),
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
