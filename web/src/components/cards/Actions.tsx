import { useState } from 'react';
import { Button, Group, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { respond } from '../../api';
import { copyText } from '../../utils/clipboard';
import { useFeed } from '../../store/feed';
import type { Card, CardButton } from '../../types';

// Map the card button's `style` to a Mantine button variant/color. Mirrors the old class mapping:
// default for a respond button is "secondary" (light); default for copy/link is "outline".
function variantFor(b: CardButton): { variant: string; color?: string } {
  const style = b.style ?? (b.behavior === 'respond' ? 'secondary' : 'outline');
  switch (style) {
    case 'primary':
      return { variant: 'filled' };
    case 'danger':
      return { variant: 'filled', color: 'red' };
    case 'secondary':
      return { variant: 'light' };
    case 'note':
      return { variant: 'default' };
    case 'outline':
    default:
      return { variant: 'outline' };
  }
}

export function Actions({ card }: { card: Card }) {
  const applyResolved = useFeed((s) => s.applyResolved);
  const [noteFor, setNoteFor] = useState<CardButton | null>(null);
  const [noteText, setNoteText] = useState('');
  const [sending, setSending] = useState(false);

  const submit = async (action: string, note: string | null) => {
    setSending(true);
    const r = await respond(card.id, action, note);
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
    notifications.show({ message: 'Sent' });
  };

  const onClick = (b: CardButton) => {
    if (b.behavior === 'copy') {
      copyText(b.value ?? card.copy_text ?? card.body ?? '');
      return;
    }
    if (b.behavior === 'link') {
      if (b.value) window.open(b.value, '_blank', 'noopener');
      return;
    }
    // respond
    if (b.style === 'note') {
      setNoteFor(b);
      setNoteText('');
    } else {
      submit(b.id, null);
    }
  };

  if (noteFor) {
    return (
      <Stack gap="xs" mt="sm">
        <Textarea
          placeholder="What should change? (optional)"
          value={noteText}
          onChange={(e) => setNoteText(e.currentTarget.value)}
          autosize
          minRows={2}
          autoFocus
        />
        <Group justify="flex-end" gap="xs">
          <Button variant="outline" onClick={() => setNoteFor(null)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => submit(noteFor.id, noteText.trim() || null)} loading={sending}>
            {noteFor.sendLabel || 'Send'}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Group gap="xs" mt="sm" wrap="wrap">
      {card.buttons!.map((b) => {
        const v = variantFor(b);
        return (
          <Button key={b.id} variant={v.variant} color={v.color} onClick={() => onClick(b)} disabled={sending}>
            {b.label}
          </Button>
        );
      })}
    </Group>
  );
}
