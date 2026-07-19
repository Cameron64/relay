import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { CardView } from './CardView';
import { useFeed } from '../store/feed';
import { respond } from '../api';
import type { Card } from '../types';

// Heavy leaf renderers are irrelevant to the response-chain logic under test — stub them so the
// suite doesn't drag in mermaid / TipTap / react-markdown / iframe plumbing.
vi.mock('./cards/Mermaid', () => ({ Mermaid: () => null }));
vi.mock('./cards/EditableDraft', () => ({ EditableDraft: () => null }));
vi.mock('./cards/PageFrame', () => ({ PageFrame: () => <div data-testid="page-frame" /> }));
vi.mock('./cards/Thread', () => ({ Thread: () => null }));
vi.mock('./cards/ImageAssets', () => ({ ImageAssets: () => null }));
vi.mock('./cards/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));

vi.mock('../api', () => ({
  respond: vi.fn(),
  dismiss: vi.fn(),
  postCardEvent: vi.fn(),
  fetchCardEvents: vi.fn(),
  assetUrl: vi.fn(() => ''),
  responseAssetUrl: vi.fn(() => ''),
}));

afterEach(cleanup);
beforeEach(() => {
  useFeed.getState().clear();
  vi.mocked(respond).mockReset();
});

const NOW = Date.parse('2026-07-19T12:00:00Z');
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function baseCard(over: Partial<Card> = {}): Card {
  return {
    id: 'c1',
    title: 'A note',
    kind: 'note',
    body: 'hello',
    status: 'pending',
    created_at: minsAgo(1),
    ...over,
  };
}

function renderCard(card: Card) {
  return render(
    <MantineProvider>
      <CardView card={card} nowMs={NOW} />
    </MantineProvider>,
  );
}

describe('CardView — fallback reply affordance (Feature 1)', () => {
  test('a pending buttonless note gets the collapsed Reply affordance', () => {
    renderCard(baseCard());
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  test('a responded card gets NO Reply affordance (resolved banner instead)', () => {
    renderCard(baseCard({ status: 'responded', response: { verdict: 'reply', note: 'done' } }));
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
    expect(screen.getByText('↩ Replied')).toBeInTheDocument();
  });

  test('a pending card WITH buttons keeps Actions — no fallback', () => {
    renderCard(baseCard({ kind: 'approval', buttons: [{ id: 'ok', label: 'Approve', behavior: 'respond' }] }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
  });

  test('an approval WITHOUT buttons falls back to Reply', () => {
    renderCard(baseCard({ kind: 'approval', buttons: [] }));
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  test('a pending page card gets the fallback under the iframe', () => {
    renderCard(baseCard({ kind: 'page', page_html: '<!doctype html><p>hi</p>', body: null }));
    expect(screen.getByTestId('page-frame')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
  });

  test('expanding and sending calls the existing respond endpoint with action "reply" and the text in note', async () => {
    vi.mocked(respond).mockResolvedValue({ status: 'ok', response: { verdict: 'reply', note: 'my answer' } });
    useFeed.getState().upsert(baseCard());
    renderCard(baseCard());

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByPlaceholderText('Type your reply…'), { target: { value: 'my answer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(respond).toHaveBeenCalledWith('c1', 'reply', 'my answer'));
    // The store card resolves exactly like a PromptReply send.
    expect(useFeed.getState().cards[0].status).toBe('responded');
    expect(useFeed.getState().cards[0].response?.verdict).toBe('reply');
  });
});

describe('CardView — resolved state (Feature 2 / task E)', () => {
  test('status responded with a NULL response still reads as resolved (generic banner, no composer)', () => {
    renderCard(baseCard({ kind: 'prompt', status: 'responded', response: null }));
    expect(screen.getByText('• answered')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type your reply…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
  });

  test('a responded choice renders the ResolvedBanner too', () => {
    renderCard(
      baseCard({
        kind: 'choice',
        options: [{ id: 'a', label: 'Option A' }],
        status: 'responded',
        response: { verdict: 'a', note: null },
      }),
    );
    expect(screen.getByText('• a')).toBeInTheDocument();
  });
});

describe('CardView — agent-staleness hint (Feature 2b)', () => {
  test('a pending actionable card with a stale poll heartbeat shows the hint with relative time', () => {
    renderCard(baseCard({ kind: 'prompt', created_at: minsAgo(30), last_poll_at: minsAgo(5) }));
    expect(screen.getByText(/Agent may no longer be listening/)).toBeInTheDocument();
    // Reply affordance keeps working — the prompt composer is still there.
    expect(screen.getByPlaceholderText('Type your reply…')).toBeInTheDocument();
  });

  test('a recently-polled card shows no hint', () => {
    renderCard(baseCard({ kind: 'prompt', created_at: minsAgo(30), last_poll_at: minsAgo(1) }));
    expect(screen.queryByText(/Agent may no longer be listening/)).not.toBeInTheDocument();
  });

  test('a non-actionable note never shows the hint', () => {
    renderCard(baseCard({ created_at: minsAgo(30) }));
    expect(screen.queryByText(/Agent may no longer be listening/)).not.toBeInTheDocument();
  });
});
