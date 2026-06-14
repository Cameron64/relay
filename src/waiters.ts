// In-memory long-poll registry for `relay card --wait`. When Claude asks
// GET /api/cards/:id/response?wait=N, the request parks here until the user responds in the
// PWA (respond() calls resolveWaiters) or the timeout fires. The DB row is the source of
// truth — a server restart just drops parked waiters; the next poll reads the stored status.
//
// `entry` IS the resolver: it's stored in the per-card set, and calling it clears its own
// timeout and removes itself from the set, so resolve and timeout share one cleanup path.

import type { CardResponse } from './cards-store.ts';

type Resolver = (resp: CardResponse | null) => void;

const waiters = new Map<string, Set<Resolver>>();

export function waitForResponse(cardId: string, timeoutMs: number): Promise<CardResponse | null> {
  return new Promise((resolve) => {
    const set = waiters.get(cardId) ?? new Set<Resolver>();
    waiters.set(cardId, set);
    let timer: ReturnType<typeof setTimeout>;
    const entry: Resolver = (resp) => {
      clearTimeout(timer);
      set.delete(entry);
      if (set.size === 0) waiters.delete(cardId);
      resolve(resp);
    };
    set.add(entry);
    timer = setTimeout(() => entry(null), timeoutMs);
  });
}

export function resolveWaiters(cardId: string, resp: CardResponse): void {
  const set = waiters.get(cardId);
  if (!set) return;
  for (const entry of [...set]) entry(resp);
}

export function waiterCount(cardId: string): number {
  return waiters.get(cardId)?.size ?? 0;
}
