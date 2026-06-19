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
export function configPath() {
  return join(relayDir(), 'config.json');
}
export function armedDir() {
  return join(relayDir(), 'armed');
}
export function afkPath() {
  return join(relayDir(), 'afk.json');
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
