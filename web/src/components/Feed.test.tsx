import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Feed } from './Feed';
import { useFeed } from '../store/feed';
import type { Card } from '../types';

// The feed's job under test is WHICH entries it renders, not how a card looks — stub the items.
vi.mock('./CardView', () => ({
  CardView: ({ card }: { card: Card }) => <div data-testid={'card-' + card.id} />,
}));
vi.mock('./DispatchItem', () => ({
  DispatchItem: () => <div data-testid="dispatch-item" />,
}));

afterEach(cleanup);
beforeEach(() => useFeed.getState().clear());

function card(id: string, extra: Partial<Card> = {}): Card {
  return { id, title: 't' + id, kind: 'note', status: 'pending', created_at: new Date().toISOString(), ...extra };
}

function renderFeed() {
  return render(
    <MantineProvider>
      <Feed onFollowUp={vi.fn()} />
    </MantineProvider>,
  );
}

describe('Feed — client-side expiry (Feature 2a)', () => {
  test('a card whose expires_at is in the past is filtered out; live cards stay', () => {
    useFeed.getState().upsert(card('live', { expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }));
    useFeed.getState().upsert(card('dead', { expires_at: new Date(Date.now() - 60_000).toISOString() }));
    renderFeed();
    expect(screen.getByTestId('card-live')).toBeInTheDocument();
    expect(screen.queryByTestId('card-dead')).not.toBeInTheDocument();
  });

  test('cards without expires_at are never filtered', () => {
    useFeed.getState().upsert(card('open', { expires_at: null }));
    renderFeed();
    expect(screen.getByTestId('card-open')).toBeInTheDocument();
  });

  test('when everything is expired, the empty state shows', () => {
    useFeed.getState().upsert(card('dead', { expires_at: new Date(Date.now() - 60_000).toISOString() }));
    renderFeed();
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });
});
