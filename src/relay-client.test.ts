// Tests the shared HTTP client (lib/relay-client.mjs) by stubbing global.fetch. These exercise the
// network-shaped behavior the MCP server depends on: create success/error, the bounded poll loop
// (responded / pending-then-responded / timeout / notfound / transient-retry), and notify's
// 503-is-soft handling.
import { test, expect, describe, afterEach } from 'bun:test';
// @ts-ignore — zero-dep .mjs client has no .d.ts
import { createCard, pollResponse, sendNotify } from '../lib/relay-client.mjs';

const cfg = { url: 'https://relay.test', writeToken: 'tok' };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function res({ status = 200, json, text }: { status?: number; json?: any; text?: string }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (json === undefined) throw new Error('no json');
      return json;
    },
    text: async () => (text !== undefined ? text : json !== undefined ? JSON.stringify(json) : ''),
  };
}

// Queue of fetch outcomes: a response object, an Error (to throw), or a function returning one.
// The last entry repeats if more calls happen.
function queueFetch(responses: any[]) {
  const calls: any[] = [];
  let i = 0;
  globalThis.fetch = (async (url: any, opts: any) => {
    calls.push({ url: String(url), opts });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  }) as any;
  return calls;
}

describe('createCard', () => {
  test('POSTs to /api/cards with the write token and returns the created card', async () => {
    const calls = queueFetch([res({ json: { id: 'abc', url: '/?card=abc' } })]);
    const r = await createCard(cfg, { title: 'x' });
    expect(r.id).toBe('abc');
    expect(calls[0].url).toBe('https://relay.test/api/cards');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers['x-write-token']).toBe('tok');
  });

  test('throws "HTTP <status>" on a non-OK response', async () => {
    queueFetch([res({ status: 400, text: 'bad payload' })]);
    await expect(createCard(cfg, {})).rejects.toThrow(/HTTP 400/);
  });
});

describe('pollResponse', () => {
  test('returns the responded payload on the first poll', async () => {
    queueFetch([res({ json: { status: 'responded', response: { verdict: 'approved', note: null } } })]);
    const r = await pollResponse(cfg, 'id1', 50);
    expect(r.status).toBe('responded');
    expect(r.response.verdict).toBe('approved');
  });

  test('keeps polling while the server returns pending, then resolves', async () => {
    queueFetch([
      res({ json: { status: 'pending' } }),
      res({ json: { status: 'responded', response: { verdict: 'reply', note: 'hi' } } }),
    ]);
    const r = await pollResponse(cfg, 'id1', 50);
    expect(r.status).toBe('responded');
    expect(r.response.verdict).toBe('reply');
  });

  test('returns pending immediately when the budget is zero (no fetch)', async () => {
    const calls = queueFetch([res({ json: { status: 'responded', response: {} } })]);
    const r = await pollResponse(cfg, 'id1', 0);
    expect(r.status).toBe('pending');
    expect(calls.length).toBe(0);
  });

  test('returns notfound on a 404', async () => {
    queueFetch([res({ status: 404 })]);
    const r = await pollResponse(cfg, 'gone', 50);
    expect(r.status).toBe('notfound');
  });

  test('retries a transient network error within the budget', async () => {
    queueFetch([new Error('ECONNRESET'), res({ json: { status: 'responded', response: { verdict: 'approved' } } })]);
    const r = await pollResponse(cfg, 'id1', 50);
    expect(r.status).toBe('responded');
  });
});

describe('sendNotify', () => {
  test('returns ok:true with the body on success', async () => {
    queueFetch([res({ status: 200, text: 'sent 1' })]);
    const r = await sendNotify(cfg, { title: 'x' });
    expect(r.ok).toBe(true);
    expect(r.body).toBe('sent 1');
  });

  test('treats 503 (push not configured) as a soft non-failure', async () => {
    queueFetch([res({ status: 503, text: 'no subscriptions' })]);
    const r = await sendNotify(cfg, {});
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('push-not-configured');
  });

  test('throws on any other non-OK status', async () => {
    queueFetch([res({ status: 500, text: 'boom' })]);
    await expect(sendNotify(cfg, {})).rejects.toThrow(/HTTP 500/);
  });
});
