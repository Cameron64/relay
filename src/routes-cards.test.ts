// HTTP-level tests for the Plan 04 poll unification on GET /api/cards/:id/response — per the
// plan's Gotchas, "the whole risk in this plan is the poll unification", so this exercises the
// route directly (Hono apps are callable via appRoutes.request(...) without a real server/socket)
// rather than only the underlying waiters.ts composition. Run with DB_PATH=:memory: (package.json's
// test script) — store.ts's single in-memory bun:sqlite connection is shared across every test
// file in the process, so schema init + __resetForTests() here mirror cards-store.test.ts's setup.
import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { appRoutes, shouldPushThreadReply } from './routes-cards.ts';
import { ensureCardsSchema, createCard, __resetForTests } from './cards-store.ts';
import { store } from './store.ts';
import { ensureNotifyLogSchema, listNotifications, __resetForTests as resetNotifyLog } from './notify-log.ts';

// Tests don't depend on real tokens — fall back to fixed values if .env didn't supply them, but
// don't clobber whatever's already set (other test files in this same process may read them too).
process.env.WRITE_TOKEN ||= 'test-write-token';
process.env.UI_TOKEN ||= 'test-ui-token';
const WRITE_HEADERS = { 'x-write-token': process.env.WRITE_TOKEN };
const UI_HEADERS = { authorization: `Bearer ${process.env.UI_TOKEN}` };

function input(over: Partial<Parameters<typeof createCard>[0]> = {}) {
  return {
    kind: 'approval',
    title: 'x',
    body: null,
    buttons: [{ id: 'approved', label: 'Approve', behavior: 'respond' as const, verdict: 'approved' }],
    options: [],
    copy_text: null,
    mermaid: null,
    page_html: null,
    source: null,
    priority: 'normal' as const,
    expires_at: null,
    ...over,
  };
}

async function postUserEvent(id: string, body: string) {
  return appRoutes.request(`/cards/${id}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...UI_HEADERS },
    body: JSON.stringify({ type: 'message', body }),
  });
}

async function postAgentEvent(id: string, body: string) {
  return appRoutes.request(`/cards/${id}/agent-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...WRITE_HEADERS },
    body: JSON.stringify({ type: 'message', body }),
  });
}

async function getResponse(id: string, qs = '') {
  return appRoutes.request(`/cards/${id}/response${qs}`, { headers: WRITE_HEADERS });
}

// Hono's Response.json() types as unknown; every assertion below reaches into the parsed body's
// fields, so cast once here instead of `as any`-ing every call site.
async function json(res: Response): Promise<any> {
  return res.json();
}

