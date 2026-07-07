#!/usr/bin/env node
// relay-runner — the desktop half of the phone-brainstorm bridge (relay-roadmap Plan 02).
// Always-on daemon (see runner/SETUP.md for Windows startup wiring): reads ~/.relay/runner.json,
// announces its targets to the server, then loops GET /api/dispatches/next?wait=50 forever. On a
// claimed job it spawns a headless `claude -p --output-format json` in the target's pre-approved
// cwd, writes the phone's text to a job-scoped temp file OUTSIDE any repo, and reports
// running -> done/failed back to the server. A successful job posts its own result CARD (which
// pushes to the phone on its own — see routes-cards.ts); only a failure gets a server-side push
// (routes-dispatch.ts, source:'dispatch'), since there's no card behind a failure to deep-link to.
//
// SECURITY INVARIANT (see dispatch-store.ts's header + relay-roadmap 00-master.md §7): the server
// can only ever hand this runner a target *id* and free-text *body* — never a cwd/command/argv.
// Every cwd this process spawns into comes from THIS FILE'S OWN local ~/.relay/runner.json, never
// from the network. Do not "simplify" that away by trusting a path/command from a dispatch row.
//
// `dispatches.claude_session` (a DB-sourced id echoed back for --resume on follow-ups) IS one
// piece of network-sourced data that reaches spawn's argv, and spawn runs with shell:true on
// win32 (needed to resolve the `claude` PATH shim) — so it must be validated against a strict
// allow-list format (isValidClaudeSessionId) BEFORE ever being placed in argv. A DB/server
// compromise must not be able to smuggle shell metacharacters through this field into an
// arbitrary command execution on the runner's desktop. See relay-runner.test.ts for the
// regression test covering a malicious claude_session value.
//
// Deliberately run under plain `node` (not `bun`) — see the plan's Gotchas: child_process.spawn
// semantics for a Windows-shimmed executable (`claude.cmd`) are the well-trodden ones under node,
// and this file has zero dependencies either way.
//
// Resilience contract (mirrors the hooks' hard contract, scaled for a long-running daemon rather
// than a short-lived hook call): the poll loop NEVER exits on error (network blip, malformed job,
// spawn failure) — it logs to ~/.relay/runner.log (size-capped, one rotation) and keeps going.
// Ctrl+C / SIGTERM / a Windows logoff killing the process are the only exits.
//
// ASSUMPTION FLAGGED FOR REVIEW (per the roadmap's "verify the exact headless flags" instruction):
// the prompt is piped via STDIN rather than passed as a positional argv string. `claude -p` reads
// the prompt from stdin when none is given positionally — this sidesteps ALL argv-quoting risk
// for arbitrary phone text (there is none passed as an argv string, ever) and is the same reason
// stdin-piped headless invocation ("cat file | claude -p") is the commonly documented form. If a
// future Claude Code version changes this, swap buildPrompt's consumer from stdin to a `-p`
// positional arg — the rest of the pipeline (parseClaudeOutput, job files) is unaffected.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { loadConfig, relayDir, projectFromCwd } from '../lib/relay-lib.mjs';

const RUNNER_CONFIG_PATH = join(relayDir(), 'runner.json');
const LOG_PATH = join(relayDir(), 'runner.log');
const JOBS_DIR = join(relayDir(), 'runner-jobs');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB, then rotate to .log.1 (single generation — good enough for a personal daemon)

const POLL_WAIT_SECS = 50; // server caps ?wait at 55s; leave margin — see routes-dispatch.ts
const RETRY_DELAY_MS = 5000; // backoff after a transient network/HTTP failure
const JOB_TIMEOUT_MIN = Number(process.env.RUNNER_JOB_TIMEOUT_MIN ?? 30);
const RESULT_CARD_BODY_MAX = 20 * 1024; // matches the plan's "truncate ~20 KB"

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  process.stderr.write(stamped);
  try {
    mkdirSync(relayDir(), { recursive: true });
    try {
      if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) renameSync(LOG_PATH, LOG_PATH + '.1');
    } catch {
      /* rotation is best-effort — never let it block logging */
    }
    appendFileSync(LOG_PATH, stamped);
  } catch {
    /* logging must never crash the loop */
  }
}

// --- runner.json (exported for tests) ---------------------------------------

