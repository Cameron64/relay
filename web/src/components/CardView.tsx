import { useEffect, useRef, useState } from 'react';
import { ActionIcon, Badge, Card as MCard, Group, Text, Title } from '@mantine/core';
import { useFeed, isAgentStale } from '../store/feed';
import { dismiss } from '../api';
import { claimFocus } from '../utils/focus';
import { timeAgo } from '../utils/markdown';
import { Markdown } from './cards/Markdown';
import { Mermaid } from './cards/Mermaid';
import { ImageAssets } from './cards/ImageAssets';
import { EditableDraft } from './cards/EditableDraft';
import { Actions } from './cards/Actions';
import { ChoiceCard } from './cards/ChoiceCard';
import { PromptReply } from './cards/PromptReply';
import { ReplyAssets } from './cards/ReplyAssets';
import { PageFrame } from './cards/PageFrame';
import { Thread } from './cards/Thread';
import { FallbackReply } from './cards/FallbackReply';
import { ResolvedBanner } from './ResolvedBanner';
import { replyRequested } from '../utils/focus';
import type { Card, CardResponse } from '../types';

// `nowMs` drives the time-sensitive bits (agent-staleness badge) — Feed.tsx passes its 60s ticker
// so every card re-evaluates together; the default keeps standalone renders (tests) working.
export function CardView({ card, nowMs = Date.now() }: { card: Card; nowMs?: number }) {
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

  // Deep-link ?card=<id>: scroll + flash + (editable draft / prompt reply) focus, once per session.
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
  const isPrompt = card.kind === 'prompt';
  const isPage = card.kind === 'page' && !!card.page_html;
  // status ALONE decides resolved — a responded card whose `response` is somehow null must still
  // read as resolved (never re-offer a composer for an already-answered card). The banner gets a
  // generic verdict in that edge case.
  const isResolved = card.status === 'responded';
  const resolvedResponse: CardResponse = card.response ?? { verdict: 'answered', note: null };
  const hasActions = !isResolved && !!card.buttons?.length;
  const isPending = card.status === 'pending';
  // Agent-staleness (cards-v2 Feature 2b): pending + actionable, but no agent long-poll heartbeat
  // recently — the agent process probably exited. Reply affordances stay live regardless (the
  // response is still recorded server-side for a later poll to pick up).
  const agentStale = isAgentStale(card, nowMs);
  // Card threads (Plan 04): threads are for approval/choice/prompt cards only — the kinds that
  // solicit a response and can meaningfully carry a "clarify before deciding" exchange. View-only
  // kinds (note/diagram/image/draft/page) never render a thread, per the plan's Non-goals.
  const supportsThread = card.kind === 'approval' || card.kind === 'choice' || card.kind === 'prompt';

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
        <Group gap="xs" align="center" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
          {/* This Mantine version's TitleProps has no `truncate` — inline the same ellipsis styles. */}
          <Title order={4} style={{ lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {card.title}
          </Title>
          {card.kind !== 'note' ? (
            <Badge variant="light" color="indigo" tt="lowercase" style={{ flexShrink: 0 }}>
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

      {/* Resolved cards read as done: the body dims slightly, and the ResolvedBanner below stays
          at full opacity so the verdict is the prominent thing. */}
      <div style={isResolved ? { opacity: 0.6 } : undefined}>
        {/* non-draft image assets (editable drafts render their own with per-asset copy buttons) */}
        {!isEditableDraft && card.assets?.length ? <ImageAssets card={card} /> : null}

        {isPage ? (
          <PageFrame card={card} />
        ) : isEditableDraft ? (
          <EditableDraft card={card} autoFocus={autoFocusEditor} />
        ) : card.kind === 'draft' && card.body ? (
          <pre className="draft-plain">{card.body}</pre>
        ) : card.body ? (
          <Markdown>{card.body}</Markdown>
        ) : null}

        {!isPage && card.mermaid ? <Mermaid code={card.mermaid} /> : null}
      </div>

      {supportsThread ? <Thread card={card} /> : null}

      {agentStale ? (
        <Text size="xs" c="dimmed" mt="xs">
          ⚠ Agent may no longer be listening
          {card.last_poll_at ? ` — last checked ${timeAgo(card.last_poll_at)}` : ''}
        </Text>
      ) : null}

      {isChoice ? (
        <ChoiceCard card={card} />
      ) : isResolved ? (
        <ResolvedBanner response={resolvedResponse} />
      ) : isPrompt ? (
        <PromptReply card={card} autoFocus={autoFocusEditor && replyRequested} />
      ) : hasActions ? (
        <Actions card={card} />
      ) : isPending ? (
        // Feature 1 (cards-v2): a pending card must NEVER dead-end with no way to answer —
        // note/diagram/image/draft, an approval without buttons, a choice without options, or a
        // page (this sits under the iframe, collapsed).
        <FallbackReply card={card} />
      ) : null}

      {/* A responded choice keeps its option highlight above; still surface the verdict banner so
          resolution reads the same across ALL kinds. */}
      {isChoice && isResolved ? <ResolvedBanner response={resolvedResponse} /> : null}

      {/* Files the user attached to their reply (shown once resolved, any card kind). */}
      {isResolved ? <ReplyAssets card={card} /> : null}
    </MCard>
  );
}
