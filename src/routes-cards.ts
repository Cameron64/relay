// Relay's own routes (mounted under /api alongside the scaffold's pushRoutes, BEFORE the
// serveStatic('*') catch-all in server.ts — new /api routes registered after the wildcard
// would be shadowed and 404):
//
//   POST /api/unlock                  token -> httpOnly session cookie        (open)
//   GET  /api/stream                  SSE live feed                            (UI)
//   POST /api/cards                   Claude creates a card (+optional push)   (write)
//   GET  /api/cards                   feed, newest first                       (UI)
//   GET  /api/cards/:id               one card                                 (UI)
//   POST /api/cards/:id/respond       record verdict (+optional assets[]), resolve --wait + SSE (UI)
//   POST /api/cards/:id/dismiss       clear a card from the feed               (UI)
//   GET  /api/cards/:id/response      long-poll the verdict (?wait=N&events_since=SEQ) (write)
//   POST /api/cards/:id/events        append a thread event, role:'user'       (UI)
//   GET  /api/cards/:id/events        list/long-poll events (?since_seq&wait)  (UI)
//   POST /api/cards/:id/agent-events  append a thread event, role:'agent'      (write)
//   GET  /api/cards/:id/agent-events  list/long-poll events (?since_seq&wait)  (write)
//   GET  /api/cards/:id/asset/:aid    image bytes                              (UI)
//   GET  /api/cards/:id/response-asset/:aid  reply-attachment bytes         (UI|write)
//   GET  /api/sessions                dashboard rows folded from notify-log     (UI)
//
// The events endpoints are deliberately split into a UI path and a write path (rather than one
// handler composing both auth middlewares) so the auth split stays legible — master doc §6.
//
// Plan 04 (card threads): the write-side /response poll gains an OPT-IN &events_since=SEQ param
// (see the handler below) — a caller that omits it gets byte-identical behavior to before this
// plan (master doc §4's frozen verdict contract; every existing CLI/MCP/hook caller keeps working
// unchanged). With it, the poll also resolves early on a new role:'user' card_event, so an agent
// blocked on --wait sees a clarifying question instead of just timing out.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireUi, requireWrite, requireUiOrWrite, handleUnlock } from './session.ts';
import * as cards from './cards-store.ts';
import * as dispatch from './dispatch-store.ts';
import { isPushConfigured, sendPushToAll } from './push.ts';
import { recordNotify, listNotifications, notifyLogReady, pruneNotifyLog, aggregateSessions } from './notify-log.ts';
import { waitForResponse, resolveWaiters, waitForResponseOrEvent } from './waiters.ts';
import { waitForEvents, notifyEventWaiters } from './event-waiters.ts';
import { addClient, removeClient, hubSize, broadcast } from './stream.ts';

export const appRoutes = new Hono();

const MAX_ASSETS = 8;

function notReady(c: any) {
  return c.json({ error: 'cards storage unavailable' }, 503);
}

// --- unlock ----------------------------------------------------------------
appRoutes.post('/unlock', handleUnlock);

// --- SSE live feed ---------------------------------------------------------
appRoutes.get('/stream', requireUi, (c) =>
  streamSSE(c, async (stream) => {
    const id = addClient(stream);
    let alive = true;
    stream.onAbort(() => {
      alive = false;
      removeClient(id);
    });
    await stream.writeSSE({ event: 'connected', data: JSON.stringify({ hub: hubSize() }) });
    while (alive) {
      await stream.sleep(25_000);
      if (!alive) break;
      try {
        await stream.writeSSE({ event: 'ping', data: String(hubSize()) });
      } catch {
        break;
      }
    }
    removeClient(id);
  }),
);

