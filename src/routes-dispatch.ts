// Dispatch routes — the phone-brainstorm → queued-job → desktop-runner bridge (relay-roadmap
// Plan 02). Mounted under /api in server.ts, BEFORE the serveStatic('*') catch-all (same warning
// as routes-cards.ts: routes registered after the wildcard would be shadowed and 404).
//
//   POST /api/dispatches                  compose: {title?, body, target, resume_of?}   (UI)
//   GET  /api/dispatches                  list mine (?status=&since=&limit=)             (UI)
//   GET  /api/dispatches/next             runner long-poll for its next job (?wait=N)     (write)
//   GET  /api/dispatches/:id              one dispatch (status screen)                    (UI)
//   POST /api/dispatches/:id/cancel       queued -> cancelled only (see cancelDispatch)    (UI)
//   POST /api/dispatches/:id/claim        atomic claim; changes=0 -> conflict              (write)
//   POST /api/dispatches/:id/status       running|done|failed, legal transitions only      (write)
//   GET  /api/dispatch-targets            union of every runner's announced targets        (UI)
//   POST /api/dispatch-targets            a runner replaces its own {id,label} list        (write)
//
// `/dispatches/next` is registered BEFORE `/dispatches/:id` so "next" can never be captured as a
// dispatch id by a param route, regardless of the underlying router's matching order.
//
// Auth split (master doc §6): UI-token cookie composes/reads/cancels from the phone/browser;
// write-token is the runner's side (claim/status/targets). Never merged into one handler.

import { Hono } from 'hono';
import * as dispatch from './dispatch-store.ts';
import { requireUi, requireWrite } from './session.ts';
import { waitForDispatch, notifyDispatchWaiters } from './dispatch-waiters.ts';
import { broadcast } from './stream.ts';
import { isPushConfigured, sendPushToAll } from './push.ts';
import { recordNotify, pruneNotifyLog } from './notify-log.ts';

export const dispatchRoutes = new Hono();

function notReady(c: any) {
  return c.json({ error: 'dispatch storage unavailable' }, 503);
}

// --- compose (UI side) ------------------------------------------------------
dispatchRoutes.post('/dispatches', requireUi, async (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const v = dispatch.validateDispatchInput(body);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const created = dispatch.createDispatch(v.value);
  if (!created.ok) return c.json({ error: created.error }, 400);
  notifyDispatchWaiters();
  await broadcast('dispatch-updated', created.value);
  try {
    dispatch.pruneDispatches();
  } catch (err) {
    console.error('[dispatch] prune failed:', err);
  }
  return c.json({ dispatch: created.value });
});

// --- list mine (UI side) ----------------------------------------------------
dispatchRoutes.get('/dispatches', requireUi, (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  const status = c.req.query('status') || undefined;
  const since = c.req.query('since') || undefined;
  const limitRaw = Number(c.req.query('limit') || '100');
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
  return c.json({ dispatches: dispatch.listDispatches({ status, since, limit }) });
});

// --- runner long-poll for its next job (write side) -------------------------
// Bounded long-poll (?wait=N, capped at 55s like /cards/:id/response) — resolves as soon as ANY
// new dispatch is queued, then re-queries nextQueued() itself so the caller gets whatever is
// oldest at that moment, not necessarily the one that triggered the wakeup (master doc §8).
dispatchRoutes.get('/dispatches/next', requireWrite, async (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  let d = dispatch.nextQueued();
  const waitN = Number(c.req.query('wait') || '0');
  const waitMs = Math.min(Math.max(Number.isFinite(waitN) ? waitN : 0, 0), 55) * 1000;
  if (!d && waitMs > 0) {
    const hasNew = await waitForDispatch(waitMs);
    if (hasNew) d = dispatch.nextQueued();
  }
  if (!d) return c.json({ status: 'none' });
  return c.json({ status: 'ok', dispatch: d });
});

