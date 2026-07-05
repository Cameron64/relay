import { useEffect } from 'react';
import { useFeed } from '../store/feed';
import { fetchCards, fetchDispatches } from '../api';

// Live feed over EventSource. Connects when `enabled` (i.e. unlocked + showing the feed). On a
// reconnect AFTER the first open, it backfills any cards AND dispatches missed while disconnected
// (since each slice's own cursor). EventSource auto-reconnects on error, so there's nothing to do
// on error but let it.
export function useSSE(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let connectedOnce = false;
    const es = new EventSource('/api/stream', { withCredentials: true });

    const onOpen = async () => {
      if (connectedOnce) {
        const cursor = useFeed.getState().newestCursor;
        const res = await fetchCards(cursor);
        if (res.status === 'ok') res.cards.forEach((c) => useFeed.getState().upsert(c));
        const dispatchCursor = useFeed.getState().newestDispatchCursor;
        const dres = await fetchDispatches(dispatchCursor);
        if (dres.status === 'ok') dres.dispatches.forEach((d) => useFeed.getState().upsertDispatch(d));
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
        if (id) useFeed.getState().remove(id);
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

    es.addEventListener('open', onOpen);
    es.addEventListener('card-created', onCreated);
    es.addEventListener('card-updated', onUpdated);
    es.addEventListener('card-removed', onRemoved);
    es.addEventListener('dispatch-updated', onDispatchUpdated);

    return () => {
      es.close();
    };
  }, [enabled]);
}