// --- create (Claude side) --------------------------------------------------
appRoutes.post('/cards', requireWrite, async (c) => {
  if (!cards.cardsReady()) return notReady(c);
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const v = cards.validateCardInput(body);
  if (!v.ok) return c.json({ error: v.error }, 400);

  // Decode + size-check inline image assets.
  const maxBytes = Number(process.env.ASSET_MAX_BYTES ?? 3_145_728);
  const assets: { mime: string; bytes: Uint8Array }[] = [];
  if (Array.isArray(body.assets)) {
    if (body.assets.length > MAX_ASSETS) return c.json({ error: `too many assets (max ${MAX_ASSETS})` }, 400);
    for (const a of body.assets) {
      const mime = typeof a?.mime === 'string' ? a.mime : '';
      const dataB64 = typeof a?.data === 'string' ? a.data : typeof a?.dataBase64 === 'string' ? a.dataBase64 : '';
      if (!mime.startsWith('image/')) return c.json({ error: 'asset mime must be image/*' }, 400);
      if (!dataB64) return c.json({ error: 'asset data (base64) required' }, 400);
      let buf: Buffer;
      try {
        buf = Buffer.from(dataB64, 'base64');
      } catch {
        return c.json({ error: 'invalid base64 asset' }, 400);
      }
      if (buf.length === 0) return c.json({ error: 'empty asset' }, 400);
      if (buf.length > maxBytes) return c.json({ error: `asset exceeds ${maxBytes} bytes` }, 413);
      assets.push({ mime, bytes: new Uint8Array(buf) });
    }
  }

  let card: cards.Card;
  try {
    card = cards.createCard(v.value, assets);
  } catch (err) {
    console.error('[cards] create failed:', err);
    return c.json({ error: 'storage error' }, 500);
  }

  const wantPush = body.push !== false;
  let push: unknown = null;
  if (wantPush && isPushConfigured()) {
    // Surface respond buttons (or, for choice cards, the first options) as notification action
    // buttons (Chrome/Android shows up to 2) so the user can answer straight from the notification —
    // the SW POSTs the tapped id to /respond in the background. High-priority cards get a delivery-
    // urgency hint + requireInteraction.
    //
    // A `prompt` card is the exception: it wants a FREE-TEXT reply, which can't be typed from a
    // notification on a PWA. Its single action is the reserved '__reply' button that the SW treats as
    // "open the app focused on the reply box" (not a background respond), and its deep link carries
    // &reply=1 so the composer auto-focuses on arrival.
    const isPrompt = card.kind === 'prompt';
    // A page created with expects_response:true (Plan 05's postMessage submit bridge) has no
    // buttons/options of its own — the "respond" affordance lives INSIDE the sandboxed iframe
    // (a form, sliders, whatever the agent built) — so it can't surface action buttons on the
    // notification the way approval/choice/prompt do. It's still time-sensitive, so it only
    // affects urgency/pushBody below, never the `actions` array.
    const isExpectingPage = card.kind === 'page' && card.expects_response;
    const respondActions = card.buttons
      .filter((b) => b.behavior === 'respond')
      .map((b) => ({ action: b.id, title: b.label }));
    const optionActions = card.options.map((o) => ({ action: o.id, title: o.label }));
    const actions = isPrompt
      ? [{ action: '__reply', title: 'Reply' }]
      : (respondActions.length ? respondActions : optionActions).slice(0, 2);
    const high = card.priority === 'high';
    // Cards that solicit a response — approval / prompt / choice, an expecting page, or any card
    // carrying respond buttons or options — are inherently time-sensitive (the sender is usually
    // blocking on the answer). Send those at high Web Push urgency so FCM wakes the device instead
    // of deferring the notification to the next Doze / battery-optimization window.
    // requireInteraction (the sticky, un-dismissable notification) stays gated on explicit --high,
    // so making interactive cards urgent doesn't also make every approval notification impossible
    // to swipe away.
    const solicitsResponse = isPrompt || respondActions.length > 0 || optionActions.length > 0 || isExpectingPage;
    const urgent = high || solicitsResponse;
    const cardUrl = '/?card=' + card.id + (isPrompt ? '&reply=1' : '');
    const pushBody =
      typeof body.pushBody === 'string' && body.pushBody
        ? body.pushBody
        : isPrompt
          ? 'Tap Reply to answer'
          : card.kind === 'approval'
            ? 'Tap to review & respond'
            : isExpectingPage
              ? 'Tap to answer'
              : 'Tap to view';
    try {
      const result = await sendPushToAll({
        title: card.title,
        body: pushBody,
        url: cardUrl,
        tag: card.id,
        cardId: card.id,
        ...(actions.length ? { actions } : {}),
        ...(urgent ? { urgency: 'high' as const } : {}),
        ...(high ? { requireInteraction: true } : {}),
      });
      push = result;
      // Add the card push to the same audit trail as bare /api/notify pushes, so the Activity log
      // is one unified timeline. Attribution comes from card.source (cwd/host set by the CLI/MCP);
      // a card_id marks this push as actionable (the "tap leads somewhere" case).
      const src = (card.source ?? {}) as Record<string, unknown>;
      const cwd = typeof src.cwd === 'string' ? src.cwd : null;
      recordNotify({
        source: 'card',
        title: card.title,
        body: pushBody,
        tag: card.id,
        url: cardUrl,
        sessionId: typeof src.sessionId === 'string' ? src.sessionId : null,
        cwd,
        project: cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null : null,
        host: typeof src.host === 'string' ? src.host : null,
        event: card.kind,
        cardId: card.id,
        sent: result.sent,
        failed: result.failed,
        subscribers: result.total,
      });
      pruneNotifyLog();
    } catch (err) {
      console.error('[cards] push failed:', err);
    }
  }

  await broadcast('card-created', card);
  try {
    cards.pruneCards();
  } catch (err) {
    console.error('[cards] prune failed:', err);
  }

  return c.json({ id: card.id, url: '/?card=' + card.id, push });
});

