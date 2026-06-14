import type { Card, CardResponse } from './types';

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
