import { describe, expect, test } from 'bun:test';
import { createComputeRoutes } from './routes-compute.ts';

process.env.UI_TOKEN ||= 'test-ui-token';
const headers = { authorization: `Bearer ${process.env.UI_TOKEN}`, 'content-type': 'application/json' };
const request = { request_key: '11111111-1111-4111-8111-111111111111', host: 'cloudripper', rounds: 1000 };
const serviceId = '22222222-2222-4222-8222-222222222222';
const serviceJob = {
  public_id: serviceId,
  sequence: 3,
  task: { kind: 'image.generate', version: '1' },
  service: 'image-lab',
  host: 'cloudripper',
  capability: 'image-cpu',
  status: 'running',
  progress: 42,
  result_ready: false,
  owner_observed_at: '2026-09-12T16:00:00.000Z',
  created_at: '2026-09-12T15:59:00.000Z',
  updated_at: '2026-09-12T16:00:00.000Z',
  cancel_requested: false,
  owner_online: true,
  observation_stale: false,
};

describe('compute compatibility boundary', () => {
  test('requires the existing UI identity before contacting the coordinator', async () => {
    let called = false;
    const routes = createComputeRoutes({ fetch: async () => { called = true; return Response.json({}); } });
    expect((await routes.request('/compute/jobs')).status).toBe(401);
    expect(called).toBe(false);
  });
  test('fails closed when the pilot has no credentials', async () => {
    const routes = createComputeRoutes({ config: () => ({ url: '', token: '' }) });
    expect((await routes.request('/compute/jobs', { headers })).status).toBe(503);
  });
  test('forwards only the registered request with a server-held token', async () => {
    let forwarded: any;
    let destination: any;
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'server-secret' }),
      fetch: async (url: any, init: any) => { destination = url; forwarded = init; return Response.json({ public_id: 'job-1' }, { status: 202 }); },
    });
    const response = await routes.request('/compute/jobs', { method: 'POST', headers, body: JSON.stringify(request) });
    expect(response.status).toBe(202);
    expect(destination).toBe('https://compute.example/v1/jobs');
    expect(forwarded.headers.authorization).toBe('Bearer server-secret');
    expect(JSON.parse(forwarded.body).input).toEqual({ seed: 'compute-pilot', rounds: 1000, chunk_bytes: 1048576 });
    expect(forwarded.redirect).toBe('error');
    expect(await response.text()).not.toContain('server-secret');
  });
  test('rejects private/arbitrary fields before any upstream request', async () => {
    let called = false;
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async () => { called = true; return Response.json({}); },
    });
    const response = await routes.request('/compute/jobs', { method: 'POST', headers, body: JSON.stringify({ ...request, prompt: 'private sentinel' }) });
    expect(response.status).toBe(422);
    expect(called).toBe(false);
  });
  test('does not expose claims, observations, private results or arbitrary proxy paths', async () => {
    const routes = createComputeRoutes();
    for (const path of ['/compute/next', '/compute/observations', '/compute/admin', '/compute/jobs/id/claim']) {
      expect((await routes.request(path, { headers })).status).toBe(404);
    }
  });
  test('sanitizes backend failure bodies', async () => {
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async () => Response.json({ detail: 'secret internal error' }, { status: 500 }),
    });
    const response = await routes.request('/compute/jobs', { headers });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('secret internal error');
  });

  test('requires UI identity for service jobs before contacting the coordinator', async () => {
    let called = false;
    const routes = createComputeRoutes({ fetch: async () => { called = true; return Response.json({}); } });
    expect((await routes.request('/compute/service-jobs')).status).toBe(401);
    expect(called).toBe(false);
  });

  test('lists only sanitized Image Lab service metadata with the server credential', async () => {
    let destination: unknown;
    let forwarded: RequestInit | undefined;
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example/', token: 'service-secret' }),
      fetch: async (url, init) => {
        destination = url;
        forwarded = init;
        return Response.json({ jobs: [{ ...serviceJob, private_prompt: 'do not expose this', result_url: 'https://evil.example/private' }], next_cursor: serviceId });
      },
    });
    const response = await routes.request('/compute/service-jobs', { headers });
    expect(response.status).toBe(200);
    expect(destination).toBe('https://compute.example/v1/service/jobs?limit=100');
    expect(forwarded?.method).toBe('GET');
    expect((forwarded?.headers as Record<string, string>).authorization).toBe('Bearer service-secret');
    expect(forwarded?.redirect).toBe('error');
    expect(forwarded?.cache).toBe('no-store');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await response.json() as any;
    expect(payload).toEqual({ jobs: [serviceJob], next_cursor: serviceId });
    expect(JSON.stringify(payload)).not.toContain('do not expose this');
    expect(JSON.stringify(payload)).not.toContain('evil.example');
  });

  test('enables only the fixed local result-link marker for eligible completed Image Lab jobs', async () => {
    const succeeded = { ...serviceJob, status: 'succeeded', progress: 100, result_ready: true };
    const routes = createComputeRoutes({
      config: () => ({
        url: 'https://compute.example', token: 'test', imageLabResultLinkEnabled: true,
      }),
      fetch: async () => Response.json({
        jobs: [
          { ...succeeded, result_url: 'https://evil.example/private' },
          { ...serviceJob, public_id: '33333333-3333-4333-8333-333333333333', result_url: 'javascript:alert(1)' },
        ],
        next_cursor: null,
      }),
    });

    const response = await routes.request('/compute/service-jobs', { headers });
    expect(response.status).toBe(200);
    const payload = await response.json() as any;
    expect(payload.jobs[0]).toEqual({ ...succeeded, result_link_enabled: true });
    expect(payload.jobs[1]).toEqual({ ...serviceJob, public_id: '33333333-3333-4333-8333-333333333333' });
    expect(JSON.stringify(payload)).not.toContain('evil.example');
    expect(JSON.stringify(payload)).not.toContain('javascript:');
  });

  test('validates service job UUIDs locally for reads and cancellation', async () => {
    let called = false;
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async () => { called = true; return Response.json(serviceJob); },
    });
    expect((await routes.request('/compute/service-jobs/not-a-uuid', { headers })).status).toBe(400);
    expect((await routes.request('/compute/service-jobs/not-a-uuid/cancel', { method: 'POST', headers })).status).toBe(400);
    expect((await routes.request('/compute/service-jobs?cursor=not-a-uuid', { headers })).status).toBe(400);
    expect(called).toBe(false);
  });

  test('forwards a validated service cursor without widening the route', async () => {
    let destination: unknown;
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async url => { destination = url; return Response.json({ jobs: [], next_cursor: null }); },
    });
    expect((await routes.request(`/compute/service-jobs?cursor=${serviceId}`, { headers })).status).toBe(200);
    expect(destination).toBe(`https://compute.example/v1/service/jobs?limit=100&cursor=${serviceId}`);
  });

  test('gets one service job through its fixed metadata route', async () => {
    let destination: unknown;
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async url => { destination = url; return Response.json(serviceJob); },
    });
    const response = await routes.request(`/compute/service-jobs/${serviceId}`, { headers });
    expect(response.status).toBe(200);
    expect(destination).toBe(`https://compute.example/v1/service/jobs/${serviceId}`);
    expect(await response.json()).toEqual(serviceJob);
  });

  test('cancels only the selected service job and returns sanitized state', async () => {
    let destination: unknown;
    let forwarded: RequestInit | undefined;
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'service-secret' }),
      fetch: async (url, init) => {
        destination = url;
        forwarded = init;
        return Response.json({ ...serviceJob, status: 'cancelling', cancel_requested: true, private_result: 'hidden' });
      },
    });
    const response = await routes.request(`/compute/service-jobs/${serviceId}/cancel`, { method: 'POST', headers });
    expect(response.status).toBe(200);
    expect(destination).toBe(`https://compute.example/v1/service/jobs/${serviceId}/cancel`);
    expect(forwarded?.method).toBe('POST');
    const payload = await response.json() as any;
    expect(payload.status).toBe('cancelling');
    expect(payload.cancel_requested).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('hidden');
  });

  test('fails closed on malformed or private upstream service responses', async () => {
    const malformed = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async () => Response.json({ jobs: [{ ...serviceJob, status: 'private-state', private_prompt: 'sentinel' }], next_cursor: null }),
    });
    const malformedResponse = await malformed.request('/compute/service-jobs', { headers });
    expect(malformedResponse.status).toBe(502);
    expect(await malformedResponse.text()).not.toContain('sentinel');

    const rejected = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async () => Response.json({ detail: 'credential scope internals' }, { status: 403 }),
    });
    const rejectedResponse = await rejected.request('/compute/service-jobs', { headers });
    expect(rejectedResponse.status).toBe(502);
    expect(await rejectedResponse.text()).not.toContain('credential scope internals');
  });

  test('canonicalizes accepted timestamps so parser comments cannot cross the boundary', async () => {
    const routes = createComputeRoutes({
      config: () => ({ url: 'https://compute.example', token: 'test' }),
      fetch: async () => Response.json({
        jobs: [{ ...serviceJob, owner_observed_at: '2026-09-12 (PRIVATE_SENTINEL)' }], next_cursor: null,
      }),
    });
    const response = await routes.request('/compute/service-jobs', { headers });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('PRIVATE_SENTINEL');
    expect(JSON.parse(text).jobs[0].owner_observed_at).toBe('2026-09-12T00:00:00.000Z');
  });

  test('rejects zero or unsafe service observation sequences', async () => {
    for (const sequence of [0, Number.MAX_SAFE_INTEGER + 1]) {
      const routes = createComputeRoutes({
        config: () => ({ url: 'https://compute.example', token: 'test' }),
        fetch: async () => Response.json({ jobs: [{ ...serviceJob, sequence }], next_cursor: null }),
      });
      expect((await routes.request('/compute/service-jobs', { headers })).status).toBe(502);
    }
  });
});
