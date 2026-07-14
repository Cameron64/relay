// HTTP-level tests for GET /api/dispatches/next — the runner's long-poll for its next job.
// Covers the DISPATCH_POLL_HOLD_MS cap (fixes the production 502 cycle: Railway's edge proxy was
// killing the connection before the old 55s hold ever resolved — see routes-dispatch.ts's header
// comment on DISPATCH_POLL_HOLD_MS) and the wake-on-new-dispatch path. Run with DB_PATH=:memory:
// (package.json's test script) — store.ts's single in-memory bun:sqlite connection is shared
// across every test file in the process, so schema init + __resetForTests() mirror
// dispatch-store.test.ts's setup.
import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { dispatchRoutes, DISPATCH_POLL_HOLD_MS, computePollWaitMs } from './routes-dispatch.ts';
import { ensureDispatchSchema, validateDispatchInput, createDispatch, __resetForTests } from './dispatch-store.ts';

process.env.WRITE_TOKEN ||= 'test-write-token';
process.env.UI_TOKEN ||= 'test-ui-token';
const WRITE_HEADERS = { 'x-write-token': process.env.WRITE_TOKEN };
const UI_HEADERS = { authorization: `Bearer ${process.env.UI_TOKEN}` };

beforeAll(() => {
  ensureDispatchSchema();
});
beforeEach(() => {
  __resetForTests();
});

async function pollNext(qs = '') {
  return dispatchRoutes.request(`/dispatches/next${qs}`, { headers: WRITE_HEADERS });
}

async function json(res: Response): Promise<any> {
  return res.json();
}

// Composes directly against the store (no waiter wakeup) — used where the test doesn't care
// whether a parked long-poll gets woken.
function queueOne(over: Partial<{ body: string; target: string }> = {}) {
  const v = validateDispatchInput({ body: 'hello', target: 't1', ...over });
  if (!v.ok) throw new Error(v.error);
  const created = createDispatch(v.value);
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

// Goes through the real POST /dispatches route, which fires notifyDispatchWaiters() on success —
// this is what actually wakes a parked long-poll in production, so the "queued mid-hold" test
// below must compose through here, not straight through the store.
async function composeOne(over: Partial<{ body: string; target: string }> = {}) {
  const res = await dispatchRoutes.request('/dispatches', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...UI_HEADERS },
    body: JSON.stringify({ body: 'hello', target: 't1', ...over }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.dispatch;
}

describe('GET /dispatches/next', () => {
  test('wait=0 with nothing queued returns {status:"none"} immediately', async () => {
    const body = await json(await pollNext('?wait=0'));
    expect(body).toEqual({ status: 'none' });
  });

  test('a queued dispatch is returned right away, no hold needed', async () => {
    const d = queueOne();
    const body = await json(await pollNext('?wait=5'));
    expect(body.status).toBe('ok');
    expect(body.dispatch.id).toBe(d.id);
  });

  test('a dispatch queued mid-hold is delivered before the wait budget elapses', async () => {
    const pollP = pollNext('?wait=5');
    const d = await composeOne();
    const body = await json(await pollP);
    expect(body.status).toBe('ok');
    expect(body.dispatch.id).toBe(d.id);
  });

  test('a small requested wait is honored as-is (well under the hold cap)', async () => {
    const started = Date.now();
    const body = await json(await pollNext('?wait=1'));
    const elapsedMs = Date.now() - started;
    expect(body).toEqual({ status: 'none' });
    expect(elapsedMs).toBeLessThan(3000); // requested 1s honored, well under any cap
  });
});

describe('computePollWaitMs — the fix for the production 502 cycle', () => {
  // Railway's edge proxy was killing the connection once the old 55s cap outlasted its own
  // patience, surfacing as `WARN poll HTTP 502 "Application failed to respond"` on nearly every
  // poll. DISPATCH_POLL_HOLD_MS (default 25s — comfortably under the edge timeout) must always
  // win over whatever the runner requests via ?wait=N, however large.
  test('default hold is 25s unless overridden via env', () => {
    expect(DISPATCH_POLL_HOLD_MS).toBe(25_000);
  });

  test('a request under the hold is honored as-is', () => {
    expect(computePollWaitMs('5')).toBe(5000);
  });

  test('a request at/above the hold is capped to DISPATCH_POLL_HOLD_MS, never the full request', () => {
    expect(computePollWaitMs('50')).toBe(DISPATCH_POLL_HOLD_MS); // the runner's old default ask
    expect(computePollWaitMs('55')).toBe(DISPATCH_POLL_HOLD_MS); // the route's old hard cap
    expect(computePollWaitMs('9999')).toBe(DISPATCH_POLL_HOLD_MS);
  });

  test('missing/garbage/negative wait all resolve to 0 (no hold requested)', () => {
    expect(computePollWaitMs(undefined)).toBe(0);
    expect(computePollWaitMs('')).toBe(0);
    expect(computePollWaitMs('nonsense')).toBe(0);
    expect(computePollWaitMs('-5')).toBe(0);
  });
});