// --- feed (UI side) --------------------------------------------------------
appRoutes.get('/cards', requireUi, (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const since = c.req.query('since') || undefined;
  const limit = Number(c.req.query('limit') || '100');
  return c.json({ cards: cards.listCards({ since, limit }) });
});

// --- notification audit trail (UI side) ------------------------------------
// Every push Relay sent, newest first, with its origin (session/project/host) — the Activity
// drawer reads this to answer "why did I get that push and who fired it?". Read-only, UI-token
// gated like the card feed. 503 (not 500) when the log table is unavailable so the drawer can
// show a "warming up" state instead of an error, matching the cards feed's degrade.
appRoutes.get('/notifications', requireUi, (c) => {
  if (!notifyLogReady()) return c.json({ error: 'notification log unavailable' }, 503);
  const since = c.req.query('since') || undefined;
  const limit = Number(c.req.query('limit') || '100');
  return c.json({ notifications: listNotifications({ since, limit: Number.isFinite(limit) ? limit : 100 }) });
});

// --- session dashboard (UI side) --------------------------------------------
// One row per Claude session seen in the last `window_hours` (default SESSION_WINDOW_HOURS, 24),
// derived entirely from the notify-log audit trail (plus the runner's claude_session linkage —
// relay-roadmap Plan 03). Pure read: no new table, no process-level truth (see the plan's
// Non-goals — a killed terminal never flips to "ended" without the SessionEnd hook firing).
appRoutes.get('/sessions', requireUi, (c) => {
  if (!notifyLogReady()) return c.json({ error: 'notification log unavailable' }, 503);
  const windowHoursRaw = Number(c.req.query('window_hours'));
  const windowHours = Number.isFinite(windowHoursRaw) && windowHoursRaw > 0 ? windowHoursRaw : undefined;
  const dispatchBySession = dispatch.dispatchReady() ? dispatch.latestDispatchIdBySession() : undefined;
  const sessions = aggregateSessions({ windowHours, dispatchBySession });
  return c.json({ sessions, window_hours: windowHours ?? Number(process.env.SESSION_WINDOW_HOURS ?? 24) });
});

appRoutes.get('/cards/:id', requireUi, (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const card = cards.getCard(c.req.param('id') as string);
  if (!card) return c.json({ error: 'not found' }, 404);
  return c.json({ card });
});

