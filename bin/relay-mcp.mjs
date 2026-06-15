#!/usr/bin/env node
// relay-mcp — a Model Context Protocol (stdio) server that exposes the Relay phone/desktop bridge
// as native tools for any MCP client (Claude Code, Claude Desktop, IDE extensions). It is a THIN
// LOCAL CLIENT of the already-deployed Relay HTTP API: it reads ~/.relay/config.json (exactly like
// the `relay` CLI) and calls the same /api endpoints with the same write token. No backend change;
// purely additive alongside the CLI, the hooks, and the /relay skill.
//
// Register with Claude Code (point at the file in your main checkout once merged):
//   claude mcp add relay -- node "C:/Users/Cam Dowdle/source/repos/personal/relay/bin/relay-mcp.mjs"
//
// STDIO HYGIENE (critical): on an MCP stdio server, STDOUT is the JSON-RPC channel — the SDK owns
// it. NOTHING here may write to stdout (no console.log). All diagnostics go to stderr.
//
// Blocking model: the Relay server long-poll caps each request at 55s and MCP clients impose a
// per-call timeout (Claude Code ~60s, set MCP_TIMEOUT to raise it). So the blocking tools poll for
// a bounded window (waitSeconds, default 50, capped at 280) and, if no answer lands, return
// {status:'pending', id}; the caller then invokes relay_poll(id) again. This is the same
// bounded-poll / re-poll pattern the CLI (`relay poll <id> --wait=50`) and /relay skill use, and it
// keeps every tool call short and resumable regardless of the client's timeout.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/relay-lib.mjs';
import { createCard, pollResponse, sendNotify } from '../lib/relay-client.mjs';
import { buildCardPayload, buildChoicePayload, buildAskPayload, parseTtl, VERDICT_ALIAS } from './relay.mjs';

const DEFAULT_WAIT = 50; // seconds; one bounded server long-poll, safely under a typical MCP timeout
const MAX_WAIT = 280; // cap so a caller can't request a block longer than its own client timeout

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'opt';

function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

// "30m" / "2h" / "1d" -> ISO expiry; "keep" -> far-future; null/undefined -> null (server default).
function ttlToExpiresAt(ttl) {
  if (ttl == null) return null;
  if (ttl === 'keep') return '9999-12-31T23:59:59.999Z';
  const ms = parseTtl(ttl);
  if (ms == null) throw new Error(`bad ttl "${ttl}" (use e.g. 30m, 2h, 1d, or "keep")`);
  return new Date(Date.now() + ms).toISOString();
}

// Clamp a requested wait to [0, MAX_WAIT]; null -> the tool's default; <=0 / non-finite -> 0 (no wait).
function resolveWait(waitSeconds, def) {
  if (waitSeconds == null) return def;
  const n = Math.floor(Number(waitSeconds));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, MAX_WAIT);
}

// --- tool args -> API payload (pure, exported for tests) -------------------

