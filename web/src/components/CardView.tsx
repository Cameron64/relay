import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Badge, Card as MCard, Group, Text, Title } from '@mantine/core';
import { useFeed } from '../store/feed';
import { dismiss } from '../api';
import { claimFocus } from '../utils/focus';
import { timeAgo } from '../utils/markdown';
import { Markdown } from './cards/Markdown';
import { Mermaid } from './cards/Mermaid';
import { ImageAssets } from './cards/ImageAssets';
import { EditableDraft } from './cards/EditableDraft';
import { Actions } from './cards/Actions';
import { ChoiceCard } from './cards/ChoiceCard';
import { ResolvedBanner } from './ResolvedBanner';
import type { Card } from '../types';

export function CardView({ card }: { card: Card }) {
  const ref = useRef<HTMLDivElement>(null);
  const flash = useFeed((s) => s.flashIds.has(card.id));
  const removeCard = useFeed((s) => s.remove);
  const [autoFocusEditor, setAutoFocusEditor] = useState(false);

  // Dismiss: optimistically drop the card now, then tell the server (which broadcasts card-removed
  // to any other open tabs). No undo in v1 — the card is gone.
  const onDismiss = () => {
    removeCard(card.id);
    void dismiss(card.id);
  };

  // Deep-link ?card=<id>: scroll + flash + (editable draft) focus, exactly once per session.
  useEffect(() => {
    if (claimFocus(card.id)) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setAutoFocusEditor(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-shot flash for SSE-created cards.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => useFeed.getState().clearFlash(card.id), 1200);
    return () => clearTimeout(t);
  }, [flash, card.id]);

  const isEditableDraft = card.kind === 'draft' && !!card.source?.editable;
  const isChoice = card.kind === 'choice' && !!card.options?.length;
  const isResolved = card.status === 'responded' && !!card.response;
  const hasActions = !isResolved && !!card.buttons?.length;

  return (
    <MCard
      ref={ref}
      withBorder
      radius="md"
      shadow="sm"
      padding="md"
      data-id={card.id}
      className={flash ? 'relay-flash' : undefined}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
        <Group gap="xs" align="center">
          <Title order={4} style={{ lineHeight: 1.2 }}>
            {card.title}
          </Title>
          {card.kind !== 'note' ? (
            <Badge variant="light" color="indigo" tt="lowercase">
              {card.kind}
            </Badge>
          ) : null}
        </Group>
        <Group gap={4} align="center" wrap="nowrap">
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
            {timeAgo(card.created_at)}
          </Text>
          <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Dismiss card" onClick={onDismiss}>
            <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>
              ×
            </span>
          </ActionIcon>
        </Group>
      </Group>

      {/* non-draft image assets (editable drafts render their own with per-asset copy buttons) */}
      {!isEditableDraft && card.assets?.length ? <ImageAssets card={card} /> : null}

      {isEditableDraft ? (
        <EditableDraft card={card} autoFocus={autoFocusEditor} />
      ) : card.kind === 'draft' && card.body ? (
        <pre className="draft-plain">{card.body}</pre>
      ) : card.body ? (
        <Markdown>{card.body}</Markdown>
      ) : null}

      {card.mermaid ? <Mermaid code={card.mermaid} /> : null}

      {isChoice ? (
        <ChoiceCard card={card} />
      ) : isResolved ? (
        <ResolvedBanner response={card.response!} />
      ) : hasActions ? (
        <Actions card={card} />
      ) : null}
    </MCard>
  );
}
