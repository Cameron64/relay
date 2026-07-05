#!/usr/bin/env node
// Claude Code "SessionStart" hook -> silent audit-trail row (relay-roadmap Plan 03). Records that
// a session started, WITHOUT pushing anything to the phone — the Sessions dashboard (GET
// /api/sessions) folds these rows (+ the matching session-end row + every other push) to answer
// "which sessions exist right now, and what project". See session-end-hook.mjs for its pair.
//
// Same HARD CONTRACT as every other Relay hook (notify-hook.mjs): inert until
// ~/.relay/config.json exists, fast AbortController timeout + an absolute setTimeout backstop,
// ALWAYS exit 0 (a hook that blocks or errors degrades every session start).

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

  // Same attribution shape as every other hook — session_id + cwd identify the exact session;
  // project (cwd basename) is the human label the dashboard shows; host distinguishes machines.
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
        body: 'Session started',
        tag: 'relay-session',
        url: '/',
        source: 'session',
        sessionId,
        cwd,
        project,
        host,
        event: 'session-start',
        deliver: false, // audit-trail only — never buzz the phone for a session opening
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
