import { useCallback, useEffect, useState } from 'react';
import { Box, Center, Container, Loader } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { TopBar } from './components/TopBar';
import { UnlockScreen } from './components/UnlockScreen';
import { Feed } from './components/Feed';
import { useSSE } from './hooks/useSSE';
import { useFeed } from './store/feed';
import { fetchCards } from './api';

type View = 'loading' | 'unlock' | 'feed';

export function App() {
  const [view, setView] = useState<View>('loading');
  const clear = useFeed((s) => s.clear);

  // GET /api/cards: 200 -> populate + feed; 401/error -> unlock; 503 -> feed (warming, SSE backfills).
  const bootstrap = useCallback(async () => {
    const r = await fetchCards();
    if (r.status === 'ok') {
      r.cards.forEach((c) => useFeed.getState().upsert(c));
      localStorage.setItem('relay_unlocked', '1');
      setView('feed');
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
        <TopBar showLock={view === 'feed'} onLock={onLock} />
      </Box>
      <Container size="sm" py="md">
        {view === 'loading' ? (
          <Center mih="50vh">
            <Loader />
          </Center>
        ) : view === 'unlock' ? (
          <UnlockScreen onUnlocked={bootstrap} />
        ) : (
          <Feed />
        )}
      </Container>
    </>
  );
}
