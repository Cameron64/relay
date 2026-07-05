import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor, act } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { SandboxedPageIframe, PageFrame } from './PageFrame';
import { useFeed } from '../../store/feed';
import { postCardEvent, respond } from '../../api';
import type { Card } from '../../types';

vi.mock('../../api', () => ({
  postCardEvent: vi.fn(),
  respond: vi.fn(),
}));

afterEach(cleanup);
beforeEach(() => {
  useFeed.getState().clear();
  vi.mocked(postCardEvent).mockReset();
  vi.mocked(respond).mockReset();
});

// SECURITY REGRESSION GUARD — do not weaken. kind:'page' runs agent-authored JS, so the iframe must
// stay in an OPAQUE origin: agent code can never be allowed to reach the Relay session cookie, the
// write/UI tokens, the API, localStorage, the service worker, or the parent DOM. That requires
// sandbox="allow-scripts" with NONE of allow-same-origin / allow-top-navigation / allow-modals /
// allow-popups. If this test ever fails, the sandbox was widened — fix the component, not the test.
describe('SandboxedPageIframe — sandbox boundary', () => {
  test('sandbox is exactly "allow-scripts" and carries the html via srcdoc', () => {
    const html = '<!doctype html><p>hi</p>';
    const { container } = render(<SandboxedPageIframe pageHtml={html} title="Test page" />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();

    const sandbox = iframe!.getAttribute('sandbox'); // string compare — portable across jsdom/browser
    expect(sandbox).toBe('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-modals');
    expect(sandbox).not.toContain('allow-popups');

    expect(iframe!.getAttribute('srcdoc')).toBe(html);
    expect(iframe!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe!.getAttribute('title')).toBe('Test page');
  });
});

// --- Plan 05: the postMessage submit bridge --------------------------------

function baseCard(over: Partial<Card> = {}): Card {
  return {
    id: 'c1',
    title: 'Sliders',
    kind: 'page',
    status: 'pending',
    created_at: '2026-07-05T00:00:00Z',
    page_html: '<!doctype html><p>hi</p>',
    ...over,
  };
}

function renderPage(card: Card) {
  return render(
    <MantineProvider>
      <PageFrame card={card} />
    </MantineProvider>,
  );
}

// Dispatches a postMessage 'message' event on window, as the browser would when the sandboxed
// iframe calls window.parent.postMessage(...). `sourceOverride`, when passed, stands in for an
// attacker/unrelated frame — anything other than the rendered iframe's own contentWindow.
function postMessageFromFrame(container: HTMLElement, data: unknown, sourceOverride?: unknown) {
  const iframe = container.querySelector('iframe')!;
  const source = sourceOverride !== undefined ? sourceOverride : iframe.contentWindow;
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { value: source, configurable: true });
  // The handler synchronously calls setState (setSubmitState/setExpectsResponse) before its async
  // network calls even start — wrap the dispatch itself in act() so that first render commits
  // cleanly; the async tail is awaited separately via waitFor() in each test.
  act(() => {
    window.dispatchEvent(ev);
  });
}

describe('PageFrame — postMessage submit bridge', () => {
  test('a message from a source other than our iframe is ignored', async () => {
    const card = baseCard();
    const { container } = renderPage(card);
    postMessageFromFrame(container, { __relay: 'submit', payload: { a: 1 } }, window);
    await new Promise((r) => setTimeout(r, 0));
    expect(postCardEvent).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  test('a message with the wrong __relay shape is ignored', async () => {
    const card = baseCard();
    const { container } = renderPage(card);
    postMessageFromFrame(container, { foo: 'bar' });
    postMessageFromFrame(container, { __relay: 'nonsense' });
    postMessageFromFrame(container, 'not even an object');
    await new Promise((r) => setTimeout(r, 0));
    expect(postCardEvent).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  test('an oversize payload (>64KB serialized) is rejected client-side, no network call', async () => {
    const card = baseCard();
    const { container } = renderPage(card);
    const big = { blob: 'x'.repeat(70 * 1024) };
    postMessageFromFrame(container, { __relay: 'submit', payload: big });
    await new Promise((r) => setTimeout(r, 0));
    expect(postCardEvent).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  test('first submit wins: stores the payload event before responding, then ignores a second submit', async () => {
    const card = baseCard();
    const { container } = renderPage(card);
    const order: string[] = [];
    vi.mocked(postCardEvent).mockImplementation(async () => {
      order.push('event');
      return { status: 'ok', event: {} as any };
    });
    vi.mocked(respond).mockImplementation(async () => {
      order.push('respond');
      return { status: 'ok', response: { verdict: 'submit', note: null } };
    });

    postMessageFromFrame(container, { __relay: 'submit', payload: { a: 1 } });
    postMessageFromFrame(container, { __relay: 'submit', payload: { a: 2 } }); // second — ignored

    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(postCardEvent).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['event', 'respond']); // payload event lands BEFORE the verdict resolves
    expect(postCardEvent).toHaveBeenCalledWith('c1', 'payload', JSON.stringify({ a: 1 }));
    expect(respond).toHaveBeenCalledWith('c1', 'submit', null);

    await waitFor(() => expect(screen.getByText('Answer sent ✓')).toBeInTheDocument());
  });

  test('a 409 from respond (already answered elsewhere) shows the conflict state', async () => {
    const card = baseCard();
    const { container } = renderPage(card);
    vi.mocked(postCardEvent).mockResolvedValue({ status: 'ok', event: {} as any });
    vi.mocked(respond).mockResolvedValue({ status: 'conflict', response: { verdict: 'submit', note: null } });

    postMessageFromFrame(container, { __relay: 'submit', payload: { a: 1 } });

    await waitFor(() => expect(screen.getByText('Already answered')).toBeInTheDocument());
  });

  test('a network error on respond shows an error state (does not crash)', async () => {
    const card = baseCard();
    const { container } = renderPage(card);
    vi.mocked(postCardEvent).mockResolvedValue({ status: 'ok', event: {} as any });
    vi.mocked(respond).mockResolvedValue({ status: 'error' });

    postMessageFromFrame(container, { __relay: 'submit', payload: { a: 1 } });

    await waitFor(() => expect(screen.getByText('Could not send')).toBeInTheDocument());
  });

  test('the ready/expectsResponse handshake shows a "waiting for your input" banner while pending', async () => {
    const card = baseCard();
    const { container } = renderPage(card);
    expect(screen.queryByText('waiting for your input')).not.toBeInTheDocument();
    postMessageFromFrame(container, { __relay: 'ready', expectsResponse: true });
    await waitFor(() => expect(screen.getByText('waiting for your input')).toBeInTheDocument());
  });

  test('a card already flagged expects_response shows the banner without any runtime handshake', () => {
    renderPage(baseCard({ expects_response: true }));
    expect(screen.getByText('waiting for your input')).toBeInTheDocument();
  });

  test('a plain page (no expects_response, no ready handshake) shows no banner at all', () => {
    renderPage(baseCard());
    expect(screen.queryByText('waiting for your input')).not.toBeInTheDocument();
  });

  test('returns null (renders nothing) when the card has no page_html', () => {
    const { container } = renderPage(baseCard({ page_html: null }));
    expect(container.querySelector('iframe')).toBeNull();
  });
});
