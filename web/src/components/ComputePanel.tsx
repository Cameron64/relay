import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Code, Drawer, Group, Select, Stack, Text } from '@mantine/core';
import { api } from '../api';

type Job = { public_id: string; status: string; placement: { host: string }; created_at: string; cancel_requested: boolean;
  result: { receipt_id: string; summary: { digest: string; rounds: number } } | null };
type Submission = { request_key: string; host: string; rounds: number };
const STORAGE_KEY = 'relay-compute-pending-v1';
const NON_STOPPABLE = new Set(['succeeded', 'failed', 'cancelled', 'awaiting_delivery']);
const REQUEST_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LABELS: Record<string, string> = { accepted: 'Accepted', queued: 'Queued', scheduled: 'Queued', running: 'Running',
  cancellation_requested: 'Stopping', cancelled: 'Stopped', succeeded: 'Complete', failed: 'Failed',
  awaiting_delivery: 'Saving result', reconciliation_required: 'Checking worker state' };

function recoverSubmission(): Submission | null {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (value && typeof value.request_key === 'string' && REQUEST_KEY.test(value.request_key) &&
      ['cloudripper', 'current-windows'].includes(value.host) && [1000, 10000, 50000].includes(value.rounds) &&
      Object.keys(value).every(key => ['request_key', 'host', 'rounds'].includes(key))) return value;
    localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch { return null; }
}

export function ComputePanel({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [host, setHost] = useState<string | null>('cloudripper');
  const [rounds, setRounds] = useState<string | null>('1000');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Submission | null>(recoverSubmission);
  const refresh = useCallback(async () => {
    try {
      const response = await api('/api/compute/jobs');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not refresh compute jobs.');
      setJobs(data.jobs || []);
    } catch (e) { setError(e instanceof Error ? e.message : 'Compute service unavailable.'); }
  }, []);
  useEffect(() => {
    if (!opened) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [opened, refresh]);

  async function submit() {
    const value = pending || { request_key: crypto.randomUUID(), host: host!, rounds: Number(rounds) };
    // Persist the exact request before sending so an uncertain response can be retried safely.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch {
      setError('Browser storage is unavailable. Enable it before submitting a job.'); return;
    }
    setPending(value);
    setBusy(true); setError(null);
    try {
      const response = await api('/api/compute/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
      // These statuses definitively reject this payload. Preserve identity for uncertain
      // transport/server failures, but do not trap a rejected request in an endless retry.
      if ([400, 404, 409, 413, 415, 422].includes(response.status)) {
        localStorage.removeItem(STORAGE_KEY); setPending(null);
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Submission was not confirmed. Retry the same request.');
      localStorage.removeItem(STORAGE_KEY); setPending(null); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Submission was not confirmed. Retry the same request.'); }
    finally { setBusy(false); }
  }

  async function cancel(id: string) {
    setError(null);
    try {
      const response = await api(`/api/compute/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not confirm the stop request. Please retry.');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not request a stop.'); }
  }

  return <Drawer opened={opened} onClose={onClose} title="Compute" position="right" size="lg"><Stack>
    <Text size="sm" c="dimmed">Run a synthetic CPU task on one of your computers. Close this panel and return later to see its progress.</Text>
    {error && <Alert color="orange" title="Compute status">{error}</Alert>}
    <Select label="Computer" value={pending?.host || host} onChange={setHost} allowDeselect={false} disabled={busy || !!pending}
      data={[{ value: 'cloudripper', label: 'Cloudripper' }, { value: 'current-windows', label: 'Current Windows computer' }]} />
    <Select label="Test size" value={pending ? String(pending.rounds) : rounds} onChange={setRounds} allowDeselect={false} disabled={busy || !!pending}
      data={[{ value: '1000', label: 'Small — 1,000 rounds' }, { value: '10000', label: 'Medium — 10,000 rounds' }, { value: '50000', label: 'Large — 50,000 rounds' }]} />
    {pending && <Text size="sm">A submission is awaiting confirmation. Retry safely using its existing request ID.</Text>}
    <Button onClick={() => void submit()} loading={busy}>{pending ? 'Retry submission' : 'Run test task'}</Button>
    <Group justify="space-between"><Text fw={600}>Recent jobs</Text><Button size="xs" variant="subtle" onClick={() => void refresh()}>Refresh</Button></Group>
    {!jobs.length && <Text c="dimmed" size="sm">No compute jobs to show yet.</Text>}
    {jobs.map((job) => <Card key={job.public_id} withBorder padding="sm"><Stack gap="xs">
      <Group justify="space-between"><Text fw={600}>{job.placement.host === 'cloudripper' ? 'Cloudripper' : 'Windows'}</Text>
        <Badge color={job.status === 'succeeded' ? 'green' : job.status === 'failed' ? 'red' : 'blue'}>{LABELS[job.status] || job.status.replaceAll('_', ' ')}</Badge></Group>
      <Text size="xs" c="dimmed">{new Date(job.created_at).toLocaleString()}</Text>
      <Text size="xs" style={{ overflowWrap: 'anywhere' }}>Job {job.public_id}</Text>
      {job.result && <><Text size="sm">Result saved · {job.result.summary.rounds.toLocaleString()} rounds</Text>
        <Code block style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{job.result.summary.digest}</Code></>}
      {!NON_STOPPABLE.has(job.status) && <Button size="xs" variant="light" color="orange" disabled={job.cancel_requested}
        onClick={() => void cancel(job.public_id)}>{job.cancel_requested ? 'Stop requested' : 'Stop task'}</Button>}
    </Stack></Card>)}
  </Stack></Drawer>;
}