export function parseRunnerConfig(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('runner.json must be an object');
  const host = typeof parsed.host === 'string' && parsed.host.trim() ? parsed.host.trim() : os.hostname();
  const concurrencyRaw = Number(parsed.concurrency);
  const concurrency = Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.floor(concurrencyRaw) : 1;
  if (!Array.isArray(parsed.targets) || parsed.targets.length === 0) throw new Error('runner.json must have a non-empty "targets" array');
  const targets = [];
  const seen = new Set();
  for (const t of parsed.targets) {
    if (!t || typeof t !== 'object') throw new Error('each target must be an object');
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : null;
    const label = typeof t.label === 'string' && t.label.trim() ? t.label.trim() : null;
    const cwd = typeof t.cwd === 'string' && t.cwd.trim() ? t.cwd.trim() : null;
    if (!id) throw new Error('target.id required');
    if (!label) throw new Error(`target "${id}": label required`);
    if (!cwd) throw new Error(`target "${id}": cwd required`);
    if (seen.has(id)) throw new Error(`duplicate target id: ${id}`);
    seen.add(id);
    const permissionMode = typeof t.permissionMode === 'string' && t.permissionMode ? t.permissionMode : 'default';
    const promptPrefix = typeof t.promptPrefix === 'string' ? t.promptPrefix : '';
    targets.push({ id, label, cwd, permissionMode, promptPrefix });
  }
  return { host, concurrency, targets };
}

export function loadRunnerConfig() {
  if (!existsSync(RUNNER_CONFIG_PATH)) {
    throw new Error(`no runner config at ${RUNNER_CONFIG_PATH} — copy runner/runner.example.json there and edit it`);
  }
  return parseRunnerConfig(readFileSync(RUNNER_CONFIG_PATH, 'utf8'));
}

export function resolveTarget(config, targetId) {
  return config.targets.find((t) => t.id === targetId) ?? null;
}

export function buildPrompt(target, jobFile, assetFiles = []) {
  const prefix = target.promptPrefix || 'Triage this phone brainstorm: organize it, identify action items, and propose next steps.\n\n';
  let attachments = '';
  if (assetFiles.length) {
    const list = assetFiles.map((f) => `  - ${f}`).join('\n');
    attachments = `\nThe user also attached ${assetFiles.length} file(s) from their phone (images or documents). They are saved next to the text at:\n${list}\nInspect any that are relevant.`;
  }
  return `${prefix}The user sent this from their phone. Full text is at ${jobFile} — read it first.${attachments}\nWhen finished, summarize what you did/found.`;
}

// Sanitize a phone-supplied filename before it is written to the runner's OWN filesystem. This is
// the ONE place network-sourced data becomes a path on the runner host, so it is defended hard
// (see the file header's SECURITY INVARIANT): take the basename only (drop any / or \ segments),
// strip a leading dot so ".ssh" / dotfiles can't be produced, allow-list [A-Za-z0-9._-] and
// collapse everything else to '_', cap the length, and fall back to a stable name keyed by the
// asset id when nothing usable survives. `..` and absolute paths cannot escape the job dir because
// the result is a single sanitized segment joined onto JOBS_DIR/<id>.
export function safeAssetFilename(raw, assetId) {
  const fallback = `attachment-${String(assetId || 'file').replace(/[^A-Za-z0-9._-]/g, '')}` || 'attachment';
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const base = raw.split(/[/\\]/).pop() || '';
  let cleaned = base.replace(/^\.+/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

// `claude -p --output-format json`'s session_id is a UUID today, but validate by allow-listed
// charset rather than UUID shape specifically — cheap, forward-compatible, and (this is the part
// that matters) closes off shell metacharacters before this value ever reaches argv under
// spawn(..., { shell: true }) on win32. See the file header's SECURITY INVARIANT note.
export function isValidClaudeSessionId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(s);
}

// --- claude -p output parsing (exported for tests) --------------------------
// `claude -p --output-format json` prints one JSON object with (at least) `result` and
// `session_id`. Parse defensively: an unparseable/truncated/multi-line stdout tail becomes the
// result text itself rather than failing the job outright (per the plan's Gotchas) — a garbled
// JSON envelope usually still contains prose worth reporting back to the phone.
export function parseClaudeOutput(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return { result: '(no output)', sessionId: null };
  try {
    const parsed = JSON.parse(trimmed);
    const result = typeof parsed.result === 'string' && parsed.result ? parsed.result : JSON.stringify(parsed).slice(0, 2000);
    const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
    return { result, sessionId };
  } catch {
    // Not valid JSON as a whole (extra log lines around it, etc.) — try each line from the end,
    // since `claude -p`'s JSON result is normally the LAST line of stdout.
    const lines = trimmed.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        const result = typeof parsed.result === 'string' && parsed.result ? parsed.result : lines[i];
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null;
        return { result, sessionId };
      } catch {
        continue;
      }
    }
    return { result: trimmed.slice(-4000), sessionId: null };
  }
}

