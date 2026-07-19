import { useEffect } from 'react';
import { useFeed, parseServerDate } from '../store/feed';
import { fetchCards, fetchDispatches, fetchCardEvents } from '../api';

// Full-list resyncs are cheap but shouldn't be hammered by a flapping EventSource (every failed
// reconnect fires onopen again) or rapid tab switches — at most one per 30s.
const FULL_RESYNC_MIN_INTERVAL_MS = 30_000;

// Live feed over EventSource. Connects when `enabled` (i.e. unlocked + showing the feed). On a
// reconnect AFTER the first open, it backfills any cards AND dispatches missed while disconnected
// (since each slice's own cursor). EventSource auto-reconnects on error, so there's nothing to do
// on error but let it.
export function useSSE(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let connectedOnce = false;
    let lastFullResyncAt = 0;
    // Tombstones for every card-removed we've applied (dismiss/sweep are terminal — an id never
    // comes back live). A fullResync GET captured BEFORE a dismiss can land AFTER its card-removed
    // echo; without this, the stale snapshot's upsert would resurrect the dismissed card and no
    // further SSE event would ever remove it again.
    const removedIds = new Set<string>();
    const es = new EventSource('/api/stream', { withCredentials: true });

    // Resolved-state sync reliability (cards-v2 Feature 2c): the cursor backfill below only
    // fetches cards CREATED since the cursor — a card ANSWERED (or dismissed/swept) while the
    // connection was down keeps looking pending forever. Fix: on reconnect and on tab-visible,
    // re-fetch the FULL list and reconcile — upsert everything returned, remove store cards the
    // server no longer has. Removal is guarded to cards created before the sync started, so a
    // card-created SSE racing this fetch is never wiped.
    const fullResync = async () => {
      const startedAt = Date.now();
      if (startedAt - lastFullResyncAt < FULL_RESYNC_MIN_INTERVAL_MS) return;
      lastFullResyncAt = startedAt;
      const res = await fetchCards();
      if (res.status !== 'ok') return;
      const serverIds = new Set(res.cards.map((c) => c.id));
      // Skip tombstoned ids: this snapshot may predate a dismiss whose card-removed echo already
      // landed — re-upserting would resurrect the card (see removedIds above).
      res.cards.forEach((c) => {
        if (!removedIds.has(c.id)) useFeed.getState().upsert(c);
      });
      // Removal pass. The server clamps the un-cursored list to the newest 100 (listCards'
      // default) — when the response hits that clamp it is NOT a complete list, so absence only
      // proves deletion for cards inside the returned created_at range; older store cards must be
      // left alone or they'd vanish while still live server-side.
      const clamped = res.cards.length >= 100;
      let oldestServerCreatedAt: string | null = null;
      for (const c of res.cards) {
        if (oldestServerCreatedAt === null || c.created_at < oldestServerCreatedAt) oldestServerCreatedAt = c.created_at;
      }
      for (const c of useFeed.getState().cards) {
        if (serverIds.has(c.id) || parseServerDate(c.created_at) >= startedAt) continue;
        if (clamped && oldestServerCreatedAt !== null && c.created_at < oldestServerCreatedAt) continue;
        useFeed.getState().remove(c.id);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void fullResync();
    };
    document.addEventListener('visibilitychange', onVisibility);

    const onOpen = async () => {
      if (connectedOnce) {
        void fullResync();
        const cursor = useFeed.getState().newestCursor;
        const res = await fetchCards(cursor);
        // Same tombstone guard as fullResync: a stale backfill must not resurrect a removed card.
        if (res.status === 'ok')
          res.cards.forEach((c) => {
            if (!removedIds.has(c.id)) useFeed.getState().upsert(c);
          });
        const dispatchCursor = useFeed.getState().newestDispatchCursor;
        const dres = await fetchDispatches(dispatchCursor);
        if (dres.status === 'ok') dres.dispatches.forEach((d) => useFeed.getState().upsertDispatch(d));
        // Card threads (Plan 04): the cursor backfills above only cover `card-created`/
        // `card-updated`/`dispatch-updated` — a dropped SSE connection also misses `card-event`
        // broadcasts, which have no cursor of their own. Resync every thread that's currently
        // hydrated (a card whose Thread.tsx is/was actually rendering it) by re-fetching its full
        // event list; setEvents() merges rather than replaces, so nothing landed via appendEvent
        // during this fetch gets clobbered. Cards not yet hydrated don't need this — Thread.tsx's
        // own mount effect (store/feed.ts's loadedEventCardIds) will do a full fetch the first
        // time it renders them regardless of what SSE has or hasn't delivered.
        const hydratedCardIds = [...useFeed.getState().loadedEventCardIds];
        for (const cardId of hydratedCardIds) {
          const evRes = await fetchCardEvents(cardId);
          if (evRes.status === 'ok') useFeed.getState().setEvents(cardId, evRes.events);
        }
      }
      connectedOnce = true;
    };
    const onCreated = (e: MessageEvent) => {
      try {
        useFeed.getState().upsert(JSON.parse(e.data), { flash: true });
      } catch {
        /* ignore malformed */
      }
    };
    const onUpdated = (e: MessageEvent) => {
      try {
        useFeed.getState().upsert(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    const onRemoved = (e: MessageEvent) => {
      try {
        const { id } = JSON.parse(e.data);
        if (id) {
          removedIds.add(id);
          useFeed.getState().remove(id);
        }
      } catch {
        /* ignore malformed */
      }
    };
    // One event covers every dispatch transition (queued/claimed/running/done/failed/cancelled) —
    // routes-dispatch.ts always broadcasts the full row, so a plain upsert is always correct.
    const onDispatchUpdated = (e: MessageEvent) => {
      try {
        useFeed.getState().upsertDispatch(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    // Card threads (Plan 04): routes-cards.ts broadcasts { cardId, event } on every card_events
    // append (agent OR user side). appendEvent is a no-op-safe merge — de-dupes if this same
    // event already landed via the composer's own optimistic post (see Thread.tsx / Actions.tsx).
    const onCardEvent = (e: MessageEvent) => {
      try {
        const { cardId, event } = JSON.parse(e.data);
        if (cardId && event) useFeed.getState().appendEvent(cardId, event);
      } catch {
        /* ignore malformed */
      }
    };

    es.addEventListener('open', onOpen);
    es.addEventListener('card-created', onCreated);
    es.addEventListener('card-updated', onUpdated);
    es.addEventListener('card-removed', onRemoved);
    es.addEventListener('dispatch-updated', onDispatchUpdated);
    es.addEventListener('card-event', onCardEvent);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      es.close();
    };
  }, [enabled]);
}
