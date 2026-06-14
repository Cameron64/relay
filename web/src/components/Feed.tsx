import { Stack, Text } from '@mantine/core';
import { useFeed } from '../store/feed';
import { CardView } from './CardView';

export function Feed() {
  const cards = useFeed((s) => s.cards);

  if (!cards.length) {
    return (
      <Text c="dimmed" ta="center" py="xl">
        No cards yet. When Claude Code sends something, it shows up here.
      </Text>
    );
  }

  return (
    <Stack gap="md" aria-live="polite">
      {cards.map((c) => (
        <CardView key={c.id} card={c} />
      ))}
    </Stack>
  );
}