// --- one dispatch (UI side) -------------------------------------------------
dispatchRoutes.get('/dispatches/:id', requireUi, (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  const d = dispatch.getDispatch(c.req.param('id') as string);
  if (!d) return c.json({ error: 'not found' }, 404);
  return c.json({ dispatch: d });
});

// --- cancel (UI side) --------------------------------------------------------
// v1: only a still-queued dispatch is cancellable (see dispatch-store.ts's cancelDispatch doc).
dispatchRoutes.post('/dispatches/:id/cancel', requireUi, async (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  const id = c.req.param('id') as string;
  const result = dispatch.cancelDispatch(id);
  if (result.status === 'notfound') return c.json({ error: 'not found' }, 404);
  if (result.status === 'notcancellable') return c.json({ error: 'only a queued dispatch can be cancelled' }, 409);
  const d = dispatch.getDispatch(id);
  await broadcast('dispatch-updated', d);
  return c.json({ ok: true, dispatch: d });
});

// --- claim (write side) ------------------------------------------------------
dispatchRoutes.post('/dispatches/:id/claim', requireWrite, async (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  const id = c.req.param('id') as string;
  let body: any = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const host = typeof body?.host === 'string' && body.host.trim() ? body.host.trim() : 'unknown';
  const result = dispatch.claimDispatch(id, host);
  if (result.status === 'notfound') return c.json({ status: 'notfound' }, 404);
  if (result.status === 'conflict') return c.json({ status: 'conflict' });
  await broadcast('dispatch-updated', result.dispatch);
  return c.json({ status: 'claimed', dispatch: result.dispatch });
});

// --- status transitions (write side) -----------------------------------------
// On a transition to 'failed' the server itself fires a plain push (there is no result card
// behind a failure) — recorded in the notify-log with source:'dispatch' so it's traceable in the
// Activity drawer like every other push. A transition to 'done' is silent here: the runner already
// posted the result card via POST /api/cards, which pushes on its own (see routes-cards.ts).
dispatchRoutes.post('/dispatches/:id/status', requireWrite, async (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  const id = c.req.param('id') as string;
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const v = dispatch.validateStatusUpdate(body);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const result = dispatch.updateDispatchStatus(id, v.value);
  if (!result.ok) return c.json({ error: result.error }, result.error === 'not found' ? 404 : 409);
  const d = result.value;
  await broadcast('dispatch-updated', d);

  if (d.status === 'failed' && isPushConfigured()) {
    const title = `✗ ${d.title || 'Dispatch'} failed`;
    const pushBody = d.result_summary || 'The runner reported a failure.';
    try {
      const pushResult = await sendPushToAll({ title, body: pushBody, url: '/', tag: d.id });
      recordNotify({
        source: 'dispatch',
        title,
        body: pushBody,
        tag: d.id,
        url: '/',
        host: d.runner_host,
        event: 'failed',
        sent: pushResult.sent,
        failed: pushResult.failed,
        subscribers: pushResult.total,
      });
      pruneNotifyLog();
    } catch (err) {
      console.error('[dispatch] failure push failed:', err);
    }
  }

  return c.json({ ok: true, dispatch: d });
});

// --- targets -----------------------------------------------------------------
// GET is UI-side (feeds the compose picker); POST is write-side (a runner announces its own
// {id,label} list on startup — ids + labels ONLY, never a filesystem path; see the security
// invariant at the top of dispatch-store.ts).
dispatchRoutes.get('/dispatch-targets', requireUi, (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  return c.json({ targets: dispatch.listTargets() });
});

dispatchRoutes.post('/dispatch-targets', requireWrite, async (c) => {
  if (!dispatch.dispatchReady()) return notReady(c);
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }
  const v = dispatch.validateTargetsInput(body);
  if (!v.ok) return c.json({ error: v.error }, 400);
  dispatch.replaceTargetsForHost(v.value.host, v.value.targets);
  return c.json({ ok: true });
});
