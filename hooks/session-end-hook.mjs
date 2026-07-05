#!/usr/bin/env node
// Claude Code "SessionEnd" hook -> silent audit-trail row (relay-roadmap Plan 03). The pair to
// session-start-hook.mjs: records that a session ended so the Sessions dashboard (GET
// /api/sessions) can flip that session's status to 'ended' instead of leaving it 'stale' forever.
// A killed terminal / crashed process never fires this — the dashboard labels that 'stale' rather
// than lying about a clean end (see the plan's Non-goals: no process-level truth).
//
// Same HARD CONTRACT as every other Relay hook: inert until ~/.relay/config.json exists, fast
// AbortController timeout + an absolute setTimeout backstop, ALWAYS exit 0 (a hook that blocks or
// errors on SessionEnd could delay the session from actually closing).

import os from 'node:os';
import { loadConfig, projectFromCwd } from '../lib/relay-lib.mjs';

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
  if (!cfg) return; // unconfigured -> inert

  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    payload = {};
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const project = projectFromCwd(cwd);
  let host = null;
  try {
    host = os.hostname() || null;
  } catch {
    /* hostname unavailable — leave null */
  }
  const title = project ? `Relay · ${project}` : 'Relay';

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2500);
  try {
    await fetch(`${cfg.url}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify({
        title,
        body: 'Session ended',
        tag: 'relay-session',
        url: '/',
        source: 'session',
        sessionId,
        cwd,
        project,
        host,
        event: 'session-end',
        deliver: false, // audit-trail only — never buzz the phone for a session closing
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
