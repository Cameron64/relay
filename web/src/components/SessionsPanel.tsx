import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Drawer,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { fetchSessions, cancelDispatch } from '../api';
import { useFeed } from '../store/feed';
import { timeAgo } from '../utils/markdown';
import { scrollToCard } from '../utils/focus';
import type { Dispatch, SessionStatus, SessionSummary } from '../types';

// relay-roadmap Plan 03 — "which Claude sessions exist right now, what project, what state, and
// does it need me", built almost entirely from data Relay already collects (GET /api/sessions
// folds notify-log + the runner's claude_session linkage — see src/notify-log.ts's
// aggregateSessions). Self-contained button + Drawer, same shape as Activity.tsx's OLD
// self-managed form (Activity itself is now lifted to App.tsx because SessionsPanel needs to be
// able to open IT from a row action — see the "otherwise" case below).
//
// This is an event-derived view, not process-level truth (see the plan's Non-goals): a killed
// terminal never reports 'ended' unless the SessionEnd hook fired. 'stale' is the honest label for
// that gap — resist the urge to add a liveness heartbeat; hooks only fire on events.

const STATUS_COLOR: Record<SessionStatus, string> = {
  'needs-input': 'red',
  active: 'indigo',
  ended: 'gray',
  stale: 'gray',
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  'needs-input': 'needs input',
  active: 'active',
  ended: 'ended',
  stale: 'stale',
};

function SessionRow({
  session,
  dispatch,
  pendingCardId,
  onFollowUp,
  onOpenActivity,
}: {
  session: SessionSummary;
  dispatch: Dispatch | undefined;
  pendingCardId: string | undefined;
  onFollowUp: (d: Dispatch) => void;
  onOpenActivity: (sessionId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const upsertDispatch = useFeed((s) => s.upsertDispatch);

  const onCancel = async () => {
    if (!dispatch) return;
    setBusy(true);
    const r = await cancelDispatch(dispatch.id);
    setBusy(false);
    if (r.status === 'error') {
      notifications.show({ message: r.error || 'Could not cancel' });
      return;
    }
    upsertDispatch(r.dispatch);
  };

  // Row actions can combine: a runner-backed job's Cancel/Follow-up is shown alongside the
  // needs-input deep-link rather than mutually excluding it — a dispatch that's claimed/running
  // (claude_session populated, per dispatch-store.ts's updateDispatchStatus) can ALSO be the
  // session that just hit a permission/approval card, and that's the single most likely
  // needs-input case for an unattended headless dispatch. Only Cancel/Follow-up are dispatch-
  // status-gated; Answer-it is driven purely by session.status/pendingCardId.
  const showCancel = dispatch?.status === 'queued';
  const showFollowUp = dispatch?.status === 'done';
  const showAnswerIt = session.status === 'needs-input' && !!pendingCardId;
  const canOpenActivity = !dispatch && !pendingCardId && !!session.sessionId;

  const onRowClick = canOpenActivity ? () => onOpenActivity(session.sessionId!) : undefined;

  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      onClick={onRowClick}
      style={onRowClick ? { cursor: 'pointer' } : undefined}
    >
      <Stack gap={6}>
        <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xs">
          <Group gap={6} wrap="wrap">
            <Text fw={700} size="sm">
              {session.project || 'unknown project'}
            </Text>
            {session.host ? (
              <Badge size="xs" variant="light" color="gray">
                🖥 {session.host}
              </Badge>
            ) : null}
          </Group>
          <Badge size="xs" variant="light" color={STATUS_COLOR[session.status]}>
            {STATUS_LABEL[session.status]}
          </Badge>
        </Group>

        <Text size="xs" c="dimmed">
          {session.lastEvent} · {timeAgo(session.lastAt)}
          {session.status === 'stale' ? ` (no signal since ${timeAgo(session.lastAt)})` : ''}
        </Text>

        {dispatch ? (
          <Text size="xs" c="dimmed">
            Job: {dispatch.title || '(untitled dispatch)'} — {dispatch.status}
          </Text>
        ) : null}

        {showCancel || showFollowUp || showAnswerIt ? (
          <Group gap="xs">
            {showCancel ? (
              <Button
                variant="outline"
                color="red"
                size="xs"
                loading={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void onCancel();
                }}
              >
                Cancel
              </Button>
            ) : null}
            {showFollowUp ? (
              <Button
                variant="light"
                color="indigo"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onFollowUp(dispatch!);
                }}
              >
                Follow-up
              </Button>
            ) : null}
            {showAnswerIt ? (
              <Button
                variant="light"
                color="red"
                size="xs"
                onClick={(e) => {
                  e.stopPropagation();
                  scrollToCard(pendingCardId!);
                }}
              >
                Answer it
              </Button>
            ) : null}
          </Group>
        ) : null}
      </Stack>
    </Paper>
  );
}

