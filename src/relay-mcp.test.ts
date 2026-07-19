// Tests the MCP server's PURE pieces (bin/relay-mcp.mjs): the tool-args -> API-payload mappers,
// the verdict formatter, and the tool definitions. Importing the .mjs does NOT start the stdio
// server (the import.meta.main / argv entry guard stays false under the test runner).
import { test, expect, describe, afterEach } from 'bun:test';
// @ts-ignore — zero-dep .mjs server has no .d.ts
import { cardArgsToPayload, askArgsToPayload, choiceArgsToPayload, pageArgsToPayload, formatResponse, withPagePayload, handleCall, TOOL_DEFS } from '../bin/relay-mcp.mjs';
// @ts-ignore — zero-dep .mjs lib has no .d.ts
import { safeFilename } from '../lib/relay-lib.mjs';
// @ts-ignore — zero-dep .mjs has no .d.ts
import { buildPagePayload } from '../bin/relay.mjs';

describe('cardArgsToPayload', () => {
  test('builds a plain note that pushes, retaining cwd/host', () => {
    const p = cardArgsToPayload({ title: 'T', body: 'b' }, { cwd: '/w', host: 'H' });
    expect(p.kind).toBe('note');
    expect(p.title).toBe('T');
    expect(p.body).toBe('b');
    expect(p.push).toBe(true);
    expect(p.buttons).toEqual([]);
    expect(p.source).toEqual({ cwd: '/w', host: 'H', sessionId: null });
  });

  test('kind=approval auto-adds Approve / Request changes respond buttons', () => {
    const p = cardArgsToPayload({ title: 'Ship?', kind: 'approval' }, {});
    const verdicts = p.buttons.filter((b: any) => b.behavior === 'respond').map((b: any) => b.verdict);
    expect(verdicts).toEqual(['approved', 'changes_requested']);
  });

  test('button action aliases map to canonical verdicts', () => {
    const p = cardArgsToPayload({ title: 'T', buttons: [{ label: 'Yes', action: 'approve' }] }, {});
    expect(p.buttons[0].behavior).toBe('respond');
    expect(p.buttons[0].verdict).toBe('approved');
  });

  test('a custom action verdict passes through unaliased', () => {
    const p = cardArgsToPayload({ title: 'T', buttons: [{ label: 'A', action: 'opt_a' }] }, {});
    expect(p.buttons[0].verdict).toBe('opt_a');
  });

  test('links become link buttons; non-http is rejected', () => {
    const p = cardArgsToPayload({ title: 'T', links: [{ label: 'PR', url: 'https://x.com/1' }] }, {});
    expect(p.buttons[0].behavior).toBe('link');
    expect(p.buttons[0].value).toBe('https://x.com/1');
    expect(() => cardArgsToPayload({ title: 'T', links: [{ label: 'Bad', url: 'javascript:alert(1)' }] }, {})).toThrow(/http/);
  });

  test('mermaid promotes a plain note to a diagram', () => {
    const p = cardArgsToPayload({ title: 'T', mermaid: 'graph TD; A-->B' }, {});
    expect(p.kind).toBe('diagram');
    expect(p.mermaid).toContain('A-->B');
  });

  test('copy adds a copy button and copy_text', () => {
    const p = cardArgsToPayload({ title: 'T', copy: 'paste me' }, {});
    expect(p.copy_text).toBe('paste me');
    expect(p.buttons.some((b: any) => b.behavior === 'copy')).toBe(true);
  });

  test('ttl converts to an expires_at; "keep" is far-future; a bad ttl throws', () => {
    expect(typeof cardArgsToPayload({ title: 'T', ttl: '30m' }, {}).expires_at).toBe('string');
    expect(cardArgsToPayload({ title: 'T', ttl: 'keep' }, {}).expires_at).toBe('9999-12-31T23:59:59.999Z');
    expect(() => cardArgsToPayload({ title: 'T', ttl: 'soon' }, {})).toThrow(/ttl/);
  });

  test('high priority flag; throws without a title', () => {
    expect(cardArgsToPayload({ title: 'T', high: true }, {}).priority).toBe('high');
    expect(() => cardArgsToPayload({}, {})).toThrow(/title/);
  });
});

