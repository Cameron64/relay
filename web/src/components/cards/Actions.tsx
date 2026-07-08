import { useState } from 'react';
import { Button, Group, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { respond } from '../../api';
import { copyRich } from '../../utils/clipboard';
import { markdownToSafeHtml } from '../../utils/markdown';
import { useFeed } from '../../store/feed';
import { AskQuestion } from './AskQuestion';
import { AttachFiles } from '../AttachFiles';
import { filesToAssets } from '../../utils/files';
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
  const [noteFiles, setNoteFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);

  const submit = async (action: string, note: string | null, files: File[] = []) => {
    setSending(true);
    let assets;
    try {
      assets = files.length ? await filesToAssets(files) : undefined;
    } catch {
      setSending(false);
      notifications.show({ message: 'Could not read an attachment — remove it and try again' });
      return;
    }
    const r = await respond(card.id, action, note, undefined, assets);
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
      // Copy rich HTML so the paste keeps formatting in Slack/Teams/Outlook (which read text/html),
      // with the original markdown kept as the plain-text fallback for plain-only targets.
      const src = b.value ?? card.copy_text ?? card.body ?? '';
      copyRich(markdownToSafeHtml(src), src);
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
      setNoteFiles([]);
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
        <AttachFiles files={noteFiles} onChange={setNoteFiles} />
        <Group justify="flex-end" gap="xs">
          <Button variant="outline" onClick={() => { setNoteFor(null); setNoteFiles([]); }} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={() => submit(noteFor.id, noteText.trim() || null, noteFiles)} loading={sending}>
            {noteFor.sendLabel || 'Send'}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap={0}>
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
      <AskQuestion cardId={card.id} />
    </Stack>
  );
}
