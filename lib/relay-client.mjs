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
//   { status:'responded', response:{ verdict, action, note, ... }, events? }
//   { status:'event', events }  // Plan 04, only when eventsSince is passed — a human message
//                                // landed instead of a verdict; caller should relay_reply then re-poll
//   { status:'pending' }     // budget exhausted with no answer — caller should re-poll
//   { status:'notfound' }    // card expired or was dismissed
//
// `eventsSince` (Plan 04, card threads) is OPT-IN: omitted (every pre-Plan-04 caller) sends the
// exact same request as before — the server can then never return status:'event' for this call,
// so the byte-identical-legacy-behavior bar (master doc §4) holds all the way through this client.
// 0 is a valid value ("since the beginning" — seq starts at 1), so this checks `!= null`, not truthiness.
export async function pollResponse(cfg, id, totalSecs, eventsSince) {
  const deadline = Date.now() + totalSecs * 1000;
  const qs = eventsSince != null ? `&events_since=${encodeURIComponent(eventsSince)}` : '';
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) return { status: 'pending' };
    const perPoll = Math.min(remaining, PER_POLL_CAP);
    let res;
    try {
      res = await fetch(`${cfg.url}/api/cards/${id}/response?wait=${perPoll}${qs}`, {
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
    if (data.status === 'responded' || data.status === 'event') return data;
    // server hit its per-request cap and returned pending — loop again while budget remains
  }
}

// Append a card_events row from the write-token side (role:'agent', fixed by the route — never
// sent here). The agent's half of Plan 04's thread loop: relay_reply / `relay reply`, used to
// answer a human's mid-thread question without resolving the card's verdict. Returns the created
// event ({card_id,seq,role,type,body,at}). Throws on a non-OK HTTP status, same convention as
// createCard.
export async function appendAgentEvent(cfg, id, body) {
  const res = await fetch(`${cfg.url}/api/cards/${id}/agent-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
    body: JSON.stringify({ type: 'message', body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json(); // { ok: true, event: {...} }
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

// Download one reply attachment's raw bytes (GET /api/cards/:id/response-asset/:aid, write-token
// side). Returns a Buffer. Throws on a non-OK HTTP status or network failure, same convention as
// createCard — the caller (relay-mcp's withResponseImages) treats any throw as "skip this asset"
// so one bad download never sinks an already-answered result.
export async function downloadResponseAsset(cfg, cardId, assetId) {
  const res = await fetch(`${cfg.url}/api/cards/${cardId}/response-asset/${assetId}`, {
    headers: { 'x-write-token': cfg.writeToken },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return Buffer.from(await res.arrayBuffer());
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