export function SessionsPanel({
  onFollowUp,
  onOpenActivity,
  trigger,
}: {
  onFollowUp: (d: Dispatch) => void;
  onOpenActivity: (sessionId: string) => void;
  // Optional custom trigger — lets the mobile overflow menu render its own Menu.Item that opens
  // the drawer, instead of the default toolbar button. Given the drawer's `open` callback.
  trigger?: (open: () => void) => ReactNode;
}) {
  const [opened, { open, close }] = useDisclosure(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'warming' | 'error'>('idle');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const dispatches = useFeed((s) => s.dispatches);
  const cards = useFeed((s) => s.cards);

  const load = useCallback(async () => {
    setState('loading');
    const r = await fetchSessions();
    if (r.status === 'ok') {
      setSessions(r.sessions);
      setState('ok');
    } else if (r.status === 'warming') {
      setState('warming');
    } else {
      setState('error');
    }
  }, []);

  // Fetch fresh on open, on window focus while open, and whenever the feed's cursors move (any
  // card/dispatch created or updated over SSE — the plan's "refetch, don't incrementally fold
  // client-side" instruction; a full re-fold server-side is cheap and always correct).
  const newestCursor = useFeed((s) => s.newestCursor);
  const newestDispatchCursor = useFeed((s) => s.newestDispatchCursor);

  useEffect(() => {
    if (opened) void load();
  }, [opened, load, newestCursor, newestDispatchCursor]);

  useEffect(() => {
    if (!opened) return;
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [opened, load]);

  // dispatchId -> Dispatch, so each row can show live status/actions from the SAME feed store
  // DispatchItem reads from, rather than the (possibly stale) snapshot GET /api/sessions returned.
  const dispatchById = useMemo(() => new Map(dispatches.map((d) => [d.id, d])), [dispatches]);

  // sessionId -> newest still-pending card from that session (client-side; source.sessionId is the
  // canonical attribution every card carries — master doc §3). Cards are already newest-first.
  const pendingCardBySession = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cards) {
      if (c.status !== 'pending') continue;
      const sid = c.source?.sessionId;
      if (typeof sid === 'string' && !map.has(sid)) map.set(sid, c.id);
    }
    return map;
  }, [cards]);

  // At-a-glance status counts for the drawer header — answers "does anything need me?" before
  // scanning the list. ended + stale collapse into one "idle" tally (neither wants action).
  const counts = useMemo(() => {
    const c = { needsInput: 0, active: 0, idle: 0 };
    for (const s of sessions) {
      if (s.status === 'needs-input') c.needsInput++;
      else if (s.status === 'active') c.active++;
      else c.idle++;
    }
    return c;
  }, [sessions]);

  return (
    <>
      {trigger ? (
        trigger(open)
      ) : (
        <Tooltip label="Which Claude sessions exist, and do they need you" openDelay={300}>
          <Button variant="subtle" size="xs" color="gray" onClick={open} aria-label="Sessions">
            Sessions
          </Button>
        </Tooltip>
      )}

      <Drawer
        opened={opened}
        onClose={close}
        position="right"
        size="md"
        title={
          <Group gap="xs">
            <Text fw={700}>Sessions</Text>
            <ActionIcon variant="subtle" size="sm" onClick={load} aria-label="Refresh" loading={state === 'loading'}>
              ↻
            </ActionIcon>
          </Group>
        }
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {state === 'loading' && sessions.length === 0 ? (
          <Center mih="40vh">
            <Loader />
          </Center>
        ) : state === 'warming' ? (
          <Text c="dimmed" ta="center" py="xl">
            The audit log is warming up — try again in a moment.
          </Text>
        ) : state === 'error' ? (
          <Stack align="center" py="xl" gap="sm">
            <Text c="dimmed">Couldn't load sessions.</Text>
            <Button variant="light" size="xs" onClick={load}>
              Retry
            </Button>
          </Stack>
        ) : sessions.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">
            No sessions in the last 24 hours. Wire the SessionStart/SessionEnd hooks (see
            hooks/SETUP.md) to see them show up here.
          </Text>
        ) : (
          <Stack gap="sm" pb="md">
            <Group gap="xs">
              {counts.needsInput > 0 ? (
                <Badge color="red" variant="filled" size="sm">
                  {counts.needsInput} need{counts.needsInput === 1 ? 's' : ''} input
                </Badge>
              ) : null}
              {counts.active > 0 ? (
                <Badge color="indigo" variant="light" size="sm">
                  {counts.active} active
                </Badge>
              ) : null}
              {counts.idle > 0 ? (
                <Badge color="gray" variant="light" size="sm">
                  {counts.idle} idle
                </Badge>
              ) : null}
            </Group>
            {sessions.map((s) => (
              <SessionRow
                key={s.sessionId ?? `${s.cwd ?? ''}|${s.host ?? ''}`}
                session={s}
                dispatch={s.dispatchId ? dispatchById.get(s.dispatchId) : undefined}
                pendingCardId={s.sessionId ? pendingCardBySession.get(s.sessionId) : undefined}
                onFollowUp={onFollowUp}
                onOpenActivity={onOpenActivity}
              />
            ))}
          </Stack>
        )}
      </Drawer>
    </>
  );
}