describe('askArgsToPayload', () => {
  test('builds a prompt card that pushes by default', () => {
    const p = askArgsToPayload({ title: 'What next?' }, { cwd: '/w', host: 'H' });
    expect(p.kind).toBe('prompt');
    expect(p.push).toBe(true);
    expect(p.buttons).toEqual([]);
    expect(p.source.cwd).toBe('/w');
  });

  test('placeholder lands in source.placeholder; ttl "keep" sets far-future expiry', () => {
    expect(askArgsToPayload({ title: 'T', placeholder: 'type…' }, {}).source.placeholder).toBe('type…');
    expect(askArgsToPayload({ title: 'T', ttl: 'keep' }, {}).expires_at).toBe('9999-12-31T23:59:59.999Z');
  });

  test('throws without a title', () => {
    expect(() => askArgsToPayload({}, {})).toThrow(/title/);
  });
});

describe('choiceArgsToPayload', () => {
  test('string options slugify into ids', () => {
    const p = choiceArgsToPayload({ title: 'Pick', options: ['Ship it', 'Wait'] }, {});
    expect(p.kind).toBe('choice');
    expect(p.options).toEqual([
      { id: 'ship-it', label: 'Ship it' },
      { id: 'wait', label: 'Wait' },
    ]);
  });

  test('object options keep an explicit id or slugify the label, and carry description', () => {
    const p = choiceArgsToPayload({ title: 'Pick', options: [{ label: 'Ship it', id: 'ship' }, { label: 'Hold On', description: 'wait a bit' }] }, {});
    expect(p.options[0]).toEqual({ id: 'ship', label: 'Ship it' });
    expect(p.options[1]).toEqual({ id: 'hold-on', label: 'Hold On', description: 'wait a bit' });
  });

  test('throws without a title or with no options', () => {
    expect(() => choiceArgsToPayload({ options: ['a'] }, {})).toThrow(/title/);
    expect(() => choiceArgsToPayload({ title: 'T', options: [] }, {})).toThrow(/option/);
  });
});

describe('pageArgsToPayload', () => {
  test('builds a page card with page_html as a top-level key, view-only (no buttons), pushes', () => {
    const p = pageArgsToPayload({ title: 'Viz', html: '<!doctype html><p>hi</p>' }, { cwd: '/w', host: 'H' });
    expect(p.kind).toBe('page');
    expect(p.title).toBe('Viz');
    expect(p.page_html).toBe('<!doctype html><p>hi</p>');
    expect(p.buttons).toEqual([]);
    expect(p.push).toBe(true);
    expect(p.source).toEqual({ cwd: '/w', host: 'H', sessionId: null });
  });

  test('high → priority high; copy → copy_text; ttl "keep" → far-future expiry', () => {
    expect(pageArgsToPayload({ title: 'T', html: '<p>x</p>', high: true }, {}).priority).toBe('high');
    expect(pageArgsToPayload({ title: 'T', html: '<p>x</p>', copy: 'paste' }, {}).copy_text).toBe('paste');
    expect(pageArgsToPayload({ title: 'T', html: '<p>x</p>', ttl: 'keep' }, {}).expires_at).toBe('9999-12-31T23:59:59.999Z');
  });

  test('throws without a title or without html', () => {
    expect(() => pageArgsToPayload({ html: '<p>x</p>' }, {})).toThrow(/title/);
    expect(() => pageArgsToPayload({ title: 'T' }, {})).toThrow(/html/);
  });

  // relay-roadmap Plan 05 — the page-submit bridge.
  test('expectResponse defaults false and maps to expects_response:true when set', () => {
    expect(pageArgsToPayload({ title: 'T', html: '<p>x</p>' }, {}).expects_response).toBe(false);
    expect(pageArgsToPayload({ title: 'T', html: '<p>x</p>', expectResponse: true }, {}).expects_response).toBe(true);
  });
});

