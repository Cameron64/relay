import { useState } from 'react';
import { Button, Center, Paper, PasswordInput, Stack, Text, Title } from '@mantine/core';
import { unlock } from '../api';

export function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    const r = await unlock(t);
    setBusy(false);
    if (!r.ok) {
      setError(r.status === 401 ? 'Invalid token' : 'Unlock failed');
      return;
    }
    setToken('');
    onUnlocked();
  };

  return (
    <Center mih="60vh">
      <Paper withBorder shadow="md" radius="md" p="xl" maw={400} w="100%">
        <form onSubmit={submit}>
          <Stack gap="md">
            <Title order={2}>Unlock Relay</Title>
            <Text c="dimmed" size="sm">
              Paste your UI token to read cards on this device. It's stored as a secure cookie, not in
              the page.
            </Text>
            <PasswordInput
              value={token}
              onChange={(e) => setToken(e.currentTarget.value)}
              placeholder="UI token"
              autoComplete="off"
              error={error || undefined}
            />
            <Button type="submit" loading={busy} fullWidth>
              Unlock
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
