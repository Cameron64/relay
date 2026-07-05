// Tests the PreToolUse hook's pure, import-testable helpers. main()/the backstop timer never run
// on import — see pretool-hook.mjs's isEntry guard (same pattern as bin/relay.mjs).
import { test, expect, describe } from 'bun:test';
// @ts-ignore — zero-dep .mjs hook has no .d.ts; the exported helpers are plain functions.
import { buildApprovalBody, mapVerdictToDecision } from '../hooks/pretool-hook.mjs';
// @ts-ignore — rule matching lives in the shared lib so it's reusable + testable from src/.
import { matchPermissionRule } from '../lib/relay-lib.mjs';

describe('matchPermissionRule', () => {
  test('a rule with no inputMatch matches every call of that tool', () => {
    const rules = [{ tool: 'Write' }];
    expect(matchPermissionRule(rules, 'Write', { file_path: 'a.ts' })).toEqual({ tool: 'Write' });
    expect(matchPermissionRule(rules, 'Write', {})).toEqual({ tool: 'Write' });
  });

  test('inputMatch is tested as a regex against JSON.stringify(tool_input)', () => {
    const rules = [{ tool: 'Bash', inputMatch: 'rm -rf' }];
    expect(matchPermissionRule(rules, 'Bash', { command: 'rm -rf /tmp/x' })).toEqual(rules[0]);
    expect(matchPermissionRule(rules, 'Bash', { command: 'ls -la' })).toBeNull();
  });

  test('a leading (?i) PCRE inline flag is stripped and matching stays case-insensitive', () => {
    const rules = [{ tool: 'Bash', inputMatch: '(?i)(rm -rf|git push)' }];
    expect(matchPermissionRule(rules, 'Bash', { command: 'GIT PUSH origin main' })).toEqual(rules[0]);
    expect(matchPermissionRule(rules, 'Bash', { command: 'RM -RF /' })).toEqual(rules[0]);
  });

  test('tool name must match exactly; a different tool never matches', () => {
    const rules = [{ tool: 'Bash', inputMatch: 'rm -rf' }];
    expect(matchPermissionRule(rules, 'Edit', { command: 'rm -rf /' })).toBeNull();
  });

  test('returns the FIRST matching rule when multiple rules could match', () => {
    const rules = [{ tool: 'Bash', inputMatch: 'push' }, { tool: 'Bash' }];
    expect(matchPermissionRule(rules, 'Bash', { command: 'git push' })).toEqual(rules[0]);
  });

  test('no rules file (empty array) never matches', () => {
    expect(matchPermissionRule([], 'Bash', { command: 'rm -rf /' })).toBeNull();
  });

  test('malformed input never throws and never matches', () => {
    expect(matchPermissionRule(null as any, 'Bash', {})).toBeNull();
    expect(matchPermissionRule('not-an-array' as any, 'Bash', {})).toBeNull();
    expect(matchPermissionRule([null, 'nope', { tool: 42 }] as any, 'Bash', {})).toBeNull();
    // malformed regex in a hand-edited rules file — degrade to "no match", never throw
    expect(() => matchPermissionRule([{ tool: 'Bash', inputMatch: '(unclosed' }], 'Bash', { command: 'x' })).not.toThrow();
    expect(matchPermissionRule([{ tool: 'Bash', inputMatch: '(unclosed' }], 'Bash', { command: 'x' })).toBeNull();
  });
});

describe('buildApprovalBody', () => {
  test('Bash renders a fenced command block', () => {
    const body = buildApprovalBody('Bash', { command: 'git push origin main' });
    expect(body).toContain('```bash');
    expect(body).toContain('git push origin main');
  });

  test('Write renders the file path plus a content preview', () => {
    const body = buildApprovalBody('Write', { file_path: '/repo/src/index.ts', content: 'console.log(1)' });
    expect(body).toContain('/repo/src/index.ts');
    expect(body).toContain('console.log(1)');
  });

  test('Edit renders the file path plus new_string content', () => {
    const body = buildApprovalBody('Edit', { file_path: '/repo/a.ts', new_string: 'const x = 1;' });
    expect(body).toContain('/repo/a.ts');
    expect(body).toContain('const x = 1;');
  });

  test('an unknown tool falls back to pretty-printed tool_input JSON', () => {
    const body = buildApprovalBody('SomeTool', { foo: 'bar' });
    expect(body).toContain('```json');
    expect(body).toContain('"foo"');
  });

  test('a huge body is capped, never left unbounded', () => {
    const body = buildApprovalBody('Bash', { command: 'x'.repeat(20_000) });
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body).toContain('truncated');
  });
});

describe('mapVerdictToDecision', () => {
  test('approved -> allow', () => {
    expect(mapVerdictToDecision({ status: 'responded', response: { verdict: 'approved', note: null } })).toEqual({
      permissionDecision: 'allow',
    });
  });

  test('changes_requested with a note -> deny, note passed through as the reason', () => {
    const decision = mapVerdictToDecision({
      status: 'responded',
      response: { verdict: 'changes_requested', note: 'do X instead' },
    });
    expect(decision).toEqual({ permissionDecision: 'deny', permissionDecisionReason: 'do X instead' });
  });

  test('changes_requested with no note -> deny, generic fallback reason', () => {
    const decision = mapVerdictToDecision({ status: 'responded', response: { verdict: 'changes_requested', note: null } });
    expect(decision).toEqual({ permissionDecision: 'deny', permissionDecisionReason: 'Denied from phone' });
  });

  test('a dismissed or otherwise custom verdict -> ask, never auto-allow', () => {
    expect(mapVerdictToDecision({ status: 'responded', response: { verdict: 'dismissed', note: null } })).toEqual({
      permissionDecision: 'ask',
    });
  });

  test('timeout (still pending) -> ask', () => {
    expect(mapVerdictToDecision({ status: 'pending' })).toEqual({ permissionDecision: 'ask' });
  });

  test('card gone (expired/dismissed before answer) -> ask', () => {
    expect(mapVerdictToDecision({ status: 'notfound' })).toEqual({ permissionDecision: 'ask' });
  });

  test('no result at all -> ask (fail closed)', () => {
    expect(mapVerdictToDecision(undefined as any)).toEqual({ permissionDecision: 'ask' });
  });
});
