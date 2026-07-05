#!/usr/bin/env node
// Claude Code "PreToolUse" hook — AFK-gated remote approval bridge (relay-roadmap plan 01).
//
// When Cam is at his desk, a permission prompt just sits in the terminal — fine, he's right
// there. When he's AFK, that same prompt stalls the session with nobody watching. This hook lets
// a small, user-configured set of high-risk tool calls escape to the phone as a Relay approval
// card instead, and maps the phone verdict back to a PreToolUse decision.
//
// TRIPLE-GATED (each is a fast local file read — this fires on EVERY tool call of EVERY session):
//   1. ~/.relay/config.json must exist (relay configured at all).
//   2. `relay afk on` must be flagged (~/.relay/afk.json) — an at-desk session is a total no-op.
//   3. ~/.relay/permission-rules.json must contain a rule matching this tool_name/tool_input.
// Any of the three failing means this hook has "no opinion" — it prints NOTHING and exits 0, the
// same inert-by-default posture as every other Relay hook (notify-hook.mjs), letting Claude
// Code's normal permission flow (settings allowlist / terminal prompt) proceed untouched.
//
// Only once gate 3 has actually matched does this hook commit to an opinion, and from that point
// on EVERY exit path prints an explicit decision — including failure paths (network error, card
// creation failure, poll timeout). Fail-closed to "ask" (the terminal prompt) in all of those
// cases; NEVER fail open to "allow". A bug here must reproduce today's behavior (stall at a
// prompt nobody's watching), not silently grant a dangerous tool call.
//
// Verified PreToolUse contract (claude-code-guide, 2026 docs — see roadmap 01's Preflight):
//   stdin (JSON):  { session_id, cwd, tool_name, tool_input, ... }
//   stdout (JSON, optional — printing nothing means "no opinion"):
//     {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny"|"ask","permissionDecisionReason":"..."}}
// Wired with a large per-hook `timeout` (600s in settings.json, see hooks/SETUP.md) to give a
// human on the phone time to answer; RELAY_PERM_DEADLINE_SECS (default 540) keeps our own poll
// loop comfortably under that so we always get a chance to print a decision before Claude Code's
// hook timeout would kill the process outright (which degrades to "ask" anyway, but late).
//
// Same hook hard contract as notify-hook.mjs otherwise: AbortController on every fetch, an
// absolute setTimeout backstop, and ALWAYS exit 0 (a non-zero exit here would block the tool call
// outright — this hook's feature is the JSON decision, never the exit code).

import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { loadConfig, readAfk, loadPermissionRules, matchPermissionRule, projectFromCwd } from '../lib/relay-lib.mjs';

const DEADLINE_MS = Math.max(1, Number(process.env.RELAY_PERM_DEADLINE_SECS) || 540) * 1000;
const PER_POLL_CAP_SECS = 50; // server caps /response?wait= at 55s; leave margin
const BODY_MAX = 4000; // cap the rendered card body (README/master doc: keep pushes/rows small)

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

// The entire feature surface of this hook is one JSON line on stdout — see file header. Callers
// that never matched a rule (main()'s early returns) simply never call this, which is what makes
// them a true no-op rather than an explicit "ask".
function emitDecision(out) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }) + '\n');
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + '\n… (truncated)';
}

// Pure: render the approval card's markdown body from the tool name + input. Exported for tests.
// Bash gets a fenced command; Write/Edit get the file path plus a capped content preview (content
// for Write, new_string for Edit); everything else falls back to pretty-printed tool_input JSON.
// Always capped at BODY_MAX so a huge Write body can't bloat the card row or the push payload.
export function buildApprovalBody(toolName, toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (toolName === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : JSON.stringify(input);
    return truncate('```bash\n' + cmd + '\n```', BODY_MAX);
  }
  if (toolName === 'Write' || toolName === 'Edit') {
    const path = typeof input.file_path === 'string' ? input.file_path : '(unknown file)';
    const content =
      typeof input.content === 'string' ? input.content : typeof input.new_string === 'string' ? input.new_string : '';
    const preview = content
      ? '\n\n```\n' + content.slice(0, 2000) + (content.length > 2000 ? '\n… (truncated)' : '') + '\n```'
      : '';
    return truncate(`**${path}**${preview}`, BODY_MAX);
  }
  return truncate('```json\n' + JSON.stringify(input, null, 2) + '\n```', BODY_MAX);
}

