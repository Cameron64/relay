import { useCallback, useEffect, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
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
import { fetchNotifications } from '../api';
import type { NotifyLogEntry, NotifySource } from '../types';

// The notification audit trail. Opened from the TopBar, it lists every push Relay has sent — newest
// first — with its origin (which session/project/host fired it, and why). This is the answer to the
// "stray relay" problem: a "Claude is waiting for your input" push that leads nowhere can be traced
// here to the exact session that sent it, and entries with no card behind them are flagged so the
// dead-end tap is explained rather than mysterious.

const SOURCE_LABEL: Record<NotifySource, string> = {
  notification: 'idle/permission hook',
  stop: 'task-done hook',
  cli: 'relay notify (CLI)',
  mcp: 'relay_notify (MCP)',
  card: 'card',
  unknown: 'unknown',
};

const SOURCE_COLOR: Record<NotifySource, string> = {
  notification: 'blue',
  stop: 'teal',
  cli: 'gray',
  mcp: 'cyan',
  card: 'grape',
  unknown: 'gray',
};

// 'idle' is the low-value nudge that motivated this whole feature — color it loud (orange) so it
// stands out in the list. Everything else is quiet.
const EVENT_COLOR: Record<string, string> = {
  idle: 'orange',
  permission: 'yellow',
  done: 'teal',
};

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function absTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

function NotifyRow({ n }: { n: NotifyLogEntry }) {
  const actionable = !!n.card_id;
  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap={6}>
        <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
          <Group gap={6} wrap="wrap">
            <Badge size="xs" variant="light" color={SOURCE_COLOR[n.source] ?? 'gray'}>
              {SOURCE_LABEL[n.source] ?? n.source}
            </Badge>
            {n.event ? (
              <Badge size="xs" variant="outline" color={EVENT_COLOR[n.event] ?? 'gray'}>
                {n.event}
              </Badge>
            ) : null}
          </Group>
          <Tooltip label={absTime(n.created_at)} openDelay={300}>
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {relTime(n.created_at)}
            </Text>
          </Tooltip>
        </Group>

        <Box>
          <Text fw={600} size="sm" lineClamp={2}>
            {n.title}
          </Text>
          {n.body ? (
            <Text size="sm" c="dimmed" lineClamp={3}>
              {n.body}
            </Text>
          ) : null}
        </Box>

        {/* Origin — the "who sent it" answer. project is the human label; host + session pin it down. */}
        <Group gap="xs" wrap="wrap">
          {n.project ? (
            <Tooltip label={n.cwd ?? n.project} openDelay={300} multiline maw={320}>
              <Text size="xs" c="dimmed">
                📁 {n.project}
              </Text>
            </Tooltip>
          ) : (
            <Text size="xs" c="dimmed">
              📁 unknown project
            </Text>
          )}
          {n.host ? (
            <Text size="xs" c="dimmed">
              🖥 {n.host}
            </Text>
          ) : null}
          {n.session_id ? (
            <Tooltip label={`session ${n.session_id}`} openDelay={300}>
              <Text size="xs" c="dimmed" ff="monospace">
                #{n.session_id.slice(0, 8)}
              </Text>
            </Tooltip>
          ) : null}
        </Group>

        <Group justify="space-between" align="center" gap="xs">
          <Text size="xs" c="dimmed">
            {n.sent} sent
            {n.failed ? ` · ${n.failed} failed` : ''}
            {` · ${n.subscribers} device${n.subscribers === 1 ? '' : 's'}`}
          </Text>
          {actionable ? (
            <Badge size="xs" variant="dot" color="green">
              opens a card
            </Badge>
          ) : (
            <Tooltip
              label="No card is attached to this push — tapping it just opens the app. These are the dead-end nudges."
              openDelay={200}
              multiline
              maw={280}
            >
              <Badge size="xs" variant="dot" color="gray">
                no card
              </Badge>
            </Tooltip>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

export function Activity() {
  const [opened, { open, close }] = useDisclosure(false);
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'warming' | 'error'>('idle');
  const [items, setItems] = useState<NotifyLogEntry[]>([]);

  const load = useCallback(async () => {
    setState('loading');
    const r = await fetchNotifications(200);
    if (r.status === 'ok') {
      setItems(r.notifications);
      setState('ok');
    } else if (r.status === 'warming') {
      setState('warming');
    } else {
      setState('error');
    }
  }, []);

  // Fetch fresh each time the drawer opens (the trail changes constantly as sessions ping).
  useEffect(() => {
    if (opened) void load();
  }, [opened, load]);

  return (
    <>
      <Tooltip label="Notification history" openDelay={300}>
        <Button variant="subtle" size="xs" color="gray" onClick={open} aria-label="Notification history">
          Activity
        </Button>
      </Tooltip>

      <Drawer
        opened={opened}
        onClose={close}
        position="right"
        size="md"
        title={
          <Group gap="xs">
            <Text fw={700}>Notification activity</Text>
            <ActionIcon variant="subtle" size="sm" onClick={load} aria-label="Refresh" loading={state === 'loading'}>
              ↻
            </ActionIcon>
          </Group>
        }
        scrollAreaComponent={ScrollArea.Autosize}
      >
        {state === 'loading' && items.length === 0 ? (
          <Center mih="40vh">
            <Loader />
          </Center>
        ) : state === 'warming' ? (
          <Text c="dimmed" ta="center" py="xl">
            The audit log is warming up — try again in a moment.
          </Text>
        ) : state === 'error' ? (
          <Stack align="center" py="xl" gap="sm">
            <Text c="dimmed">Couldn't load the notification log.</Text>
            <Button variant="light" size="xs" onClick={load}>
              Retry
            </Button>
          </Stack>
        ) : items.length === 0 ? (
          <Text c="dimmed" ta="center" py="xl">
            No notifications yet. Every push Relay sends will show up here with the session that fired it.
          </Text>
        ) : (
          <Stack gap="sm" pb="md">
            <Text size="xs" c="dimmed">
              Every push Relay has sent, newest first. The project/host/session tell you who fired it.
            </Text>
            {items.map((n) => (
              <NotifyRow key={n.id} n={n} />
            ))}
          </Stack>
        )}
      </Drawer>
    </>
  );
}
