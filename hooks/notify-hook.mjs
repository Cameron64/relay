#!/usr/bin/env node
// Claude Code "Notification" hook → pushes "Claude needs you" to your phone via Relay.
//
// HARD CONTRACT (a hook that hangs or errors degrades EVERY session):
//   - INERT until ~/.relay/config.json exists (exit 0, do nothing) — safe to wire globally.
//   - 2.5s AbortController on the fetch + a 4s absolute backstop that force-exits 0.
//   - swallow every error; ALWAYS exit 0. NEVER exit non-zero (exit 2 would block the session).
//
// Reads the event JSON from stdin; the human-facing text is the `message` field. The event also
// carries `session_id` and `cwd` — we forward both (plus the project name and host) so every push
// is traceable in Relay's notification audit log ("why did I get this, and which session sent it?")
// and the lock-screen title says WHICH project, instead of an anonymous "Claude Code".

import os from 'node:os';
import { loadConfig, projectFromCwd, classifyNotification } from '../lib/relay-lib.mjs';

setTimeout(() => process.exit(0), 4000); // absolute backstop — fires even if everything stalls

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) return; // unconfigured → inert

  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    payload = {};
  }
  const message = typeof payload.message === 'string' && payload.message ? payload.message : 'Claude needs your input.';

  // Attribution carried by the Claude Code Notification event. session_id + cwd identify the
  // exact session; project (cwd basename) is the human label; host distinguishes machines.
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const project = projectFromCwd(cwd);
  let host = null;
  try {
    host = os.hostname() || null;
  } catch {
    /* hostname unavailable — leave null */
  }
  // Put the project in the TITLE so the lock screen already tells you which session pinged —
  // no need to open the app to find out. Body stays the verbatim Claude Code message.
  const title = project ? `Claude Code · ${project}` : 'Claude Code';

  // 'idle' = "Claude is waiting for your input" — a low-value nudge with nothing to act on (it
  // led nowhere when tapped). Record it for the audit trail (deliver:false) but DON'T buzz the
  // phone. Permission prompts and everything else still push normally.
  const event = classifyNotification(message);
  const deliver = event !== 'idle';

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`${cfg.url}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify({
        title,
        body: message,
        tag: 'relay-attn',
        url: '/',
        source: 'notification',
        sessionId,
        cwd,
        project,
        host,
        event,
        deliver,
      }),
      signal: ctrl.signal,
    });
  } catch {
    // network/timeout/server down — ignore; the session must not be affected
  } finally {
    clearTimeout(t);
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
