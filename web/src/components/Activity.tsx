import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Center,
  Chip,
  Drawer,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Switch,
  Tooltip,
} from '@mantine/core';
import { fetchNotifications } from '../api';
import type { NotifyLogEntry, NotifySource } from '../types';

// The notification audit trail. Lifted to App.tsx (like Compose) so both TopBar's own "Activity"
// button AND SessionsPanel's "otherwise, open Activity pre-filtered to this session" row action
// (relay-roadmap Plan 03) can open the SAME drawer instance instead of each mounting their own.
// Lists every push Relay has sent — newest first — with its origin (which session/project/host
// fired it, and why). This is the answer to the "stray relay" problem: a "Claude is waiting for
// your input" push that leads nowhere can be traced here to the exact session that sent it, and
// entries with no card behind them are flagged so the dead-end tap is explained rather than
// mysterious.

const SOURCE_LABEL: Record<NotifySource, string> = {
  notification: 'idle/permission hook',
  stop: 'task-done hook',
  cli: 'relay notify (CLI)',
  mcp: 'relay_notify (MCP)',
  card: 'card',
  dispatch: 'dispatch failure',
  session: 'session start/end hook',
  unknown: 'unknown',
};

const SOURCE_COLOR: Record<NotifySource, string> = {
  notification: 'blue',
  stop: 'teal',
  cli: 'gray',
  mcp: 'cyan',
  card: 'grape',
  dispatch: 'red',
  session: 'violet',
  unknown: 'gray',
};

