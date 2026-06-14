#!/usr/bin/env node
// relay — the Claude Code side of the bridge. Zero deps; runs under node or bun.
//
//   relay init --url <https://...> --token <WRITE_TOKEN>   # write ~/.relay/config.json
//   relay notify [--title T] [--body B] [--url U]          # fire a push (body from stdin if piped)
//   relay card  --title T [...]  [--wait[=SECS]]           # create a card; --wait blocks for a verdict
//   relay poll  <cardId> [--wait=SECS]                     # re-poll an existing card's verdict
//   relay arm "<label>" / relay disarm                    # arm/clear the Stop-hook "task done" ping
//
// --wait / poll exit codes (relay-specific): 0=approved  20=changes_requested  1=other  3=timeout.
// On timeout, the cardId is printed so Claude can re-issue `relay poll <id> --wait=50` in a
// fresh Bash call — the bounded-poll pattern that keeps every call under the harness limit.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, configPath, relayDir, armedDir, sessionKey, afkPath, readAfk } from '../lib/relay-lib.mjs';

const PER_POLL_CAP = 50; // server caps at 55; leave margin
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- arg parsing -----------------------------------------------------------
// Returns { _: positionals, flags: {...} }. Repeatable flags (image/button/link) collect
// into arrays. `--flag=value`, `--flag value`, and bare booleans all supported.
const REPEATABLE = new Set(['image', 'button', 'link']);
const BOOLEANS = new Set(['body-stdin', 'copy-stdin', 'high', 'push', 'no-push', 'open', 'no-open']);

