import { describe, it, expect, beforeEach } from 'vitest';
import { useFeed, isCardExpired, isAgentStale } from './feed';
import type { Card, CardEvent, Dispatch } from '../types';

function event(cardId: string, seq: number, extra: Partial<CardEvent> = {}): CardEvent {
  return { card_id: cardId, seq, role: 'agent', type: 'message', body: 'm' + seq, at: 't' + seq, ...extra };
}

function card(id: string, created_at: string, extra: Partial<Card> = {}): Card {
  return { id, title: 't' + id, kind: 'note', status: 'pending', created_at, ...extra };
}

function dispatch(id: string, created_at: string, extra: Partial<Dispatch> = {}): Dispatch {
  return {
    id,
    created_at,
    title: 't' + id,
    body: 'body',
    target: 'notes',
    status: 'queued',
    runner_host: null,
    claimed_at: null,
    finished_at: null,
    resume_of: null,
    claude_session: null,
    result_summary: null,
    result_card_id: null,
    ...extra,
  };
}

describe('feed store', () => {
  beforeEach(() => useFeed.getState().clear());

  it('keeps cards newest-first', () => {
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z'));
    useFeed.getState().upsert(card('b', '2026-06-14T11:00:00Z'));
    useFeed.getState().upsert(card('c', '2026-06-14T09:00:00Z'));
    expect(useFeed.getState().cards.map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it('replaces by id without duplicating', () => {
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z', { title: 'old' }));
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z', { title: 'new' }));
    expect(useFeed.getState().cards).toHaveLength(1);
    expect(useFeed.getState().cards[0].title).toBe('new');
  });

  it('tracks newestCursor as the max created_at', () => {
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z'));
    useFeed.getState().upsert(card('b', '2026-06-14T11:00:00Z'));
    useFeed.getState().upsert(card('c', '2026-06-14T09:00:00Z'));
    expect(useFeed.getState().newestCursor).toBe('2026-06-14T11:00:00Z');
  });

  it('applyResolved marks the card responded', () => {
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z', { kind: 'approval' }));
    useFeed.getState().applyResolved('a', { verdict: 'approved' });
    expect(useFeed.getState().cards[0].status).toBe('responded');
    expect(useFeed.getState().cards[0].response?.verdict).toBe('approved');
  });

  it('upsert never downgrades a responded card back to pending (stale resync snapshot losing the race)', () => {
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z', { kind: 'approval' }));
    useFeed.getState().applyResolved('a', { verdict: 'approved' });
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z', { kind: 'approval', status: 'pending', title: 'fresh' }));
    const c = useFeed.getState().cards[0];
    expect(c.status).toBe('responded');
    expect(c.response?.verdict).toBe('approved');
    expect(c.title).toBe('fresh'); // non-status fields still take the newer row
  });

  it('flash opt-in adds then clears flashIds', () => {
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z'), { flash: true });
    expect(useFeed.getState().flashIds.has('a')).toBe(true);
    useFeed.getState().clearFlash('a');
    expect(useFeed.getState().flashIds.has('a')).toBe(false);
  });

  it('remove drops a card and clears its flash', () => {
    useFeed.getState().upsert(card('a', '2026-06-14T10:00:00Z'), { flash: true });
    useFeed.getState().upsert(card('b', '2026-06-14T11:00:00Z'));
    useFeed.getState().remove('a');
    expect(useFeed.getState().cards.map((c) => c.id)).toEqual(['b']);
    expect(useFeed.getState().flashIds.has('a')).toBe(false);
  });

  // Plan 02 acceptance: "Feed store test: dispatch slice upsert via SSE event" — upsertDispatch is
  // the exact handler useSSE.ts wires to the 'dispatch-updated' event.
  describe('dispatch slice', () => {
    it('keeps dispatches newest-first, independent of the cards list', () => {
      useFeed.getState().upsert(card('c1', '2026-06-14T09:00:00Z'));
      useFeed.getState().upsertDispatch(dispatch('a', '2026-06-14T10:00:00Z'));
      useFeed.getState().upsertDispatch(dispatch('b', '2026-06-14T11:00:00Z'));
      expect(useFeed.getState().dispatches.map((d) => d.id)).toEqual(['b', 'a']);
      expect(useFeed.getState().cards.map((c) => c.id)).toEqual(['c1']);
    });

    it('replaces by id without duplicating (e.g. queued -> claimed -> running -> done)', () => {
      useFeed.getState().upsertDispatch(dispatch('a', '2026-06-14T10:00:00Z', { status: 'queued' }));
      useFeed.getState().upsertDispatch(dispatch('a', '2026-06-14T10:00:00Z', { status: 'claimed', runner_host: 'cam-desktop' }));
      useFeed.getState().upsertDispatch(dispatch('a', '2026-06-14T10:00:00Z', { status: 'done', result_summary: 'did the thing' }));
      expect(useFeed.getState().dispatches).toHaveLength(1);
      expect(useFeed.getState().dispatches[0].status).toBe('done');
      expect(useFeed.getState().dispatches[0].result_summary).toBe('did the thing');
    });

    it('tracks newestDispatchCursor as the max created_at', () => {
      useFeed.getState().upsertDispatch(dispatch('a', '2026-06-14T10:00:00Z'));
      useFeed.getState().upsertDispatch(dispatch('b', '2026-06-14T11:00:00Z'));
      expect(useFeed.getState().newestDispatchCursor).toBe('2026-06-14T11:00:00Z');
    });

    it('clear() resets both the card and dispatch slices', () => {
      useFeed.getState().upsert(card('c1', '2026-06-14T09:00:00Z'));
      useFeed.getState().upsertDispatch(dispatch('a', '2026-06-14T10:00:00Z'));
      useFeed.getState().clear();
      expect(useFeed.getState().cards).toHaveLength(0);
      expect(useFeed.getState().dispatches).toHaveLength(0);
      expect(useFeed.getState().newestDispatchCursor).toBeNull();
    });
  });

  // relay-roadmap Plan 04 — card threads: events are a SEPARATE keyed slice (never embedded on
  // the Card object), populated lazily by Thread.tsx and kept live via the SSE 'card-event'
  // broadcast (see useSSE.ts's onCardEvent -> appendEvent wiring).
  describe('events slice (Plan 04)', () => {
    it('setEvents replaces a card thread, sorted ascending by seq', () => {
      useFeed.getState().setEvents('c1', [event('c1', 2), event('c1', 1)]);
      expect(useFeed.getState().events.c1.map((e) => e.seq)).toEqual([1, 2]);
    });

    it('appendEvent merges a new event into an existing thread', () => {
      useFeed.getState().setEvents('c1', [event('c1', 1)]);
      useFeed.getState().appendEvent('c1', event('c1', 2));
      expect(useFeed.getState().events.c1.map((e) => e.seq)).toEqual([1, 2]);
    });

    it('appendEvent de-dupes by seq (the composer\'s own post + the SSE echo landing for the same event)', () => {
      useFeed.getState().setEvents('c1', [event('c1', 1)]);
      useFeed.getState().appendEvent('c1', event('c1', 2, { body: 'first' }));
      useFeed.getState().appendEvent('c1', event('c1', 2, { body: 'duplicate echo' })); // same seq, ignored
      expect(useFeed.getState().events.c1).toHaveLength(2);
      expect(useFeed.getState().events.c1[1].body).toBe('first');
    });

    it('appendEvent initializes an unloaded card thread rather than dropping the message', () => {
      expect(useFeed.getState().events.c2).toBeUndefined();
      useFeed.getState().appendEvent('c2', event('c2', 1));
      expect(useFeed.getState().events.c2.map((e) => e.seq)).toEqual([1]);
    });

    it('other cards\' threads are untouched', () => {
      useFeed.getState().setEvents('c1', [event('c1', 1)]);
      useFeed.getState().appendEvent('c2', event('c2', 1));
      expect(useFeed.getState().events.c1).toHaveLength(1);
      expect(useFeed.getState().events.c2).toHaveLength(1);
    });

    it('clear() resets the events slice too', () => {
      useFeed.getState().setEvents('c1', [event('c1', 1)]);
      useFeed.getState().clear();
      expect(useFeed.getState().events).toEqual({});
    });

    // Review fix: distinguish "fully hydrated via a real fetchCardEvents()" from "has some
    // entries" — appendEvent alone must never make Thread.tsx skip its one-time full fetch.
    describe('loadedEventCardIds (review fix)', () => {
      it('setEvents marks the card as fully loaded', () => {
        expect(useFeed.getState().loadedEventCardIds.has('c1')).toBe(false);
        useFeed.getState().setEvents('c1', [event('c1', 1)]);
        expect(useFeed.getState().loadedEventCardIds.has('c1')).toBe(true);
      });

      it('appendEvent alone does NOT mark the card as fully loaded', () => {
        useFeed.getState().appendEvent('c1', event('c1', 1));
        expect(useFeed.getState().events.c1).toHaveLength(1); // visible immediately
        expect(useFeed.getState().loadedEventCardIds.has('c1')).toBe(false); // but not "hydrated"
      });

      it('clear() resets loadedEventCardIds too', () => {
        useFeed.getState().setEvents('c1', [event('c1', 1)]);
        useFeed.getState().clear();
        expect(useFeed.getState().loadedEventCardIds.has('c1')).toBe(false);
      });

      // Review fix: setEvents (a completed fetchCardEvents()) must MERGE with, not clobber, an
      // event that arrived via appendEvent (an SSE 'card-event' broadcast) while that fetch was
      // still in flight — otherwise the concurrently-arrived event is silently dropped.
      it('setEvents merges with events already appended live during the fetch, instead of dropping them', () => {
        useFeed.getState().appendEvent('c1', event('c1', 2)); // arrives via SSE mid-fetch
        useFeed.getState().setEvents('c1', [event('c1', 1)]); // the fetch's own (now-stale) snapshot
        expect(useFeed.getState().events.c1.map((e) => e.seq)).toEqual([1, 2]);
      });
    });
  });
});

// --- cards-v2: pure card-status predicates ----------------------------------

const NOW = Date.parse('2026-07-19T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const minsAhead = (m: number) => new Date(NOW + m * 60_000).toISOString();

describe('isCardExpired', () => {
  it('is false when expires_at is null/absent', () => {
    expect(isCardExpired({ expires_at: null }, NOW)).toBe(false);
    expect(isCardExpired({}, NOW)).toBe(false);
  });

  it('is true once expires_at has passed, false before', () => {
    expect(isCardExpired({ expires_at: minsAgo(1) }, NOW)).toBe(true);
    expect(isCardExpired({ expires_at: minsAhead(1) }, NOW)).toBe(false);
  });

  it('handles naive-UTC timestamps (no trailing Z) like timeAgo does', () => {
    const naive = minsAgo(5).replace('T', ' ').replace(/\.\d+Z$/, ''); // "YYYY-MM-DD HH:MM:SS"
    expect(isCardExpired({ expires_at: naive }, NOW)).toBe(true);
  });

  it('is false for an unparseable expires_at (never hide a card on garbage data)', () => {
    expect(isCardExpired({ expires_at: 'not-a-date' }, NOW)).toBe(false);
  });
});

describe('isAgentStale', () => {
  const base = (extra: Partial<Card>): Card => card('s1', minsAgo(60), { kind: 'approval', ...extra });

  it('is false for non-pending cards, regardless of poll age', () => {
    expect(isAgentStale(base({ status: 'responded', last_poll_at: minsAgo(30) }), NOW)).toBe(false);
    expect(isAgentStale(base({ status: 'dismissed', last_poll_at: minsAgo(30) }), NOW)).toBe(false);
  });

  it('is false for non-actionable kinds without expects_response', () => {
    expect(isAgentStale(card('n1', minsAgo(60), { kind: 'note', last_poll_at: minsAgo(30) }), NOW)).toBe(false);
  });

  it('expects_response makes any kind actionable', () => {
    expect(isAgentStale(card('n1', minsAgo(60), { kind: 'note', expects_response: true, last_poll_at: minsAgo(30) }), NOW)).toBe(true);
  });

  it('polled recently (<3min): fresh; polled >3min ago: stale', () => {
    for (const kind of ['approval', 'choice', 'prompt'] as const) {
      expect(isAgentStale(card('k', minsAgo(60), { kind, last_poll_at: minsAgo(2) }), NOW)).toBe(false);
      expect(isAgentStale(card('k', minsAgo(60), { kind, last_poll_at: minsAgo(4) }), NOW)).toBe(true);
    }
  });

  it('never polled: fresh within 10min of creation, stale after', () => {
    expect(isAgentStale(card('k', minsAgo(5), { kind: 'prompt', last_poll_at: null }), NOW)).toBe(false);
    expect(isAgentStale(card('k', minsAgo(11), { kind: 'prompt' }), NOW)).toBe(true);
  });
});
