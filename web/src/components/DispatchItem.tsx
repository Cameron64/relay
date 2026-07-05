import { useState } from 'react';
import { Badge, Button, Card as MCard, Group, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { cancelDispatch } from '../api';
import { useFeed } from '../store/feed';
import { timeAgo } from '../utils/markdown';
import { scrollToCard } from '../utils/focus';
import type { Dispatch } from '../types';

// One dispatch's status card in the feed (relay-roadmap Plan 02) — title, target, a status badge,
// the runner's result summary once it lands, Cancel while still queued, and Follow-up once done
// (opens Compose prefilled with resume_of + the ORIGINAL target locked — see Feed.tsx). Rendered
// interleaved with regular cards, newest-first, by Feed.tsx; this component never fetches its own
// data — everything it needs is already on the `dispatch` prop from the feed store.

const STATUS_COLOR: Record<Dispatch['status'], string> = {
  queued: 'gray',
  claimed: 'blue',
  running: 'blue',
  done: 'teal',
  failed: 'red',
  cancelled: 'gray',
};

const STATUS_LABEL: Record<Dispatch['status'], string> = {
  queued: 'queued',
  claimed: 'claimed',
  running: 'running…',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function DispatchItem({ dispatch, onFollowUp }: { dispatch: Dispatch; onFollowUp: (d: Dispatch) => void }) {
  const [busy, setBusy] = useState(false);
  const upsertDispatch = useFeed((s) => s.upsertDispatch);

  const onCancel = async () => {
    setBusy(true);
    const r = await cancelDispatch(dispatch.id);
    setBusy(false);
    if (r.status === 'error') {
      notifications.show({ message: r.error || 'Could not cancel' });
      return;
    }
    upsertDispatch(r.dispatch);
  };

  return (
    <MCard withBorder radius="md" shadow="sm" padding="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
        <Group gap="xs" align="center" wrap="wrap">
          <Title order={4} style={{ lineHeight: 1.2 }}>
            {dispatch.title || '(untitled dispatch)'}
          </Title>
          <Badge variant="light" color={STATUS_COLOR[dispatch.status]} tt="lowercase">
            {STATUS_LABEL[dispatch.status]}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
          {timeAgo(dispatch.created_at)}
        </Text>
      </Group>

      <Text size="xs" c="dimmed" mb={4}>
        Target: {dispatch.target}
        {dispatch.runner_host ? ` · ${dispatch.runner_host}` : ''}
      </Text>

      <Text size="sm" c="dimmed" lineClamp={4} mb="sm">
        {dispatch.body}
      </Text>

      {dispatch.result_summary ? (
        <Text size="sm" mb="sm">
          {dispatch.result_summary}
        </Text>
      ) : null}

      <Group gap="xs">
        {dispatch.status === 'queued' ? (
          <Button variant="outline" color="red" size="xs" onClick={onCancel} loading={busy}>
            Cancel
          </Button>
        ) : null}
        {dispatch.status === 'done' ? (
          <Button variant="light" color="indigo" size="xs" onClick={() => onFollowUp(dispatch)}>
            Follow-up
          </Button>
        ) : null}
        {dispatch.result_card_id ? (
          <Button variant="outline" color="gray" size="xs" onClick={() => scrollToCard(dispatch.result_card_id!)}>
            View result
          </Button>
        ) : null}
      </Group>
    </MCard>
  );
}
