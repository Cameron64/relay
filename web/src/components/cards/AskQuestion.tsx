import { useState } from 'react';
import { Button, Group, Stack, Textarea, UnstyledButton, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { postCardEvent } from '../../api';
import { useFeed } from '../../store/feed';

// Card threads (relay-roadmap Plan 04): the secondary "Ask a question" affordance shown next to an
// approval/choice card's verdict buttons — posts a role:'user' 'message' card_event instead of a
// verdict, so the card STAYS PENDING and the waiting agent sees the question on its next
// events_since-aware poll (routes-cards.ts's union of the verdict-wait and the events-wait). Renders
// collapsed as a plain text button; tapping it expands a one-line composer. Shared by Actions.tsx
// and ChoiceCard.tsx (both only mount this while the card is still pending — see each file's own
// gate) so the affordance and its wire-up logic live in exactly one place.
export function AskQuestion({ cardId }: { cardId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const appendEvent = useFeed((s) => s.appendEvent);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const r = await postCardEvent(cardId, 'message', body);
    setSending(false);
    if (r.status === 'ok') {
      appendEvent(cardId, r.event); // seen immediately, before the SSE echo (which will de-dupe)
      setText('');
      setOpen(false);
      notifications.show({ message: 'Question sent' });
      return;
    }
    if (r.status === 'conflict') {
      notifications.show({ message: 'Already answered — the thread is read-only now' });
      setOpen(false);
      return;
    }
    notifications.show({ message: 'Could not send' });
  };

  if (!open) {
    return (
      <UnstyledButton onClick={() => setOpen(true)} mt="xs">
        <Text size="sm" c="dimmed" td="underline">
          Ask a question
        </Text>
      </UnstyledButton>
    );
  }

  return (
    <Stack gap="xs" mt="xs">
      <Textarea
        placeholder="What do you want to ask before deciding?"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        autosize
        minRows={2}
        autoFocus
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Group justify="flex-end" gap="xs">
        <Button variant="outline" size="xs" onClick={() => setOpen(false)} disabled={sending}>
          Cancel
        </Button>
        <Button size="xs" onClick={() => void send()} loading={sending} disabled={!text.trim()}>
          Send question
        </Button>
      </Group>
    </Stack>
  );
}
