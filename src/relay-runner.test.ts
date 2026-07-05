// Tests the runner's pure helpers (config parsing, target resolution, prompt building, claude -p
// output parsing — see the plan's "Tests / acceptance": "pure helpers ... unit-tested; the spawn
// path smoke-tested manually"). import.meta.main stays false on import, so main()/mainLoop() never
// run — no network, no child_process spawn, no ~/.relay/runner.json touched by this test file.
import { test, expect, describe } from 'bun:test';
// @ts-ignore — zero-dep .mjs daemon has no .d.ts; the helpers under test are plain functions.
import { parseRunnerConfig, resolveTarget, buildPrompt, parseClaudeOutput, isValidClaudeSessionId } from '../bin/relay-runner.mjs';

describe('parseRunnerConfig', () => {
  test('parses a full config', () => {
    const cfg = parseRunnerConfig(
      JSON.stringify({
        host: 'cam-desktop',
        concurrency: 1,
        targets: [{ id: 'relay', label: 'relay app', cwd: 'C:/repos/relay', permissionMode: 'acceptEdits' }],
      }),
    );
    expect(cfg.host).toBe('cam-desktop');
    expect(cfg.concurrency).toBe(1);
    expect(cfg.targets).toEqual([{ id: 'relay', label: 'relay app', cwd: 'C:/repos/relay', permissionMode: 'acceptEdits', promptPrefix: '' }]);
  });

  test('defaults permissionMode to "default" and promptPrefix to ""', () => {
    const cfg = parseRunnerConfig(JSON.stringify({ host: 'h', targets: [{ id: 'a', label: 'A', cwd: '/x' }] }));
    expect(cfg.targets[0].permissionMode).toBe('default');
    expect(cfg.targets[0].promptPrefix).toBe('');
  });

  test('defaults concurrency to 1 when absent/invalid', () => {
    const cfg = parseRunnerConfig(JSON.stringify({ host: 'h', targets: [{ id: 'a', label: 'A', cwd: '/x' }], concurrency: 0 }));
    expect(cfg.concurrency).toBe(1);
  });

  test('throws on invalid JSON', () => {
    expect(() => parseRunnerConfig('{not json')).toThrow();
  });

  test('throws on a non-object', () => {
    expect(() => parseRunnerConfig('"just a string"')).toThrow();
  });

  test('throws when targets is missing or empty', () => {
    expect(() => parseRunnerConfig(JSON.stringify({ host: 'h', targets: [] }))).toThrow(/targets/);
    expect(() => parseRunnerConfig(JSON.stringify({ host: 'h' }))).toThrow(/targets/);
  });

  test('throws on a target missing cwd', () => {
    expect(() => parseRunnerConfig(JSON.stringify({ host: 'h', targets: [{ id: 'a', label: 'A' }] }))).toThrow(/cwd/);
  });

  test('throws on a target missing label', () => {
    expect(() => parseRunnerConfig(JSON.stringify({ host: 'h', targets: [{ id: 'a', cwd: '/x' }] }))).toThrow(/label/);
  });

  test('throws on a duplicate target id', () => {
    const raw = JSON.stringify({
      host: 'h',
      targets: [
        { id: 'a', label: 'A', cwd: '/x' },
        { id: 'a', label: 'A2', cwd: '/y' },
      ],
    });
    expect(() => parseRunnerConfig(raw)).toThrow(/duplicate/);
  });
});

describe('resolveTarget', () => {
  const cfg = parseRunnerConfig(
    JSON.stringify({ host: 'h', targets: [{ id: 'relay', label: 'relay app', cwd: '/repos/relay' }, { id: 'notes', label: 'notes', cwd: '/repos/notes' }] }),
  );

  test('finds a target by id', () => {
    expect(resolveTarget(cfg, 'notes')?.cwd).toBe('/repos/notes');
  });

  test('returns null for an unknown id', () => {
    expect(resolveTarget(cfg, 'nope')).toBeNull();
  });
});

