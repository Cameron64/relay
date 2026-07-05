import { useEffect, useState } from 'react';
import { Avatar, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { fetchCardEvents } from '../../api';
import { useFeed } from '../../store/feed';
import { Markdown } from './Markdown';
import { timeAgo } from '../../utils/markdown';
import type { Card } from '../../types';

// Card threads (relay-roadmap Plan 04): renders a card's card_events between the card body and its
// verdict controls. Agent messages left-aligned, user (Cam's) messages right-aligned — a plain
// two-lane chat layout, not a full chat app (see the plan's Non-goals: threads exist to REACH a
// verdict, the card still ends with one verdict through the frozen respond path). Only 'message'
// events render here — 'payload' events (Plan 05's structured page-submit data) aren't human-
// readable thread text and are filtered out.
//
// Hydration: fetches the full thread ONCE on mount if the card has any prior events AND this
// card hasn't completed a REAL fetchCardEvents() hydration yet (store/feed.ts's
// `loadedEventCardIds` — set only by setEvents, never by appendEvent). After that it stays live
// purely via the SSE 'card-event' broadcast (useSSE.ts) — this component never re-fetches.
// Gating on `loadedEventCardIds` rather than on "does events[card.id] have anything" matters: an
// SSE 'card-event' broadcast (or a local optimistic append — see Actions.tsx / ChoiceCard.tsx /
// PromptReply.tsx) can seed the slice with a single live event before this effect ever runs (cold
// app start, SSE reconnect while a pending card already has multi-message history) — if that alone
// skipped the fetch, the rest of the thread's history would be silently lost from view.
const COLLAPSE_AFTER = 4;

export function Thread({ card }: { card: Card }) {
  const loaded = useFeed((s) => s.events[card.id]);
  const hydrated = useFeed((s) => s.loadedEventCardIds.has(card.id));
  const setEvents = useFeed((s) => s.setEvents);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (hydrated) return; // already did a real full fetch for this card's thread
    if (!card.event_count) return; // nothing to fetch yet — a live append will seed the slice
    let cancelled = false;
    fetchCardEvents(card.id).then((r) => {
      if (!cancelled && r.status === 'ok') setEvents(card.id, r.events);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id, card.event_count, hydrated]);

  const messages = (loaded ?? []).filter((e) => e.type === 'message');
  if (!messages.length) return null;

  const collapsed = !expanded && messages.length > COLLAPSE_AFTER;
  const visible = collapsed ? messages.slice(-2) : messages; // last 2 stay visible behind the toggle

  return (
    <Stack gap={6} mt="sm">
      {collapsed ? (
        <UnstyledButton onClick={() => setExpanded(true)}>
          <Text size="xs" c="dimmed">
            Show all {messages.length} messages
          </Text>
        </UnstyledButton>
      ) : null}
      {visible.map((e) => {
        const isUser = e.role === 'user';
        return (
          <Group key={e.seq} justify={isUser ? 'flex-end' : 'flex-start'} align="flex-end" gap={6} wrap="nowrap">
            {!isUser ? (
              <Avatar size="sm" radius="xl" color="indigo">
                C
              </Avatar>
            ) : null}
            <Paper
              withBorder
              radius="md"
              px="sm"
              py={6}
              maw="80%"
              style={{ background: isUser ? 'var(--mantine-color-indigo-light)' : undefined }}
            >
              <Markdown>{e.body}</Markdown>
              <Text size="xs" c="dimmed" ta={isUser ? 'right' : 'left'} mt={2}>
                {timeAgo(e.at)}
              </Text>
            </Paper>
          </Group>
        );
      })}
    </Stack>
  );
}