function parseArgs(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (key === 'wait') {
        val = true; // --wait with no value => default budget
      } else if (BOOLEANS.has(key)) {
        val = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        val = argv[++i];
      } else {
        val = true;
      }
      if (REPEATABLE.has(key)) (flags[key] ||= []).push(val);
      else flags[key] = val;
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function die(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg)
    die(
      `relay is not configured. Run:\n  relay init --url <https://your-app.up.railway.app> --token <WRITE_TOKEN>\n(or set RELAY_URL and RELAY_WRITE_TOKEN). Config path: ${configPath()}`,
    );
  return cfg;
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

// --- button spec parser (exported for tests) -------------------------------
// "Label=action[:style]" -> respond button. Friendly action aliases map to verdicts.
const VERDICT_ALIAS = { approve: 'approved', approved: 'approved', changes: 'changes_requested', 'request-changes': 'changes_requested', changes_requested: 'changes_requested', dismiss: 'dismissed', dismissed: 'dismissed', reject: 'dismissed' };

export function parseButtonSpec(spec) {
  const eq = spec.indexOf('=');
  if (eq < 0) throw new Error(`bad --button "${spec}" (expected "Label=action[:style]")`);
  const label = spec.slice(0, eq).trim();
  let rest = spec.slice(eq + 1).trim();
  let style;
  const colon = rest.indexOf(':');
  if (colon >= 0) {
    style = rest.slice(colon + 1).trim() || undefined;
    rest = rest.slice(0, colon).trim();
  }
  if (!label || !rest) throw new Error(`bad --button "${spec}"`);
  const verdict = VERDICT_ALIAS[rest.toLowerCase()] || rest;
  return { id: verdict, label, behavior: 'respond', verdict, ...(style ? { style } : {}) };
}

export function parseLinkSpec(spec) {
  const eq = spec.indexOf('=');
  if (eq < 0) throw new Error(`bad --link "${spec}" (expected "Label=https://url")`);
  const label = spec.slice(0, eq).trim();
  const value = spec.slice(eq + 1).trim();
  if (!/^https?:\/\//i.test(value)) throw new Error(`--link url must be http(s): "${value}"`);
  return { id: 'link-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, behavior: 'link', value };
}

// --- draft template (exported for tests) -----------------------------------
// `relay draft` is the first Relay "template": a rich, WYSIWYG-editable message card the
// browser auto-opens to. buildDraftPayload is PURE (no fs/network) so it's unit-testable;
// cmdDraft pre-reads stdin/image assets and passes them in.
//
// v1 drafts take LINK buttons only. Respond buttons are deliberately rejected: they would
// collide with the editor's intrinsic copy toolbar and a respond-click's `card-updated` SSE
// would rebuild the card from the ORIGINAL body, wiping in-progress edits.
export function buildDraftPayload(flags, { stdin = '', cwd = '', host = null, assets = [] } = {}) {
  const title = typeof flags.title === 'string' ? flags.title : null;
  if (!title) throw new Error('relay draft: --title is required');
  let body = typeof flags.body === 'string' ? flags.body : null;
  if (flags['body-stdin']) body = stdin;
  if (flags.button) throw new Error('relay draft: respond buttons (--button) are not supported on drafts in v1 — use --link for links');
  const buttons = [];
  for (const spec of flags.link || []) buttons.push(parseLinkSpec(spec));
  return {
    kind: 'draft',
    title,
    body,
    source: { cwd, host, editable: true },
    buttons,
    priority: flags.high ? 'high' : 'normal',
    push: flags.push ? true : false, // auto-open makes a push to the same box redundant; --push opts in
    ...(assets.length ? { assets } : {}),
  };
}

// win32 `cmd /c start` re-parses its own command line and treats &, ^, | specially even when
// args are passed as an array — so validate the WHOLE assembled URL (not just the hex card id)
// before handing it to cmd.exe. Our card path /?card=<hex16> is always safe; this guards against
// a `cfg.url` containing shell-special characters.
const WIN_URL_SAFE = /^https?:\/\/[^\s"&^|<>]+$/;
export function browserOpenCommand(platform, url) {
  if (platform === 'win32') {
    if (!WIN_URL_SAFE.test(url)) throw new Error(`relay: refusing to open unsafe URL on win32: ${url}`);
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

export function isSameOrigin(url, cfgUrl) {
  try {
    return new URL(url).origin === new URL(cfgUrl).origin;
  } catch {
    return false;
  }
}

// Fire-and-forget open of the default browser. NEVER throws or blocks: a headless/SSH/no-DISPLAY
// box (or an unsafe URL) just means no window — `relay draft` must still succeed. Returns whether
// a spawn was attempted (for the caller's log line / tests).
function openInBrowser(url, cfgUrl) {
  if (!isSameOrigin(url, cfgUrl)) return false;
  let spec;
  try {
    spec = browserOpenCommand(process.platform, url);
  } catch {
    return false;
  }
  try {
    const child = spawn(spec.cmd, spec.args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function verdictExit(verdict) {
  if (verdict === 'approved') return 0;
  if (verdict === 'changes_requested') return 20;
  return 1; // dismissed / custom / other-action
}

// --- long-poll loop (one bounded Bash-call budget) -------------------------
async function pollUntil(cfg, id, totalSecs) {
  const deadline = Date.now() + totalSecs * 1000;
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) return { status: 'pending' };
    const perPoll = Math.min(remaining, PER_POLL_CAP);
    let res;
    try {
      res = await fetch(`${cfg.url}/api/cards/${id}/response?wait=${perPoll}`, {
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
    if (data.status === 'responded') return data;
    // server hit its cap and returned pending — loop again if budget remains
  }
}

function reportVerdict(id, data) {
  const r = data.response || {};
  process.stdout.write(JSON.stringify({ verdict: r.verdict, action: r.action, note: r.note, id }) + '\n');
  const noteStr = r.note ? ` — “${r.note}”` : '';
  process.stderr.write(`relay: ${r.verdict}${noteStr}\n`);
  process.exit(verdictExit(r.verdict));
}

// --- commands --------------------------------------------------------------
async function cmdInit(flags) {
  const url = typeof flags.url === 'string' ? flags.url : '';
  const token = typeof flags.token === 'string' ? flags.token : '';
  if (!url || !token) die('usage: relay init --url <https://...> --token <WRITE_TOKEN>');
  mkdirSync(relayDir(), { recursive: true });
  const existing = existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), 'utf8')) : {};
  const next = { ...existing, url: url.replace(/\/+$/, ''), writeToken: token };
  writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n');
  process.stdout.write(`wrote ${configPath()}\n`);
}

async function cmdNotify(cfg, flags) {
  let body = typeof flags.body === 'string' ? flags.body : '';
  if (!body) body = (await readStdin()).trim();
  const payload = {
    title: typeof flags.title === 'string' ? flags.title : 'Relay',
    body: body || 'You have a new update.',
    url: typeof flags.url === 'string' ? flags.url : '/',
  };
  let res;
  try {
    res = await fetch(`${cfg.url}/api/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    die('relay notify: network error: ' + e.message);
  }
  const text = await res.text();
  if (res.ok) {
    process.stdout.write(text + '\n');
    return;
  }
  process.stderr.write(`relay notify: HTTP ${res.status}: ${text}\n`);
  // 503 = push/VAPID not configured — a warning, not a failure (e.g. no subscriptions yet).
  process.exit(res.status === 503 ? 0 : 1);
}

async function cmdCard(cfg, flags) {
  const kind = typeof flags.kind === 'string' ? flags.kind : 'note';
  let body = typeof flags.body === 'string' ? flags.body : null;
  let copyText = typeof flags.copy === 'string' ? flags.copy : null;
  let mermaid = null;

  // stdin can feed --body-stdin, --copy-stdin, or --mermaid -
  const wantsStdin = flags['body-stdin'] || flags['copy-stdin'] || flags.mermaid === '-';
  const stdin = wantsStdin ? (await readStdin()).replace(/\s+$/, '') : '';
  if (flags['body-stdin']) body = stdin;
  if (flags['copy-stdin']) copyText = stdin;
  if (flags.mermaid === '-') mermaid = stdin;
  else if (typeof flags.mermaid === 'string') mermaid = readFileSync(flags.mermaid, 'utf8');

  const title = typeof flags.title === 'string' ? flags.title : null;
  if (!title) die('relay card: --title is required');

  // buttons
  const buttons = [];
  for (const spec of flags.button || []) buttons.push(parseButtonSpec(spec));
  for (const spec of flags.link || []) buttons.push(parseLinkSpec(spec));
  if (copyText != null || flags['copy-stdin'] || flags.copy === true) {
    buttons.push({ id: 'copy', label: 'Copy to clipboard', behavior: 'copy' });
  }
  if (kind === 'approval' && !buttons.some((b) => b.behavior === 'respond')) {
    buttons.push({ id: 'approved', label: 'Approve', behavior: 'respond', verdict: 'approved', style: 'primary' });
    buttons.push({ id: 'changes_requested', label: 'Request changes', behavior: 'respond', verdict: 'changes_requested', style: 'note' });
  }

  // assets (images)
  const assets = [];
  for (const p of flags.image || []) {
    const buf = readFileSync(p);
    const mime = MIME[extname(p).toLowerCase()] || 'application/octet-stream';
    assets.push({ mime, data: buf.toString('base64') });
  }

  const effectiveKind = mermaid && kind === 'note' ? 'diagram' : assets.length && kind === 'note' ? 'image' : kind;
  const payload = {
    kind: effectiveKind,
    title,
    body,
    buttons,
    copy_text: copyText,
    mermaid,
    priority: flags.high ? 'high' : 'normal',
    push: flags['no-push'] ? false : true,
    source: { cwd: process.cwd(), host: process.env.COMPUTERNAME || process.env.HOSTNAME || null },
    ...(assets.length ? { assets } : {}),
    ...(typeof flags['push-body'] === 'string' ? { pushBody: flags['push-body'] } : {}),
  };

  let res;
  try {
    res = await fetch(`${cfg.url}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    die('relay card: network error: ' + e.message);
  }
  if (!res.ok) die(`relay card: HTTP ${res.status}: ${await res.text()}`);
  const created = await res.json();

  // --open: auto-open the desktop browser to the card (what /show uses). Assemble the ABSOLUTE
  // url the same way cmdDraft does — created.url is relative ("/?card=<hex16>"), and isSameOrigin
  // (inside openInBrowser) rejects a relative url, silently opening nothing. Runs before either
  // exit branch so it fires for both the no-wait (default) and --wait cases.
  if (flags.open) {
    const absUrl = cfg.url + (created.url || '/?card=' + created.id);
    if (openInBrowser(absUrl, cfg.url)) process.stderr.write(`relay: opened ${absUrl}\n`);
  }

  if (flags.wait === undefined) {
    process.stdout.write(JSON.stringify({ id: created.id, url: created.url }) + '\n');
    process.stderr.write(`relay: card ${created.id} created\n`);
    return;
  }
  const budget = typeof flags.wait === 'string' && flags.wait ? Math.max(1, parseInt(flags.wait, 10) || PER_POLL_CAP) : PER_POLL_CAP;
  const result = await pollUntil(cfg, created.id, budget);
  if (result.status === 'responded') reportVerdict(created.id, result);
  // timeout
  process.stdout.write(JSON.stringify({ status: 'pending', id: created.id }) + '\n');
  process.stderr.write(`relay: no response yet. Re-poll with:\n  relay poll ${created.id} --wait=50\n`);
  process.exit(3);
}

async function cmdDraft(cfg, flags) {
  const stdin = flags['body-stdin'] ? (await readStdin()).replace(/\s+$/, '') : '';
  const assets = [];
  for (const p of flags.image || []) {
    const buf = readFileSync(p);
    const mime = MIME[extname(p).toLowerCase()] || 'application/octet-stream';
    assets.push({ mime, data: buf.toString('base64') });
  }
  const host = process.env.COMPUTERNAME || process.env.HOSTNAME || null;

  let payload;
  try {
    payload = buildDraftPayload(flags, { stdin, cwd: process.cwd(), host, assets });
  } catch (e) {
    die(e.message);
  }

  let res;
  try {
    res = await fetch(`${cfg.url}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    die('relay draft: network error: ' + e.message);
  }
  if (!res.ok) die(`relay draft: HTTP ${res.status}: ${await res.text()}`);
  const created = await res.json();

  const absUrl = cfg.url + (created.url || '/?card=' + created.id);
  process.stdout.write(JSON.stringify({ id: created.id, url: absUrl }) + '\n');

  const open = flags['no-open'] ? false : true; // default open; --no-open suppresses
  if (open && openInBrowser(absUrl, cfg.url)) {
    process.stderr.write(`relay: opened ${absUrl}\n`);
  } else {
    process.stderr.write(`relay: draft ${created.id} ready — ${absUrl}\n`);
  }
}

async function cmdPoll(cfg, args) {
  const id = args._[0];
  if (!id) die('usage: relay poll <cardId> [--wait=SECS]');
  const budget = typeof args.flags.wait === 'string' && args.flags.wait ? Math.max(1, parseInt(args.flags.wait, 10) || PER_POLL_CAP) : PER_POLL_CAP;
  const result = await pollUntil(cfg, id, budget);
  if (result.status === 'notfound') die(`relay poll: card ${id} not found`, 1);
  if (result.status === 'responded') reportVerdict(id, result);
  process.stdout.write(JSON.stringify({ status: 'pending', id }) + '\n');
  process.stderr.write(`relay: still pending. Re-poll with: relay poll ${id} --wait=50\n`);
  process.exit(3);
}

function cmdArm(args) {
  const label = args._.join(' ').trim() || 'Task';
  mkdirSync(armedDir(), { recursive: true });
  const key = sessionKey({});
  writeFileSync(join(armedDir(), key + '.json'), JSON.stringify({ label, at: new Date().toISOString() }) + '\n');
  process.stderr.write(`relay: armed "${label}" (${key}) — the Stop hook will ping when this session ends.\n`);
}

function cmdDisarm() {
  const key = sessionKey({});
  try {
    rmSync(join(armedDir(), key + '.json'));
  } catch {}
  process.stderr.write(`relay: disarmed (${key}).\n`);
}

// `relay afk` — the away-from-keyboard flag (~/.relay/afk.json). Local state only (NO config
// needed, like arm/disarm): `on` writes the flag, `off`/`back`/`done`/`here` clears it, and the
// default `status` prints {afk:bool,...} and exits 10 when AFK / 0 when at the desk so a caller can
// branch on the exit code (`relay afk status >/dev/null; AFK=$?`). Other sessions consult this via
// the /relay + /show skills to decide whether to push to the phone instead of opening the desktop.
function cmdAfk(args) {
  const sub = (args._[0] || 'status').toLowerCase();
  if (sub === 'on' || sub === 'start') {
    const reason =
      (typeof args.flags.reason === 'string' ? args.flags.reason : args._.slice(1).join(' ').trim()) || null;
    mkdirSync(relayDir(), { recursive: true });
    const rec = { since: new Date().toISOString(), reason, host: process.env.COMPUTERNAME || process.env.HOSTNAME || null };
    writeFileSync(afkPath(), JSON.stringify(rec, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ afk: true, ...rec }) + '\n');
    process.stderr.write(`relay: AFK on${reason ? ' — ' + reason : ''}\n`);
    return;
  }
  if (sub === 'off' || sub === 'back' || sub === 'done' || sub === 'here') {
    try {
      rmSync(afkPath());
    } catch {}
    process.stdout.write(JSON.stringify({ afk: false }) + '\n');
    process.stderr.write('relay: AFK off — welcome back\n');
    return;
  }
  // status (default / bare `relay afk`)
  const rec = readAfk();
  process.stdout.write(JSON.stringify(rec ? { afk: true, ...rec } : { afk: false }) + '\n');
  process.exit(rec ? 10 : 0);
}

// --- main ------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'init':
      return cmdInit(args.flags);
    case 'notify':
      return cmdNotify(requireConfig(), args.flags);
    case 'card':
      return cmdCard(requireConfig(), args.flags);
    case 'draft':
      return cmdDraft(requireConfig(), args.flags);
    case 'poll':
      return cmdPoll(requireConfig(), args);
    case 'arm':
      return cmdArm(args);
    case 'disarm':
      return cmdDisarm();
    case 'afk':
      return cmdAfk(args); // local state only — no requireConfig
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(
        'relay — Claude Code ⇄ phone/desktop bridge\n\n' +
          '  relay init --url <https://...> --token <WRITE_TOKEN>\n' +
          '  relay notify [--title T] [--body B] [--url U]\n' +
          '  relay card --title T [--body B|--body-stdin] [--kind K] [--image PATH]...\n' +
          '             [--mermaid FILE|-] [--button "Label=action[:style]"]... [--link "Label=url"]...\n' +
          '             [--copy TEXT|--copy-stdin] [--open] [--no-push] [--high] [--wait[=SECS]]\n' +
          '             # --open auto-opens this desktop\'s browser to the card (what /show uses)\n' +
          '  relay draft --title T [--body B|--body-stdin] [--image PATH]... [--link "Label=url"]...\n' +
          '             [--push] [--no-open] [--high]   # rich WYSIWYG-editable message card; opens your browser\n' +
          '  relay poll <cardId> [--wait=SECS]\n' +
          '  relay arm "<label>" | relay disarm\n' +
          '  relay afk [on [--reason R] | off | status]   # away-from-keyboard flag (~/.relay/afk.json)\n\n' +
          'wait/poll exit codes: 0=approved 20=changes_requested 1=other 3=timeout\n' +
          'afk status exit codes: 0=at desk  10=AFK\n',
      );
      return;
    default:
      die(`unknown command: ${cmd}\nrun "relay help"`);
  }
}

// Portable "am I the entry point?" — import.meta.main is Bun-only; fall back to argv compare
// under node. Stays false when imported by tests, so they get the exported helpers only.
const isEntry =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((e) => die('relay: ' + (e && e.message ? e.message : String(e))));
}