// Pure: map a resolved (or not) /response poll result to a PreToolUse decision. Exported for
// tests. Fail-closed everywhere except the one explicit "approved" case:
//   responded, verdict 'approved'           -> allow
//   responded, verdict 'changes_requested'  -> deny, reason = the phone's note (so Claude sees
//                                              WHY and can redirect: "deny — do X instead"), or a
//                                              generic fallback when no note was typed
//   responded, any other/custom verdict      -> ask (e.g. a dismissed card — never auto-allow an
//                                              unrecognized outcome)
//   pending (timeout) / notfound (card expired or dismissed before answer) / no response at all
//                                             -> ask (fail closed; the terminal prompt takes over)
export function mapVerdictToDecision(result) {
  if (result && result.status === 'responded' && result.response) {
    const { verdict, note } = result.response;
    if (verdict === 'approved') return { permissionDecision: 'allow' };
    if (verdict === 'changes_requested') {
      return { permissionDecision: 'deny', permissionDecisionReason: (note && note.trim()) || 'Denied from phone' };
    }
    return { permissionDecision: 'ask', ...(note && note.trim() ? { permissionDecisionReason: note } : {}) };
  }
  return { permissionDecision: 'ask' };
}

// Bounded long-poll loop — same idiom as bin/relay.mjs's pollUntil / the master doc's §8
// bounded-poll contract. Every fetch carries its own AbortController so a stalled network can
// never hang past this hook's own deadline.
async function pollUntil(cfg, id, deadline) {
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) return { status: 'pending' };
    const perPoll = Math.min(remaining, PER_POLL_CAP_SECS);
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), (perPoll + 10) * 1000);
    let res;
    try {
      res = await fetch(`${cfg.url}/api/cards/${id}/response?wait=${perPoll}`, {
        headers: { 'x-write-token': cfg.writeToken },
        signal: ctrl.signal,
      });
    } catch {
      clearTimeout(abortTimer);
      await new Promise((r) => setTimeout(r, 1000)); // transient network/edge drop — retry within budget
      continue;
    }
    clearTimeout(abortTimer);
    if (res.status === 404) return { status: 'notfound' };
    if (!res.ok) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    let data;
    try {
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (data.status === 'responded') return data;
    // server hit its own cap and returned pending — loop again if budget remains
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) return; // unconfigured -> no opinion, stay fully inert

  const afk = readAfk();
  if (!afk) return; // at the desk -> no opinion; this is what keeps every normal session untouched

  let payload = {};
  try {
    payload = JSON.parse((await readStdin()) || '{}');
  } catch {
    payload = {};
  }
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;
  const toolInput = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (!toolName) return; // can't classify the call -> no opinion

  const rules = loadPermissionRules();
  const rule = matchPermissionRule(rules, toolName, toolInput);
  if (!rule) return; // no configured rule wants this call -> no opinion

  // Every path below has committed to an opinion — from here on we ALWAYS emit a decision.
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const project = projectFromCwd(cwd);
  let host = null;
  try {
    host = os.hostname() || null;
  } catch {
    /* hostname unavailable — leave null */
  }

  const cardPayload = {
    kind: 'approval',
    title: `⚠ ${project || 'Claude Code'} — allow ${toolName}?`,
    body: buildApprovalBody(toolName, toolInput),
    priority: 'high', // this genuinely blocks work — sticky notification
    buttons: [
      { id: 'allow', label: 'Allow', behavior: 'respond', verdict: 'approved', style: 'primary' },
      { id: 'deny', label: 'Deny', behavior: 'respond', verdict: 'changes_requested', style: 'danger' },
    ],
    source: { sessionId, cwd, project, host },
  };

  let created;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    let res;
    try {
      res = await fetch(`${cfg.url}/api/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
        body: JSON.stringify(cardPayload),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    created = await res.json();
  } catch {
    // Couldn't even create the card (network down, server unreachable) — fail closed to the
    // terminal prompt, exactly like any other unexpected failure in this hook.
    emitDecision({ permissionDecision: 'ask', permissionDecisionReason: 'relay: could not reach the approval server' });
    return;
  }

  const deadline = Date.now() + DEADLINE_MS;
  const result = await pollUntil(cfg, created.id, deadline);
  emitDecision(mapVerdictToDecision(result));
}

// Portable "am I the entry point?" (same pattern as bin/relay.mjs) — keeps main() from running,
// and the backstop timer from ever being scheduled, when this file is imported by tests for its
// pure exports (buildApprovalBody / mapVerdictToDecision).
const isEntry =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  // Absolute backstop: if the poll loop or anything else stalls past our own deadline, force an
  // explicit "ask" decision rather than let Claude Code's hook timeout (600s, see SETUP.md) kill
  // the process with no stdout at all. .unref() so this timer can never itself keep the process
  // alive once main() has already finished and called process.exit(0).
  const backstop = setTimeout(() => {
    emitDecision({ permissionDecision: 'ask', permissionDecisionReason: 'relay pretool-hook: backstop timeout' });
    process.exit(0);
  }, DEADLINE_MS + 15_000);
  backstop.unref?.();

  main()
    .catch(() => emitDecision({ permissionDecision: 'ask', permissionDecisionReason: 'relay pretool-hook: unexpected error' }))
    .finally(() => process.exit(0));
}
