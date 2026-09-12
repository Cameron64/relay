// Separate compatibility route: never writes the legacy dispatch queue or exposes its claims.
import { Hono } from 'hono';
import { requireUi } from './session.ts';

type ComputeConfig = { url: string; token: string; imageLabResultLinkEnabled?: boolean };
type ComputeOptions = {
  config?: () => ComputeConfig;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SERVICE_STATUSES = new Set(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'unknown']);

type ServiceJob = {
  public_id: string;
  sequence: number;
  task: { kind: 'image.generate'; version: '1' };
  service: 'image-lab';
  host: 'cloudripper';
  capability: 'image-cpu';
  status: string;
  progress: number | null;
  result_ready: boolean;
  owner_observed_at: string;
  created_at: string;
  updated_at: string;
  cancel_requested: boolean;
  owner_online: boolean;
  observation_stale: boolean;
  result_link_enabled?: true;
};

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sanitizeServiceJob(value: any, imageLabResultLinkEnabled = false): ServiceJob {
  const ownerObservedAt = canonicalTimestamp(value?.owner_observed_at);
  const createdAt = canonicalTimestamp(value?.created_at);
  const updatedAt = canonicalTimestamp(value?.updated_at);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.public_id !== 'string' || !UUID.test(value.public_id) ||
    !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
    value.task?.kind !== 'image.generate' || value.task?.version !== '1' ||
    value.service !== 'image-lab' || value.host !== 'cloudripper' || value.capability !== 'image-cpu' ||
    typeof value.status !== 'string' || !SERVICE_STATUSES.has(value.status) ||
    !(value.progress === null || (Number.isInteger(value.progress) && value.progress >= 0 && value.progress <= 100)) ||
    typeof value.result_ready !== 'boolean' || value.result_ready !== (value.status === 'succeeded') ||
    ownerObservedAt === null || createdAt === null || updatedAt === null ||
    typeof value.cancel_requested !== 'boolean' || typeof value.owner_online !== 'boolean' ||
    typeof value.observation_stale !== 'boolean') {
    throw new Error('invalid service job response');
  }
  const job: ServiceJob = {
    public_id: value.public_id, sequence: value.sequence,
    task: { kind: 'image.generate', version: '1' }, service: 'image-lab',
    host: 'cloudripper', capability: 'image-cpu', status: value.status,
    progress: value.progress, result_ready: value.result_ready,
    owner_observed_at: ownerObservedAt, created_at: createdAt, updated_at: updatedAt,
    cancel_requested: value.cancel_requested, owner_online: value.owner_online,
    observation_stale: value.observation_stale,
  };
  // Never forward a URL supplied by the coordinator. This local marker lets
  // the browser construct the one fixed private Image Lab destination after
  // production activation, and only for a completed result.
  if (imageLabResultLinkEnabled && job.status === 'succeeded' && job.result_ready) {
    job.result_link_enabled = true;
  }
  return job;
}

