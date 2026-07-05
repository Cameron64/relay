// Shared HTTP client for the deployed Relay API. Built for the MCP server (bin/relay-mcp.mjs) but
// usable by any zero-dep client. Deliberately SIDE-EFFECT-FREE: no process.exit, no stdout/stderr
// writes. That matters because an MCP stdio server uses STDOUT as its JSON-RPC channel — a stray
// console.log here would corrupt the protocol stream. It also makes every function trivially
// unit-testable by stubbing global.fetch.
//
// TODO(dedup): bin/relay.mjs carries its own copy of this poll loop (`pollUntil`, ~line 268) and
// the create POST (`createAndWait`). They predate this module and are battle-tested, but have no
// network-layer unit tests — so folding the CLI onto this client is a follow-up to do once these
// functions have coverage, not a same-change refactor.

export const PER_POLL_CAP = 50; // the server caps ?wait at 55s; leave margin
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST a card payload to /api/cards. Resolves to { id, url, push } on success. Throws an Error on
// a non-OK HTTP status (message "HTTP <status>: <body>") or a network failure (fetch rejection).
export async function createCard(cfg, payload) {
  const res = await fetch(`${cfg.url}/api/cards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// Bounded long-poll for a card's verdict. Loops the server's ?wait long-poll (each request capped
// at PER_POLL_CAP seconds) until the card is answered, vanishes (404), or `totalSecs` elapses.
// Transient failures (network error, non-OK status, unparseable JSON) are retried within the
// budget with a short backoff. Returns a plain result object and NEVER throws for an expected
// outcome:
//   { status:'responded', response:{ verdict, action, note, ... } }
//   { status:'pending' }     // budget exhausted with no answer — caller should re-poll
//   { status:'notfound' }    // card expired or was dismissed
export async function pollResponse(cfg, id, totalSecs) {
  const deadline = Date.now() + totalSecs * 1000;
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) return { status: 'pending' };
    const perPoll = Math.min(remaining, PER_POLL_CAP);
    let res;
    try {
      res = await fetch(`${cfg.url}/api/cards/${id}/response?wait=${perPoll}`, {
        headers: { 'x-write-token': cfg.writeToken },
      });
    } catch {
      await sleep(1000); // transient network/edge drop — retry within budget
      continue;
    }
    if (res.status === 404) return { status: 'notfound' };
    if (!res.ok) {
      await sleep(1000);
      continue;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      await sleep(500);
      continue;
    }
    if (data.status === 'responded') return data; // { status:'responded', response }
    // server hit its per-request cap and returned pending — loop again while budget remains
  }
}

// List a card's card_events (write-token side — GET /api/cards/:id/agent-events, no wait: this is
// a one-shot read for a card whose VERDICT has already resolved, used to fetch the structured
// payload a page-submit bridge (relay-roadmap Plan 05) stashed alongside the bare 'submit' verdict.
// Returns ALL events regardless of role (the route doesn't filter by role — only by auth token; see
// routes-cards.ts). Throws on a non-OK HTTP status, same convention as createCard.
export async function getCardEvents(cfg, id) {
  const res = await fetch(`${cfg.url}/api/cards/${id}/agent-events`, {
    headers: { 'x-write-token': cfg.writeToken },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.events || [];
}

// Fire a push via /api/notify. Resolves to { ok:true, body } on success. A 503 means push/VAPID is
// not configured (or there are no subscriptions yet) — a soft condition, not a failure — reported
// as { ok:false, reason:'push-not-configured', body }. Any other non-OK status throws.
export async function sendNotify(cfg, payload) {
  const res = await fetch(`${cfg.url}/api/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
    body: JSON.stringify(payload),
  });
  const body = await res.text().catch(() => '');
  if (res.ok) return { ok: true, body };
  if (res.status === 503) return { ok: false, reason: 'push-not-configured', body };
  throw new Error(`HTTP ${res.status}: ${body}`);
}
