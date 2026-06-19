#!/usr/bin/env node
// Claude Code "Stop" hook → if THIS session was armed via `relay arm "<label>"`, push
// "✅ <label> — done" to your phone and clear the flag. No flag → silent exit 0, so ordinary
// turns never ping (only the long task you explicitly armed does).
//
// Same HARD CONTRACT as notify-hook: inert until configured, fast timeout + backstop, ALWAYS
// exit 0 (NEVER exit 2 — that would prevent the session from ending). The arm flag is keyed by
// cwd (see lib/relay-lib.mjs sessionKey) so `relay arm` and this hook agree on the key.

import os from 'node:os';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, armedDir, sessionKey, projectFromCwd } from '../lib/relay-lib.mjs';

setTimeout(() => process.exit(0), 4000); // absolute backstop

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

  const key = sessionKey({ cwd: payload.cwd });
  const flagPath = join(armedDir(), key + '.json');
  if (!existsSync(flagPath)) return; // not armed → no ping

  let label = 'Task';
  try {
    const v = JSON.parse(readFileSync(flagPath, 'utf8'));
    if (v && typeof v.label === 'string' && v.label) label = v.label;
  } catch {
    // keep default label
  }
  try {
    rmSync(flagPath);
  } catch {
    // best effort
  }

  // Attribution (same shape as notify-hook) so the "done" ping is traceable in the audit log too.
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const project = projectFromCwd(cwd);
  let host = null;
  try {
    host = os.hostname() || null;
  } catch {
    /* hostname unavailable — leave null */
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`${cfg.url}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify({
        title: project ? `Relay · ${project}` : 'Relay',
        body: `✅ ${label} — done`,
        tag: 'relay-done',
        url: '/',
        source: 'stop',
        sessionId,
        cwd,
        project,
        host,
        event: 'done',
      }),
      signal: ctrl.signal,
    });
  } catch {
    // ignore
  } finally {
    clearTimeout(t);
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