export function createComputeRoutes(options: ComputeOptions = {}) {
  const routes = new Hono();
  const config = options.config ?? (() => ({
    url: process.env.COMPUTE_API_URL || '',
    token: process.env.COMPUTE_APP_TOKEN || '',
    imageLabResultLinkEnabled: process.env.IMAGE_LAB_RESULT_LINK_ENABLED === '1',
  }));
  const upstreamFetch = options.fetch ?? globalThis.fetch;
  routes.use('/compute/*', requireUi);

  async function proxy(c: any, path: string, method = 'GET', body?: unknown) {
    const settings = config();
    if (!settings.url || !settings.token) return c.json({ error: 'Compute pilot is not enabled.' }, 503);
    try {
      const base = new URL(settings.url);
      if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        return c.json({ error: 'Compute pilot configuration is invalid.' }, 503);
      }
      const response = await upstreamFetch(`${base.toString().replace(/\/$/, '')}${path}`, {
        method,
        redirect: 'error',
        headers: { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(12_000),
      });
      // Error details can contain upstream internals or rejected payloads. Keep them server-side
      // without logging credentials/payloads, and expose only a stable status to the phone.
      if (!response.ok) {
        const status = [400, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 502;
        return c.json({ error: status === 409 ? 'Request conflicts with an existing job.' : 'Compute request could not be completed.' }, status);
      }
      const result = await response.json();
      return c.json(result, response.status);
    } catch {
      return c.json({ error: 'Compute service is unavailable. Your accepted jobs keep their IDs.' }, 502);
    }
  }

  async function proxyServiceJobs(c: any, path: string, method = 'GET', list = false) {
    c.header('Cache-Control', 'no-store');
    const settings = config();
    if (!settings.url || !settings.token) return c.json({ error: 'Compute pilot is not enabled.' }, 503);
    try {
      const base = new URL(settings.url);
      if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        return c.json({ error: 'Compute pilot configuration is invalid.' }, 503);
      }
      const response = await upstreamFetch(`${base.toString().replace(/\/$/, '')}${path}`, {
        method,
        redirect: 'error',
        cache: 'no-store',
        headers: { authorization: `Bearer ${settings.token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        const status = [400, 404, 409, 422, 429, 503].includes(response.status) ? response.status : 502;
        return c.json({ error: status === 409 ? 'Request conflicts with an existing job.' : 'Compute request could not be completed.' }, status);
      }
      const payload = await response.json() as any;
      if (list) {
        if (!payload || !Array.isArray(payload.jobs) || payload.jobs.length > 100 ||
          !(payload.next_cursor === null || (typeof payload.next_cursor === 'string' && UUID.test(payload.next_cursor)))) {
          throw new Error('invalid list');
        }
        return c.json({
          jobs: payload.jobs.map((job: unknown) => sanitizeServiceJob(job, settings.imageLabResultLinkEnabled === true)),
          next_cursor: payload.next_cursor,
        }, response.status);
      }
      return c.json(sanitizeServiceJob(payload, settings.imageLabResultLinkEnabled === true), response.status);
    } catch {
      return c.json({ error: 'Compute service is unavailable.' }, 502);
    }
  }

  routes.get('/compute/capabilities', (c) => proxy(c, '/v1/capabilities'));
  routes.get('/compute/jobs', (c) => proxy(c, '/v1/jobs'));
  routes.get('/compute/service-jobs', (c) => {
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && !UUID.test(cursor)) {
      return c.json({ error: 'Invalid service job cursor.' }, 400, { 'Cache-Control': 'no-store' });
    }
    const suffix = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    return proxyServiceJobs(c, `/v1/service/jobs?limit=100${suffix}`, 'GET', true);
  });
  routes.get('/compute/service-jobs/:id', (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'Invalid service job ID.' }, 400, { 'Cache-Control': 'no-store' });
    return proxyServiceJobs(c, `/v1/service/jobs/${id}`);
  });
  routes.post('/compute/service-jobs/:id/cancel', (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'Invalid service job ID.' }, 400, { 'Cache-Control': 'no-store' });
    return proxyServiceJobs(c, `/v1/service/jobs/${id}/cancel`, 'POST');
  });
  routes.get('/compute/jobs/:id', (c) => {
    const id = c.req.param('id');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return c.json({ error: 'Invalid job ID.' }, 400);
    return proxy(c, `/v1/jobs/${id}`);
  });
  routes.post('/compute/jobs/:id/cancel', (c) => {
    const id = c.req.param('id');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return c.json({ error: 'Invalid job ID.' }, 400);
    return proxy(c, `/v1/jobs/${id}/cancel`, 'POST');
  });
  // The UI route accepts a tiny numeric test request, then constructs the registered job.
  // Private prompts, paths, shell commands and arbitrary task parameters cannot be forwarded.
  routes.post('/compute/jobs', async (c) => {
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required.' }, 415);
    const text = await c.req.text();
    if (text.length > 2048) return c.json({ error: 'Request too large.' }, 413);
    let value: any;
    try { value = JSON.parse(text); } catch { return c.json({ error: 'Invalid JSON.' }, 400); }
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['request_key', 'host', 'rounds'].includes(key)) ||
      typeof value.request_key !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.request_key) ||
      !['cloudripper', 'current-windows'].includes(value.host) ||
      ![1000, 10000, 50000].includes(value.rounds)) {
      return c.json({ error: 'Choose a computer and a valid synthetic workload.' }, 422);
    }
    return proxy(c, '/v1/jobs', 'POST', {
      request_key: value.request_key,
      task: { kind: 'cpu.sha256', version: '1' },
      input: { seed: 'compute-pilot', rounds: value.rounds, chunk_bytes: 1048576 },
      placement: { host: value.host, capability: value.host === 'cloudripper' ? 'linux-cpu' : 'windows-native' },
      resources: { cpu_cores: 1, memory_mb: 256, timeout_seconds: 120 },
    });
  });
  return routes;
}

export const computeRoutes = createComputeRoutes();
