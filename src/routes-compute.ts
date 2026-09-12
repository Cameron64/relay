// Separate compatibility route: never writes the legacy dispatch queue or exposes its claims.
import { Hono } from 'hono';
import { requireUi } from './session.ts';

type ComputeConfig = { url: string; token: string };
type ComputeOptions = {
  config?: () => ComputeConfig;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export function createComputeRoutes(options: ComputeOptions = {}) {
  const routes = new Hono();
  const config = options.config ?? (() => ({
    url: process.env.COMPUTE_API_URL || '',
    token: process.env.COMPUTE_APP_TOKEN || '',
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

  routes.get('/compute/capabilities', (c) => proxy(c, '/v1/capabilities'));
  routes.get('/compute/jobs', (c) => proxy(c, '/v1/jobs'));
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
