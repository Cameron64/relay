// Run with: DB_PATH=:memory: bun test  (the test script sets DB_PATH so store.ts opens an
// in-memory DB and never touches a real volume).
import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  ensureNotifyLogSchema,
  notifyLogReady,
  recordNotify,
  listNotifications,
  pruneNotifyLog,
  __resetForTests,
} from './notify-log.ts';
// @ts-ignore — zero-dep .mjs lib has no .d.ts; these are plain pure functions.
import { projectFromCwd, classifyNotification } from '../lib/relay-lib.mjs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function entry(over: Partial<Parameters<typeof recordNotify>[0]> = {}) {
  return {
    source: 'notification',
    title: 'Claude Code · relay',
    body: 'Claude is waiting for your input',
    tag: 'relay-attn',
    url: '/',
    sessionId: 'sess-123',
    cwd: 'C:/Users/x/relay',
    project: 'relay',
    host: 'DESKTOP',
    event: 'idle',
    cardId: null,
    sent: 1,
    failed: 0,
    subscribers: 1,
    ...over,
  };
}

beforeAll(() => {
  ensureNotifyLogSchema();
});
beforeEach(() => {
  __resetForTests();
});

describe('schema', () => {
  test('ensureNotifyLogSchema marks the log ready', () => {
    expect(notifyLogReady()).toBe(true);
  });
});

describe('recordNotify + listNotifications', () => {
  test('records a row and reads it back with all fields', () => {
    const id = recordNotify(entry());
    expect(id).toBeTruthy();
    const rows = listNotifications();
    expect(rows.length).toBe(1);
    const r = rows[0];
    expect(r.id).toBe(id!);
    expect(r.source).toBe('notification');
    expect(r.session_id).toBe('sess-123');
    expect(r.project).toBe('relay');
    expect(r.event).toBe('idle');
    expect(r.card_id).toBeNull();
    expect(r.sent).toBe(1);
    expect(r.subscribers).toBe(1);
    expect(r.delivered).toBe(1); // default — actually pushed
  });

  test('delivered:false records a silenced (logged-but-not-pushed) row', () => {
    recordNotify(entry({ delivered: false, sent: 0, subscribers: 0 }));
    const r = listNotifications()[0];
    expect(r.delivered).toBe(0);
    expect(r.event).toBe('idle');
  });

  test('coerces an unknown source to "unknown"', () => {
    recordNotify(entry({ source: 'haxor' as any }));
    expect(listNotifications()[0].source).toBe('unknown');
  });

  test('falls back to "(untitled)" / empty body for missing text', () => {
    recordNotify(entry({ title: '' as any, body: '' as any }));
    const r = listNotifications()[0];
    expect(r.title).toBe('(untitled)');
    expect(r.body).toBe('');
  });

  test('coerces negative / non-numeric counts to 0', () => {
    recordNotify(entry({ sent: -5 as any, failed: 'x' as any, subscribers: undefined }));
    const r = listNotifications()[0];
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.subscribers).toBe(0);
  });

  test('returns newest first', async () => {
    recordNotify(entry({ title: 'first' }));
    await sleep(3);
    recordNotify(entry({ title: 'second' }));
    await sleep(3);
    recordNotify(entry({ title: 'third' }));
    const titles = listNotifications().map((r) => r.title);
    expect(titles).toEqual(['third', 'second', 'first']);
  });

  test('honors the limit (capped 1..500)', () => {
    for (let i = 0; i < 5; i++) recordNotify(entry({ title: 't' + i }));
    expect(listNotifications({ limit: 2 }).length).toBe(2);
  });

  test('a card push records card_id (actionable)', () => {
    recordNotify(entry({ source: 'card', event: 'approval', cardId: 'abc123' }));
    const r = listNotifications()[0];
    expect(r.source).toBe('card');
    expect(r.card_id).toBe('abc123');
  });
});

describe('pruneNotifyLog', () => {
  afterEach(() => {
    delete process.env.NOTIFY_LOG_MAX;
  });
  test('trims to the most recent NOTIFY_LOG_MAX rows', async () => {
    process.env.NOTIFY_LOG_MAX = '3';
    for (let i = 0; i < 5; i++) {
      recordNotify(entry({ title: 'n' + i }));
      await sleep(2);
    }
    pruneNotifyLog();
    const rows = listNotifications();
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.title)).toEqual(['n4', 'n3', 'n2']); // newest 3 survive
  });
});

describe('projectFromCwd', () => {
  test('basename of a Windows path', () => {
    expect(projectFromCwd('C:\\Users\\Cam\\source\\repos\\relay')).toBe('relay');
  });
  test('basename of a POSIX path', () => {
    expect(projectFromCwd('/home/cam/source/relay')).toBe('relay');
  });
  test('ignores a trailing slash', () => {
    expect(projectFromCwd('/home/cam/relay/')).toBe('relay');
    expect(projectFromCwd('C:\\a\\relay\\')).toBe('relay');
  });
  test('null for empty/invalid input', () => {
    expect(projectFromCwd('')).toBeNull();
    expect(projectFromCwd(null)).toBeNull();
    expect(projectFromCwd(undefined)).toBeNull();
  });
});

describe('classifyNotification', () => {
  test('idle: waiting-for-input nudge', () => {
    expect(classifyNotification('Claude is waiting for your input')).toBe('idle');
  });
  test('permission: tool approval', () => {
    expect(classifyNotification('Claude needs your permission to use Bash')).toBe('permission');
  });
  test('other: anything else', () => {
    expect(classifyNotification('Build finished')).toBe('other');
    expect(classifyNotification('')).toBe('other');
  });
});