describe('buildPagePayload', () => {
  test('produces a kind:page payload with page_html and no buttons', () => {
    const p = buildPagePayload({ title: 'T', pageHtml: '<p>hi</p>' });
    expect(p.kind).toBe('page');
    expect(p.page_html).toBe('<p>hi</p>');
    expect(p.buttons).toEqual([]);
  });

  test('throws without a title or without pageHtml', () => {
    expect(() => buildPagePayload({ pageHtml: '<p>x</p>' })).toThrow(/title/);
    expect(() => buildPagePayload({ title: 'T' })).toThrow(/html/);
  });

  test('expectsResponse defaults false; true sets expects_response on the payload', () => {
    expect(buildPagePayload({ title: 'T', pageHtml: '<p>x</p>' }).expects_response).toBe(false);
    expect(buildPagePayload({ title: 'T', pageHtml: '<p>x</p>', expectsResponse: true }).expects_response).toBe(true);
  });
});

describe('formatResponse', () => {
  test('an approved verdict formats as answered', () => {
    const r = formatResponse({ status: 'responded', response: { verdict: 'approved', action: 'approved', note: null } }, 'id1');
    expect(r).toEqual({ status: 'answered', verdict: 'approved', action: 'approved', note: null, id: 'id1' });
  });

  test('a reply verdict surfaces the free text in `reply`', () => {
    const r = formatResponse({ status: 'responded', response: { verdict: 'reply', note: 'do the thing' } }, 'id2');
    expect(r.verdict).toBe('reply');
    expect(r.reply).toBe('do the thing');
  });

  test('reply attachments pass through as response_assets metadata (withResponseImages downloads them)', () => {
    const response_assets = [{ id: 'a1', filename: 'shot.png', mime: 'image/png' }];
    const r = formatResponse({ status: 'responded', response: { verdict: 'reply', note: 'see this' }, response_assets }, 'id6');
    expect(r.response_assets).toEqual(response_assets);
  });

  test('no response_assets key when the reply carried no attachments', () => {
    const r = formatResponse({ status: 'responded', response: { verdict: 'approved', action: 'approved', note: null } }, 'id7');
    expect(r.response_assets).toBeUndefined();
  });

  test('pending tells the caller to relay_poll the id', () => {
    const r = formatResponse({ status: 'pending' }, 'id3');
    expect(r.status).toBe('pending');
    expect(r.message).toContain('relay_poll');
    expect(r.id).toBe('id3');
  });

  test('notfound is reported with the id', () => {
    const r = formatResponse({ status: 'notfound' }, 'id4');
    expect(r.status).toBe('notfound');
    expect(r.id).toBe('id4');
  });

  // relay-roadmap Plan 04 — card threads: a poll made with eventsSince can come back as
  // status:'event' (a human message landed instead of a verdict) rather than being swallowed as
  // a plain timeout.
  describe('status "event" (Plan 04 card threads)', () => {
    test('surfaces the events array and points the caller at relay_reply + resuming relay_poll', () => {
      const events = [{ card_id: 'id5', seq: 3, role: 'user', type: 'message', body: 'why this migration?', at: 't' }];
      const r = formatResponse({ status: 'event', events }, 'id5');
      expect(r.status).toBe('event');
      expect(r.id).toBe('id5');
      expect(r.events).toEqual(events);
      expect(r.sinceSeq).toBe(3);
      expect(r.message).toContain('relay_reply');
      expect(r.message).toContain('relay_poll');
    });

    test('sinceSeq falls back to 0 when events is empty', () => {
      const r = formatResponse({ status: 'event', events: [] }, 'id6');
      expect(r.sinceSeq).toBe(0);
    });
  });
});

