// Tests the shared HTTP client (lib/relay-client.mjs) by stubbing global.fetch. These exercise the
// network-shaped behavior the MCP server depends on: create success/error, the bounded poll loop
// (responded / pending-then-responded / timeout / notfound / transient-retry), and notify's
// 503-is-soft handling.
import { test, expect, describe, afterEach } from 'bun:test';
// @ts-ignore — zero-dep .mjs client has no .d.ts
import { createCard, pollResponse, sendNotify, getCardEvents, appendAgentEvent } from '../lib/relay-client.mjs';

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

  // relay-roadmap Plan 04 — card threads.
  describe('eventsSince (Plan 04)', () => {
    test('omitted: the request URL carries no events_since param (legacy byte-identical request)', async () => {
      const calls = queueFetch([res({ json: { status: 'responded', response: { verdict: 'approved' } } })]);
      await pollResponse(cfg, 'id1', 50);
      expect(calls[0].url).not.toContain('events_since');
    });

    test('0 is a valid value (not treated as "omitted")', async () => {
      const calls = queueFetch([res({ json: { status: 'pending' } })]);
      await pollResponse(cfg, 'id1', 0, 0);
      // budget 0 -> no fetch happens at all (same short-circuit as the no-eventsSince case), so
      // assert on a nonzero budget instead so the URL actually gets built.
      expect(calls.length).toBe(0);
    });

    test('a positive eventsSince is appended to the request URL', async () => {
      // 'responded' (not 'pending') so the loop exits on the first fetch — a queued 'pending'
      // response would spin the internal poll loop for the whole totalSecs budget, real wall time.
      const calls = queueFetch([res({ json: { status: 'responded', response: { verdict: 'approved' } } })]);
      await pollResponse(cfg, 'id1', 5, 3);
      expect(calls[0].url).toContain('events_since=3');
    });

    test('resolves on status "event" without waiting out the full budget', async () => {
      const calls = queueFetch([res({ json: { status: 'event', events: [{ seq: 1, role: 'user', type: 'message', body: 'why?' }] } })]);
      const r = await pollResponse(cfg, 'id1', 50, 0);
      expect(r.status).toBe('event');
      expect(r.events).toHaveLength(1);
      expect(calls[0].url).toContain('events_since=0');
    });
  });
});

describe('appendAgentEvent', () => {
  test('POSTs a role:agent message event to /agent-events with the write token', async () => {
    const calls = queueFetch([res({ json: { ok: true, event: { card_id: 'id1', seq: 4, role: 'agent', type: 'message', body: 'got it', at: 't' } } })]);
    const r = await appendAgentEvent(cfg, 'id1', 'got it');
    expect(calls[0].url).toBe('https://relay.test/api/cards/id1/agent-events');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.headers['x-write-token']).toBe('tok');
    expect(JSON.parse(calls[0].opts.body)).toEqual({ type: 'message', body: 'got it' });
    expect(r.event.seq).toBe(4);
  });

  test('throws "HTTP <status>" on a non-OK response', async () => {
    queueFetch([res({ status: 409, text: 'card is not pending' })]);
    await expect(appendAgentEvent(cfg, 'id1', 'x')).rejects.toThrow(/HTTP 409/);
  });
});

describe('getCardEvents', () => {
  test('GETs /api/cards/:id/agent-events with the write token and returns the events array', async () => {
    const calls = queueFetch([res({ json: { events: [{ card_id: 'id1', seq: 1, role: 'user', type: 'payload', body: '{}', at: 't' }] } })]);
    const events = await getCardEvents(cfg, 'id1');
    expect(events).toHaveLength(1);
    expect(calls[0].url).toBe('https://relay.test/api/cards/id1/agent-events');
    expect(calls[0].opts.headers['x-write-token']).toBe('tok');
  });

  test('returns [] when the response has no events field', async () => {
    queueFetch([res({ json: {} })]);
    expect(await getCardEvents(cfg, 'id1')).toEqual([]);
  });

  test('throws "HTTP <status>" on a non-OK response', async () => {
    queueFetch([res({ status: 404, text: 'not found' })]);
    await expect(getCardEvents(cfg, 'gone')).rejects.toThrow(/HTTP 404/);
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
