#!/usr/bin/env node
// relay — the Claude Code side of the bridge. Zero deps; runs under node or bun.
//
//   relay init --url <https://...> --token <WRITE_TOKEN>   # write ~/.relay/config.json
//   relay notify [--title T] [--body B] [--url U]          # fire a push (body from stdin if piped)
//   relay card  --title T [...]  [--wait[=SECS]]           # create a card; --wait blocks for a verdict
//   relay ask   --title T [...]  [--wait[=SECS]]           # ask an open-ended question; answer is free text
//   relay poll  <cardId> [--wait=SECS] [--events-since=N]   # re-poll an existing card's verdict
//   relay reply <cardId> --body B|--body-stdin              # reply into a card's thread (no verdict)
//   relay arm "<label>" / relay disarm                    # arm/clear the Stop-hook "task done" ping
//
// Every terminal result of card/choice/ask/poll is ONE line of JSON on stdout with an explicit
// `status` (answered|event|pending|notfound|error|created) — parse that, not the exit code. A
// free-text answer (`relay ask`) comes back as verdict 'reply' with the text in both `note` and a
// top-level `reply` field. `relay poll --events-since=N` (card threads, relay-roadmap Plan 04) can
// come back as status 'event' (a human thread message landed instead of a verdict) — answer with
// `relay reply <id> --body "..."`, then re-poll with --events-since set to the seq that reply
// returned. Exit codes (relay-specific): 0=approved-or-reply 20=changes_requested 21=event
// 1=other-verdict 3=timeout 4=notfound 5=error (2=usage). On timeout the cardId is printed so
// Claude can re-issue `relay poll <id> --wait=50` in a fresh Bash call — the bounded-poll pattern
// that keeps every call under the harness limit.

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig, configPath, relayDir, armedDir, sessionKey, afkPath, readAfk, projectFromCwd, sessionIdFromEnv } from '../lib/relay-lib.mjs';

const PER_POLL_CAP = 50; // server caps at 55; leave margin
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- arg parsing -----------------------------------------------------------
// Returns { _: positionals, flags: {...} }. Repeatable flags (image/button/link) collect
// into arrays. `--flag=value`, `--flag value`, and bare booleans all supported.
const REPEATABLE = new Set(['image', 'button', 'link', 'option']);
const BOOLEANS = new Set(['body-stdin', 'copy-stdin', 'high', 'push', 'no-push', 'open', 'no-open', 'keep', 'options-stdin']);

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

// The machine-readable result: every terminal outcome of card/choice/poll emits exactly ONE line
// of JSON on stdout, always carrying an explicit `status` (answered|pending|notfound|error|created),
// so a caller can key off stdout and never has to disambiguate by exit code. Human-readable status
// goes to stderr separately.
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function requireConfig() {
  const cfg = loadConfig();
  if (!cfg)
    die(
      `relay is not configured. Run:\n  relay init --url <https://your-app.up.railway.app> --token <WRITE_TOKEN>\n(or set RELAY_URL and RELAY_WRITE_TOKEN). Config path: ${configPath()}`,
    );
  return cfg;
}