export function cardArgsToPayload(args, ctx = {}) {
  if (!args.title) throw new Error('relay_card: title is required');
  const buttons = [];
  for (const b of args.buttons || []) {
    if (!b || !b.label || !b.action) throw new Error('relay_card: each button needs a label and an action');
    const verdict = VERDICT_ALIAS[String(b.action).toLowerCase()] || b.action;
    buttons.push({ id: verdict, label: b.label, behavior: 'respond', verdict, ...(b.style ? { style: b.style } : {}) });
  }
  for (const l of args.links || []) {
    if (!l || !l.label || !l.url) throw new Error('relay_card: each link needs a label and a url');
    if (!/^https?:\/\//i.test(l.url)) throw new Error(`relay_card: link url must be http(s): ${l.url}`);
    buttons.push({ id: 'link-' + l.label.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: l.label, behavior: 'link', value: l.url });
  }
  const kind = args.kind || 'note';
  if (args.copy != null) buttons.push({ id: 'copy', label: 'Copy to clipboard', behavior: 'copy' });
  if (kind === 'approval' && !buttons.some((b) => b.behavior === 'respond')) {
    buttons.push({ id: 'approved', label: 'Approve', behavior: 'respond', verdict: 'approved', style: 'primary' });
    buttons.push({ id: 'changes_requested', label: 'Request changes', behavior: 'respond', verdict: 'changes_requested', style: 'note' });
  }
  return buildCardPayload({
    title: args.title,
    body: args.body ?? null,
    kind,
    buttons,
    copyText: args.copy ?? null,
    mermaid: args.mermaid ?? null,
    priority: args.high ? 'high' : 'normal',
    push: true,
    expiresAt: ttlToExpiresAt(args.ttl),
    source: { cwd: ctx.cwd ?? null, host: ctx.host ?? null },
  });
}

export function askArgsToPayload(args, ctx = {}) {
  // Reuse the CLI's tested buildAskPayload by translating structured args into its flag shape.
  const flags = { title: args.title };
  if (args.body != null) flags.body = args.body;
  if (args.placeholder != null) flags.placeholder = args.placeholder;
  if (args.high) flags.high = true;
  if (args.ttl === 'keep') flags.keep = true;
  else if (args.ttl != null) flags.ttl = args.ttl;
  return buildAskPayload(flags, { cwd: ctx.cwd ?? null, host: ctx.host ?? null });
}

export function choiceArgsToPayload(args, ctx = {}) {
  if (!args.title) throw new Error('relay_choice: title is required');
  const options = (args.options || []).map((o) => {
    if (typeof o === 'string') return { id: slugify(o), label: o };
    if (!o || !o.label) throw new Error('relay_choice: each option needs a label');
    return { id: o.id || slugify(o.label), label: o.label, ...(o.description ? { description: o.description } : {}) };
  });
  return buildChoicePayload({
    title: args.title,
    body: args.body ?? null,
    options,
    priority: args.high ? 'high' : 'normal',
    push: true,
    expiresAt: ttlToExpiresAt(args.ttl),
    source: { cwd: ctx.cwd ?? null, host: ctx.host ?? null },
  });
}

// Normalize a pollResponse() result into the single JSON object a blocking tool returns.
export function formatResponse(pollResult, id) {
  if (!pollResult || pollResult.status === 'notfound') {
    return { status: 'notfound', id, message: 'Card not found — it expired or was dismissed.' };
  }
  if (pollResult.status === 'pending') {
    return { status: 'pending', id, message: `No response yet. Call relay_poll with id "${id}" to keep waiting.` };
  }
  const r = pollResult.response || {};
  const isReply = r.verdict === 'reply'; // a prompt card's free-text answer (relay_ask)
  return {
    status: 'answered',
    verdict: r.verdict ?? null,
    action: r.action ?? null,
    note: r.note ?? null,
    ...(isReply ? { reply: r.note ?? '' } : {}),
    id,
  };
}

// --- MCP result envelopes --------------------------------------------------
// v1 returns the result object as JSON text in `content` (universally supported). A declared
// outputSchema + structuredContent is a deferred follow-up — lock the shapes once tests + the
// smoke test prove them stable.
function okResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}
function errResult(msg) {
  return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: String(msg) }) }], isError: true };
}

// --- tool definitions (raw JSON Schema; exported for tests) ----------------

