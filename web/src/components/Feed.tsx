import { useMemo } from 'react';
import { Stack, Text } from '@mantine/core';
import { useFeed } from '../store/feed';
import { CardView } from './CardView';
import { DispatchItem } from './DispatchItem';
import type { Card, Dispatch } from '../types';

type Entry = { key: string; created_at: string; kind: 'card'; card: Card } | { key: string; created_at: string; kind: 'dispatch'; dispatch: Dispatch };

export function Feed({ onFollowUp }: { onFollowUp: (d: Dispatch) => void }) {
  const cards = useFeed((s) => s.cards);
  const dispatches = useFeed((s) => s.dispatches);

  // Cards and dispatches are separate slices (see feed.ts's header comment) but share one visual
  // timeline — interleave them by created_at, newest first, same as the card-only sort used to be.
  const entries = useMemo<Entry[]>(() => {
    const merged: Entry[] = [
      ...cards.map((card): Entry => ({ key: 'card:' + card.id, created_at: card.created_at, kind: 'card', card })),
      ...dispatches.map((dispatch): Entry => ({ key: 'dispatch:' + dispatch.id, created_at: dispatch.created_at, kind: 'dispatch', dispatch })),
    ];
    return merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }, [cards, dispatches]);

  if (!entries.length) {
    return (
      <Text c="dimmed" ta="center" py="xl">
        Nothing yet. When Claude Code sends something — or you send a dispatch — it shows up here.
      </Text>
    );
  }

  return (
    <Stack gap="md" aria-live="polite">
      {entries.map((e) => (e.kind === 'card' ? <CardView key={e.key} card={e.card} /> : <DispatchItem key={e.key} dispatch={e.dispatch} onFollowUp={onFollowUp} />))}
    </Stack>
  );
}
