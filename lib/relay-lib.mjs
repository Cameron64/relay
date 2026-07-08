// Shared helpers for the relay CLI and the Claude Code hooks. Zero dependencies — runnable
// under both node and bun. Keeping config + sessionKey here guarantees `relay arm/disarm`
// (CLI) and the Stop hook compute the SAME key for the same session.

import os from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function relayDir() {
  return join(os.homedir(), '.relay');
}

// Sanitize a network-supplied filename before it becomes a path on THIS machine (the MCP writing a
// reply attachment to a temp dir for the agent to read). Same hardening as bin/relay-runner.mjs's
// safeAssetFilename: basename only (drop any / or \ segments), strip leading dots (no dotfiles),
// allow-list [A-Za-z0-9._-] and collapse the rest to '_', cap length, and fall back to an id-keyed
// name when nothing usable survives. The result is always a single path segment — `..`, absolute
// paths, and traversal cannot escape the dir it is joined onto.
export function safeFilename(raw, id) {
  const fallback = `attachment-${String(id || 'file').replace(/[^A-Za-z0-9._-]/g, '')}`;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const base = raw.split(/[/\\]/).pop() || '';
  const cleaned = base.replace(/^\.+/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}
export function configPath() {
  return join(relayDir(), 'config.json');
}
export function armedDir() {
  return join(relayDir(), 'armed');
}
export function afkPath() {
  return join(relayDir(), 'afk.json');
}
export function permissionRulesPath() {
  return join(relayDir(), 'permission-rules.json');
}

/**
 * Read the AFK flag (~/.relay/afk.json) written by `relay afk on`. Returns the parsed record
 * ({ since, reason, host }) when Cam is away, or null when he's at the desk. Mirrors loadConfig's
 * defensive shape: ANY read/parse failure (missing, truncated, hand-edited garbage) returns null,
 * so a corrupt flag fails safe to "at desk" rather than bricking every relay command that consults
 * it. Used by `relay afk status` (exit 10 when non-null) and the AFK-aware /relay + /show skills.
 */
export function readAfk() {
  try {
    if (!existsSync(afkPath())) return null;
    return JSON.parse(readFileSync(afkPath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve { url, writeToken } from ~/.relay/config.json, overridable by RELAY_URL /
 * RELAY_WRITE_TOKEN env. Returns null if unconfigured — hooks treat null as "exit 0,
 * stay inert"; the CLI treats it as a friendly error.
 */
export function loadConfig() {
  let cfg = {};
  try {
    if (existsSync(configPath())) cfg = JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    cfg = {};
  }
  const url = process.env.RELAY_URL || cfg.url || '';
  const writeToken = process.env.RELAY_WRITE_TOKEN || cfg.writeToken || '';
  if (!url || !writeToken) return null;
  return { url: String(url).replace(/\/+$/, ''), writeToken: String(writeToken) };
}

/**
 * Stable key for the `relay arm` flag, computed IDENTICALLY by the CLI and the Stop hook.
 *
 * Keyed by CWD, not session id: verified (claude-code-guide, 2026-06) that CLAUDE_SESSION_ID
 * is NOT reliably exported into Bash-tool subprocesses, so `relay arm` (run in a Bash call)
 * cannot read the same session id the Stop hook gets on stdin. The cwd is the reliable common
 * denominator — `relay arm` uses process.cwd(); the Stop hook passes the payload's `cwd`; both
 * are the session's project root. Normalized (slashes + lowercase) so a Windows backslash path
 * from node's process.cwd() matches a forward-slash path in the hook payload.
 *
 * Trade-off: two concurrent sessions in the SAME directory would share one arm flag — an
 * acceptable edge case for a personal tool.
 */
export function sessionKey({ cwd } = {}) {
  const dir = String(cwd || process.cwd())
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
  return 'cwd-' + createHash('sha1').update(dir).digest('hex').slice(0, 16);
}

/**
 * Human label for "which session" — the basename of a project cwd. Separator-agnostic: handles
 * a Windows backslash path or a POSIX slash path regardless of the host OS (the hook payload's
 * cwd may use either). Returns null for empty/unusable input. Used both to make the push title
 * self-describing ("Claude Code · relay") and to attribute rows in the notification audit log.
 */
export function projectFromCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last || null;
}

/**
 * Session id Claude Code exports to child processes, when present — the sessionId leg of the
 * canonical attribution shape { sessionId, cwd, project, host } (see relay-roadmap 00-master.md
 * §3) that cards/notify-log/dispatches/card_events all key on for per-session aggregation.
 *
 * Reliable for the MCP server (a long-lived stdio subprocess Claude Code spawns directly) and for
 * hooks (which get session_id on stdin regardless). NOT reliably present for `relay` CLI
 * invocations run via the Bash tool — verified (claude-code-guide, 2026-06) alongside the
 * sessionKey note above. Callers must treat a missing env var as an expected degradation (null),
 * never as an error: the hooks and the Plan 02 runner are the writers sessionId can actually count
 * on.
 */
export function sessionIdFromEnv() {
  return process.env.CLAUDE_SESSION_ID || null;
}

/**
 * Read the user-authored ~/.relay/permission-rules.json (relay-roadmap plan 01 — see
 * hooks/permission-rules.example.json for the shape). Returns [] on ANYTHING that isn't a clean
 * parse: missing file (the common case — most sessions never opt in), truncated/garbage JSON, or
 * a `rules` field that isn't an array. Same defensive shape as loadConfig/readAfk: a broken file
 * must fail toward "the hook never intercepts", never toward a crash or a stale-cache surprise
 * (the pretool-hook re-reads this fresh on every single tool call — no caching, by design).
 */
export function loadPermissionRules() {
  try {
    if (!existsSync(permissionRulesPath())) return [];
    const parsed = JSON.parse(readFileSync(permissionRulesPath(), 'utf8'));
    return parsed && Array.isArray(parsed.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

// JS RegExp has no PCRE-style inline mode modifier — a literal "(?i)" prefix (as used in
// hooks/permission-rules.example.json, mirroring the plan doc's example) is a SyntaxError if
// compiled as-is. Strip it and always match case-insensitively instead, so the example file's
// rule works as written rather than silently never matching.
function toRegex(pattern) {
  return new RegExp(String(pattern).replace(/^\(\?i\)/, ''), 'i');
}

/**
 * Test a hook's (tool_name, tool_input) against permission-rules ({tool, inputMatch?}). Returns
 * the FIRST matching rule, or null. Pure and defensive on purpose — this runs on EVERY tool call
 * of every AFK session, so it must never throw: a non-array rules list, a malformed rule object,
 * or a bad regex in a hand-edited file all degrade to "no match" (fail toward the hook staying
 * inert), never to an exception that could take down the hook process.
 *
 * `tool` must match exactly. Absent `inputMatch` means "every call of this tool matches" (e.g. the
 * example file's bare `{ "tool": "Write" }`). Present `inputMatch` is tested against
 * JSON.stringify(tool_input) — a regex, not a substring search, so rules can target multiple
 * phrases at once (see the Bash rm/push/publish example).
 */
export function matchPermissionRule(rules, toolName, toolInput) {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (typeof rule.tool !== 'string' || rule.tool !== toolName) continue;
    if (rule.inputMatch === undefined || rule.inputMatch === null) return rule;
    if (typeof rule.inputMatch !== 'string') continue;
    try {
      if (toRegex(rule.inputMatch).test(JSON.stringify(toolInput ?? {}))) return rule;
    } catch {
      continue; // malformed regex — never match, never throw
    }
  }
  return null;
}

/**
 * Coarse "why did this push fire?" tag for a Claude Code Notification `message`. The audit trail
 * uses it to separate the low-value nudges from the actionable ones:
 *   - 'idle'       → "Claude is waiting for your input" (the 60s+ idle ping; the stray relays
 *                    that lead nowhere because no card is behind them)
 *   - 'permission' → a tool-approval prompt ("Claude needs your permission to use …")
 *   - 'other'      → anything else
 */
export function classifyNotification(message) {
  const m = String(message || '').toLowerCase();
  if (/waiting for your input|waiting for input|is idle/.test(m)) return 'idle';
  if (/permission|needs your approval|to use the|wants to use/.test(m)) return 'permission';
  return 'other';
}
