import { create } from 'zustand';
import type { Card, CardEvent, CardResponse, Dispatch } from '../types';

// Sort newest-first by created_at (ISO strings compare lexicographically for the same format).
// Generic over Card|Dispatch — both shapes carry a plain `created_at` ISO string.
function sortDesc<T extends { created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

interface FeedState {
  cards: Card[]; // newest-first
  // Dispatch slice (Plan 02): a separate keyed list from cards, updated by the dispatch-updated
  // SSE event (see useSSE.ts) and by the Compose/DispatchItem components' own API responses. Kept
  // apart from `cards` rather than merged in because a dispatch and its eventual result CARD are
  // two distinct rows the server never conflates — Feed.tsx interleaves them for display only.
  dispatches: Dispatch[]; // newest-first
  // Card threads (Plan 04): a card's card_events, KEYED BY CARD ID, populated lazily by Thread.tsx
  // (a fetchCardEvents() call) rather than embedded on the Card object itself — Plan 00's gotcha
  // that listCards()/getCard's feed payload must never carry the full thread just to show a badge.
  // Absent key = "never loaded this card's thread"; Thread.tsx is what decides when to load it.
  events: Record<string, CardEvent[]>;
  newestCursor: string | null;
  newestDispatchCursor: string | null;
  flashIds: Set<string>;
  upsert: (card: Card, opts?: { flash?: boolean }) => void;
  upsertDispatch: (dispatch: Dispatch) => void;
  applyResolved: (id: string, response: CardResponse) => void;
  remove: (id: string) => void;
  clearFlash: (id: string) => void;
  // Full replace of a card's thread — the result of a fetchCardEvents() GET (Thread.tsx's initial
  // hydration). Always sorted ascending by seq (the server already returns them that way).
  setEvents: (cardId: string, events: CardEvent[]) => void;
  // Merge one new event into a card's thread — used by both the composer's own post (so the
  // sender sees their message immediately, without waiting for the SSE echo) and the SSE
  // 'card-event' broadcast (so OTHER open tabs/devices see it live). De-duped by seq so the two
  // paths landing for the same event is harmless. Initializes the slice to [] if it wasn't loaded
  // yet — safe because the only way to append BEFORE a load is posting the card's first-ever
  // message, so "previously unloaded" and "previously empty" are the same state in that case.
  appendEvent: (cardId: string, event: CardEvent) => void;
  clear: () => void;
}

export const useFeed = create<FeedState>((set) => ({
  cards: [],
  dispatches: [],
  events: {},
  newestCursor: null,
  newestDispatchCursor: null,
  flashIds: new Set<string>(),

  // Insert-or-replace by id, keeping the list newest-first. Note: an SSE card-updated for a card
  // whose editable-draft editor is open does NOT wipe the editor — the editor seeds its content
  // once on mount and never re-reads card.body, so replacing the card object here is safe.
  upsert: (card, opts) =>
    set((s) => {
      const without = s.cards.filter((c) => c.id !== card.id);
      const cards = sortDesc([...without, card]);
      const newestCursor =
        card.created_at && (!s.newestCursor || card.created_at > s.newestCursor) ? card.created_at : s.newestCursor;
      let flashIds = s.flashIds;
      if (opts?.flash) {
        flashIds = new Set(s.flashIds);
        flashIds.add(card.id);
      }
      return { cards, newestCursor, flashIds };
    }),

  // Insert-or-replace a dispatch by id, keeping newest-first — the exact same shape as `upsert`
  // above, mirroring dispatch-updated SSE payloads (server.ts's routes-dispatch.ts broadcasts the
  // full row on every transition, so a plain replace is always correct — no partial-patch logic).
  upsertDispatch: (dispatch) =>
    set((s) => {
      const without = s.dispatches.filter((d) => d.id !== dispatch.id);
      const dispatches = sortDesc([...without, dispatch]);
      const newestDispatchCursor =
        dispatch.created_at && (!s.newestDispatchCursor || dispatch.created_at > s.newestDispatchCursor)
          ? dispatch.created_at
          : s.newestDispatchCursor;
      return { dispatches, newestDispatchCursor };
    }),

  applyResolved: (id, response) =>
    set((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'responded' as const, response } : c)),
    })),

  // Drop a card from the feed (dismissed or expired). Also clears any pending flash for it.
  remove: (id) =>
    set((s) => {
      if (!s.cards.some((c) => c.id === id)) return {} as Partial<FeedState>;
      let flashIds = s.flashIds;
      if (s.flashIds.has(id)) {
        flashIds = new Set(s.flashIds);
        flashIds.delete(id);
      }
      return { cards: s.cards.filter((c) => c.id !== id), flashIds };
    }),

  clearFlash: (id) =>
    set((s) => {
      if (!s.flashIds.has(id)) return {} as Partial<FeedState>;
      const flashIds = new Set(s.flashIds);
      flashIds.delete(id);
      return { flashIds };
    }),

  setEvents: (cardId, events) =>
    set((s) => ({ events: { ...s.events, [cardId]: [...events].sort((a, b) => a.seq - b.seq) } })),

  appendEvent: (cardId, event) =>
    set((s) => {
      const existing = s.events[cardId] ?? [];
      if (existing.some((e) => e.seq === event.seq)) return {} as Partial<FeedState>; // de-dupe
      const merged = [...existing, event].sort((a, b) => a.seq - b.seq);
      return { events: { ...s.events, [cardId]: merged } };
    }),

  clear: () => set({ cards: [], dispatches: [], events: {}, newestCursor: null, newestDispatchCursor: null, flashIds: new Set<string>() }),
}));