async function respond(id: string, action: string) {
  return appRoutes.request(`/cards/${id}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...UI_HEADERS },
    body: JSON.stringify({ action, note: null }),
  });
}

beforeAll(async () => {
  ensureCardsSchema();
  ensureNotifyLogSchema();
  await store.ensureSchema(); // push_subscriptions — sendPushToAll reads it (see push.ts)
});
beforeEach(() => {
  __resetForTests();
  resetNotifyLog();
});

describe('GET /cards/:id/response — legacy path (no events_since)', () => {
  test('a bare wait=0 poll on a pending card returns plain {status:"pending"} — no events field', async () => {
    const card = createCard(input());
    const body = await json(await getResponse(card.id, '?wait=0'));
    expect(body).toEqual({ status: 'pending' });
  });

  test('a user thread message does NOT resolve a legacy poll — it only wakes an events_since-aware one', async () => {
    const card = createCard(input());
    const pollP = getResponse(card.id, '?wait=1'); // 1s bounded wait, no events_since
    await postUserEvent(card.id, 'why this migration?');
    const body = await json(await pollP);
    expect(body).toEqual({ status: 'pending' }); // times out — legacy path ignores events entirely
  });

  test('resolving the verdict still returns the bare legacy shape (no events field)', async () => {
    const card = createCard(input());
    const pollP = getResponse(card.id, '?wait=5');
    await respond(card.id, 'approved');
    const body = await json(await pollP);
    expect(body.status).toBe('responded');
    expect(body.response.verdict).toBe('approved');
    expect(body.events).toBeUndefined();
  });
});

describe('GET /cards/:id/response — events_since (Plan 04 thread awareness)', () => {
  test('resolves status "event" when a user message lands while waiting', async () => {
    const card = createCard(input());
    const pollP = getResponse(card.id, '?wait=5&events_since=0');
    await postUserEvent(card.id, 'why this migration?');
    const body = await json(await pollP);
    expect(body.status).toBe('event');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].role).toBe('user');
    expect(body.events[0].body).toBe('why this migration?');
  });

  test('an agent-role append does NOT wake the poll — the agent already knows what it wrote', async () => {
    const card = createCard(input());
    const pollP = getResponse(card.id, '?wait=1&events_since=0');
    await postAgentEvent(card.id, 'still working on it');
    const body = await json(await pollP);
    expect(body.status).toBe('pending'); // timed out — no user event landed
  });

  // Review fix: waitForEvents (event-waiters.ts) wakes on ANY card_event, agent or user role — an
  // agent-role append must not truncate the caller's `wait` budget. Assert ELAPSED TIME (not just
  // the returned status) so a regression that returns early can't hide behind a passing status
  // assertion the way the bug above did before this fix.
  test('an agent-role append does not truncate the wait budget — the poll honors the full wait=N', async () => {
    const card = createCard(input());
    const started = Date.now();
    const pollP = getResponse(card.id, '?wait=1&events_since=0');
    await postAgentEvent(card.id, 'unrelated agent chatter');
    const body = await json(await pollP);
    const elapsed = Date.now() - started;
    expect(body.status).toBe('pending');
    expect(elapsed).toBeGreaterThanOrEqual(900); // ~1s wait honored, not an early bail-out
  });

  test('events_since filters out events at or before the given seq', async () => {
    const card = createCard(input());
    await postUserEvent(card.id, 'first question'); // seq 1
    // Already-past-seq check (no wait needed): asking since seq 1 should see nothing yet.
    const already = await json(await getResponse(card.id, '?wait=0&events_since=1'));
    expect(already.status).toBe('pending');
    // Asking since seq 0 sees the existing message immediately (no need to block).
    const fromStart = await json(await getResponse(card.id, '?wait=0&events_since=0'));
    expect(fromStart.status).toBe('event');
    expect(fromStart.events).toHaveLength(1);
  });

  test('resolves the verdict (with events context) even when events_since is set', async () => {
    const card = createCard(input());
    const pollP = getResponse(card.id, '?wait=5&events_since=0');
    await respond(card.id, 'approved');
    const body = await json(await pollP);
    expect(body.status).toBe('responded');
    expect(body.response.verdict).toBe('approved');
    expect(Array.isArray(body.events)).toBe(true);
  });

  test('an already-responded card immediately returns responded + events, no waiting', async () => {
    const card = createCard(input());
    await postAgentEvent(card.id, 'fyi');
    await respond(card.id, 'approved');
    const body = await json(await getResponse(card.id, '?wait=0&events_since=0'));
    expect(body.status).toBe('responded');
    expect(body.events).toHaveLength(1);
  });
});

describe('agent-events push (Plan 04 thread-reply notification)', () => {
  test('shouldPushThreadReply: true only for role agent + type message', () => {
    expect(shouldPushThreadReply('agent', 'message')).toBe(true);
    expect(shouldPushThreadReply('user', 'message')).toBe(false);
    expect(shouldPushThreadReply('agent', 'payload')).toBe(false);
    expect(shouldPushThreadReply('user', 'payload')).toBe(false);
  });

  test('an agent message append records a thread-reply notify-log row', async () => {
    const card = createCard(input());
    await postAgentEvent(card.id, 'need a decision from you');
    const rows = listNotifications();
    const row = rows.find((r) => r.card_id === card.id && r.event === 'thread-reply');
    expect(row).toBeTruthy();
  });

  test('a user message append records NO notify-log row (Cam wrote it — nothing to push)', async () => {
    const card = createCard(input());
    await postUserEvent(card.id, 'why though?');
    const rows = listNotifications();
    expect(rows.find((r) => r.card_id === card.id)).toBeUndefined();
  });
});