// --- respond (UI side) -----------------------------------------------------
appRoutes.post('/cards/:id/respond', requireUi, async (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const id = c.req.param('id') as string;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const action = typeof body?.action === 'string' && body.action ? body.action : null;
  if (!action) return c.json({ error: 'action required' }, 400);
  const note = typeof body?.note === 'string' ? body.note.slice(0, 4000) : null;

  // Optional page-submit payload (Plan 05): validated with the SAME rules as the events endpoint
  // (type/size), then handed to respondCard to write atomically with the status flip — see the
  // comment on respondCard for why this must be one transaction, not a separate events POST.
  let payload: string | undefined;
  if (body?.payload !== undefined) {
    const v = cards.validateCardEventInput({ type: 'payload', body: body.payload });
    if (!v.ok) return c.json({ error: v.error }, 400);
    payload = v.value.body;
  }

  // Optional reply attachments (images/files the user sends back with their answer). Decoded +
  // size-checked here, then persisted atomically with the verdict flip inside respondCard.
  const decoded = cards.decodeResponseAssets(body?.assets);
  if (!decoded.ok) return c.json({ error: decoded.error }, decoded.error.includes('exceeds') ? 413 : 400);

  const result = cards.respondCard(id, { action, note, payload }, decoded.value);
  if (result.status === 'notfound') return c.json({ error: 'not found' }, 404);
  // Reserved sentinel (e.g. '__reply' from a stale SW) — reject so the old SW falls back to opening
  // the app at the reply composer instead of recording a junk verdict. See respondCard's guard.
  if (result.status === 'reserved') return c.json({ error: 'reserved action' }, 400);
  if (result.status === 'conflict') return c.json({ error: 'already responded', response: result.response }, 409);
  if (result.status === 'payload_cap') return c.json({ error: `card has reached the max of ${cards.CARD_EVENT_MAX_PER_CARD} events` }, 409);

  resolveWaiters(id, result.response);
  // A payload event was written atomically with this respond (Plan 05) — wake any long-poller on
  // GET events and broadcast it over SSE, same as the dedicated events endpoint does, so a thread
  // view or the write-side events poll sees it immediately instead of waiting out its timeout.
  if (result.event) {
    notifyEventWaiters(id);
    await broadcast('card-event', { cardId: id, event: result.event });
  }
  const card = cards.getCard(id);
  await broadcast('card-updated', card);
  return c.json({ ok: true, response: result.response });
});

// --- dismiss (UI side) -----------------------------------------------------
// Clear a card from the feed (a swipe / × in the UI). Idempotent: dismissing an unknown or
// already-gone card still returns ok. Broadcasts card-removed so other open tabs drop it too.
appRoutes.post('/cards/:id/dismiss', requireUi, async (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const id = c.req.param('id') as string;
  cards.dismissCard(id);
  await broadcast('card-removed', { id });
  return c.json({ ok: true });
});

