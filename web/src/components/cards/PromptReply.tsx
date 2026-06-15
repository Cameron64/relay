import { useState } from 'react';
import { Button, Group, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { respond } from '../../api';
import { useFeed } from '../../store/feed';
import type { Card } from '../../types';

// kind: 'prompt' — an open-ended question that wants a FREE-TEXT reply (created by `relay ask`).
// Unlike the approval "note" box (which hides behind a Request-changes button), the composer IS the
// card's primary content. Submitting responds with action 'reply'; the typed text rides in the
// response note, so `relay ask --wait` reads it back as the answer (verdict 'reply'). autoFocus is
// set when the card was deep-linked via the notification "Reply" tap (/?card=<id>&reply=1) so the
// mobile keyboard pops straight away.
export function PromptReply({ card, autoFocus = false }: { card: Card; autoFocus?: boolean }) {
  const applyResolved = useFeed((s) => s.applyResolved);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const placeholder =
    typeof card.source?.placeholder === 'string' && card.source.placeholder
      ? card.source.placeholder
      : 'Type your reply…';

  const send = async () => {
    const reply = text.trim();
    if (!reply || sending) return;
    setSending(true);
    const r = await respond(card.id, 'reply', reply);
    setSending(false);
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
    notifications.show({ message: 'Reply sent' });
  };

  return (
    <Stack gap="xs" mt="sm">
      <Textarea
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        autosize
        minRows={2}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter sends — the muscle memory of most chat composers. Plain Enter inserts a
          // newline (replies can be multi-line), matching the approval note box.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Group justify="flex-end">
        <Button onClick={() => void send()} loading={sending} disabled={!text.trim()}>
          Send reply
        </Button>
      </Group>
    </Stack>
  );
}
