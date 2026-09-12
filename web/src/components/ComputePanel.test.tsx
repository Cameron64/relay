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
    mockedApi.mockImplementation(async () => Response.json({jobs:[{
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