describe('withPagePayload', () => {
  const cfg = { url: 'https://relay.test', writeToken: 'tok' };
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('a non-submit verdict passes through untouched (no fetch)', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('should not be called');
    }) as any;
    const formatted = { status: 'answered', verdict: 'approved', action: 'approved', note: null, id: 'id1' };
    const r = await withPagePayload(cfg, formatted);
    expect(r).toEqual(formatted);
    expect(fetched).toBe(false);
  });

  test('a pending/notfound result passes through untouched', async () => {
    const pending = { status: 'pending', id: 'id1', message: 'x' };
    expect(await withPagePayload(cfg, pending)).toEqual(pending);
  });

  test('a submit verdict fetches events and inlines the latest payload row', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        events: [
          { card_id: 'id1', seq: 1, role: 'agent', type: 'message', body: 'hi', at: 't1' },
          { card_id: 'id1', seq: 2, role: 'user', type: 'payload', body: JSON.stringify({ slider: 42 }), at: 't2' },
        ],
      }),
    })) as any;
    const formatted = { status: 'answered', verdict: 'submit', action: 'submit', note: null, id: 'id1' };
    const r = await withPagePayload(cfg, formatted);
    expect(r.payload).toEqual({ slider: 42 });
    expect(r.status).toBe('answered');
  });

  test('a fetch failure degrades to payload:null rather than throwing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as any;
    const formatted = { status: 'answered', verdict: 'submit', action: 'submit', note: null, id: 'id1' };
    const r = await withPagePayload(cfg, formatted);
    expect(r.payload).toBeNull();
  });
});

describe('TOOL_DEFS', () => {
  test('exposes the seven relay tools, each with a description and input schema', () => {
    const names = TOOL_DEFS.map((t: any) => t.name).sort();
    expect(names).toEqual(['relay_ask', 'relay_card', 'relay_choice', 'relay_notify', 'relay_page', 'relay_poll', 'relay_reply']);
    for (const t of TOOL_DEFS) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  test('relay_card and relay_ask require a title; relay_poll requires an id; relay_page requires title+html', () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t: any) => [t.name, t]));
    expect(byName.relay_card.inputSchema.required).toContain('title');
    expect(byName.relay_ask.inputSchema.required).toContain('title');
    expect(byName.relay_poll.inputSchema.required).toContain('id');
    expect(byName.relay_page.inputSchema.required).toEqual(['title', 'html']);
  });

  // relay-roadmap Plan 04 — card threads.
  test('relay_poll exposes eventsSince; relay_reply requires id + body', () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t: any) => [t.name, t]));
    expect(byName.relay_poll.inputSchema.properties.eventsSince.type).toBe('number');
    expect(byName.relay_reply.inputSchema.required).toEqual(['id', 'body']);
    expect(byName.relay_reply.inputSchema.properties.body.type).toBe('string');
  });

  test('relay_page exposes expectResponse + waitSeconds and documents the submit protocol', () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t: any) => [t.name, t]));
    expect(byName.relay_page.inputSchema.properties.expectResponse.type).toBe('boolean');
    expect(byName.relay_page.inputSchema.properties.waitSeconds.type).toBe('number');
    expect(byName.relay_page.description).toContain('__relay');
    expect(byName.relay_page.description).toContain('submit');
  });

  // Feature 3 — descriptions steer agents toward rich HTML/chart presentation via relay_page.
  test('descriptions steer information-presentation toward relay_page', () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t: any) => [t.name, t]));
    expect(byName.relay_card.description).toContain('use relay_page instead');
    expect(byName.relay_card.description).toContain('visual/HTML');
    expect(byName.relay_page.description).toContain('PREFER this tool');
    expect(byName.relay_ask.description).toContain('relay_page');
    expect(byName.relay_choice.description).toContain('relay_page');
  });

  // New lifecycle: pending question cards auto-expire (CARD_PENDING_TTL_HOURS, default 24h), and
  // every card gets a fallback reply box in the PWA (replies land as verdict 'reply', text in note).
  test('descriptions document pending auto-expiry (pass a ttl matching real polling) and the fallback reply box', () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t: any) => [t.name, t]));
    for (const name of ['relay_card', 'relay_ask', 'relay_choice']) {
      expect(byName[name].description).toContain('auto-expire');
      expect(byName[name].description.toLowerCase()).toContain('ttl');
    }
    expect(byName.relay_card.description).toContain('fallback reply box');
    expect(byName.relay_choice.description).toContain('fallback reply box');
    expect(byName.relay_poll.description).toContain('fallback reply box');
    expect(byName.relay_page.description).toContain('fallback reply box');
  });
});

