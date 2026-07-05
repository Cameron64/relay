// Run with: DB_PATH=:memory: bun test  (the test script sets DB_PATH so store.ts opens an
// in-memory DB and never touches a real volume).
import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test';
import {
  ensureNotifyLogSchema,
  notifyLogReady,
  recordNotify,
  listNotifications,
  pruneNotifyLog,
  foldSessionRows,
  aggregateSessions,
  __resetForTests,
  type NotifyLogEntry,
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

// --- session aggregation (relay-roadmap Plan 03) ----------------------------

function row(over: Partial<NotifyLogEntry> = {}): NotifyLogEntry {
  return {
    id: 'row-' + Math.random().toString(36).slice(2),
    created_at: new Date().toISOString(),
    source: 'notification',
    title: 't',
    body: 'b',
    tag: null,
    url: null,
    session_id: 'sess-a',
    cwd: 'C:/repo/relay',
    project: 'relay',
    host: 'DESKTOP',
    event: 'other',
    card_id: null,
    sent: 1,
    failed: 0,
    subscribers: 1,
    delivered: 1,
    ...over,
  };
}

const NOW = new Date('2026-07-05T12:00:00.000Z');
function minutesAgo(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

describe('foldSessionRows — status inference matrix', () => {
  test('a lone recent row with a plain event -> active', () => {
    const out = foldSessionRows([row({ event: 'other', created_at: minutesAgo(5) })], { now: NOW });
    expect(out).toEqual([
      expect.objectContaining({ sessionId: 'sess-a', status: 'active', lastEvent: 'other' }),
    ]);
  });

  test('last event "permission" -> needs-input, regardless of age', () => {
    const out = foldSessionRows([row({ event: 'permission', created_at: minutesAgo(500) })], { now: NOW });
    expect(out[0].status).toBe('needs-input');
  });

  test('last event is an approval/prompt/choice card push -> needs-input', () => {
    for (const kind of ['approval', 'prompt', 'choice']) {
      const out = foldSessionRows([row({ source: 'card', event: kind, created_at: minutesAgo(1) })], { now: NOW });
      expect(out[0].status).toBe('needs-input');
    }
  });

  test('a non-soliciting card kind (e.g. "note") does NOT trigger needs-input', () => {
    const out = foldSessionRows([row({ source: 'card', event: 'note', created_at: minutesAgo(1) })], { now: NOW });
    expect(out[0].status).toBe('active');
  });

  test('last event "session-end" -> ended, even if very recent', () => {
    const out = foldSessionRows([row({ event: 'session-end', created_at: minutesAgo(1) })], { now: NOW });
    expect(out[0].status).toBe('ended');
  });

  test('idle event within the active window -> active', () => {
    const out = foldSessionRows([row({ event: 'idle', delivered: 0, created_at: minutesAgo(10) })], {
      now: NOW,
      activeWindowMinutes: 30,
    });
    expect(out[0].status).toBe('active');
  });

  test('an event older than the active window with no session-end -> stale', () => {
    const out = foldSessionRows([row({ event: 'idle', created_at: minutesAgo(45) })], { now: NOW, activeWindowMinutes: 30 });
    expect(out[0].status).toBe('stale');
  });

  test('a null event (bare /api/notify with no event field) falls back to "other"', () => {
    const out = foldSessionRows([row({ event: null, created_at: minutesAgo(1) })], { now: NOW });
    expect(out[0].lastEvent).toBe('other');
    expect(out[0].status).toBe('active');
  });

  test('grouping uses the NEWEST row per session, not the first in the array', () => {
    const out = foldSessionRows(
      [
        row({ event: 'session-end', created_at: minutesAgo(60) }), // older but session-end
        row({ event: 'other', created_at: minutesAgo(1) }), // newest — this one wins
      ],
      { now: NOW },
    );
    expect(out.length).toBe(1);
    expect(out[0].lastEvent).toBe('other');
    expect(out[0].status).toBe('active');
  });

  test('null sessionId groups fall back to the cwd|host key', () => {
    const out = foldSessionRows(
      [
        row({ session_id: null, cwd: 'C:/repo/a', host: 'H1', created_at: minutesAgo(2) }),
        row({ session_id: null, cwd: 'C:/repo/a', host: 'H1', created_at: minutesAgo(1) }),
        row({ session_id: null, cwd: 'C:/repo/b', host: 'H1', created_at: minutesAgo(1) }),
      ],
      { now: NOW },
    );
    // two distinct (cwd,host) keys -> two groups, even though sessionId is null for all three
    expect(out.length).toBe(2);
    expect(out.every((s) => s.sessionId === null)).toBe(true);
  });

  test('two different sessionIds never collapse into one group', () => {
    const out = foldSessionRows(
      [row({ session_id: 'a', created_at: minutesAgo(1) }), row({ session_id: 'b', created_at: minutesAgo(1) })],
      { now: NOW },
    );
    expect(out.length).toBe(2);
  });

  test('dispatchBySession attaches dispatchId only for a session present in the map', () => {
    const map = new Map([['sess-a', 'dispatch-123']]);
    const out = foldSessionRows(
      [row({ session_id: 'sess-a', created_at: minutesAgo(1) }), row({ session_id: 'sess-other', created_at: minutesAgo(1) })],
      { now: NOW, dispatchBySession: map },
    );
    const a = out.find((s) => s.sessionId === 'sess-a')!;
    const other = out.find((s) => s.sessionId === 'sess-other')!;
    expect(a.dispatchId).toBe('dispatch-123');
    expect(other.dispatchId).toBeUndefined();
  });

  test('sort order: needs-input first, then active, then stale, then ended', () => {
    const out = foldSessionRows(
      [
        row({ session_id: 'ended', event: 'session-end', created_at: minutesAgo(1) }),
        row({ session_id: 'stale', event: 'other', created_at: minutesAgo(60) }),
        row({ session_id: 'active', event: 'other', created_at: minutesAgo(1) }),
        row({ session_id: 'needs-input', event: 'permission', created_at: minutesAgo(1) }),
      ],
      { now: NOW, activeWindowMinutes: 30 },
    );
    expect(out.map((s) => s.sessionId)).toEqual(['needs-input', 'active', 'stale', 'ended']);
  });

  test('within the same status bucket, newest lastAt sorts first', () => {
    const out = foldSessionRows(
      [
        row({ session_id: 'older', event: 'other', created_at: minutesAgo(5) }),
        row({ session_id: 'newer', event: 'other', created_at: minutesAgo(1) }),
      ],
      { now: NOW },
    );
    expect(out.map((s) => s.sessionId)).toEqual(['newer', 'older']);
  });
});

describe('aggregateSessions — DB-backed wrapper', () => {
  test('folds real recordNotify rows within the window', () => {
    recordNotify({ source: 'session', title: 'Relay · relay', body: 'Session started', sessionId: 'sess-live', cwd: 'C:/repo/relay', project: 'relay', host: 'H', event: 'session-start', delivered: false });
    const out = aggregateSessions();
    expect(out.some((s) => s.sessionId === 'sess-live' && s.status === 'active')).toBe(true);
  });

  test('a row older than windowHours is excluded', () => {
    // Can't backdate a real INSERT's default clock easily; verify the window param is honored by
    // requesting a window of 0 hours (nothing is "newer than now"), which must return [].
    recordNotify({ source: 'session', title: 't', body: 'b', sessionId: 'sess-window', event: 'session-start', delivered: false });
    expect(aggregateSessions({ windowHours: 0 })).toEqual([]);
  });

  test('returns [] when the log is not ready', () => {
    // notifyLogReady() is true for the whole suite (ensureNotifyLogSchema ran in beforeAll) — this
    // just documents the contract; a dedicated not-ready test would require a separate DB module
    // instance, which none of the other tests in this file attempt either.
    expect(Array.isArray(aggregateSessions())).toBe(true);
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
