import { ActionIcon, Box, Button, Group, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { usePush } from '../hooks/usePush';
import { SessionsPanel } from './SessionsPanel';
import type { Dispatch } from '../types';

// Injected at build time by Vite `define` (see vite.config.ts).
declare const __BUILD_ID__: string;

// Force the PWA onto the latest build. We deliberately do NOT unregister the service worker — that
// would discard the Web Push subscription and silence the device until it's re-enabled. Instead: pull
// any new SW (it self-activates via skipWaiting/clientsClaim in service-worker.js), clear Cache Storage
// so stale hashed bundles can't be served, then reload. Navigation is network-first, so the reload
// pulls a fresh index.html referencing the new assets.
async function hardRefresh(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) await reg.update();
    }
  } catch {
    /* best effort — reload regardless */
  }
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best effort — reload regardless */
  }
  location.reload();
}

export function TopBar({
  showLock,
  onLock,
  onCompose,
  onFollowUp,
  onOpenActivity,
}: {
  showLock: boolean;
  onLock: () => void;
  onCompose?: () => void;
  // Both undefined together outside the 'feed' view (same gating as onCompose) — the Sessions
  // button and the Activity button only make sense once there's a feed to act on.
  onFollowUp?: (d: Dispatch) => void;
  onOpenActivity?: (sessionId?: string | null) => void;
}) {
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
        <div>
          <Text fw={700} size="lg" style={{ lineHeight: 1.1 }}>
            Relay
          </Text>
          <Text c="dimmed" style={{ fontSize: 10, lineHeight: 1.1 }}>
            build {__BUILD_ID__}
          </Text>
        </div>
      </Group>

      <Group gap="xs" align="center">
        {onCompose ? (
          <Tooltip label="New dispatch — send a brainstorm to your desktop" openDelay={300}>
            <ActionIcon variant="filled" color="indigo" onClick={onCompose} aria-label="New dispatch">
              +
            </ActionIcon>
          </Tooltip>
        ) : null}

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

        <Tooltip label="Hard refresh — clear cache & reload" openDelay={300}>
          <ActionIcon
            variant="subtle"
            onClick={() => {
              void hardRefresh();
            }}
            aria-label="Hard refresh"
          >
            ↻
          </ActionIcon>
        </Tooltip>

        {showLock && onFollowUp && onOpenActivity ? <SessionsPanel onFollowUp={onFollowUp} onOpenActivity={onOpenActivity} /> : null}

        {showLock && onOpenActivity ? (
          <Tooltip label="Notification history" openDelay={300}>
            <Button variant="subtle" size="xs" color="gray" onClick={() => onOpenActivity()} aria-label="Notification history">
              Activity
            </Button>
          </Tooltip>
        ) : null}

        {showLock ? (
          <Button variant="subtle" size="xs" color="gray" onClick={onLock} title="Forget this device">
            Lock
          </Button>
        ) : null}
      </Group>
    </Group>
  );
}
