import { Badge, Group, Text } from '@mantine/core';
import type { CardResponse, Verdict } from '../types';

const LABEL: Record<string, string> = {
  approved: '✓ Approved',
  changes_requested: '✎ Changes requested',
  dismissed: '✕ Dismissed',
};
const COLOR: Record<string, string> = {
  approved: 'green',
  changes_requested: 'yellow',
  dismissed: 'gray',
};

function label(v: Verdict): string {
  return LABEL[v as string] ?? '• ' + v;
}
function color(v: Verdict): string {
  return COLOR[v as string] ?? 'blue';
}

export function ResolvedBanner({ response }: { response: CardResponse }) {
  return (
    <Group gap="sm" mt="sm" wrap="nowrap" align="center">
      <Badge color={color(response.verdict)} variant="light" size="lg" tt="none">
        {label(response.verdict)}
      </Badge>
      {response.note ? (
        <Text size="sm" c="dimmed" fs="italic">
          “{response.note}”
        </Text>
      ) : null}
    </Group>
  );
}
