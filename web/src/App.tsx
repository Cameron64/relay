import { useCallback, useEffect, useState } from 'react';
import { Box, Center, Container, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { TopBar } from './components/TopBar';
import { UnlockScreen } from './components/UnlockScreen';
import { Feed } from './components/Feed';
import { Compose } from './components/Compose';
import { useSSE } from './hooks/useSSE';
import { useFeed } from './store/feed';
import { fetchCards, fetchDispatches } from './api';
import type { Dispatch } from './types';

type View = 'loading' | 'unlock' | 'feed';

export function App() {
  const [view, setView] = useState<View>('loading');
  const clear = useFeed((s) => s.clear);

  // Compose modal state, lifted here so both TopBar's "+" (fresh dispatch) and a DispatchItem's
  // Follow-up button (resumeOf + the parent's target locked — see DispatchItem.tsx) can open it.
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeResumeOf, setComposeResumeOf] = useState<string | null>(null);
  const [composeLockedTarget, setComposeLockedTarget] = useState<string | null>(null);

  const openCompose = useCallback(() => {
    setComposeResumeOf(null);
    setComposeLockedTarget(null);
    setComposeOpen(true);
  }, []);

  const openFollowUp = useCallback((d: Dispatch) => {
    setComposeResumeOf(d.id);
    setComposeLockedTarget(d.target);
    setComposeOpen(true);
  }, []);

  // GET /api/cards: 200 -> populate + feed; 401/error -> unlock; 503 -> feed (warming, SSE backfills).
  // Dispatches are fetched best-effort alongside — a warming/error dispatch fetch never blocks the
  // card feed from showing (the SSE backfill on the first successful stream reconnect catches up).
  const bootstrap = useCallback(async () => {
    const r = await fetchCards();
    if (r.status === 'ok') {
      r.cards.forEach((c) => useFeed.getState().upsert(c));
      localStorage.setItem('relay_unlocked', '1');
      setView('feed');
      const dr = await fetchDispatches();
      if (dr.status === 'ok') dr.dispatches.forEach((d) => useFeed.getState().upsertDispatch(d));
      return;
    }
    if (r.status === 'warming') {
      notifications.show({ message: 'Server storage warming up…' });
      setView('feed');
      return;
    }
    setView('unlock');
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useSSE(view === 'feed');

  const onLock = () => {
    // The session cookie is httpOnly (can't be cleared from JS) — forget locally and show unlock;
    // the cookie expires server-side.
    localStorage.removeItem('relay_unlocked');
    clear();
    setView('unlock');
  };

  return (
    <>
      <Box
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          borderBottom: '1px solid var(--mantine-color-default-border)',
          background: 'var(--mantine-color-body)',
        }}
      >
        <TopBar showLock={view === 'feed'} onLock={onLock} onCompose={view === 'feed' ? openCompose : undefined} />
      </Box>
      <Container size="sm" py="md">
        {view === 'loading' ? (
          <Center mih="50vh">
            <Loader />
          </Center>
        ) : view === 'unlock' ? (
          <UnlockScreen onUnlocked={bootstrap} />
        ) : (
          <Feed onFollowUp={openFollowUp} />
        )}
      </Container>
      <Compose opened={composeOpen} onClose={() => setComposeOpen(false)} resumeOf={composeResumeOf} lockedTarget={composeLockedTarget} />
    </>
  );
}
