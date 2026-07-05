// In-memory long-poll registry for card_events, modeled directly on waiters.ts (see that module's
// header comment for the full rationale). The one difference: a card_events waiter doesn't need to
// carry a payload — it just wakes on "something new landed", and the route re-lists from sinceSeq
// itself. A server restart just drops parked waiters; the next poll re-lists from the DB, which is
// the source of truth either way.
//
// `entry` IS the resolver: it's stored in the per-card set, and calling it clears its own timeout
// and removes itself from the set, so resolve and timeout share one cleanup path.

type Resolver = (hasNew: boolean) => void;

const waiters = new Map<string, Set<Resolver>>();

export function waitForEvents(cardId: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const set = waiters.get(cardId) ?? new Set<Resolver>();
    waiters.set(cardId, set);
    let timer: ReturnType<typeof setTimeout>;
    const entry: Resolver = (hasNew) => {
      clearTimeout(timer);
      set.delete(entry);
      if (set.size === 0) waiters.delete(cardId);
      resolve(hasNew);
    };
    set.add(entry);
    timer = setTimeout(() => entry(false), timeoutMs);
  });
}

export function notifyEventWaiters(cardId: string): void {
  const set = waiters.get(cardId);
  if (!set) return;
  for (const entry of [...set]) entry(true);
}

export function eventWaiterCount(cardId: string): number {
  return waiters.get(cardId)?.size ?? 0;
}