// handleCall('relay_page', …) blocking path — the initial wait must be thread-aware (eventsSince:0,
// same as settle()): without it a human thread message on the pending page is invisible during the
// first wait and the call just times out as 'pending'.
describe('handleCall relay_page blocking poll', () => {
  const realFetch = globalThis.fetch;
  const realUrl = process.env.RELAY_URL;
  const realToken = process.env.RELAY_WRITE_TOKEN;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realUrl === undefined) delete process.env.RELAY_URL;
    else process.env.RELAY_URL = realUrl;
    if (realToken === undefined) delete process.env.RELAY_WRITE_TOKEN;
    else process.env.RELAY_WRITE_TOKEN = realToken;
  });

  function stub(responses: any[]) {
    process.env.RELAY_URL = 'https://relay.test';
    process.env.RELAY_WRITE_TOKEN = 'tok';
    const calls: any[] = [];
    let i = 0;
    globalThis.fetch = (async (url: any, opts: any) => {
      calls.push({ url: String(url), opts });
      const json = responses[Math.min(i, responses.length - 1)];
      i++;
      return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
    }) as any;
    return calls;
  }

  test('the initial wait polls /response with events_since=0', async () => {
    const calls = stub([
      { id: 'p1', url: '/?card=p1' }, // POST /api/cards
      { status: 'responded', response: { verdict: 'submit', action: 'submit', note: null } }, // GET .../response
      { events: [{ card_id: 'p1', seq: 1, role: 'user', type: 'payload', body: JSON.stringify({ ok: 1 }), at: 't' }] }, // getCardEvents
    ]);
    const result = await handleCall('relay_page', { title: 'T', html: '<p>x</p>', expectResponse: true, waitSeconds: 5 });
    const body = JSON.parse(result.content[0].text);
    expect(calls[1].url).toContain('/api/cards/p1/response');
    expect(calls[1].url).toContain('events_since=0');
    expect(body.status).toBe('answered');
    expect(body.verdict).toBe('submit');
    expect(body.payload).toEqual({ ok: 1 });
  });

  test('a human thread message during the initial wait surfaces as status "event" (not a silent timeout)', async () => {
    const calls = stub([
      { id: 'p2', url: '/?card=p2' },
      { status: 'event', events: [{ card_id: 'p2', seq: 2, role: 'user', type: 'message', body: 'which repo?', at: 't' }] },
    ]);
    const result = await handleCall('relay_page', { title: 'T', html: '<p>x</p>', expectResponse: true, waitSeconds: 5 });
    const body = JSON.parse(result.content[0].text);
    expect(calls[1].url).toContain('events_since=0');
    expect(body.status).toBe('event');
    expect(body.sinceSeq).toBe(2);
    expect(body.message).toContain('relay_reply');
  });
});

// safeFilename (relay-lib) — the ONLY place a network-supplied reply-attachment name becomes a path
// on this machine (the MCP writing to ~/.relay/mcp-assets). Path traversal, absolute paths, and
// dotfiles must all be neutralized to a single safe path segment.
describe('safeFilename', () => {
  test('keeps an ordinary filename', () => {
    expect(safeFilename('screenshot.png', 'a1')).toBe('screenshot.png');
  });
  test('strips directory components (POSIX + Windows) and absolute paths', () => {
    expect(safeFilename('../../etc/passwd', 'a1')).toBe('passwd');
    expect(safeFilename('..\\..\\Windows\\evil.dll', 'a1')).toBe('evil.dll');
    expect(safeFilename('/abs/thing.png', 'a1')).toBe('thing.png');
  });
  test('neutralizes bare .. and leading dots (no dotfiles)', () => {
    expect(safeFilename('..', 'a1')).toBe('attachment-a1');
    expect(safeFilename('.ssh', 'a1')).toBe('ssh');
  });
  test('collapses disallowed characters and falls back when nothing survives', () => {
    expect(safeFilename('a b.png', 'a1')).toBe('a_b.png');
    expect(safeFilename('', 'a1')).toBe('attachment-a1');
    expect(safeFilename('///', 'a1')).toBe('attachment-a1');
    expect(safeFilename(null, 'x/y')).toBe('attachment-xy');
  });
});