// 'idle' is the low-value nudge that motivated this whole feature — color it loud (orange) so it
// stands out in the list. Everything else is quiet.
const EVENT_COLOR: Record<string, string> = {
  idle: 'orange',
  permission: 'yellow',
  done: 'teal',
  'session-start': 'violet',
  'session-end': 'gray',
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
            {n.delivered
              ? `${n.sent} sent${n.failed ? ` · ${n.failed} failed` : ''} · ${n.subscribers} device${n.subscribers === 1 ? '' : 's'}`
              : '🔕 silenced — logged, not pushed'}
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

export function Activity({
  opened,
  onClose,
  initialSessionId = null,
}: {
  opened: boolean;
  onClose: () => void;
  // Pre-filter to one session's rows on open (SessionsPanel's "otherwise" tap action). Seeded into
  // local state on each open (not synced back), so clearing the chip below doesn't fight the prop.
  initialSessionId?: string | null;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ok' | 'warming' | 'error'>('idle');
  const [items, setItems] = useState<NotifyLogEntry[]>([]);

  // Filters, applied client-side over the fetched page. Default hides the silenced (logged-but-not-
  // pushed) rows so the list shows pushes that actually reached the phone — they're one toggle away.
  const [hideSilenced, setHideSilenced] = useState(true);
  const [sourceSel, setSourceSel] = useState<string[]>([]); // empty = all sources
  const [eventSel, setEventSel] = useState<string[]>([]); // empty = all events
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);

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

  // Fetch fresh each time the drawer opens (the trail changes constantly as sessions ping), and
  // seed the session filter from the caller's initialSessionId — SessionsPanel's row action opens
  // this ALREADY pre-filtered; the plain "Activity" button in TopBar opens it with null (no filter).
  // Also re-seeds on a bare initialSessionId change while the drawer stays open (opened stays true):
  // the drawer instance is shared between TopBar's button and every SessionsPanel row action, so a
  // caller can retarget it to a different session (or clear to none) without a close/reopen cycle.
  useEffect(() => {
    if (!opened) return;
    setSessionFilter(initialSessionId);
    void load();
  }, [opened, initialSessionId, load]);

  // Only offer chips for the sources/events actually present in this page of the trail.
  const presentSources = useMemo(() => {
    const s = new Set<string>();
    for (const n of items) s.add(n.source);
    return [...s].sort();
  }, [items]);
  const presentEvents = useMemo(() => {
    const s = new Set<string>();
    for (const n of items) if (n.event) s.add(n.event);
    return [...s].sort();
  }, [items]);

  const silencedCount = useMemo(() => items.reduce((acc, n) => acc + (n.delivered ? 0 : 1), 0), [items]);

  const filtered = useMemo(
    () =>
      items.filter((n) => {
        if (sessionFilter && n.session_id !== sessionFilter) return false;
        if (hideSilenced && !n.delivered) return false;
        if (sourceSel.length && !sourceSel.includes(n.source)) return false;
        if (eventSel.length && !eventSel.includes(n.event ?? '')) return false;
        return true;
      }),
    [items, sessionFilter, hideSilenced, sourceSel, eventSel],
  );

  const atDefaults = hideSilenced && sourceSel.length === 0 && eventSel.length === 0 && !sessionFilter;
  const resetFilters = useCallback(() => {
    setHideSilenced(true);
    setSourceSel([]);
    setEventSel([]);
    setSessionFilter(null);
  }, []);

  const filterBar = (
    <Paper
      withBorder
      p="xs"
      radius="md"
      bg="var(--mantine-color-body)"
      style={{ position: 'sticky', top: 0, zIndex: 2 }}
    >
      <Stack gap={8}>
        {sessionFilter ? (
          <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
            <Badge size="sm" variant="filled" color="indigo" style={{ fontFamily: 'monospace' }}>
              session #{sessionFilter.slice(0, 8)}
            </Badge>
            <Button variant="subtle" size="compact-xs" color="gray" onClick={() => setSessionFilter(null)}>
              Clear
            </Button>
          </Group>
        ) : null}

        <Group justify="space-between" align="center" wrap="nowrap" gap="xs">
          <Switch
            size="xs"
            checked={hideSilenced}
            onChange={(e) => setHideSilenced(e.currentTarget.checked)}
            label={`Hide silenced${silencedCount ? ` (${silencedCount})` : ''}`}
          />
          {!atDefaults ? (
            <Button variant="subtle" size="compact-xs" color="gray" onClick={resetFilters}>
              Reset
            </Button>
          ) : null}
        </Group>

        {presentSources.length > 1 ? (
          <Box>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>
              Source
            </Text>
            <Chip.Group multiple value={sourceSel} onChange={setSourceSel}>
              <Group gap={6}>
                {presentSources.map((s) => (
                  <Chip key={s} value={s} size="xs" variant="outline" color={SOURCE_COLOR[s as NotifySource] ?? 'gray'}>
                    {SOURCE_LABEL[s as NotifySource] ?? s}
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </Box>
        ) : null}

        {presentEvents.length > 1 ? (
          <Box>
            <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>
              Event
            </Text>
            <Chip.Group multiple value={eventSel} onChange={setEventSel}>
              <Group gap={6}>
                {presentEvents.map((ev) => (
                  <Chip key={ev} value={ev} size="xs" variant="outline" color={EVENT_COLOR[ev] ?? 'gray'}>
                    {ev}
                  </Chip>
                ))}
              </Group>
            </Chip.Group>
          </Box>
        ) : null}

        <Text size="xs" c="dimmed">
          Showing {filtered.length} of {items.length}
          {hideSilenced && silencedCount ? ` · ${silencedCount} silenced hidden` : ''}
        </Text>
      </Stack>
    </Paper>
  );

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
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
            {filterBar}
            {filtered.length === 0 ? (
              <Stack align="center" py="xl" gap="sm">
                <Text c="dimmed" ta="center">
                  Nothing matches these filters.
                </Text>
                <Button variant="light" size="xs" onClick={resetFilters}>
                  Reset filters
                </Button>
              </Stack>
            ) : (
              filtered.map((n) => <NotifyRow key={n.id} n={n} />)
            )}
          </Stack>
        )}
    </Drawer>
  );
}
