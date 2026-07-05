import { useState } from 'react';
import { Anchor, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { respond } from '../../api';
import { useFeed } from '../../store/feed';
import { Markdown } from './Markdown';
import { Mermaid } from './Mermaid';
import { AskQuestion } from './AskQuestion';
import type { Card } from '../../types';

// Rich multiple-choice card (kind: 'choice'). Each option is a selectable panel that can carry a
// description, markdown body, diagram, and link. Selecting one responds with the option id (which
// becomes the verdict, so `relay choice --wait` reads it back like any other card). Once answered,
// the chosen option is highlighted and the rest dim — the card stays in the feed (with its grace
// window) so you can see what you picked.
export function ChoiceCard({ card }: { card: Card }) {
  const applyResolved = useFeed((s) => s.applyResolved);
  const [sending, setSending] = useState<string | null>(null);
  const chosen = card.status === 'responded' ? (card.response?.verdict ?? null) : null;
  const locked = !!chosen || !!sending;

  const choose = async (id: string) => {
    if (locked) return;
    setSending(id);
    const r = await respond(card.id, id, null);
    setSending(null);
    if (r.status === 'conflict') {
      notifications.show({ message: 'Already answered' });
      if (r.response) applyResolved(card.id, r.response);
      return;
    }
    if (r.status === 'error') {
      notifications.show({ message: 'Could not send' });
      return;
    }
    applyResolved(card.id, r.response);
  };

  return (
    <Stack gap="xs" mt="sm">
      {card.options!.map((o) => {
        const isChosen = chosen === o.id;
        const isSending = sending === o.id;
        const dim = !!chosen && !isChosen;
        const hasDetail = !!(o.description || o.body || o.mermaid || o.link);
        return (
          <Paper
            key={o.id}
            withBorder
            radius="md"
            p="sm"
            role="button"
            tabIndex={locked ? -1 : 0}
            aria-pressed={isChosen || undefined}
            aria-disabled={locked || undefined}
            onClick={() => choose(o.id)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !locked) {
                e.preventDefault();
                choose(o.id);
              }
            }}
            style={{
              cursor: locked ? 'default' : 'pointer',
              opacity: dim ? 0.5 : 1,
              borderColor: isChosen ? 'var(--mantine-color-indigo-filled)' : undefined,
              borderWidth: isChosen ? 2 : undefined,
              transition: 'opacity 150ms ease',
            }}
          >
            <Group justify="space-between" align="center" wrap="nowrap" mb={hasDetail ? 4 : 0}>
              <Text fw={600}>{o.label}</Text>
              {isChosen ? (
                <Badge color="indigo" variant="light">
                  chosen
                </Badge>
              ) : isSending ? (
                <Badge color="gray" variant="light">
                  sending…
                </Badge>
              ) : null}
            </Group>
            {o.description ? (
              <Text size="sm" c="dimmed">
                {o.description}
              </Text>
            ) : null}
            {o.body ? <Markdown>{o.body}</Markdown> : null}
            {o.mermaid ? <Mermaid code={o.mermaid} /> : null}
            {o.link ? (
              <Anchor href={o.link} target="_blank" rel="noopener" size="sm" onClick={(e) => e.stopPropagation()}>
                {o.link}
              </Anchor>
            ) : null}
          </Paper>
        );
      })}
      {!chosen ? <AskQuestion cardId={card.id} /> : null}
    </Stack>
  );
}
