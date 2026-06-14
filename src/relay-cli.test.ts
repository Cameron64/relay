// Tests the CLI's pure spec parsers (imported from the .mjs; import.meta.main stays false so
// main() does not run on import).
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import os from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
// @ts-ignore — zero-dep .mjs CLI has no .d.ts; the parsers are plain functions.
import { parseButtonSpec, parseLinkSpec, buildDraftPayload, browserOpenCommand, isSameOrigin } from '../bin/relay.mjs';
// @ts-ignore — afk helpers live in the shared lib (read pure; the CLI does the writes).
import { afkPath, readAfk } from '../lib/relay-lib.mjs';

describe('parseButtonSpec', () => {
  test('Label=action -> respond button with behavior field', () => {
    const b = parseButtonSpec('Approve=approved');
    expect(b.behavior).toBe('respond');
    expect(b.label).toBe('Approve');
    expect(b.verdict).toBe('approved');
  });
  test('friendly aliases map to verdicts', () => {
    expect(parseButtonSpec('Approve=approve').verdict).toBe('approved');
    expect(parseButtonSpec('Changes=changes').verdict).toBe('changes_requested');
    expect(parseButtonSpec('No=reject').verdict).toBe('dismissed');
  });
  test('optional :style is parsed', () => {
    const b = parseButtonSpec('Approve=approved:primary');
    expect(b.style).toBe('primary');
    expect(b.verdict).toBe('approved');
  });
  test('label with spaces is preserved', () => {
    const b = parseButtonSpec('Request changes=changes:note');
    expect(b.label).toBe('Request changes');
    expect(b.verdict).toBe('changes_requested');
    expect(b.style).toBe('note');
  });
  test('custom verdict passes through (not an alias)', () => {
    const b = parseButtonSpec('Option A=opt_a');
    expect(b.verdict).toBe('opt_a');
  });
  test('throws on missing =', () => {
    expect(() => parseButtonSpec('NoEquals')).toThrow();
  });
});

describe('parseLinkSpec', () => {
  test('Label=https url -> link button', () => {
    const b = parseLinkSpec('Open PR=https://example.com/pr/1');
    expect(b.behavior).toBe('link');
    expect(b.label).toBe('Open PR');
    expect(b.value).toBe('https://example.com/pr/1');
  });
  test('rejects non-http url', () => {
    expect(() => parseLinkSpec('Bad=javascript:alert(1)')).toThrow();
  });
});

describe('buildDraftPayload', () => {
  test('builds an editable draft card with source.editable and retained cwd/host', () => {
    const p = buildDraftPayload({ title: 'Msg to team', body: '## hi' }, { cwd: '/work', host: 'BOX' });
    expect(p.kind).toBe('draft');
    expect(p.title).toBe('Msg to team');
    expect(p.body).toBe('## hi');
    expect(p.source).toEqual({ cwd: '/work', host: 'BOX', editable: true });
  });
  test('defaults push to false; --push opts in', () => {
    expect(buildDraftPayload({ title: 'T' }, {}).push).toBe(false);
    expect(buildDraftPayload({ title: 'T', push: true }, {}).push).toBe(true);
  });
  test('--body-stdin uses the piped stdin as the body', () => {
    const p = buildDraftPayload({ title: 'T', 'body-stdin': true }, { stdin: 'piped body' });
    expect(p.body).toBe('piped body');
  });
  test('throws without a title', () => {
    expect(() => buildDraftPayload({}, {})).toThrow(/title/);
  });
  test('accepts --link buttons but rejects respond --button (v1)', () => {
    const p = buildDraftPayload({ title: 'T', link: ['Open=https://example.com'] }, {});
    expect(p.buttons).toHaveLength(1);
    expect(p.buttons[0].behavior).toBe('link');
    expect(() => buildDraftPayload({ title: 'T', button: ['Send=approved'] }, {})).toThrow(/respond/);
  });
  test('passes through pre-read image assets', () => {
    const p = buildDraftPayload({ title: 'T' }, { assets: [{ mime: 'image/png', data: 'AAAA' }] });
    expect(p.assets).toHaveLength(1);
    expect(p.assets[0].mime).toBe('image/png');
  });
  test('high priority flag', () => {
    expect(buildDraftPayload({ title: 'T', high: true }, {}).priority).toBe('high');
    expect(buildDraftPayload({ title: 'T' }, {}).priority).toBe('normal');
  });
});