// --- long-poll the verdict (Claude side) -----------------------------------
// Plan 04: &events_since=SEQ is OPT-IN thread awareness. Omitted (every caller before this plan,
// and Plan 01's permission hook, which never sends it — permission cards stay verdict-only) takes
// the "legacy path" below, byte-identical to the route's behavior before this plan. Provided, the
// poll ALSO resolves early on a new role:'user' card_event (> SEQ) — the human asked a question
// instead of answering yet — and both branches echo the card's current event list back for
// context (master doc: "events = full list, so the agent has context").
appRoutes.get('/cards/:id/response', requireWrite, async (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const id = c.req.param('id') as string;
  const card = cards.getCard(id);
  if (!card) return c.json({ error: 'not found' }, 404);
  // Heartbeat: stamp last_poll_at at request arrival, before any waiting — the UI reads the gap
  // since this stamp to flag pending cards whose agent has probably stopped listening. Broadcast
  // the refreshed row too: without it a healthy long-lived tab only ever sees the stamp from its
  // initial load/resync, so a frozen last_poll_at would false-positive the staleness warning on a
  // card whose agent is polling right now. Once per poll cycle (~50s/card) — cheap. Pending only:
  // a dismissed card's row must never be re-broadcast into feeds (upsert would resurrect it), and
  // responded cards don't carry the warning at all.
  cards.touchLastPoll(id);
  if (card.status === 'pending') await broadcast('card-updated', cards.getCard(id));
  const sinceParam = c.req.query('events_since');
  // 0 is a valid sinceSeq (seq starts at 1, so "since 0" means "every event so far") — only an
  // ABSENT param means "no thread awareness at all", so this can't just be `Number(...) || undefined`.
  const sinceSeq = sinceParam !== undefined ? Math.max(0, Math.floor(Number(sinceParam)) || 0) : undefined;

  if (card.status === 'responded') {
    // response_assets: metadata for any files the user attached to their reply. The MCP downloads
    // the bytes to temp files and hands the paths to the waiting agent. Always included (empty
    // array when none) so the client can branch on presence without a separate call.
    const response_assets = card.response_assets;
    return c.json(
      sinceSeq === undefined
        ? { status: 'responded', response: card.response, response_assets }
        : { status: 'responded', response: card.response, response_assets, events: cards.listCardEvents(id) },
    );
  }
  // Dismissed cards are marked for deletion (expires_at set) but linger until the next
  // sweepExpired() tick — resolve pollers immediately instead of making them wait out the sweep.
  if (card.status === 'dismissed') return c.json({ error: 'not found' }, 404);

  const waitN = Number(c.req.query('wait') || '0');
  const waitMs = Math.min(Math.max(Number.isFinite(waitN) ? waitN : 0, 0), 55) * 1000;

  if (sinceSeq === undefined) {
    // Legacy path — exactly the route's behavior before Plan 04, no thread awareness at all.
    if (waitMs <= 0) return c.json({ status: 'pending' });
    const resp = await waitForResponse(id, waitMs);
    if (resp) return c.json({ status: 'responded', response: resp });
    return c.json({ status: 'pending' });
  }

  // Only a role:'user' event counts as "the human asked something" — an agent's own agent-events
  // writes must never wake its own poll (it already knows what it just wrote there).
  const alreadyNew = cards.listCardEvents(id, { sinceSeq }).some((e) => e.role === 'user');
  if (alreadyNew) return c.json({ status: 'event', events: cards.listCardEvents(id, { sinceSeq }) });
  if (waitMs <= 0) return c.json({ status: 'pending' });

  // event-waiters.ts's waitForEvents wakes on ANY card_event append (agent OR user role) — it has
  // no concept of role, by design (routes-cards.ts's plain GET .../events long-poll wants exactly
  // that "wake on anything new" behavior). So a role:'agent' append elsewhere (e.g. a concurrent
  // relay_reply for the same card) wins the race here too, even though it isn't "the human asked
  // something". Re-loop on the REMAINING time budget instead of surfacing that as 'pending' — a
  // caller's `wait=N` is a promise to hold the connection open for N seconds; only a real verdict
  // or a role:'user' event (or the deadline itself) may end it early.
  const deadline = Date.now() + waitMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const woke = await waitForResponseOrEvent(id, remaining);
    if (woke.kind === 'responded') return c.json({ status: 'responded', response: woke.resp, events: cards.listCardEvents(id) });
    if (woke.kind === 'event') {
      const events = cards.listCardEvents(id, { sinceSeq });
      if (events.some((e) => e.role === 'user')) return c.json({ status: 'event', events });
      continue; // agent-only event landed elsewhere — not a wake condition, keep waiting
    }
    break; // 'pending': both sides of the race timed out with nothing new
  }
  return c.json({ status: 'pending' });
});

// --- card events (thread messages / structured payloads) -------------------
// Append-only richer channel alongside the frozen single-verdict `response` (master doc §4). See
// the card_events table + appendCardEvent/listCardEvents in cards-store.ts. `role` is fixed per
// route (never read from the request body) — the UI path always writes/reads role:'user', the
// write-token path always writes/reads role:'agent'.
//
// Plan 04 push rule: a role:'agent' text message pushes (the agent is STILL BLOCKED waiting on a
// verdict — Cam should know it said something); a role:'user' append never pushes (Cam wrote it —
// pushing his own message back to his own phone would be pointless), matching master §6's split
// (only the write side triggers outbound notifications). 'payload' events (Plan 05's structured
// page-submit data) aren't human-readable thread text, so they don't push either.
export function shouldPushThreadReply(role: cards.CardEventRole, type: cards.CardEventType): boolean {
  return role === 'agent' && type === 'message';
}

