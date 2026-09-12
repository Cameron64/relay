import { describe, expect, test } from 'bun:test';
import { createComputeRoutes } from './routes-compute.ts';

process.env.UI_TOKEN ||= 'test-ui-token';
const headers = { authorization: `Bearer ${process.env.UI_TOKEN}`, 'content-type': 'application/json' };
const request = { request_key: '11111111-1111-4111-8111-111111111111', host: 'cloudripper', rounds: 1000 };

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
});
