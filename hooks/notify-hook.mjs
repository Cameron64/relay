#!/usr/bin/env node
// Claude Code "Notification" hook → pushes "Claude needs you" to your phone via Relay.
//
// HARD CONTRACT (a hook that hangs or errors degrades EVERY session):
//   - INERT until ~/.relay/config.json exists (exit 0, do nothing) — safe to wire globally.
//   - 2.5s AbortController on the fetch + a 4s absolute backstop that force-exits 0.
//   - swallow every error; ALWAYS exit 0. NEVER exit non-zero (exit 2 would block the session).
//
// Reads the event JSON from stdin; the human-facing text is the `message` field.

import { loadConfig } from '../lib/relay-lib.mjs';

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

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`${cfg.url}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify({ title: 'Claude Code', body: message, tag: 'relay-attn', url: '/' }),
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
