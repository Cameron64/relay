import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ComputePanel } from './ComputePanel';
import { api } from '../api';

vi.mock('../api', () => ({ api: vi.fn() }));
const mockedApi = vi.mocked(api);
beforeEach(() => {
  localStorage.clear(); mockedApi.mockReset();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<MantineProvider><ComputePanel opened onClose={() => {}} /></MantineProvider>);
const serviceId = '22222222-2222-4222-8222-222222222222';
const serviceJob = {
  public_id: serviceId, sequence: 3, task: { kind: 'image.generate' as const, version: '1' as const },
  service: 'image-lab' as const, host: 'cloudripper' as const, capability: 'image-cpu' as const,
  status: 'running' as const, progress: 42, result_ready: false,
  owner_observed_at: '2026-09-12T16:00:00Z', created_at: '2026-09-12T15:59:00Z',
  updated_at: '2026-09-12T16:00:00Z', cancel_requested: false, owner_online: true,
  observation_stale: false,
};

describe('compute submission recovery', () => {
  test('corrupt persisted identity does not lock the form', () => {
    localStorage.setItem('relay-compute-pending-v1', JSON.stringify({request_key:'broken',host:'cloudripper',rounds:1000}));
    mockedApi.mockImplementation(async () => Response.json({jobs:[]}));
    mount();
    expect(screen.getByLabelText('Computer', {selector:'input'})).not.toBeDisabled();
    expect(screen.getByRole('button', {name:'Run test task'})).toBeEnabled();
    expect(localStorage.getItem('relay-compute-pending-v1')).toBeNull();
  });
  test.each([409, 422])('a definitive %s rejection releases the form', async status => {
    mockedApi.mockImplementation(async (_path, opts) => opts?.method === 'POST'
      ? Response.json({error:'Request rejected'}, {status}) : Response.json({jobs:[]}));
    mount();
    fireEvent.click(screen.getByRole('button', {name:'Run test task'}));
    await screen.findByText('Request rejected');
    expect(screen.getByLabelText('Computer', {selector:'input'})).not.toBeDisabled();
    expect(screen.getByRole('button', {name:'Run test task'})).toBeEnabled();
    expect(localStorage.getItem('relay-compute-pending-v1')).toBeNull();
  });
  test('completed work awaiting result delivery has no stop action', async () => {
    mockedApi.mockImplementation(async path => path.includes('service-jobs') ? Response.json({ jobs: [] }) : Response.json({jobs:[{
      public_id:'saved-work',status:'awaiting_delivery',placement:{host:'cloudripper'},
      created_at:new Date().toISOString(),cancel_requested:false,result:null,
    }]}));
    mount();
    await screen.findByText('Saving result');
    expect(screen.queryByRole('button', {name:'Stop task'})).toBeNull();
  });
  test('retry after a lost response uses the persisted request identity and inputs', async () => {
    const submissions: unknown[] = [];
    mockedApi.mockImplementation(async (_path, opts) => {
      if (opts?.method !== 'POST') return Response.json({ jobs: [] });
      submissions.push(JSON.parse(opts.body as string));
      if (submissions.length === 1) throw new Error('Response lost');
      return Response.json({ public_id: 'stable-job' }, { status: 202 });
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run test task' }));
    await screen.findByText('Response lost');
    expect(localStorage.getItem('relay-compute-pending-v1')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry submission' }));
    await waitFor(() => expect(submissions).toHaveLength(2));
    expect(submissions[0]).toEqual(submissions[1]);
    await waitFor(() => expect(localStorage.getItem('relay-compute-pending-v1')).toBeNull());
  });
  test('a reload resumes an unconfirmed Windows request without silently selecting Cloudripper', async () => {
    const request = { request_key: '11111111-1111-4111-8111-111111111111', host: 'current-windows', rounds: 50000 };
    localStorage.setItem('relay-compute-pending-v1', JSON.stringify(request));
    mockedApi.mockImplementation(async () => Response.json({ jobs: [] }));
    mount();
    expect(screen.getByLabelText('Computer', { selector: 'input' })).toHaveValue('Current Windows computer');
    expect(screen.getByLabelText('Computer', { selector: 'input' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry submission' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/api/compute/jobs', expect.objectContaining({ body: JSON.stringify(request) })));
  });
});

describe('Image Lab service jobs', () => {
  test('shows finite progress and stale or unknown owner state', async () => {
    mockedApi.mockImplementation(async path => path.includes('service-jobs') ? Response.json({ jobs: [
      serviceJob,
      { ...serviceJob, public_id: '33333333-3333-4333-8333-333333333333', status: 'unknown', progress: null,
        owner_online: false, observation_stale: true },
    ], next_cursor: null }) : Response.json({ jobs: [] }));
    mount();
    expect((await screen.findAllByText('Image Lab • Cloudripper'))).toHaveLength(2);
    expect(screen.getByText('Generating')).toBeInTheDocument();
    expect(screen.getByText('42% complete')).toBeInTheDocument();
    expect(screen.getByText('Status unavailable')).toBeInTheDocument();
    expect(screen.getByText('The current picture status is unavailable.')).toBeInTheDocument();
  });

  test('keeps cancellation pending until a terminal observation', async () => {
    mockedApi.mockImplementation(async (path, opts) => {
      if (path.endsWith('/cancel') && opts?.method === 'POST') {
        return Response.json({ ...serviceJob, status: 'cancelling', cancel_requested: true });
      }
      // A list replica can briefly return its older running view after cancel accepts.
      if (path.includes('service-jobs')) return Response.json({ jobs: [serviceJob], next_cursor: null });
      return Response.json({ jobs: [] });
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel picture' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(
      `/api/compute/service-jobs/${serviceId}/cancel`, { method: 'POST' },
    ));
    expect(await screen.findByText(/Image Lab may continue briefly/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancellation requested' })).toBeDisabled();
  });

  test('shows result readiness and no cancellation action for terminal jobs', async () => {
    mockedApi.mockImplementation(async path => path.includes('service-jobs') ? Response.json({ jobs: [
      { ...serviceJob, status: 'succeeded', progress: 100, result_ready: true, cancel_requested: true,
        owner_online: false, observation_stale: true, result_url: 'https://evil.example/private' },
      { ...serviceJob, public_id: '44444444-4444-4444-8444-444444444444', status: 'cancelled', progress: null },
    ], next_cursor: null }) : Response.json({ jobs: [] }));
    mount();
    expect(await screen.findByText('Picture ready in private Image Lab.')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText(/Image Lab may continue briefly/)).toBeNull();
    expect(screen.queryByText(/This status may be stale/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel picture' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open picture in Image Lab' })).toBeNull();
  });

  test('opens only an activated succeeded result at the fixed private Image Lab URL', async () => {
    mockedApi.mockImplementation(async path => path.includes('service-jobs') ? Response.json({ jobs: [
      { ...serviceJob, status: 'succeeded', progress: 100, result_ready: true, result_link_enabled: true,
        result_url: 'https://evil.example/private' },
    ], next_cursor: null }) : Response.json({ jobs: [] }));
    mount();

    const link = await screen.findByRole('link', { name: 'Open picture in Image Lab' });
    expect(link).toHaveAttribute('href', `https://lab.internal:8444/?shared_job=${serviceId}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link).not.toHaveAttribute('href', 'https://evil.example/private');
  });

  test('does not construct a result link from an invalid service identity', async () => {
    mockedApi.mockImplementation(async path => path.includes('service-jobs') ? Response.json({ jobs: [
      { ...serviceJob, public_id: 'javascript-alert', status: 'succeeded', progress: 100,
        result_ready: true, result_link_enabled: true },
    ], next_cursor: null }) : Response.json({ jobs: [] }));
    mount();

    await screen.findByText('Picture ready in private Image Lab.');
    expect(screen.queryByRole('link', { name: 'Open picture in Image Lab' })).toBeNull();
  });

  test('keeps the service identity readable at a phone viewport', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 412 });
    mockedApi.mockImplementation(async path => path.includes('service-jobs')
      ? Response.json({ jobs: [serviceJob], next_cursor: null }) : Response.json({ jobs: [] }));
    mount();
    const identity = await screen.findByText(`Image job ${serviceId}`);
    expect(identity).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(screen.getByRole('button', { name: 'Cancel picture' })).toBeVisible();
  });

  test('loads older service jobs with a validated cursor', async () => {
    const olderId = '55555555-5555-4555-8555-555555555555';
    mockedApi.mockImplementation(async path => {
      if (path === '/api/compute/service-jobs') return Response.json({ jobs: [serviceJob], next_cursor: serviceId });
      if (path === `/api/compute/service-jobs?cursor=${serviceId}`) return Response.json({
        jobs: [{ ...serviceJob, public_id: olderId, status: 'queued', progress: 0 }], next_cursor: null,
      });
      return Response.json({ jobs: [] });
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older Image Lab jobs' }));
    expect(await screen.findByText(`Image job ${olderId}`)).toBeInTheDocument();
    expect(mockedApi).toHaveBeenCalledWith(`/api/compute/service-jobs?cursor=${serviceId}`);
    expect(screen.queryByRole('button', { name: 'Load older Image Lab jobs' })).toBeNull();
  });

  test('refreshes every loaded page before replacing older active state', async () => {
    const olderId = '66666666-6666-4666-8666-666666666666';
    let olderLoaded = false;
    let olderFinished = false;
    mockedApi.mockImplementation(async path => {
      if (path === '/api/compute/service-jobs') return Response.json({ jobs: [serviceJob], next_cursor: serviceId });
      if (path === `/api/compute/service-jobs?cursor=${serviceId}`) {
        olderLoaded = true;
        return Response.json({ jobs: [{ ...serviceJob, public_id: olderId,
          status: olderFinished ? 'succeeded' : 'running', result_ready: olderFinished }], next_cursor: null });
      }
      return Response.json({ jobs: [] });
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older Image Lab jobs' }));
    expect(await screen.findByText(`Image job ${olderId}`)).toBeInTheDocument();
    expect(olderLoaded).toBe(true);
    olderFinished = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Picture ready in private Image Lab.')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Cancel picture' })).toHaveLength(1);
  });

  test('a delayed older observation cannot regress a newer terminal cancellation response', async () => {
    const firstObservation = { ...serviceJob, sequence: 1 };
    let listCalls = 0;
    let releaseDelayed: (response: Response) => void = () => {};
    const delayed = new Promise<Response>(resolve => { releaseDelayed = resolve; });
    mockedApi.mockImplementation(async (path, opts) => {
      if (path.endsWith('/cancel') && opts?.method === 'POST') return Response.json({
        ...serviceJob, sequence: 2, status: 'succeeded', progress: 100, result_ready: true, cancel_requested: true,
      });
      if (path === '/api/compute/service-jobs') {
        listCalls += 1;
        if (listCalls === 2) return delayed;
        return Response.json({ jobs: [firstObservation], next_cursor: null });
      }
      return Response.json({ jobs: [] });
    });
    mount();
    const cancelButton = await screen.findByRole('button', { name: 'Cancel picture' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(listCalls).toBe(2));
    fireEvent.click(cancelButton);
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(
      `/api/compute/service-jobs/${serviceId}/cancel`, { method: 'POST' },
    ));
    releaseDelayed(Response.json({ jobs: [firstObservation], next_cursor: null }));
    expect(await screen.findByText('Picture ready in private Image Lab.')).toBeInTheDocument();
    expect(listCalls).toBe(2);
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel picture' })).toBeNull();
  });

  test('serializes an older-page load behind an active refresh so the page remains visible', async () => {
    const olderId = '77777777-7777-4777-8777-777777777777';
    let firstPageCalls = 0;
    let olderPageCalls = 0;
    let releaseRefresh: (response: Response) => void = () => {};
    const delayedRefresh = new Promise<Response>(resolve => { releaseRefresh = resolve; });
    mockedApi.mockImplementation(async path => {
      if (path === '/api/compute/service-jobs') {
        firstPageCalls += 1;
        if (firstPageCalls === 2) return delayedRefresh;
        return Response.json({ jobs: [serviceJob], next_cursor: serviceId });
      }
      if (path === `/api/compute/service-jobs?cursor=${serviceId}`) {
        olderPageCalls += 1;
        return Response.json({ jobs: [{ ...serviceJob, public_id: olderId }], next_cursor: null });
      }
      return Response.json({ jobs: [] });
    });
    mount();
    const loadOlder = await screen.findByRole('button', { name: 'Load older Image Lab jobs' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(firstPageCalls).toBe(2));
    fireEvent.click(loadOlder);
    await Promise.resolve();
    expect(olderPageCalls).toBe(0);
    releaseRefresh(Response.json({ jobs: [serviceJob], next_cursor: serviceId }));
    expect(await screen.findByText(`Image job ${olderId}`)).toBeInTheDocument();
    expect(olderPageCalls).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByText(`Image job ${olderId}`)).toBeInTheDocument();
  });
});