function eventsPostHandler(role: cards.CardEventRole) {
  return async (c: Context) => {
    if (!cards.cardsReady()) return notReady(c);
    const id = c.req.param('id') as string;
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const v = cards.validateCardEventInput(body);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const result = cards.appendCardEvent(id, { role, type: v.value.type, body: v.value.body });
    if (!result.ok) {
      const status = result.error === 'card not found' ? 404 : result.error === 'card is not pending' ? 409 : 400;
      return c.json({ error: result.error }, status);
    }
    notifyEventWaiters(id);
    await broadcast('card-event', { cardId: id, event: result.value });

    if (shouldPushThreadReply(role, v.value.type) && isPushConfigured()) {
      const card = cards.getCard(id);
      if (card) {
        const cardUrl = '/?card=' + id;
        const pushBody = v.value.body.length > 200 ? v.value.body.slice(0, 200) + '…' : v.value.body;
        try {
          const pushResult = await sendPushToAll({
            title: card.title,
            body: pushBody,
            url: cardUrl,
            tag: id,
            cardId: id,
            urgency: 'high',
          });
          const src = (card.source ?? {}) as Record<string, unknown>;
          const cwd = typeof src.cwd === 'string' ? src.cwd : null;
          recordNotify({
            source: 'card',
            title: card.title,
            body: pushBody,
            tag: id,
            url: cardUrl,
            sessionId: typeof src.sessionId === 'string' ? src.sessionId : null,
            cwd,
            project: cwd ? cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null : null,
            host: typeof src.host === 'string' ? src.host : null,
            event: 'thread-reply',
            cardId: id,
            sent: pushResult.sent,
            failed: pushResult.failed,
            subscribers: pushResult.total,
          });
          pruneNotifyLog();
        } catch (err) {
          console.error('[cards] thread-reply push failed:', err);
        }
      }
    }

    return c.json({ ok: true, event: result.value });
  };
}

// Bounded long-poll (?wait=N, capped at 55s like /response) — resolves as soon as ANY new event
// lands, then re-lists from the same since_seq so the caller gets everything that landed while it
// was parked, not just a "there's something new" flag.
function eventsGetHandler() {
  return async (c: Context) => {
    if (!cards.cardsReady()) return notReady(c);
    const id = c.req.param('id') as string;
    if (!cards.getCard(id)) return c.json({ error: 'not found' }, 404);
    const sinceRaw = Number(c.req.query('since_seq') || '0');
    const sinceSeq = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : undefined;
    let events = cards.listCardEvents(id, { sinceSeq });
    const waitN = Number(c.req.query('wait') || '0');
    const waitMs = Math.min(Math.max(Number.isFinite(waitN) ? waitN : 0, 0), 55) * 1000;
    if (events.length === 0 && waitMs > 0) {
      const hasNew = await waitForEvents(id, waitMs);
      if (hasNew) events = cards.listCardEvents(id, { sinceSeq });
    }
    return c.json({ events });
  };
}

appRoutes.post('/cards/:id/events', requireUi, eventsPostHandler('user'));
appRoutes.get('/cards/:id/events', requireUi, eventsGetHandler());
appRoutes.post('/cards/:id/agent-events', requireWrite, eventsPostHandler('agent'));
appRoutes.get('/cards/:id/agent-events', requireWrite, eventsGetHandler());

// --- asset bytes (UI side) -------------------------------------------------
appRoutes.get('/cards/:id/asset/:aid', requireUi, (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const a = cards.getAsset(c.req.param('id') as string, c.req.param('aid') as string);
  if (!a) return c.json({ error: 'not found' }, 404);
  return new Response(a.bytes, {
    headers: { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=86400' },
  });
});

// --- reply-attachment bytes (UI preview + MCP download) --------------------
// requireUiOrWrite: the phone (UI cookie) renders the reply image back on the resolved card; the
// agent's MCP (write token) downloads it to a temp file. Distinct route from /asset/:aid above so
// agent-sent card images and user-sent reply images never share an addressing space.
appRoutes.get('/cards/:id/response-asset/:aid', requireUiOrWrite, (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const a = cards.getResponseAsset(c.req.param('id') as string, c.req.param('aid') as string);
  if (!a) return c.json({ error: 'not found' }, 404);
  return new Response(a.bytes, {
    headers: { 'Content-Type': a.mime, 'Cache-Control': 'private, max-age=86400' },
  });
});
