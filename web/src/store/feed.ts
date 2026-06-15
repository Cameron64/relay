import { create } from 'zustand';
import type { Card, CardResponse } from '../types';

// Sort newest-first by created_at (ISO strings compare lexicographically for the same format).
function sortDesc(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

interface FeedState {
  cards: Card[]; // newest-first
  newestCursor: string | null;
  flashIds: Set<string>;
  upsert: (card: Card, opts?: { flash?: boolean }) => void;
  applyResolved: (id: string, response: CardResponse) => void;
  remove: (id: string) => void;
  clearFlash: (id: string) => void;
  clear: () => void;
}

export const useFeed = create<FeedState>((set) => ({
  cards: [],
  newestCursor: null,
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

  clear: () => set({ cards: [], newestCursor: null, flashIds: new Set<string>() }),
}));