// "30m" / "2h" / "1d" / bare "45" (minutes) -> milliseconds. Returns null on a bad spec.
const TTL_UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
export function parseTtl(spec) {
  const m = String(spec).trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return null;
  return parseInt(m[1], 10) * TTL_UNITS[(m[2] || 'm').toLowerCase()];
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
export const VERDICT_ALIAS = { approve: 'approved', approved: 'approved', changes: 'changes_requested', 'request-changes': 'changes_requested', changes_requested: 'changes_requested', dismiss: 'dismissed', dismissed: 'dismissed', reject: 'dismissed' };

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

// --- choice option spec parser (exported for tests) ------------------------
// Simple text-only options for `relay choice`. "id=Label" sets an explicit id; a bare "Label"
// derives the id by slugifying it (rich options — body/diagram/link — come via --options-stdin JSON).
function slugifyId(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'opt';
}
export function parseOptionSpec(spec) {
  const eq = spec.indexOf('=');
  if (eq < 0) {
    const label = spec.trim();
    if (!label) throw new Error(`bad --option "${spec}"`);
    return { id: slugifyId(label), label };
  }
  const id = spec.slice(0, eq).trim();
  const label = spec.slice(eq + 1).trim();
  if (!id || !label) throw new Error(`bad --option "${spec}" (expected "id=Label" or "Label")`);
  return { id, label };
}

// --- draft template (exported for tests) -----------------------------------
// `relay draft` is the first Relay "template": a rich, WYSIWYG-editable message card the
// browser auto-opens to. buildDraftPayload is PURE (no fs/network) so it's unit-testable;
// cmdDraft pre-reads stdin/image assets and passes them in.
//
// v1 drafts take LINK buttons only. Respond buttons are deliberately rejected: they would
// collide with the editor's intrinsic copy toolbar and a respond-click's `card-updated` SSE
// would rebuild the card from the ORIGINAL body, wiping in-progress edits.
export function buildDraftPayload(flags, { stdin = '', cwd = '', host = null, sessionId = null, assets = [] } = {}) {
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
    source: { cwd, host, sessionId, editable: true },
    buttons,
    priority: flags.high ? 'high' : 'normal',
    push: flags.push ? true : false, // auto-open makes a push to the same box redundant; --push opts in
    ...(assets.length ? { assets } : {}),
  };
}

