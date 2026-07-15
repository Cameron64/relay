import { ActionIcon, Box, Button, Group, Menu, Text, Tooltip, useComputedColorScheme, useMantineColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
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

  // Below the `sm` breakpoint the full toolbar (wide "Disable notifications" / "Sessions" /
  // "Activity" / "Lock" text buttons) overflows the bar on a phone, so we collapse the secondary
  // controls into a `⋯` overflow menu. Defaults to mobile until the query resolves so the first
  // paint on a phone never flashes the spilling desktop layout.
  const isMobile = useMediaQuery('(max-width: 48em)', true);

  const toggleScheme = () => setColorScheme(computed === 'dark' ? 'light' : 'dark');

  const brand = (
    <Group gap="xs" align="center" wrap="nowrap">
      <Box
        w={10}
        h={10}
        style={{ borderRadius: '50%', background: 'var(--mantine-color-indigo-5)', flexShrink: 0 }}
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
  );

  const compose = onCompose ? (
    <Tooltip label="New dispatch — send a brainstorm to your desktop" openDelay={300}>
      <ActionIcon variant="filled" color="indigo" onClick={onCompose} aria-label="New dispatch">
        +
      </ActionIcon>
    </Tooltip>
  ) : null;

  if (isMobile) {
    // Compact bar: brand + primary "+" + an overflow menu holding everything else. Nothing wide
    // ever lands directly on the bar, so it can't spill.
    return (
      <Group justify="space-between" align="center" mih={56} px="md" py={4} wrap="nowrap">
        {brand}
        <Group gap="xs" align="center" wrap="nowrap">
          {compose}
          <Menu position="bottom-end" shadow="md" width={220} withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" aria-label="More actions">
                ⋯
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {push.supported ? (
                <Menu.Item
                  closeMenuOnClick={false}
                  disabled={push.disabled || push.busy}
                  onClick={() => void push.toggle()}
                >
                  {push.enabled ? 'Disable notifications' : 'Enable notifications'}
                </Menu.Item>
              ) : (
                <Menu.Item disabled>{push.status}</Menu.Item>
              )}

              <Menu.Item closeMenuOnClick={false} onClick={toggleScheme}>
                {computed === 'dark' ? '☀ Light theme' : '☾ Dark theme'}
              </Menu.Item>

              <Menu.Item
                onClick={() => {
                  void hardRefresh();
                }}
              >
                ↻ Hard refresh
              </Menu.Item>

              {showLock && onFollowUp && onOpenActivity ? (
                <>
                  <Menu.Divider />
                  <SessionsPanel
                    onFollowUp={onFollowUp}
                    onOpenActivity={onOpenActivity}
                    trigger={(open) => (
                      <Menu.Item closeMenuOnClick={false} onClick={open}>
                        Sessions
                      </Menu.Item>
                    )}
                  />
                  <Menu.Item onClick={() => onOpenActivity()}>Activity</Menu.Item>
                </>
              ) : null}

              {showLock ? (
                <>
                  <Menu.Divider />
                  <Menu.Item color="red" onClick={onLock}>
                    Lock — forget this device
                  </Menu.Item>
                </>
              ) : null}
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
    );
  }

  // Desktop / wide: the full toolbar.
  return (
    <Group justify="space-between" align="center" mih={56} px="md" py={4} wrap="nowrap">
      {brand}

      <Group gap="xs" align="center" wrap="nowrap">
        {compose}

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
