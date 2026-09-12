import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Code, Drawer, Group, Progress, Select, Stack, Text } from '@mantine/core';
import { api } from '../api';

type Job = { public_id: string; status: string; placement: { host: string }; created_at: string; cancel_requested: boolean;
  result: { receipt_id: string; summary: { digest: string; rounds: number } } | null };
type Submission = { request_key: string; host: string; rounds: number };
type ServiceStatus = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
type ServiceJob = {
  public_id: string; sequence: number; task: { kind: 'image.generate'; version: '1' };
  service: 'image-lab'; host: 'cloudripper'; capability: 'image-cpu'; status: ServiceStatus;
  progress: number | null; result_ready: boolean; owner_observed_at: string; created_at: string; updated_at: string;
  cancel_requested: boolean; owner_online: boolean; observation_stale: boolean; result_link_enabled?: true;
};
const STORAGE_KEY = 'relay-compute-pending-v1';
const NON_STOPPABLE = new Set(['succeeded', 'failed', 'cancelled', 'awaiting_delivery']);
const SERVICE_TERMINAL = new Set<ServiceStatus>(['succeeded', 'failed', 'cancelled']);
const REQUEST_KEY = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LABELS: Record<string, string> = { accepted: 'Accepted', queued: 'Queued', scheduled: 'Queued', running: 'Running',
  cancellation_requested: 'Stopping', cancelled: 'Stopped', succeeded: 'Complete', failed: 'Failed',
  awaiting_delivery: 'Saving result', reconciliation_required: 'Checking worker state' };