export const TOOL_DEFS = [
  {
    name: 'relay_notify',
    description:
      "Send a fire-and-forget push notification to the user's phone/desktop. Use for FYI updates that need NO response (build finished, deploy done, long task started). For anything that needs an answer, use relay_ask, relay_choice, or relay_card instead.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title (default "Relay").' },
        body: { type: 'string', description: 'Notification body text.' },
        url: { type: 'string', description: 'In-app path to open on tap, e.g. "/" (default).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_card',
    description:
      "Post a rich card to the Relay feed: a note, an approval request, or a Mermaid diagram. Returns the card id/url immediately by default. Set waitSeconds to BLOCK for a verdict — use kind='approval' for an Approve / Request changes decision. For a free-text answer use relay_ask; to pick among options use relay_choice.",
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown body.' },
        kind: { type: 'string', enum: ['note', 'approval', 'diagram'], description: 'Card kind (default note). approval auto-adds Approve / Request changes buttons.' },
        buttons: {
          type: 'array',
          description: 'Custom respond buttons.',
          items: {
            type: 'object',
            required: ['label', 'action'],
            properties: {
              label: { type: 'string' },
              action: { type: 'string', description: 'Verdict id returned when tapped. "approve"/"changes"/"dismiss" are aliased to canonical verdicts.' },
              style: { type: 'string', description: 'Optional button style, e.g. primary / note / danger.' },
            },
            additionalProperties: false,
          },
        },
        links: {
          type: 'array',
          description: 'Link buttons (open a URL, do not respond).',
          items: { type: 'object', required: ['label', 'url'], properties: { label: { type: 'string' }, url: { type: 'string' } }, additionalProperties: false },
        },
        mermaid: { type: 'string', description: 'Mermaid diagram source; promotes a plain note to a diagram card.' },
        copy: { type: 'string', description: 'Text offered behind a one-tap "Copy to clipboard" button.' },
        high: { type: 'boolean', description: 'High-priority push (urgent + requireInteraction).' },
        ttl: { type: 'string', description: 'Auto-clear after a duration ("30m","2h","1d") or "keep" to never expire.' },
        waitSeconds: { type: 'number', description: 'Block up to N seconds (<=280) for a verdict. Omit / 0 = return immediately with the id.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_ask',
    description:
      'Ask the user an open-ended question and get their FREE-TEXT reply. Pushes a notification with a Reply button that opens a text box. Blocks up to waitSeconds (default 50) for the answer; on status "pending", call relay_poll with the returned id to keep waiting. Use when you need typed input — not a yes/no or a pick.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'The question.' },
        body: { type: 'string', description: 'Optional extra context (markdown).' },
        placeholder: { type: 'string', description: "Placeholder text for the reply box." },
        high: { type: 'boolean', description: 'High-priority push.' },
        ttl: { type: 'string', description: 'Auto-clear duration ("30m","2h","1d") or "keep".' },
        waitSeconds: { type: 'number', description: 'Block up to N seconds (<=280, default 50). 0 = create without waiting.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_choice',
    description:
      'Ask the user to pick ONE of several options. Blocks up to waitSeconds (default 50); the chosen option id comes back as the verdict. On status "pending", re-poll with relay_poll. Use for multiple-choice decisions; use relay_ask for free text and relay_card (approval) for approve/reject.',
    inputSchema: {
      type: 'object',
      required: ['title', 'options'],
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'Optional context (markdown).' },
        options: {
          type: 'array',
          minItems: 1,
          description: 'The choices. Each is a plain string label, or an object { label, id?, description? }.',
          items: {
            anyOf: [
              { type: 'string' },
              { type: 'object', required: ['label'], properties: { label: { type: 'string' }, id: { type: 'string' }, description: { type: 'string' } }, additionalProperties: false },
            ],
          },
        },
        high: { type: 'boolean', description: 'High-priority push.' },
        ttl: { type: 'string', description: 'Auto-clear duration ("30m","2h","1d") or "keep".' },
        waitSeconds: { type: 'number', description: 'Block up to N seconds (<=280, default 50). 0 = create without waiting.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'relay_poll',
    description:
      'Resume waiting for a response to a card created earlier by relay_ask / relay_choice / relay_card that returned status "pending". Blocks up to waitSeconds (default 50). Returns status answered | pending | notfound.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'The card id returned by the earlier call.' },
        waitSeconds: { type: 'number', description: 'Block up to N seconds (<=280, default 50). 0 = check once, do not block.' },
      },
      additionalProperties: false,
    },
  },
];

// --- dispatch --------------------------------------------------------------

// Create a card, then either return its id (wait==0) or block on the bounded poll and format the verdict.
async function settle(cfg, created, waitSeconds, def) {
  const wait = resolveWait(waitSeconds, def);
  if (wait === 0) return okResult({ status: 'created', id: created.id, url: created.url });
  const res = await pollResponse(cfg, created.id, wait);
  return okResult(formatResponse(res, created.id));
}

export async function handleCall(name, rawArgs) {
  const args = rawArgs || {};
  const cfg = loadConfig();
  if (!cfg) {
    return errResult(
      'Relay is not configured. Run: relay init --url <https://your-app.up.railway.app> --token <WRITE_TOKEN>  (or set RELAY_URL and RELAY_WRITE_TOKEN).',
    );
  }
  const ctx = { cwd: safeCwd(), host: process.env.COMPUTERNAME || process.env.HOSTNAME || null };
  try {
    switch (name) {
      case 'relay_notify': {
        const r = await sendNotify(cfg, {
          title: args.title || 'Relay',
          body: args.body || 'You have a new update.',
          url: args.url || '/',
        });
        return okResult(r.ok ? { status: 'sent', ok: true } : { status: 'sent', ok: false, reason: r.reason || 'push-unavailable' });
      }
      case 'relay_card': {
        const created = await createCard(cfg, cardArgsToPayload(args, ctx));
        return settle(cfg, created, args.waitSeconds, 0); // fire-and-return unless waitSeconds is given
      }
      case 'relay_ask': {
        const created = await createCard(cfg, askArgsToPayload(args, ctx));
        return settle(cfg, created, args.waitSeconds, DEFAULT_WAIT); // blocks for the reply
      }
      case 'relay_choice': {
        const created = await createCard(cfg, choiceArgsToPayload(args, ctx));
        return settle(cfg, created, args.waitSeconds, DEFAULT_WAIT);
      }
      case 'relay_poll': {
        if (!args.id) return errResult('relay_poll: id is required');
        const res = await pollResponse(cfg, args.id, resolveWait(args.waitSeconds, DEFAULT_WAIT));
        return okResult(formatResponse(res, args.id));
      }
      default:
        return errResult(`unknown tool: ${name}`);
    }
  } catch (e) {
    return errResult(e && e.message ? e.message : e);
  }
}

// --- server bootstrap ------------------------------------------------------

async function main() {
  const server = new Server({ name: 'relay', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => handleCall(req.params?.name, req.params?.arguments));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('relay-mcp: ready on stdio\n');
}

// Same portable entry-point guard as relay.mjs: stays false when imported by tests, so they get the
// exported pure helpers without starting the stdio server.
const isEntry =
  typeof import.meta.main === 'boolean'
    ? import.meta.main
    : !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main().catch((e) => {
    process.stderr.write('relay-mcp fatal: ' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(1);
  });
}
