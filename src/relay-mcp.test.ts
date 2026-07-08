// Tests the MCP server's PURE pieces (bin/relay-mcp.mjs): the tool-args -> API-payload mappers,
// the verdict formatter, and the tool definitions. Importing the .mjs does NOT start the stdio
// server (the import.meta.main / argv entry guard stays false under the test runner).
import { test, expect, describe, afterEach } from 'bun:test';
// @ts-ignore — zero-dep .mjs server has no .d.ts
import { cardArgsToPayload, askArgsToPayload, choiceArgsToPayload, pageArgsToPayload, formatResponse, withPagePayload, TOOL_DEFS } from '../bin/relay-mcp.mjs';
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