// --- HTTP (thin wrappers; each call has its own timeout) --------------------

async function httpJson(cfg, path, opts = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken, ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

async function announceTargets(cfg, runnerConfig) {
  const targets = runnerConfig.targets.map((t) => ({ id: t.id, label: t.label })); // ids + labels ONLY — never a path
  try {
    const r = await httpJson(cfg, '/api/dispatch-targets', { method: 'POST', body: JSON.stringify({ host: runnerConfig.host, targets }) });
    if (!r.ok) log(`WARN announceTargets failed: ${r.status} ${JSON.stringify(r.body)}`);
    else log(`announced ${targets.length} target(s) as "${runnerConfig.host}"`);
  } catch (e) {
    log(`WARN announceTargets network error: ${e.message || e}`); // non-fatal — the loop still runs
  }
}

async function nextDispatch(cfg) {
  return httpJson(cfg, `/api/dispatches/next?wait=${POLL_WAIT_SECS}`, { method: 'GET' }, (POLL_WAIT_SECS + 10) * 1000);
}

async function claim(cfg, id, host) {
  return httpJson(cfg, `/api/dispatches/${id}/claim`, { method: 'POST', body: JSON.stringify({ host }) });
}

async function reportStatus(cfg, id, update) {
  return httpJson(cfg, `/api/dispatches/${id}/status`, { method: 'POST', body: JSON.stringify(update) });
}

async function postResultCard(cfg, payload) {
  return httpJson(cfg, '/api/cards', { method: 'POST', body: JSON.stringify(payload) }, 20_000);
}

// --- job execution -----------------------------------------------------------

function writeJobFile(id, body) {
  const dir = join(JOBS_DIR, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'brainstorm.md');
  writeFileSync(file, body, 'utf8');
  return file;
}

// Download each attachment the phone uploaded and write it into the job dir under a SANITIZED
// filename (see safeAssetFilename). Returns the absolute paths written, for buildPrompt to point
// Claude at. Best-effort per asset: a single failed download is logged and skipped, never fatal to
// the whole job (the text brainstorm is the primary payload; a missing attachment shouldn't sink
// it). Collisions after sanitization are de-duped with a numeric prefix so two "photo.jpg" uploads
// don't clobber each other.
async function writeJobAssets(cfg, d) {
  const assets = Array.isArray(d.assets) ? d.assets : [];
  if (!assets.length) return [];
  const dir = join(JOBS_DIR, d.id);
  mkdirSync(dir, { recursive: true });
  const written = [];
  const used = new Set();
  for (const [i, a] of assets.entries()) {
    let name = safeAssetFilename(a.filename, a.id);
    if (used.has(name)) name = `${i}-${name}`;
    used.add(name);
    const dest = join(dir, name);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(`${cfg.url}/api/dispatches/${d.id}/asset/${a.id}`, {
        headers: { 'x-write-token': cfg.writeToken },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        log(`dispatch ${d.id}: asset ${a.id} download failed: HTTP ${res.status} — skipping`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(dest, buf);
      written.push(dest);
    } catch (e) {
      log(`dispatch ${d.id}: asset ${a.id} download error: ${e.message || e} — skipping`);
    } finally {
      clearTimeout(t);
    }
  }
  return written;
}

// Spawn `claude -p ...`, feed the prompt over stdin (see the file header's flagged assumption),
// and collect stdout/stderr. NEVER rejects — a spawn failure resolves with a non-zero code and the
// error in stderr, so the caller has exactly one failure path to handle either kind of failure.
function runClaude({ cwd, prompt, permissionMode, resumeSessionId, timeoutMin }) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--permission-mode', permissionMode || 'default'];
    if (resumeSessionId) args.push('--resume', resumeSessionId);

    let child;
    try {
      // shell:true on win32 only: resolves the `claude` PATH shim (commonly a .cmd/.ps1 wrapper,
      // which node's spawn cannot exec directly without a shell). The phone-supplied brainstorm
      // body never reaches argv (it travels over stdin) — but `resumeSessionId` (DB-sourced, see
      // the file header's SECURITY INVARIANT) does reach argv here. The caller (handleDispatch)
      // MUST validate it with isValidClaudeSessionId before it ever gets to this function; this
      // function does not re-validate so that a missing caller-side check fails loudly in tests
      // rather than being silently masked here.
      child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: `spawn failed: ${e.message}`, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, Math.max(1, timeoutMin) * 60_000);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    };

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      stderr += stderr ? `\n${e.message}` : e.message;
      finish(1);
    });
    child.on('close', (code) => finish(code));

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch {
      /* if stdin is already gone the process will just see EOF — close/error handles the rest */
    }
  });
}

