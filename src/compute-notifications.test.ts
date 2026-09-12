import { beforeAll, describe, expect, test } from 'bun:test';
import { db } from './store.ts';
import { ensureCardsSchema } from './cards-store.ts';
import { ensureComputeNotificationsSchema, recordComputeCompletion, syncComputeNotifications, type ComputeCompletion } from './compute-notifications.ts';

beforeAll(() => { ensureCardsSchema(); ensureComputeNotificationsSchema(); });
const job: ComputeCompletion = { public_id: 'compute-test-job', status: 'succeeded', placement: { host: 'cloudripper' },
  result: { receipt_id: 'compute-test-receipt', summary: { algorithm: 'sha256', digest: 'a'.repeat(64), rounds: 1000, chunk_bytes: 1048576 } } };

describe('compute result card commits', () => {
  test('a malformed first result does not block the next valid result or acknowledge the bad item', async () => {
    const valid = {...job,public_id:'poison-test-valid',result:{...job.result,receipt_id:'poison-test-valid-receipt'}};
    const calls: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      return url.endsWith('/pending') ? Response.json({jobs:[{...job,status:'running'},valid]}) : Response.json({ok:true});
    }) as typeof fetch;
    await syncComputeNotifications('https://compute.invalid', 'test-only', fetcher);
    expect(calls).toEqual(['https://compute.invalid/v1/notifications/pending',
      'https://compute.invalid/v1/notifications/poison-test-valid-receipt/ack']);
    const row = db.query('SELECT count(*) AS n FROM compute_notification_receipts WHERE job_id = ?').get(valid.public_id) as any;
    expect(row.n).toBe(1);
  });
  test('a retry after lost acknowledgement returns the same committed card', () => {
    const first = recordComputeCompletion(job);
    const retry = recordComputeCompletion(JSON.parse(JSON.stringify(job)));
    expect(first.created).toBe(true);
    expect(retry).toEqual({ card_id: first.card_id, created: false });
    const count = db.query('SELECT count(*) AS n FROM compute_notification_receipts WHERE job_id = ?').get(job.public_id) as any;
    expect(count.n).toBe(1);
  });
  test('a conflicting receipt is rejected instead of changing an existing result', () => {
    expect(() => recordComputeCompletion({ ...job, result: { ...job.result, summary: { ...job.result.summary, digest: 'b'.repeat(64) } } })).toThrow('conflict');
  });
  test('only validated committed synthetic results create cards', () => {
    expect(() => recordComputeCompletion({ ...job, status: 'running' })).toThrow('Invalid');
    expect(() => recordComputeCompletion({ ...job, result: { ...job.result, summary: { ...job.result.summary, digest: 'private payload' } } })).toThrow('Invalid');
  });
});
