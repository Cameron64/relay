// Relay's own routes (mounted under /api alongside the scaffold's pushRoutes, BEFORE the
// serveStatic('*') catch-all in server.ts — new /api routes registered after the wildcard
// would be shadowed and 404):
//
//   POST /api/unlock                  token -> httpOnly session cookie        (open)
//   GET  /api/stream                  SSE live feed                            (UI)
//   POST /api/cards                   Claude creates a card (+optional push)   (write)
//   GET  /api/cards                   feed, newest first                       (UI)
//   GET  /api/cards/:id               one card                                 (UI)
//   POST /api/cards/:id/respond       record verdict, resolve --wait + SSE     (UI)
//   POST /api/cards/:id/dismiss       clear a card from the feed               (UI)
//   GET  /api/cards/:id/response      long-poll the verdict (?wait=N)          (write)
//   POST /api/cards/:id/events        append a thread event, role:'user'       (UI)
//   GET  /api/cards/:id/events        list/long-poll events (?since_seq&wait)  (UI)
//   POST /api/cards/:id/agent-events  append a thread event, role:'agent'      (write)
//   GET  /api/cards/:id/agent-events  list/long-poll events (?since_seq&wait)  (write)
//   GET  /api/cards/:id/asset/:aid    image bytes                              (UI)
//
// The events endpoints are deliberately split into a UI path and a write path (rather than one
// handler composing both auth middlewares) so the auth split stays legible — master doc §6.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { requireUi, requireWrite, handleUnlock } from './session.ts';
import * as cards from './cards-store.ts';
import { isPushConfigured, sendPushToAll } from './push.ts';
import { recordNotify, listNotifications, notifyLogReady, pruneNotifyLog } from './notify-log.ts';
import { waitForResponse, resolveWaiters } from './waiters.ts';
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
    const respondActions = card.buttons
      .filter((b) => b.behavior === 'respond')
      .map((b) => ({ action: b.id, title: b.label }));
    const optionActions = card.options.map((o) => ({ action: o.id, title: o.label }));
    const actions = isPrompt
      ? [{ action: '__reply', title: 'Reply' }]
      : (respondActions.length ? respondActions : optionActions).slice(0, 2);
    const high = card.priority === 'high';
    // Cards that solicit a response — approval / prompt / choice, or any card carrying respond
    // buttons or options — are inherently time-sensitive (the sender is usually blocking on the
    // answer). Send those at high Web Push urgency so FCM wakes the device instead of deferring
    // the notification to the next Doze / battery-optimization window. requireInteraction (the
    // sticky, un-dismissable notification) stays gated on explicit --high, so making interactive
    // cards urgent doesn't also make every approval notification impossible to swipe away.
    const solicitsResponse = isPrompt || respondActions.length > 0 || optionActions.length > 0;
    const urgent = high || solicitsResponse;
    const cardUrl = '/?card=' + card.id + (isPrompt ? '&reply=1' : '');
    const pushBody =
      typeof body.pushBody === 'string' && body.pushBody
        ? body.pushBody
        : isPrompt
          ? 'Tap Reply to answer'
          : card.kind === 'approval'
            ? 'Tap to review & respond'
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

  const result = cards.respondCard(id, { action, note });
  if (result.status === 'notfound') return c.json({ error: 'not found' }, 404);
  // Reserved sentinel (e.g. '__reply' from a stale SW) — reject so the old SW falls back to opening
  // the app at the reply composer instead of recording a junk verdict. See respondCard's guard.
  if (result.status === 'reserved') return c.json({ error: 'reserved action' }, 400);
  if (result.status === 'conflict') return c.json({ error: 'already responded', response: result.response }, 409);

  resolveWaiters(id, result.response);
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
appRoutes.get('/cards/:id/response', requireWrite, async (c) => {
  if (!cards.cardsReady()) return notReady(c);
  const id = c.req.param('id') as string;
  const card = cards.getCard(id);
  if (!card) return c.json({ error: 'not found' }, 404);
  if (card.status === 'responded') return c.json({ status: 'responded', response: card.response });
  const waitN = Number(c.req.query('wait') || '0');
  const waitMs = Math.min(Math.max(Number.isFinite(waitN) ? waitN : 0, 0), 55) * 1000;
  if (waitMs <= 0) return c.json({ status: 'pending' });
  const resp = await waitForResponse(id, waitMs);
  if (resp) return c.json({ status: 'responded', response: resp });
  return c.json({ status: 'pending' });
});

// --- card events (thread messages / structured payloads) -------------------
// Append-only richer channel alongside the frozen single-verdict `response` (master doc §4). See
// the card_events table + appendCardEvent/listCardEvents in cards-store.ts. `role` is fixed per
// route (never read from the request body) — the UI path always writes/reads role:'user', the
// write-token path always writes/reads role:'agent'. No push notification on append; events are
// silent in this plan (Plan 04 decides push behavior for threads).
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