const SERVICE_LABELS: Record<ServiceStatus, string> = {
  queued: 'Queued', running: 'Generating', cancelling: 'Cancellation requested',
  succeeded: 'Ready', failed: 'Failed', cancelled: 'Cancelled', unknown: 'Status unavailable',
};
const SERVICE_REFRESH_PAGE_LIMIT = 20;

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
  const [serviceJobs, setServiceJobs] = useState<ServiceJob[]>([]);
  const serviceJobsRef = useRef<ServiceJob[]>([]);
  const serviceNextCursorRef = useRef<string | null>(null);
  const serviceRequestLaneRef = useRef<Promise<void>>(Promise.resolve());
  const serviceRefreshRef = useRef<Promise<void> | null>(null);
  const loadingOlderRef = useRef(false);
  const [serviceNextCursor, setServiceNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Submission | null>(recoverSubmission);
  const enqueueServiceRequest = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = serviceRequestLaneRef.current.then(operation, operation);
    serviceRequestLaneRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const commitServiceJobs = useCallback((next: ServiceJob[], cursor: string | null) => {
    const previous = new Map(serviceJobsRef.current.map(job => [job.public_id, job]));
    const merged = new Map<string, ServiceJob>();
    for (const incoming of next) {
      const prior = previous.get(incoming.public_id);
      const incomingIsOlder = prior && (incoming.sequence < prior.sequence ||
        (incoming.sequence === prior.sequence && Date.parse(incoming.updated_at) < Date.parse(prior.updated_at)));
      const terminalWouldRegress = prior && SERVICE_TERMINAL.has(prior.status) && !SERVICE_TERMINAL.has(incoming.status);
      const newest = incomingIsOlder || terminalWouldRegress ? prior : incoming;
      const cancellationWasPending = prior && (prior.cancel_requested || prior.status === 'cancelling');
      const job = cancellationWasPending && !SERVICE_TERMINAL.has(newest.status)
        ? { ...newest, cancel_requested: true }
        : newest;
      merged.set(job.public_id, job);
    }
    const committed = [...merged.values()];
    serviceJobsRef.current = committed;
    serviceNextCursorRef.current = cursor;
    setServiceJobs(committed);
    setServiceNextCursor(cursor);
  }, []);

  const refreshServiceJobs = useCallback(() => {
    if (serviceRefreshRef.current) return serviceRefreshRef.current;
    const request = enqueueServiceRequest(async () => {
      const oldestLoadedId = serviceJobsRef.current.at(-1)?.public_id;
      const refreshed: ServiceJob[] = [];
      let cursor: string | null = null;
      let foundOldest = oldestLoadedId === undefined;
      let nextCursor: string | null = null;
      for (let page = 0; page < SERVICE_REFRESH_PAGE_LIMIT; page += 1) {
        const path = cursor ? `/api/compute/service-jobs?cursor=${encodeURIComponent(cursor)}` : '/api/compute/service-jobs';
        const response = await api(path);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not refresh Image Lab jobs.');
        const pageJobs = (data.jobs || []) as ServiceJob[];
        refreshed.push(...pageJobs);
        foundOldest ||= pageJobs.some(job => job.public_id === oldestLoadedId);
        nextCursor = data.next_cursor ?? null;
        if (foundOldest || nextCursor === null) break;
        cursor = nextCursor;
      }
      if (!foundOldest) throw new Error('Could not safely refresh all loaded Image Lab jobs.');
      commitServiceJobs(refreshed, nextCursor);
    });
    serviceRefreshRef.current = request;
    const clear = () => { if (serviceRefreshRef.current === request) serviceRefreshRef.current = null; };
    request.then(clear, clear);
    return request;
  }, [commitServiceJobs, enqueueServiceRequest]);

  const refresh = useCallback(async () => {
    const [cpu, service] = await Promise.allSettled([
      (async () => {
        const response = await api('/api/compute/jobs');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not refresh CPU jobs.');
        setJobs(data.jobs || []);
      })(),
      refreshServiceJobs(),
    ]);
    const errors = [cpu, service].flatMap(result => result.status === 'rejected'
      ? [result.reason instanceof Error ? result.reason.message : 'Compute service unavailable.'] : []);
    setError(errors.length ? errors.join(' ') : null);
  }, [refreshServiceJobs]);
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

  async function cancelServiceJob(id: string) {
    setError(null);
    try {
      const response = await api(`/api/compute/service-jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not confirm the Image Lab cancellation request.');
      const updated = serviceJobsRef.current.map(job => job.public_id === id ? data : job);
      commitServiceJobs(updated, serviceNextCursorRef.current);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not request Image Lab cancellation.'); }
  }

  async function loadOlderServiceJobs() {
    if (!serviceNextCursorRef.current || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setError(null);
    try {
      await enqueueServiceRequest(async () => {
        const cursor = serviceNextCursorRef.current;
        if (!cursor) return;
        const response = await api(`/api/compute/service-jobs?cursor=${encodeURIComponent(cursor)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load older Image Lab jobs.');
        const byId = new Map(serviceJobsRef.current.map(job => [job.public_id, job]));
        for (const job of (data.jobs || []) as ServiceJob[]) byId.set(job.public_id, job);
        commitServiceJobs([...byId.values()], data.next_cursor ?? null);
      });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load older Image Lab jobs.'); }
    finally { loadingOlderRef.current = false; setLoadingOlder(false); }
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
    <Group justify="space-between"><Text fw={600}>CPU checks</Text><Button size="xs" variant="subtle" onClick={() => void refresh()}>Refresh</Button></Group>
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
    <Stack gap="xs">
      <Text fw={600}>Image Lab jobs</Text>
      <Text size="sm" c="dimmed">Pictures are started and stored in private Image Lab. This view shows safe service status only.</Text>
    </Stack>
    {!serviceJobs.length && <Text c="dimmed" size="sm">No Image Lab jobs to show yet.</Text>}
    {serviceJobs.map(job => {
      const cancellationPending = job.cancel_requested || job.status === 'cancelling';
      const stale = job.observation_stale || !job.owner_online || job.status === 'unknown';
      const badgeColor = job.status === 'succeeded' ? 'green' : job.status === 'failed' ? 'red' :
        job.status === 'cancelled' ? 'gray' : stale ? 'orange' : 'blue';
      const resultUrl = job.result_link_enabled === true && job.status === 'succeeded' && job.result_ready && REQUEST_KEY.test(job.public_id)
        ? `https://lab.internal:8444/?shared_job=${encodeURIComponent(job.public_id)}`
        : null;
      return <Card key={`image-lab-${job.public_id}`} withBorder padding="sm" style={{ minWidth: 0 }}><Stack gap="xs">
        <Group justify="space-between" wrap="wrap"><Text fw={600}>Image Lab • Cloudripper</Text>
          <Badge color={badgeColor}>{cancellationPending && !SERVICE_TERMINAL.has(job.status)
            ? 'Cancellation requested' : SERVICE_LABELS[job.status]}</Badge></Group>
        <Text size="xs" c="dimmed">{new Date(job.created_at).toLocaleString()}</Text>
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>Image job {job.public_id}</Text>
        {job.progress !== null && !SERVICE_TERMINAL.has(job.status) && <Stack gap={4}>
          <Progress value={job.progress} aria-label={`Image generation ${job.progress}% complete`} />
          <Text size="xs">{job.progress}% complete</Text>
        </Stack>}
        {stale && !SERVICE_TERMINAL.has(job.status) && <Alert color="orange" title="Image Lab status">
          {job.status === 'unknown' ? 'The current picture status is unavailable.' :
            'This status may be stale because Image Lab is not reporting a fresh observation.'}
        </Alert>}
        {job.result_ready && <Text size="sm">Picture ready in private Image Lab.</Text>}
        {resultUrl && <Button component="a" href={resultUrl} target="_blank" rel="noreferrer" size="xs" variant="light">
          Open picture in Image Lab
        </Button>}
        {cancellationPending && !SERVICE_TERMINAL.has(job.status) && <Text size="sm">
          Cancellation requested. Image Lab may continue briefly while it finishes or discards the picture.
        </Text>}
        {!SERVICE_TERMINAL.has(job.status) && <Button size="xs" variant="light" color="orange"
          disabled={cancellationPending} onClick={() => void cancelServiceJob(job.public_id)}>
          {cancellationPending ? 'Cancellation requested' : 'Cancel picture'}
        </Button>}
      </Stack></Card>;
    })}
    {serviceNextCursor && <Button variant="subtle" loading={loadingOlder} onClick={() => void loadOlderServiceJobs()}>
      Load older Image Lab jobs
    </Button>}
  </Stack></Drawer>;
}
