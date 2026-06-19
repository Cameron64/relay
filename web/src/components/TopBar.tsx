import { ActionIcon, Box, Button, Group, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { usePush } from '../hooks/usePush';
import { Activity } from './Activity';

export function TopBar({ showLock, onLock }: { showLock: boolean; onLock: () => void }) {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light', { getInitialValueInEffect: true });
  const push = usePush();

  const toggleScheme = () => setColorScheme(computed === 'dark' ? 'light' : 'dark');

  return (
    <Group justify="space-between" align="center" h={56} px="md">
      <Group gap="xs" align="center">
        <Box
          w={10}
          h={10}
          style={{ borderRadius: '50%', background: 'var(--mantine-color-indigo-5)' }}
        />
        <Text fw={700} size="lg">
          Relay
        </Text>
      </Group>

      <Group gap="xs" align="center">
        {push.supported ? (
          <Tooltip label={push.status} disabled={!push.status} openDelay={300}>
            <Button
              variant="subtle"
              size="xs"
              onClick={push.toggle}
              loading={push.busy}
              disabled={push.disabled}
            >
              {push.enabled ? 'Disable notifications' : 'Enable notifications'}
            </Button>
          </Tooltip>
        ) : (
          <Text size="xs" c="dimmed">
            {push.status}
          </Text>
        )}

        <Tooltip label="Toggle theme" openDelay={300}>
          <ActionIcon variant="subtle" onClick={toggleScheme} aria-label="Toggle color scheme">
            {computed === 'dark' ? '☀' : '☾'}
          </ActionIcon>
        </Tooltip>

        {showLock ? <Activity /> : null}

        {showLock ? (
          <Button variant="subtle" size="xs" color="gray" onClick={onLock} title="Forget this device">
            Lock
          </Button>
        ) : null}
      </Group>
    </Group>
  );
}
