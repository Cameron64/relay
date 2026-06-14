// Tests the CLI's pure spec parsers (imported from the .mjs; import.meta.main stays false so
// main() does not run on import).
import { test, expect, describe } from 'bun:test';
// @ts-ignore — zero-dep .mjs CLI has no .d.ts; the parsers are plain functions.
import { parseButtonSpec, parseLinkSpec } from '../bin/relay.mjs';

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