// `relay ask` — a prompt card that wants a FREE-TEXT reply. The push carries a "Reply" button that
// opens the app focused on a text box (you can't type free text from a notification on a PWA); the
// answer comes back via --wait as verdict 'reply' with the text in `reply`/`note`. buildAskPayload
// is PURE (no fs/network) so it's unit-testable; cmdAsk pre-reads stdin and passes it in. Push
// defaults TRUE — a question needs to reach the phone — unlike `relay draft` which auto-opens locally.
export function buildAskPayload(flags, { stdin = '', cwd = '', host = null, sessionId = null } = {}) {
  const title = typeof flags.title === 'string' ? flags.title : null;
  if (!title) throw new Error('relay ask: --title is required');
  let body = typeof flags.body === 'string' ? flags.body : null;
  if (flags['body-stdin']) body = stdin;
  const placeholder = typeof flags.placeholder === 'string' ? flags.placeholder : null;

  let expires_at;
  if (flags.keep) expires_at = '9999-12-31T23:59:59.999Z';
  else if (flags.ttl !== undefined) {
    const ms = parseTtl(flags.ttl);
    if (ms == null) throw new Error(`relay ask: bad --ttl "${flags.ttl}" (use e.g. 30m, 2h, 1d)`);
    expires_at = new Date(Date.now() + ms).toISOString();
  }

  return {
    kind: 'prompt',
    title,
    body,
    buttons: [],
    priority: flags.high ? 'high' : 'normal',
    push: flags['no-push'] ? false : true,
    source: { cwd, host, sessionId, ...(placeholder ? { placeholder } : {}) },
    ...(expires_at ? { expires_at } : {}),
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

export function verdictExit(verdict) {
  if (verdict === 'approved' || verdict === 'reply') return 0; // approved, or a free-text reply landed
  if (verdict === 'changes_requested') return 20;
  return 1; // dismissed / custom / other-action
}

// --- long-poll loop (one bounded Bash-call budget) -------------------------
// `eventsSince` (card threads, relay-roadmap Plan 04) is OPT-IN: omitted (every caller except
// `relay poll --events-since=N`) sends the exact same request as before this plan, so the server
// can never return status:'event' for that call — byte-identical legacy behavior (master doc §4).
// 0 is a valid value ("since the beginning" — seq starts at 1), so this checks `!= null`.
async function pollUntil(cfg, id, totalSecs, eventsSince) {
  const deadline = Date.now() + totalSecs * 1000;
  const qs = eventsSince != null ? `&events_since=${encodeURIComponent(eventsSince)}` : '';
  for (;;) {
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) return { status: 'pending' };
    const perPoll = Math.min(remaining, PER_POLL_CAP);
    let res;
    try {
      res = await fetch(`${cfg.url}/api/cards/${id}/response?wait=${perPoll}${qs}`, {
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
    if (data.status === 'responded' || data.status === 'event') return data;
    // server hit its cap and returned pending — loop again if budget remains
  }
}

function reportVerdict(id, data) {
  const r = data.response || {};
  const isReply = r.verdict === 'reply'; // a prompt card's free-text answer (relay ask)
  emit({
    status: 'answered',
    verdict: r.verdict,
    action: r.action,
    note: r.note ?? null,
    ...(isReply ? { reply: r.note ?? '' } : {}),
    id,
  });
  if (isReply) {
    process.stderr.write(`relay: reply — ${r.note && r.note.trim() ? r.note : '(empty)'}\n`);
  } else {
    const noteStr = r.note ? ` — “${r.note}”` : '';
    process.stderr.write(`relay: ${r.verdict}${noteStr}\n`);
  }
  process.exit(verdictExit(r.verdict));
}

// POST a card payload, optionally open the browser, and (with --wait) block for a verdict. Shared by
// `relay card` and `relay choice` — same output contract and wait/poll exit codes (see file header).
async function createAndWait(cfg, payload, flags, cmdName) {
  let res;
  try {
    res = await fetch(`${cfg.url}/api/cards`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    emit({ status: 'error', error: `network error: ${e.message}` });
    process.stderr.write(`relay ${cmdName}: network error: ${e.message}\n`);
    process.exit(5);
  }
  if (!res.ok) {
    const text = await res.text();
    emit({ status: 'error', error: `HTTP ${res.status}: ${text}` });
    process.stderr.write(`relay ${cmdName}: HTTP ${res.status}: ${text}\n`);
    process.exit(5);
  }
  const created = await res.json();

  if (flags.open) {
    const absUrl = cfg.url + (created.url || '/?card=' + created.id);
    if (openInBrowser(absUrl, cfg.url)) process.stderr.write(`relay: opened ${absUrl}\n`);
  }

  if (flags.wait === undefined) {
    emit({ status: 'created', id: created.id, url: created.url });
    process.stderr.write(`relay: ${cmdName} ${created.id} created\n`);
    return;
  }
  const budget =
    typeof flags.wait === 'string' && flags.wait ? Math.max(1, parseInt(flags.wait, 10) || PER_POLL_CAP) : PER_POLL_CAP;
  const result = await pollUntil(cfg, created.id, budget);
  if (result.status === 'responded') reportVerdict(created.id, result);
  if (result.status === 'notfound') {
    emit({ status: 'notfound', id: created.id });
    process.stderr.write(`relay: card ${created.id} not found (expired or dismissed)\n`);
    process.exit(4);
  }
  emit({ status: 'pending', id: created.id });
  process.stderr.write(`relay: no response yet. Re-poll with:\n  relay poll ${created.id} --wait=50\n`);
  process.exit(3);
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
  // Attribution so a hand-fired `relay notify` is traceable in the audit log too (source 'cli').
  const cwd = process.cwd();
  const payload = {
    title: typeof flags.title === 'string' ? flags.title : 'Relay',
    body: body || 'You have a new update.',
    url: typeof flags.url === 'string' ? flags.url : '/',
    source: 'cli',
    cwd,
    project: projectFromCwd(cwd),
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
    sessionId: sessionIdFromEnv(),
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

// Pure: assemble a card payload object from already-resolved inputs. cmdCard does the fs/stdin/flag
// work (reading images, parsing button specs, adding the copy + approval-default buttons) and passes
// the finished pieces in; the MCP server (bin/relay-mcp.mjs) builds its own pieces from structured
// tool args and calls this for the exact same payload shape. effectiveKind promotes a plain note to
// 'diagram' (mermaid present) or 'image' (assets present). Throws without a title.
export function buildCardPayload({
  title,
  body = null,
  kind = 'note',
  buttons = [],
  copyText = null,
  mermaid = null,
  assets = [],
  priority = 'normal',
  push = true,
  expiresAt = null,
  source = {},
  pushBody = null,
}) {
  if (!title) throw new Error('relay card: --title is required');
  const effectiveKind = mermaid && kind === 'note' ? 'diagram' : assets.length && kind === 'note' ? 'image' : kind;
  return {
    kind: effectiveKind,
    title,
    body,
    buttons,
    copy_text: copyText,
    mermaid,
    priority,
    push,
    source,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(assets.length ? { assets } : {}),
    ...(pushBody != null ? { pushBody } : {}),
  };
}

// Pure: assemble a choice card payload. cmdChoice parses/validates options first; the MCP server
// maps structured options. Throws without a title or with no options.
export function buildChoicePayload({ title, body = null, options = [], priority = 'normal', push = true, expiresAt = null, source = {} }) {
  if (!title) throw new Error('relay choice: --title is required');
  if (!Array.isArray(options) || options.length === 0) throw new Error('relay choice: at least one option is required');
  return {
    kind: 'choice',
    title,
    body,
    options,
    buttons: [],
    priority,
    push,
    source,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
}

// Pure: assemble a 'page' card payload — a full agent-authored HTML+JS document rendered in a
// sandboxed iframe on the Relay web app. page_html is a TOP-LEVEL key (the server's validateCardInput
// reads b.page_html and createCard INSERTs it). No buttons/options: a page's respond affordance (if
// any) lives INSIDE the sandboxed document, via the postMessage submit bridge (relay-roadmap Plan
// 05) — see expectsResponse below. Throws without a title or pageHtml. There is no CLI `relay page`
// command — this builder exists so the MCP server (relay_page) shares the same tested payload shape.
//
// expectsResponse: false (default) is a plain view-only page — unchanged from before Plan 05.
// true marks the card as response-soliciting: pending it defaults to a CARD_PENDING_TTL_HOURS
// expiry (~24h, like an approval — cards-store.ts defaultExpiryFor) and the push is sent at high
// urgency (routes-cards.ts). It does NOT add any button/action — the page itself must call
// postMessage({__relay:'submit', payload}).
export function buildPagePayload({ title, pageHtml, copyText = null, priority = 'normal', push = true, expiresAt = null, expectsResponse = false, source = {} }) {
  if (!title) throw new Error('relay page: title is required');
  if (!pageHtml) throw new Error('relay page: html is required');
  return {
    kind: 'page',
    title,
    page_html: pageHtml,
    copy_text: copyText,
    buttons: [],
    priority,
    push,
    expects_response: !!expectsResponse,
    source,
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
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

  // Expiry: --ttl sets an explicit lifetime; --keep opts out (far-future); otherwise omit and let
  // the server apply its kind-based default (notes ~24h; pending question cards also default to
  // CARD_PENDING_TTL_HOURS, ~24h — pass --ttl to match how long you'll actually poll).
  let expiresAt = null;
  if (flags.keep) {
    expiresAt = '9999-12-31T23:59:59.999Z';
  } else if (flags.ttl !== undefined) {
    const ms = parseTtl(flags.ttl);
    if (ms == null) die(`relay card: bad --ttl "${flags.ttl}" (use e.g. 30m, 2h, 1d)`);
    expiresAt = new Date(Date.now() + ms).toISOString();
  }

  const payload = buildCardPayload({
    title,
    body,
    kind,
    buttons,
    copyText,
    mermaid,
    assets,
    priority: flags.high ? 'high' : 'normal',
    push: flags['no-push'] ? false : true,
    expiresAt,
    source: { cwd: process.cwd(), host: process.env.COMPUTERNAME || process.env.HOSTNAME || null, sessionId: sessionIdFromEnv() },
    pushBody: typeof flags['push-body'] === 'string' ? flags['push-body'] : null,
  });

  // --open auto-opens the desktop browser to the card (what /show uses); --wait blocks for a verdict.
  return createAndWait(cfg, payload, flags, 'card');
}

// `relay choice` — a rich multiple-choice card. Options come from --options-stdin / --options FILE
// (a JSON array of {id,label,description?,body?,mermaid?,link?}) for rich options, or repeatable
// --option "id=Label" / "Label" for simple ones. --wait returns the chosen option id as the verdict.
async function cmdChoice(cfg, flags) {
  const title = typeof flags.title === 'string' ? flags.title : null;
  if (!title) die('relay choice: --title is required');
  const body = typeof flags.body === 'string' ? flags.body : null;

  // Rich options as JSON (stdin or file), then any simple --option shorthands appended.
  let options = [];
  let json = '';
  if (flags['options-stdin']) json = await readStdin();
  else if (typeof flags.options === 'string') json = readFileSync(flags.options, 'utf8');
  if (json.trim()) {
    try {
      options = JSON.parse(json);
    } catch {
      die('relay choice: --options must be a valid JSON array');
    }
    if (!Array.isArray(options)) die('relay choice: --options JSON must be an array');
  }
  for (const spec of flags.option || []) options.push(parseOptionSpec(spec));
  if (!options.length) die('relay choice: provide --option "Label" (repeatable) or --options-stdin <JSON array>');

  let expiresAt = null;
  if (flags.keep) expiresAt = '9999-12-31T23:59:59.999Z';
  else if (flags.ttl !== undefined) {
    const ms = parseTtl(flags.ttl);
    if (ms == null) die(`relay choice: bad --ttl "${flags.ttl}" (use e.g. 30m, 2h, 1d)`);
    expiresAt = new Date(Date.now() + ms).toISOString();
  }

  const payload = buildChoicePayload({
    title,
    body,
    options,
    priority: flags.high ? 'high' : 'normal',
    push: flags['no-push'] ? false : true,
    expiresAt,
    source: { cwd: process.cwd(), host: process.env.COMPUTERNAME || process.env.HOSTNAME || null, sessionId: sessionIdFromEnv() },
  });
  return createAndWait(cfg, payload, flags, 'choice');
}

// `relay ask` — open-ended question, free-text answer. See buildAskPayload. --wait blocks for the
// reply just like `relay card --wait`; the answer comes back as verdict 'reply' (exit 0) with the
// text in the `reply`/`note` fields.
async function cmdAsk(cfg, flags) {
  const stdin = flags['body-stdin'] ? (await readStdin()).replace(/\s+$/, '') : '';
  const host = process.env.COMPUTERNAME || process.env.HOSTNAME || null;
  let payload;
  try {
    payload = buildAskPayload(flags, { stdin, cwd: process.cwd(), host, sessionId: sessionIdFromEnv() });
  } catch (e) {
    die(e.message);
  }
  return createAndWait(cfg, payload, flags, 'ask');
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
    payload = buildDraftPayload(flags, { stdin, cwd: process.cwd(), host, sessionId: sessionIdFromEnv(), assets });
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
  emit({ status: 'created', id: created.id, url: absUrl });

  const open = flags['no-open'] ? false : true; // default open; --no-open suppresses
  if (open && openInBrowser(absUrl, cfg.url)) {
    process.stderr.write(`relay: opened ${absUrl}\n`);
  } else {
    process.stderr.write(`relay: draft ${created.id} ready — ${absUrl}\n`);
  }
}

async function cmdPoll(cfg, args) {
  const id = args._[0];
  if (!id) die('usage: relay poll <cardId> [--wait=SECS] [--events-since=N]', 2);
  const budget = typeof args.flags.wait === 'string' && args.flags.wait ? Math.max(1, parseInt(args.flags.wait, 10) || PER_POLL_CAP) : PER_POLL_CAP;
  // --events-since (card threads, Plan 04): opt-in — omitted keeps this an ordinary verdict-only
  // poll, exactly as before this existed. 0 is valid ("since the beginning"), so check for the
  // flag's presence rather than truthiness.
  const eventsSinceFlag = args.flags['events-since'];
  const eventsSince = eventsSinceFlag !== undefined ? Math.max(0, parseInt(eventsSinceFlag, 10) || 0) : undefined;
  const result = await pollUntil(cfg, id, budget, eventsSince);
  if (result.status === 'notfound') {
    emit({ status: 'notfound', id });
    process.stderr.write(`relay poll: card ${id} not found (expired or dismissed)\n`);
    process.exit(4);
  }
  if (result.status === 'responded') reportVerdict(id, result);
  if (result.status === 'event') {
    const events = result.events || [];
    const sinceSeq = events.length ? events[events.length - 1].seq : eventsSince ?? 0;
    emit({ status: 'event', id, events });
    process.stderr.write(
      `relay: new thread message on card ${id} — reply with:\n  relay reply ${id} --body "..."\n` +
        `then keep waiting for the verdict:\n  relay poll ${id} --wait=50 --events-since=${sinceSeq}\n`,
    );
    process.exit(21);
  }
  emit({ status: 'pending', id });
  process.stderr.write(
    `relay: still pending. Re-poll with: relay poll ${id} --wait=50${eventsSince !== undefined ? ' --events-since=' + eventsSince : ''}\n`,
  );
  process.exit(3);
}

// `relay reply` — the human's half of a card thread answered from the write side: append a
// role:'agent' message to a pending card's thread WITHOUT resolving its verdict (relay-roadmap
// Plan 04). Use after `relay poll` returns status 'event'. Prints the created event's seq so the
// caller knows what --events-since to pass on the next `relay poll` call.
async function cmdReply(cfg, args) {
  const id = args._[0];
  if (!id) die('usage: relay reply <cardId> --body B|--body-stdin', 2);
  let body = typeof args.flags.body === 'string' ? args.flags.body : null;
  if (args.flags['body-stdin']) body = (await readStdin()).trim();
  if (!body || !body.trim()) die('relay reply: --body or --body-stdin is required');

  let res;
  try {
    res = await fetch(`${cfg.url}/api/cards/${id}/agent-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-write-token': cfg.writeToken },
      body: JSON.stringify({ type: 'message', body }),
    });
  } catch (e) {
    emit({ status: 'error', error: `network error: ${e.message}` });
    process.stderr.write(`relay reply: network error: ${e.message}\n`);
    process.exit(5);
  }
  if (!res.ok) {
    const text = await res.text();
    emit({ status: 'error', error: `HTTP ${res.status}: ${text}` });
    process.stderr.write(`relay reply: HTTP ${res.status}: ${text}\n`);
    process.exit(res.status === 404 ? 4 : 5);
  }
  const data = await res.json();
  const seq = data.event?.seq ?? null;
  emit({ status: 'sent', id, seq });
  process.stderr.write(`relay: reply sent (seq ${seq ?? '?'}) — resume with: relay poll ${id} --wait=50 --events-since=${seq ?? 0}\n`);
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
    case 'choice':
      return cmdChoice(requireConfig(), args.flags);
    case 'ask':
      return cmdAsk(requireConfig(), args.flags);
    case 'draft':
      return cmdDraft(requireConfig(), args.flags);
    case 'poll':
      return cmdPoll(requireConfig(), args);
    case 'reply':
      return cmdReply(requireConfig(), args);
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
          '             [--copy TEXT|--copy-stdin] [--ttl 30m|2h|1d] [--keep] [--open] [--no-push] [--high] [--wait[=SECS]]\n' +
          '             # --open auto-opens this desktop\'s browser to the card (what /show uses)\n' +
          '             # --ttl sets when the card auto-clears from the feed; --keep never expires it\n' +
          '  relay choice --title T [--body B] [--option "id=Label"]... | [--options-stdin <JSON>]\n' +
          '             [--ttl D] [--no-push] [--high] [--wait[=SECS]]   # rich multiple-choice card;\n' +
          '             # JSON option = {id,label,description?,body?,mermaid?,link?}; --wait returns the chosen id\n' +
          '  relay ask --title T [--body B|--body-stdin] [--placeholder P]\n' +
          '             [--ttl D] [--keep] [--no-push] [--high] [--wait[=SECS]]   # open-ended question;\n' +
          '             # the push has a Reply button that opens a text box; --wait returns the free-text reply\n' +
          '  relay draft --title T [--body B|--body-stdin] [--image PATH]... [--link "Label=url"]...\n' +
          '             [--push] [--no-open] [--high]   # rich WYSIWYG-editable message card; opens your browser\n' +
          '  relay poll <cardId> [--wait=SECS] [--events-since=N]\n' +
          '             # --events-since (card threads): also resolve early on a new human thread message\n' +
          '  relay reply <cardId> --body B|--body-stdin   # reply into a card thread WITHOUT resolving it\n' +
          '  relay arm "<label>" | relay disarm\n' +
          '  relay afk [on [--reason R] | off | status]   # away-from-keyboard flag (~/.relay/afk.json)\n\n' +
          'wait/poll: stdout is one JSON line with a status (answered|event|pending|notfound|error|created);\n' +
          '  a free-text reply (relay ask) is verdict "reply" with the text in note + a top-level "reply";\n' +
          '  status "event" (only with --events-since) means a human sent a thread message, not a verdict\n' +
          '  exit codes: 0=approved/reply 20=changes_requested 21=event 1=other-verdict 3=timeout 4=notfound 5=error\n' +
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
