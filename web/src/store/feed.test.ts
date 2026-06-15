import { describe, it, expect, beforeEach } from 'vitest';
import { useFeed } from './feed';
import type { Card } from '../types';

function card(id: string, created_at: string, extra: Partial<Card> = {}): Card {
  return { id, title: 't' + id, kind: 'note', status: 'pending', created_at, ...extra };
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
});
