import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MantineProvider } from '@mantine/core';
import { TopBar } from './TopBar';
import { SessionsPanel } from './SessionsPanel';

// usePush touches serviceWorker/PushManager/Notification, none of which jsdom implements — mock it
// to a stable "supported, enabled" shape so the bar renders its notification control deterministically.
vi.mock('../hooks/usePush', () => ({
  usePush: () => ({
    supported: true,
    enabled: true,
    busy: false,
    status: '',
    disabled: false,
    toggle: vi.fn(),
  }),
}));

// SessionsPanel fetches on drawer open; resolve to an empty-but-ok payload so the drawer settles
// into its empty state instead of rejecting.
vi.mock('../api', () => ({
  fetchSessions: vi.fn(async () => ({ status: 'ok', sessions: [] })),
  cancelDispatch: vi.fn(),
}));

afterEach(cleanup);

// jsdom has no ResizeObserver; Mantine's ScrollArea (used by the SessionsPanel drawer via
// scrollAreaComponent={ScrollArea.Autosize}) observes its viewport on mount. A no-op stub is enough.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  (window as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
}

// isMobile comes from useMediaQuery, which reads window.matchMedia. test-setup.ts installs a matcher
// that returns matches:false; per-test we override it to force the mobile branch.
function setMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderBar() {
  return render(
    <MantineProvider>
      <TopBar
        showLock
        onLock={vi.fn()}
        onCompose={vi.fn()}
        onOpenSessions={vi.fn()}
        onOpenActivity={vi.fn()}
      />
    </MantineProvider>,
  );
}

describe('TopBar — responsive layout', () => {
  beforeEach(() => setMatchMedia(false));

  test('wide viewport: the secondary controls sit directly on the bar (no overflow menu)', () => {
    setMatchMedia(false);
    renderBar();
    // Wide text buttons live on the bar itself…
    expect(screen.getByRole('button', { name: 'Lock' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notification history' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument();
    // …and there is no "More actions" overflow trigger.
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  test('narrow viewport: only brand + "+" + overflow menu are on the bar (nothing wide can spill)', () => {
    setMatchMedia(true);
    renderBar();
    // The primary compose action and the overflow trigger stay on the bar…
    expect(screen.getByRole('button', { name: 'New dispatch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    // …but the wide text buttons are NOT rendered on the bar — they've moved behind the menu, so
    // the bar can't overflow. (Menu.Dropdown is unmounted until opened.)
    expect(screen.queryByRole('button', { name: 'Lock' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Notification history' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeInTheDocument();
  });
});

// App.tsx-shaped harness: TopBar only signals "open sessions"; the drawer state and the single
// SessionsPanel instance live in the PARENT, outside the Menu. This mirrors the fix for the
// drawer flash-close bug — if the state ever moves back under Menu.Dropdown, the regression test
// below fails (the dropdown's unmount would destroy the drawer).
function SessionsHarness() {
  const [sessionsOpen, setSessionsOpen] = useState(false);
  return (
    <MantineProvider>
      <TopBar
        showLock
        onLock={vi.fn()}
        onCompose={vi.fn()}
        onOpenSessions={() => setSessionsOpen(true)}
        onOpenActivity={vi.fn()}
      />
      <SessionsPanel
        opened={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        onFollowUp={vi.fn()}
        onOpenActivity={vi.fn()}
      />
    </MantineProvider>
  );
}

describe('TopBar — sessions drawer survives the overflow menu closing (flash-close regression)', () => {
  beforeEach(() => setMatchMedia(true));

  test('mobile: tapping Sessions closes the menu (dropdown unmounts) but the drawer stays open', async () => {
    render(<SessionsHarness />);

    // Open the overflow menu and tap Sessions. The Menu.Item deliberately has no
    // closeMenuOnClick={false} — the menu is EXPECTED to close (and unmount its dropdown).
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = await screen.findByRole('menuitem', { name: 'Sessions' });
    fireEvent.click(item);

    // The drawer opens…
    const drawer = await screen.findByRole('dialog');
    expect(drawer).toBeInTheDocument();

    // …and the menu dropdown fully unmounts (the old bug's trigger)…
    await waitFor(() => {
      expect(screen.queryByRole('menuitem', { name: 'Sessions' })).not.toBeInTheDocument();
    });

    // …yet the drawer is STILL open, because its state lives in the parent, not under the menu.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByText('No sessions in the last 24 hours', { exact: false })).toBeInTheDocument();
  });
});
