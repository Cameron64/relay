// In-memory long-poll registry for `relay card --wait`. When Claude asks
// GET /api/cards/:id/response?wait=N, the request parks here until the user responds in the
// PWA (respond() calls resolveWaiters) or the timeout fires. The DB row is the source of
// truth — a server restart just drops parked waiters; the next poll reads the stored status.
//
// `entry` IS the resolver: it's stored in the per-card set, and calling it clears its own
// timeout and removes itself from the set, so resolve and timeout share one cleanup path.
//
// Plan 04 (card threads) adds waitForResponseOrEvent below: a write-side poll that opted into
// thread-awareness (?events_since=N on the /response route) needs to resolve early on EITHER the
// verdict landing OR a new card_event being appended. Per the roadmap's master doc, that's
// composed here via Promise.race over the two EXISTING waiter registries — this module's verdict
// waiters and event-waiters.ts's card_events waiters — rather than inventing a third registry.

import type { CardResponse } from './cards-store.ts';
import { waitForEvents } from './event-waiters.ts';

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

export type ResponseOrEvent = { kind: 'responded'; resp: CardResponse } | { kind: 'event' } | { kind: 'pending' };

// Race a verdict-wait against an events-wait sharing the SAME timeout budget. Resolves the moment
// EITHER produces a real signal (a verdict lands, or a new card_event is appended); resolves
// 'pending' once BOTH have settled falsy (i.e. both timed out with nothing new — since they share
// timeoutMs, that happens right around the caller's own deadline). Callers that don't want thread
// awareness at all should keep calling waitForResponse directly (see routes-cards.ts's legacy path
// for the /response route without ?events_since — this function is opt-in, never a default).
export function waitForResponseOrEvent(cardId: string, timeoutMs: number): Promise<ResponseOrEvent> {
  return new Promise((resolve) => {
    let settled = false;
    let respDone = false;
    let eventDone = false;
    const finish = (v: ResponseOrEvent) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    waitForResponse(cardId, timeoutMs).then((resp) => {
      respDone = true;
      if (resp) finish({ kind: 'responded', resp });
      else if (eventDone) finish({ kind: 'pending' });
    });
    waitForEvents(cardId, timeoutMs).then((hasNew) => {
      eventDone = true;
      if (hasNew) finish({ kind: 'event' });
      else if (respDone) finish({ kind: 'pending' });
    });
  });
}
