import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { TopBar } from './TopBar';

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

// SessionsPanel fetches on drawer open only; the module still imports api at load time, so stub it.
vi.mock('../api', () => ({
  fetchSessions: vi.fn(),
  cancelDispatch: vi.fn(),
}));

afterEach(cleanup);

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
        onFollowUp={vi.fn()}
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
