import { create } from 'zustand';
import type { Card, CardEvent, CardResponse, Dispatch } from '../types';

// --- card status predicates (cards-v2) --------------------------------------
// Pure functions (unit-tested in feed.test.ts) — take an explicit `nowMs` so callers drive
// re-evaluation from their own ticker (Feed.tsx's 60s interval) and tests stay deterministic.

// Agent poll waits are ~50s loops, so a >3-minute gap since the last long-poll means nobody is
// waiting on the card anymore. A card that was NEVER polled gets a longer 10-minute grace from
// creation (the agent may still be between create and first poll).
export const AGENT_POLL_STALE_MS = 3 * 60_000;
export const AGENT_UNPOLLED_STALE_MS = 10 * 60_000;

// Server timestamps are toISOString (trailing Z); older rows may be naive UTC (no Z) — same
// normalization as utils/markdown.ts's timeAgo.
export function parseServerDate(iso: string): number {
  return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
}

// Client-side expiry (belt-and-braces alongside the server sweep + card-removed broadcast): a card
// whose expires_at has passed should vanish from the feed even if no SSE event arrives.
export function isCardExpired(card: Pick<Card, 'expires_at'>, nowMs: number): boolean {
  if (!card.expires_at) return false;
  const t = parseServerDate(card.expires_at);
  return Number.isFinite(t) && t <= nowMs;
}

// "Agent probably stopped listening": pending + actionable, and either the poll heartbeat went
// quiet (>3min since last_poll_at) or no poll ever arrived within 10min of creation.
export function isAgentStale(
  card: Pick<Card, 'status' | 'kind' | 'expects_response' | 'last_poll_at' | 'created_at'>,
  nowMs: number,
): boolean {
  if (card.status !== 'pending') return false;
  const actionable =
    card.kind === 'approval' || card.kind === 'choice' || card.kind === 'prompt' || !!card.expects_response;
  if (!actionable) return false;
  if (card.last_poll_at) {
    const t = parseServerDate(card.last_poll_at);
    return Number.isFinite(t) && nowMs - t > AGENT_POLL_STALE_MS;
  }
  const created = parseServerDate(card.created_at);
  return Number.isFinite(created) && nowMs - created > AGENT_UNPOLLED_STALE_MS;
}

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
  // Review fix: "has an entry in `events`" and "has done a REAL fetchCardEvents() hydration" are
  // NOT the same thing — appendEvent (an SSE 'card-event' broadcast, or an optimistic local post)
  // can seed events[cardId] with a single message before Thread.tsx ever mounts for that card
  // (cold app start, SSE reconnect while a pending card already has multi-message history).
  // loadedEventCardIds is set ONLY by setEvents (a completed full fetch), so Thread.tsx can gate
  // its one-time hydration fetch on "did we ever actually fetch the whole thread", not on "is the
  // slice merely non-empty" — otherwise a single live-delivered event permanently skips the fetch
  // and the rest of the thread's history is silently lost from view.
  loadedEventCardIds: Set<string>;
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
  // yet so the message isn't dropped — but does NOT mark the card as "loaded" (see
  // loadedEventCardIds above): a card whose thread has real prior history still needs its one real
  // fetchCardEvents() the first time Thread.tsx renders it, even if a live event beat that fetch.
  appendEvent: (cardId: string, event: CardEvent) => void;
  clear: () => void;
}

export const useFeed = create<FeedState>((set) => ({
  cards: [],
  dispatches: [],
  events: {},
  loadedEventCardIds: new Set<string>(),
  newestCursor: null,
  newestDispatchCursor: null,
  flashIds: new Set<string>(),

  // Insert-or-replace by id, keeping the list newest-first. Note: an SSE card-updated for a card
  // whose editable-draft editor is open does NOT wipe the editor — the editor seeds its content
  // once on mount and never re-reads card.body, so replacing the card object here is safe.
  upsert: (card, opts) =>
    set((s) => {
      // A respond is one-shot server-side (respondCard conflicts on a second attempt), so a
      // 'pending' copy arriving after we've already marked the card responded can only be a STALE
      // snapshot (a fullResync/backfill GET captured before the respond) racing the card-updated
      // echo — keep the resolved status/response, take the incoming row's other fields.
      const existing = s.cards.find((c) => c.id === card.id);
      if (existing?.status === 'responded' && card.status === 'pending') {
        card = { ...card, status: 'responded', response: existing.response };
      }
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

  // Review fix: MERGE with whatever's already in the slice instead of blindly replacing it. A full
  // fetchCardEvents() (Thread.tsx's initial hydration, or useSSE.ts's reconnect backfill) can land
  // AFTER an SSE 'card-event' broadcast already appended a newer event via appendEvent for the same
  // card — a plain replace would silently drop that concurrently-arrived event. Dedupe by seq
  // (a seq present in both is the same event either way) and keep the union.
  setEvents: (cardId, events) =>
    set((s) => {
      const bySeq = new Map<number, CardEvent>();
      for (const e of events) bySeq.set(e.seq, e);
      for (const e of s.events[cardId] ?? []) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      const loadedEventCardIds = new Set(s.loadedEventCardIds);
      loadedEventCardIds.add(cardId);
      return { events: { ...s.events, [cardId]: merged }, loadedEventCardIds };
    }),

  appendEvent: (cardId, event) =>
    set((s) => {
      const existing = s.events[cardId] ?? [];
      if (existing.some((e) => e.seq === event.seq)) return {} as Partial<FeedState>; // de-dupe
      const merged = [...existing, event].sort((a, b) => a.seq - b.seq);
      return { events: { ...s.events, [cardId]: merged } };
    }),

  clear: () =>
    set({
      cards: [],
      dispatches: [],
      events: {},
      loadedEventCardIds: new Set<string>(),
      newestCursor: null,
      newestDispatchCursor: null,
      flashIds: new Set<string>(),
    }),
}));