async function handleDispatch(cfg, runnerConfig, d) {
  const target = resolveTarget(runnerConfig, d.target);
  if (!target) {
    log(`dispatch ${d.id}: unknown target "${d.target}" on ${runnerConfig.host}`);
    await reportStatus(cfg, d.id, { status: 'failed', result_summary: `unknown target "${d.target}" on ${runnerConfig.host}` });
    return;
  }

  // SECURITY: claude_session is DB-sourced (server-copied from a parent dispatch row on
  // resume_of — see dispatch-store.ts), not free-typed phone text, but it still reaches
  // spawn's argv under shell:true on win32 (see runClaude's SECURITY note). Validate its
  // charset BEFORE it ever gets near argv — a DB/server compromise must not be able to smuggle
  // shell metacharacters through this field into arbitrary command execution on this desktop.
  let resumeSessionId = null;
  if (d.claude_session) {
    if (!isValidClaudeSessionId(d.claude_session)) {
      log(`dispatch ${d.id}: rejected malformed claude_session on resume (refusing to pass it to spawn argv) — failing job`);
      await reportStatus(cfg, d.id, { status: 'failed', result_summary: 'rejected: malformed claude_session on resume' });
      return;
    }
    resumeSessionId = d.claude_session;
  }

  log(`dispatch ${d.id}: running in ${target.cwd} (target=${target.id}, resume=${resumeSessionId ?? 'none'})`);
  await reportStatus(cfg, d.id, { status: 'running' });

  const jobFile = writeJobFile(d.id, d.body);
  const assetFiles = await writeJobAssets(cfg, d);
  if (assetFiles.length) log(`dispatch ${d.id}: wrote ${assetFiles.length} attachment(s)`);
  const prompt = buildPrompt(target, jobFile, assetFiles);
  const result = await runClaude({
    cwd: target.cwd,
    prompt,
    permissionMode: target.permissionMode,
    resumeSessionId,
    timeoutMin: JOB_TIMEOUT_MIN,
  });

  // Best-effort cleanup of the job's temp dir regardless of outcome — its content already made it
  // into the prompt/summary; nothing downstream needs the file to persist.
  try {
    rmSync(join(JOBS_DIR, d.id), { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  if (result.timedOut) {
    log(`dispatch ${d.id}: timed out after ${JOB_TIMEOUT_MIN}m`);
    await reportStatus(cfg, d.id, { status: 'failed', result_summary: `timed out after ${JOB_TIMEOUT_MIN} minutes` });
    return;
  }
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout || '').slice(-500);
    log(`dispatch ${d.id}: claude exited ${result.code}: ${tail}`);
    await reportStatus(cfg, d.id, { status: 'failed', result_summary: `claude exited ${result.code}: ${tail}`.slice(0, 2000) });
    return;
  }

  const { result: resultText, sessionId } = parseClaudeOutput(result.stdout);
  const cardBody = resultText.length > RESULT_CARD_BODY_MAX ? resultText.slice(0, RESULT_CARD_BODY_MAX) + '\n\n…(truncated)' : resultText;

  const cardPayload = {
    kind: 'note',
    title: `✅ ${d.title || 'Dispatch'}`,
    body: cardBody,
    push: true,
    source: { sessionId, cwd: target.cwd, project: projectFromCwd(target.cwd), host: runnerConfig.host },
  };
  let resultCardId = null;
  try {
    const posted = await postResultCard(cfg, cardPayload);
    if (posted.ok && typeof posted.body.id === 'string') resultCardId = posted.body.id;
    else log(`dispatch ${d.id}: result card post failed: ${posted.status} ${JSON.stringify(posted.body)}`);
  } catch (e) {
    log(`dispatch ${d.id}: result card post network error: ${e.message || e}`);
  }

  // Wrapped like postResultCard above (and deliberately NOT rethrown): the job already finished
  // and — when resultCardId is set — already delivered a result card + push to the phone. If this
  // call throws, letting it propagate to mainLoop's catch would report status:'failed' on a
  // dispatch that in fact succeeded, permanently overwriting the true outcome (running -> failed
  // is a legal transition, so the overwrite would stick) with no result_card_id/result_summary
  // ever recorded — the phone would see a failed badge alongside a separately-arriving result
  // card. Best-effort retry once after a short delay, then give up and just log.
  try {
    await reportStatus(cfg, d.id, {
      status: 'done',
      claude_session: sessionId,
      result_summary: resultText.slice(0, 200),
      result_card_id: resultCardId,
    });
    log(`dispatch ${d.id}: done (session=${sessionId ?? 'none'}, card=${resultCardId ?? 'none'})`);
  } catch (e) {
    log(`dispatch ${d.id}: reportStatus(done) network error, retrying once: ${e.message || e}`);
    try {
      await sleep(RETRY_DELAY_MS);
      await reportStatus(cfg, d.id, {
        status: 'done',
        claude_session: sessionId,
        result_summary: resultText.slice(0, 200),
        result_card_id: resultCardId,
      });
      log(`dispatch ${d.id}: done on retry (session=${sessionId ?? 'none'}, card=${resultCardId ?? 'none'})`);
    } catch (e2) {
      log(
        `dispatch ${d.id}: reportStatus(done) failed after retry — result card (${resultCardId ?? 'none'}) was already delivered; ` +
          `NOT letting this bubble up to a failed report, which would overwrite a job that actually succeeded: ${e2.message || e2}`,
      );
    }
  }
}

// --- main loop ---------------------------------------------------------------
// Concurrency is always 1 in v1 regardless of runner.json's `concurrency` field (the plan's
// explicit default — "claim only when idle" avoids two headless sessions colliding in one repo).
// The field is parsed/kept for a later plan to use; this loop simply never claims a second job
// before the first one's reportStatus('done'|'failed') call returns.
async function mainLoop(cfg, runnerConfig) {
  log(`relay-runner starting — host="${runnerConfig.host}" targets=[${runnerConfig.targets.map((t) => t.id).join(', ')}]`);
  await announceTargets(cfg, runnerConfig);

  for (;;) {
    let next;
    try {
      next = await nextDispatch(cfg);
    } catch (e) {
      log(`WARN poll failed: ${e.message || e}`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (!next.ok) {
      log(`WARN poll HTTP ${next.status}: ${JSON.stringify(next.body)}`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (next.body.status !== 'ok' || !next.body.dispatch) continue; // 'none' after the wait budget — loop again immediately

    const queued = next.body.dispatch;
    let claimed;
    try {
      claimed = await claim(cfg, queued.id, runnerConfig.host);
    } catch (e) {
      log(`WARN claim failed: ${e.message || e}`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (!claimed.ok || claimed.body.status !== 'claimed') continue; // another runner won, or it vanished — re-poll

    try {
      await handleDispatch(cfg, runnerConfig, claimed.body.dispatch);
    } catch (e) {
      // Should be unreachable (every path inside handleDispatch resolves rather than throws), but
      // the loop must survive regardless of what a job throws — never let one bad job kill the daemon.
      log(`ERROR handleDispatch threw: ${e && e.stack ? e.stack : e}`);
      try {
        await reportStatus(cfg, queued.id, { status: 'failed', result_summary: `runner error: ${e.message || e}` });
      } catch {
        /* best effort */
      }
    }
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg) {
    log('ERROR relay is not configured — run: node bin/relay.mjs init --url <https://...> --token <WRITE_TOKEN>');
    process.exitCode = 1;
    return;
  }
  let runnerConfig;
  try {
    runnerConfig = loadRunnerConfig();
  } catch (e) {
    log(`ERROR ${e.message}`);
    process.exitCode = 1;
    return;
  }
  await mainLoop(cfg, runnerConfig);
}

// Same "am I the entry point?" idiom as bin/relay.mjs — stays false when imported by tests.
const isEntry =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((e) => {
    log(`FATAL ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}