describe('browserOpenCommand', () => {
  test('win32 wraps cmd /c start with an empty title arg', () => {
    const c = browserOpenCommand('win32', 'https://relay.example.app/?card=00aabb11ccdd2233');
    expect(c.cmd).toBe('cmd');
    expect(c.args).toEqual(['/c', 'start', '', 'https://relay.example.app/?card=00aabb11ccdd2233']);
  });
  test('win32 allows a URL with a ?query= card id', () => {
    expect(() => browserOpenCommand('win32', 'https://h.app/?card=abcd1234abcd1234')).not.toThrow();
  });
  test('win32 rejects a URL containing cmd-special & / ^ / | characters', () => {
    expect(() => browserOpenCommand('win32', 'https://h.app/?a=1&b=2')).toThrow();
    expect(() => browserOpenCommand('win32', 'https://h.app/?x=^foo')).toThrow();
  });
  test('darwin uses open, linux uses xdg-open', () => {
    expect(browserOpenCommand('darwin', 'https://h.app/?card=x')).toEqual({ cmd: 'open', args: ['https://h.app/?card=x'] });
    expect(browserOpenCommand('linux', 'https://h.app/?card=x')).toEqual({ cmd: 'xdg-open', args: ['https://h.app/?card=x'] });
  });
});

describe('isSameOrigin (auto-open safety gate)', () => {
  const cfg = 'https://relay-production-6ebb.up.railway.app';
  test('assembled card URL matches the configured origin', () => {
    expect(isSameOrigin(cfg + '/?card=00aabb11ccdd2233', cfg)).toBe(true);
  });
  test('a different origin is rejected', () => {
    expect(isSameOrigin('https://evil.example.com/?card=x', cfg)).toBe(false);
  });
  test('garbage URL is rejected, not thrown', () => {
    expect(isSameOrigin('not a url', cfg)).toBe(false);
  });
});

describe('readAfk / afkPath (the AFK flag)', () => {
  // Isolate from the real ~/.relay by pointing the home dir at a temp dir. os.homedir() reads
  // HOME (POSIX) / USERPROFILE (Windows) at call time, so afkPath()/readAfk() follow the override.
  // The second test asserts the override actually took effect — if a runtime ever cached homedir,
  // the fs-based tests below would silently read the real home, so we fail loudly instead.
  const tmpHome = join(os.tmpdir(), 'relay-afk-test-' + process.pid);
  const savedHome = process.env.HOME;
  const savedUserprofile = process.env.USERPROFILE;

  beforeAll(() => {
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    mkdirSync(join(tmpHome, '.relay'), { recursive: true });
  });
  afterAll(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserprofile;
  });

  test('afkPath() resolves to afk.json under the .relay dir', () => {
    expect(afkPath()).toMatch(/[\\/]\.relay[\\/]afk\.json$/);
  });
  test('the temp-home override took effect (afkPath is under tmpHome)', () => {
    expect(afkPath().startsWith(tmpHome)).toBe(true);
  });
  test('readAfk() returns null when no flag file exists', () => {
    try {
      rmSync(afkPath());
    } catch {}
    expect(readAfk()).toBeNull();
  });
  test('readAfk() returns the parsed record when the flag exists', () => {
    writeFileSync(afkPath(), JSON.stringify({ since: '2026-06-14T00:00:00Z', reason: 'lunch' }));
    const rec = readAfk();
    expect(rec).not.toBeNull();
    expect(rec.reason).toBe('lunch');
  });
  test('readAfk() returns null on malformed JSON (fail-safe = at desk)', () => {
    writeFileSync(afkPath(), '{ this is not valid json');
    expect(readAfk()).toBeNull();
  });
});
