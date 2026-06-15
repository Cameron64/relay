// Tests the MCP server's PURE pieces (bin/relay-mcp.mjs): the tool-args -> API-payload mappers,
// the verdict formatter, and the tool definitions. Importing the .mjs does NOT start the stdio
// server (the import.meta.main / argv entry guard stays false under the test runner).
import { test, expect, describe } from 'bun:test';
// @ts-ignore — zero-dep .mjs server has no .d.ts
import { cardArgsToPayload, askArgsToPayload, choiceArgsToPayload, formatResponse, TOOL_DEFS } from '../bin/relay-mcp.mjs';

describe('cardArgsToPayload', () => {
  test('builds a plain note that pushes, retaining cwd/host', () => {
    const p = cardArgsToPayload({ title: 'T', body: 'b' }, { cwd: '/w', host: 'H' });
    expect(p.kind).toBe('note');
    expect(p.title).toBe('T');
    expect(p.body).toBe('b');
    expect(p.push).toBe(true);
    expect(p.buttons).toEqual([]);
    expect(p.source).toEqual({ cwd: '/w', host: 'H' });
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
});

describe('TOOL_DEFS', () => {
  test('exposes the five relay tools, each with a description and input schema', () => {
    const names = TOOL_DEFS.map((t: any) => t.name).sort();
    expect(names).toEqual(['relay_ask', 'relay_card', 'relay_choice', 'relay_notify', 'relay_poll']);
    for (const t of TOOL_DEFS) {
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
  });

  test('relay_card and relay_ask require a title; relay_poll requires an id', () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t: any) => [t.name, t]));
    expect(byName.relay_card.inputSchema.required).toContain('title');
    expect(byName.relay_ask.inputSchema.required).toContain('title');
    expect(byName.relay_poll.inputSchema.required).toContain('id');
  });
});
