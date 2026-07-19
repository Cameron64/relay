import { useEffect, useMemo, useState } from 'react';
import { Stack, Text } from '@mantine/core';
import { useFeed, isCardExpired } from '../store/feed';
import { CardView } from './CardView';
import { DispatchItem } from './DispatchItem';
import type { Card, Dispatch } from '../types';

type Entry = { key: string; created_at: string; kind: 'card'; card: Card } | { key: string; created_at: string; kind: 'dispatch'; dispatch: Dispatch };

// Re-evaluate time-derived card state (client-side expiry, agent-staleness) once a minute while
// the tab is open — belt-and-braces alongside the server's sweep + card-removed SSE broadcast.
function useNowMs(intervalMs = 60_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return nowMs;
}

export function Feed({ onFollowUp }: { onFollowUp: (d: Dispatch) => void }) {
  const cards = useFeed((s) => s.cards);
  const dispatches = useFeed((s) => s.dispatches);
  const nowMs = useNowMs();

  // Cards and dispatches are separate slices (see feed.ts's header comment) but share one visual
  // timeline — interleave them by created_at, newest first, same as the card-only sort used to be.
  // Expired cards are filtered here rather than removed from the store: the ticker makes them
  // vanish while the tab is open even if no SSE card-removed ever arrives.
  const entries = useMemo<Entry[]>(() => {
    const merged: Entry[] = [
      ...cards
        .filter((card) => !isCardExpired(card, nowMs))
        .map((card): Entry => ({ key: 'card:' + card.id, created_at: card.created_at, kind: 'card', card })),
      ...dispatches.map((dispatch): Entry => ({ key: 'dispatch:' + dispatch.id, created_at: dispatch.created_at, kind: 'dispatch', dispatch })),
    ];
    return merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }, [cards, dispatches, nowMs]);

  if (!entries.length) {
    return (
      <Text c="dimmed" ta="center" py="xl">
        Nothing yet. When Claude Code sends something — or you send a dispatch — it shows up here.
      </Text>
    );
  }

  return (
    <Stack gap="md" aria-live="polite">
      {entries.map((e) => (e.kind === 'card' ? <CardView key={e.key} card={e.card} nowMs={nowMs} /> : <DispatchItem key={e.key} dispatch={e.dispatch} onFollowUp={onFollowUp} />))}
    </Stack>
  );
}