describe('buildPrompt', () => {
  test('uses the target promptPrefix when set', () => {
    const target = { id: 'notes', label: 'notes', cwd: '/x', promptPrefix: 'Custom prefix.\n\n' };
    const p = buildPrompt(target, '/jobs/1/brainstorm.md');
    expect(p.startsWith('Custom prefix.')).toBe(true);
    expect(p).toContain('/jobs/1/brainstorm.md');
  });

  test('falls back to the default triage preamble when promptPrefix is empty', () => {
    const target = { id: 'notes', label: 'notes', cwd: '/x', promptPrefix: '' };
    const p = buildPrompt(target, '/jobs/1/brainstorm.md');
    expect(p).toContain('Triage this phone brainstorm');
  });
});

describe('parseClaudeOutput', () => {
  test('parses a clean JSON envelope', () => {
    const out = parseClaudeOutput(JSON.stringify({ result: 'did the thing', session_id: 'sess-1' }));
    expect(out).toEqual({ result: 'did the thing', sessionId: 'sess-1' });
  });

  test('finds the last valid JSON line among noise', () => {
    const out = parseClaudeOutput('some log line\n' + JSON.stringify({ result: 'ok', session_id: 's1' }));
    expect(out.result).toBe('ok');
    expect(out.sessionId).toBe('s1');
  });

  test('falls back to the raw tail on totally unparseable output', () => {
    const out = parseClaudeOutput('not json at all, just prose from a crash');
    expect(out.sessionId).toBeNull();
    expect(out.result).toContain('prose from a crash');
  });

  test('treats empty stdout as "(no output)"', () => {
    expect(parseClaudeOutput('')).toEqual({ result: '(no output)', sessionId: null });
    expect(parseClaudeOutput('   ')).toEqual({ result: '(no output)', sessionId: null });
  });

  test('a JSON envelope with a non-string result falls back to the stringified object', () => {
    const out = parseClaudeOutput(JSON.stringify({ session_id: 's1', other: 'field' }));
    expect(out.sessionId).toBe('s1');
    expect(out.result).toContain('other');
  });
});

// Regression coverage for the review finding: `dispatches.claude_session` is DB-sourced (echoed
// back for --resume) but still reaches spawn's argv under shell:true on win32 (runClaude). A
// compromised server/DB must not be able to smuggle shell metacharacters through this field into
// arbitrary command execution — handleDispatch calls this guard on every d.claude_session before
// it goes anywhere near runClaude/spawn.
describe('isValidClaudeSessionId', () => {
  test('accepts a realistic UUID-shaped session id', () => {
    expect(isValidClaudeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test('accepts plain alphanumeric/underscore ids', () => {
    expect(isValidClaudeSessionId('abc123_XYZ-9')).toBe(true);
  });

  test('rejects shell metacharacter payloads (cmd.exe injection attempt)', () => {
    expect(isValidClaudeSessionId('x & calc.exe &')).toBe(false);
    expect(isValidClaudeSessionId('a"; rm -rf ~ #')).toBe(false);
    expect(isValidClaudeSessionId('$(whoami)')).toBe(false);
    expect(isValidClaudeSessionId('a|b')).toBe(false);
    expect(isValidClaudeSessionId('a\nb')).toBe(false);
    expect(isValidClaudeSessionId('a b')).toBe(false); // spaces alone can break unquoted argv too
  });

  test('rejects non-strings, empty string, and oversized ids', () => {
    expect(isValidClaudeSessionId(null)).toBe(false);
    expect(isValidClaudeSessionId(undefined)).toBe(false);
    expect(isValidClaudeSessionId(123)).toBe(false);
    expect(isValidClaudeSessionId('')).toBe(false);
    expect(isValidClaudeSessionId('a'.repeat(201))).toBe(false);
    expect(isValidClaudeSessionId('a'.repeat(200))).toBe(true);
  });
});
