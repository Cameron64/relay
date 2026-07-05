// In-memory long-poll registry for `GET /api/dispatches/next?wait=N` — the runner's "give me the
// next job" long-poll. Modeled directly on event-waiters.ts (see that module's header for the full
// rationale): a waiter here doesn't carry a payload, just a "something new was queued" wakeup; the
// route re-queries nextQueued() itself once woken, so the DB row stays the single source of truth.
//
// Unlike waiters.ts/event-waiters.ts (keyed per-card), this queue is GLOBAL — there's one dispatch
// queue, not one per row — so it's a plain Set<Resolver>, not a Map. A server restart just drops
// parked waiters; the next poll re-queries the DB either way.
//
// `entry` IS the resolver: it's stored in the set, and calling it clears its own timeout and
// removes itself from the set, so resolve and timeout share one cleanup path.

type Resolver = (hasNew: boolean) => void;

const waiters = new Set<Resolver>();

export function waitForDispatch(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const entry: Resolver = (hasNew) => {
      clearTimeout(timer);
      waiters.delete(entry);
      resolve(hasNew);
    };
    waiters.add(entry);
    timer = setTimeout(() => entry(false), timeoutMs);
  });
}

export function notifyDispatchWaiters(): void {
  for (const entry of [...waiters]) entry(true);
}

export function dispatchWaiterCount(): number {
  return waiters.size;
}
