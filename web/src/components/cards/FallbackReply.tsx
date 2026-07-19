import { useState } from 'react';
import { Button, Group, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { respond } from '../../api';
import { useFeed } from '../../store/feed';
import type { Card } from '../../types';

// Fallback reply affordance (cards-v2 Feature 1): the last link in CardView's response chain, so a
// PENDING card never renders with NO way to answer it — a buttonless approval, an optionless
// choice, a plain note/diagram/image/draft the agent is actually --wait-ing on, or a page (under
// the iframe). Collapsed by default (a quiet "Reply" button — visually subordinate to real card
// actions); expanding shows a textarea + Send. Sending goes through the EXISTING respond endpoint
// with action 'reply' and the text in note — byte-for-byte what kind:'prompt' PromptReply does —
// so the card resolves with verdict 'reply' and any waiting agent poll reads the text back.
export function FallbackReply({ card }: { card: Card }) {
  const applyResolved = useFeed((s) => s.applyResolved);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

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

  if (!open) {
    return (
      <Group justify="flex-end" mt="sm">
        <Button variant="subtle" color="gray" size="compact-sm" onClick={() => setOpen(true)}>
          Reply
        </Button>
      </Group>
    );
  }

  return (
    <Stack gap="xs" mt="sm">
      <Textarea
        placeholder="Type your reply…"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        autosize
        minRows={2}
        autoFocus
        onKeyDown={(e) => {
          // Ctrl/Cmd+Enter sends, plain Enter inserts a newline — same muscle memory as PromptReply.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void send();
          }
        }}
      />
      <Group justify="flex-end" gap="xs">
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          onClick={() => {
            setOpen(false);
            setText('');
          }}
        >
          Cancel
        </Button>
        <Button variant="light" size="compact-sm" onClick={() => void send()} loading={sending} disabled={!text.trim()}>
          Send
        </Button>
      </Group>
    </Stack>
  );
}
