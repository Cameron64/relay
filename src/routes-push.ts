import { Hono } from 'hono';
import { tokensMatch } from './auth.ts';
import { store } from './store.ts';
import { getPublicKey, isPushConfigured, sendPushToAll } from './push.ts';
import { recordNotify, pruneNotifyLog } from './notify-log.ts';

// Web Push endpoints. Mounted under `/api` in server.ts, so the public paths are:
//   GET  /api/push/public-key   — VAPID public key for the client subscribe handshake (open)
//   POST /api/push/subscribe    — store a browser subscription (open: anyone can opt in)
//   POST /api/push/unsubscribe  — remove a subscription by endpoint (open)
//   POST /api/notify            — broadcast a push to everyone (WRITE_TOKEN-protected;
//                                 this is the "trigger a notification at a moment's notice"
//                                 entry point — call it from a cron, a webhook, or by hand)
//
// Keep these paths bare here and rely on the `/api` mount in server.ts — moving the mount
// to `/api/push` would silently double the prefix (/api/push/push/subscribe) and 404.

export const pushRoutes = new Hono();

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

pushRoutes.get('/push/public-key', (c) => {
  const key = getPublicKey();
  if (!key) return c.json({ error: 'push not configured' }, 503);
  return c.json({ key });
});

pushRoutes.post('/push/subscribe', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!isStr(body?.endpoint) || !isStr(body?.keys?.p256dh) || !isStr(body?.keys?.auth)) {
    return c.json({ error: 'invalid subscription' }, 400);
  }
  try {
    await store.upsert({
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userLabel: isStr(body.userLabel) ? body.userLabel.slice(0, 120) : null,
    });
    return c.json({ ok: true });
  } catch (err) {
    console.error('[push] subscribe store error:', err);
    return c.json({ error: 'storage unavailable' }, 503);
  }
});

pushRoutes.post('/push/unsubscribe', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  if (!isStr(body?.endpoint)) return c.json({ error: 'endpoint required' }, 400);
  try {
    await store.remove(body.endpoint);
    return c.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe store error:', err);
    return c.json({ error: 'storage unavailable' }, 503);
  }
});

pushRoutes.post('/notify', async (c) => {
  const writeToken = process.env.WRITE_TOKEN;
  if (!writeToken) return c.json({ error: 'server not configured (WRITE_TOKEN unset)' }, 500);
  if (!tokensMatch(c.req.header('x-write-token'), writeToken)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // Body is optional — an empty POST sends a default nudge.
  let body: any = {};
  const raw = await c.req.text();
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
  }

  // Resolve the push fields once so the SAME values are both delivered and written to the audit
  // log. The trailing metadata fields (source/sessionId/cwd/project/host/event) are optional and
  // carried only by enriched callers (the hooks, CLI, MCP) — a bare POST still works and logs as
  // source:'unknown' with null attribution.
  // `deliver` lets a caller RECORD a push to the audit trail WITHOUT buzzing any device. The
  // Notification hook sends deliver:false for 'idle' nudges ("Claude is waiting for your input") —
  // they stay in the trail (so you can review which session went idle) but no longer ping the
  // phone. Defaults true, so a bare POST and every other caller still delivers exactly as before.
  const deliver = body.deliver !== false;

  // Only actual delivery needs VAPID configured; a silent (deliver:false) record does not.
  if (deliver && !isPushConfigured()) {
    return c.json({ error: 'push not configured (VAPID keys unset)' }, 503);
  }

  const title = isStr(body.title) ? body.title : 'Relay';
  const text = isStr(body.body) ? body.body : 'You have a new update.';
  const url = isStr(body.url) ? body.url : '/';
  const tag = isStr(body.tag) ? body.tag : 'relay';

  try {
    let sent = 0;
    let failed = 0;
    let total = 0;
    if (deliver) {
      const result = await sendPushToAll({ title, body: text, url, tag });
      sent = result.sent;
      failed = result.failed;
      total = result.total;
    }
    // deliver:false → silenced: no send; counts stay 0 and the delivered:0 flag marks the row.

    // Append to the audit trail (best-effort: recordNotify swallows its own errors and never
    // throws, so a logging failure can't turn a push into a 503).
    recordNotify({
      source: isStr(body.source) ? body.source : 'unknown',
      title,
      body: text,
      tag,
      url,
      sessionId: isStr(body.sessionId) ? body.sessionId : null,
      cwd: isStr(body.cwd) ? body.cwd : null,
      project: isStr(body.project) ? body.project : null,
      host: isStr(body.host) ? body.host : null,
      event: isStr(body.event) ? body.event : null,
      cardId: isStr(body.cardId) ? body.cardId : null,
      sent,
      failed,
      subscribers: total,
      delivered: deliver,
    });
    pruneNotifyLog();

    return c.json({ sent, failed, total, delivered: deliver });
  } catch (err) {
    console.error('[push] notify error:', err);
    return c.json({ error: 'storage unavailable' }, 503);
  }
});
