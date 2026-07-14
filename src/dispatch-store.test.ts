// Run with: DB_PATH=:memory: bun test (the test script sets DB_PATH so store.ts opens an
// in-memory DB and never touches a real volume).
import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { db } from './store.ts';
import {
  ensureDispatchSchema,
  DISPATCH_BODY_MAX,
  validateDispatchInput,
  validateStatusUpdate,
  validateTargetsInput,
  decodeDispatchAssets,
  getDispatchAsset,
  MAX_DISPATCH_ASSETS,
  DISPATCH_ASSET_MAX_BYTES,
  createDispatch,
  getDispatch,
  listDispatches,
  nextQueued,
  claimDispatch,
  updateDispatchStatus,
  cancelDispatch,
  replaceTargetsForHost,
  listTargets,
  latestDispatchIdBySession,
  pruneDispatches,
  __resetForTests,
} from './dispatch-store.ts';

beforeAll(() => {
  ensureDispatchSchema();
});
beforeEach(() => {
  __resetForTests();
});

function makeQueued(over: Partial<{ title: string | null; body: string; target: string; resume_of: string | null }> = {}) {
  const v = validateDispatchInput({ body: 'hello', target: 't1', ...over });
  if (!v.ok) throw new Error(v.error);
  const created = createDispatch(v.value);
  if (!created.ok) throw new Error(created.error);
  return created.value;
}

describe('validateDispatchInput', () => {
  test('accepts body + target only', () => {
    const r = validateDispatchInput({ body: 'brainstorm text', target: 'notes' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBeNull();
      expect(r.value.resume_of).toBeNull();
    }
  });
  test('rejects missing body', () => {
    const r = validateDispatchInput({ target: 'notes' });
    expect(r.ok).toBe(false);
  });
  test('rejects blank body', () => {
    const r = validateDispatchInput({ body: '   ', target: 'notes' });
    expect(r.ok).toBe(false);
  });
  test('rejects missing target', () => {
    const r = validateDispatchInput({ body: 'x' });
    expect(r.ok).toBe(false);
  });
  test('rejects a body over the cap', () => {
    const r = validateDispatchInput({ body: 'x'.repeat(DISPATCH_BODY_MAX + 1), target: 'notes' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('exceeds');
  });
  test('rejects a non-object body', () => {
    const r = validateDispatchInput('nope');
    expect(r.ok).toBe(false);
  });
});

describe('validateStatusUpdate', () => {
  test('accepts running with no extra fields', () => {
    const r = validateStatusUpdate({ status: 'running' });
    expect(r.ok).toBe(true);
  });
  test('rejects an unknown status', () => {
    const r = validateStatusUpdate({ status: 'queued' });
    expect(r.ok).toBe(false);
  });
  test('rejects a non-object body', () => {
    const r = validateStatusUpdate(null);
    expect(r.ok).toBe(false);
  });
});

describe('validateTargetsInput', () => {
  test('accepts a valid host + targets list', () => {
    const r = validateTargetsInput({ host: 'cam-desktop', targets: [{ id: 'relay', label: 'relay app' }] });
    expect(r.ok).toBe(true);
  });
  test('rejects missing host', () => {
    const r = validateTargetsInput({ targets: [] });
    expect(r.ok).toBe(false);
  });
  test('rejects a non-array targets field', () => {
    const r = validateTargetsInput({ host: 'h', targets: 'nope' });
    expect(r.ok).toBe(false);
  });
  test('rejects a duplicate target id', () => {
    const r = validateTargetsInput({
      host: 'h',
      targets: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'A again' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('duplicate');
  });
});

describe('createDispatch / getDispatch', () => {
  test('creates a queued dispatch with no session/claude fields', () => {
    const d = makeQueued();
    expect(d.status).toBe('queued');
    expect(d.claude_session).toBeNull();
    expect(d.runner_host).toBeNull();
    expect(getDispatch(d.id)?.id).toBe(d.id);
  });

  test('resume_of on a dispatch that does not exist is rejected', () => {
    const v = validateDispatchInput({ body: 'follow up', target: 't1', resume_of: 'nope' });
    if (!v.ok) throw new Error(v.error);
    const created = createDispatch(v.value);
    expect(created.ok).toBe(false);
  });

  test('resume_of on a non-done parent is rejected', () => {
    const parent = makeQueued();
    const v = validateDispatchInput({ body: 'follow up', target: 't1', resume_of: parent.id });
    if (!v.ok) throw new Error(v.error);
    const created = createDispatch(v.value);
    expect(created.ok).toBe(false);
  });

  test('resume_of on a done parent with a session copies claude_session onto the child', () => {
    const parent = makeQueued();
    claimDispatch(parent.id, 'host1');
    updateDispatchStatus(parent.id, { status: 'running', claude_session: null, result_summary: null, result_card_id: null });
    updateDispatchStatus(parent.id, { status: 'done', claude_session: 'sess-abc', result_summary: 'did it', result_card_id: 'card1' });

    const v = validateDispatchInput({ body: 'follow up', target: 't1', resume_of: parent.id });
    if (!v.ok) throw new Error(v.error);
    const created = createDispatch(v.value);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.claude_session).toBe('sess-abc');
      expect(created.value.resume_of).toBe(parent.id);
      expect(created.value.status).toBe('queued'); // the child is a fresh job, not auto-run
    }
  });
});

describe('listDispatches', () => {
  test('lists everything and filters by status', () => {
    const a = makeQueued({ body: 'a' });
    const b = makeQueued({ body: 'b' });
    claimDispatch(b.id, 'host1');
    const all = listDispatches({});
    expect(all.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
    expect(all).toHaveLength(2);
    const queuedOnly = listDispatches({ status: 'queued' });
    expect(queuedOnly.map((d) => d.id)).toEqual([a.id]);
    const claimedOnly = listDispatches({ status: 'claimed' });
    expect(claimedOnly.map((d) => d.id)).toEqual([b.id]);
  });

  test('newest first when created_at differs', async () => {
    const a = makeQueued({ body: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    const b = makeQueued({ body: 'second' });
    expect(listDispatches({}).map((d) => d.id)).toEqual([b.id, a.id]);
  });
});

describe('nextQueued', () => {
  test('returns the oldest queued row', async () => {
    const a = makeQueued({ body: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    makeQueued({ body: 'second' });
    expect(nextQueued()?.id).toBe(a.id);
  });

  test('returns null when nothing is queued', () => {
    expect(nextQueued()).toBeNull();
  });
});

describe('claimDispatch — atomicity', () => {
  test('two claims on the same dispatch: exactly one wins', () => {
    const d = makeQueued();
    const r1 = claimDispatch(d.id, 'host1');
    const r2 = claimDispatch(d.id, 'host2');
    const results = [r1.status, r2.status].sort();
    expect(results).toEqual(['claimed', 'conflict']);
    // the winner is recorded — the loser's host never lands in the row
    const won = r1.status === 'claimed' ? r1 : (r2 as any);
    expect(won.dispatch.runner_host).toBe(won === r1 ? 'host1' : 'host2');
  });

  test('claiming an unknown id is notfound', () => {
    expect(claimDispatch('nope', 'host1').status).toBe('notfound');
  });

  test('claiming an already-claimed dispatch is a conflict', () => {
    const d = makeQueued();
    claimDispatch(d.id, 'host1');
    expect(claimDispatch(d.id, 'host2').status).toBe('conflict');
  });
});

describe('updateDispatchStatus — legal transitions', () => {
  test('claimed -> running -> done is legal and sets finished_at', () => {
    const d = makeQueued();
    claimDispatch(d.id, 'host1');
    const r1 = updateDispatchStatus(d.id, { status: 'running', claude_session: null, result_summary: null, result_card_id: null });
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.finished_at).toBeNull();
    const r2 = updateDispatchStatus(d.id, { status: 'done', claude_session: 'sess-1', result_summary: 'ok', result_card_id: 'c1' });
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value.status).toBe('done');
      expect(r2.value.finished_at).not.toBeNull();
      expect(r2.value.claude_session).toBe('sess-1');
    }
  });

  test('claimed -> failed is legal (unknown target, never ran)', () => {
    const d = makeQueued();
    claimDispatch(d.id, 'host1');
    const r = updateDispatchStatus(d.id, { status: 'failed', claude_session: null, result_summary: 'unknown target', result_card_id: null });
    expect(r.ok).toBe(true);
  });

  test('queued -> running is illegal (must claim first)', () => {
    const d = makeQueued();
    const r = updateDispatchStatus(d.id, { status: 'running', claude_session: null, result_summary: null, result_card_id: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('illegal transition');
  });

  test('done -> running is illegal (terminal state)', () => {
    const d = makeQueued();
    claimDispatch(d.id, 'host1');
    updateDispatchStatus(d.id, { status: 'running', claude_session: null, result_summary: null, result_card_id: null });
    updateDispatchStatus(d.id, { status: 'done', claude_session: null, result_summary: null, result_card_id: null });
    const r = updateDispatchStatus(d.id, { status: 'running', claude_session: null, result_summary: null, result_card_id: null });
    expect(r.ok).toBe(false);
  });

  test('updating an unknown id is not found', () => {
    const r = updateDispatchStatus('nope', { status: 'running', claude_session: null, result_summary: null, result_card_id: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not found');
  });

  test('a later update without result_summary does not blank out an earlier one', () => {
    const d = makeQueued();
    claimDispatch(d.id, 'host1');
    updateDispatchStatus(d.id, { status: 'running', claude_session: 'sess-1', result_summary: null, result_card_id: null });
    const r = updateDispatchStatus(d.id, { status: 'done', claude_session: null, result_summary: 'final summary', result_card_id: null });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.claude_session).toBe('sess-1'); // preserved via COALESCE
      expect(r.value.result_summary).toBe('final summary');
    }
  });
});

describe('latestDispatchIdBySession (relay-roadmap Plan 03 — Sessions dashboard linkage)', () => {
  test('a dispatch with no claude_session set is never in the map', () => {
    makeQueued(); // claude_session stays null until claimed+running reports one
    expect(latestDispatchIdBySession().size).toBe(0);
  });

  test('a running/done dispatch with a reported claude_session is linked', () => {
    const d = makeQueued();
    claimDispatch(d.id, 'host1');
    updateDispatchStatus(d.id, { status: 'running', claude_session: 'sess-1', result_summary: null, result_card_id: null });
    const map = latestDispatchIdBySession();
    expect(map.get('sess-1')).toBe(d.id);
  });

  test('two dispatches sharing a session (a resumed follow-up) resolve to the newest', async () => {
    const first = makeQueued();
    claimDispatch(first.id, 'host1');
    updateDispatchStatus(first.id, { status: 'running', claude_session: 'sess-shared', result_summary: null, result_card_id: null });
    updateDispatchStatus(first.id, { status: 'done', claude_session: null, result_summary: 'done', result_card_id: null });

    await new Promise((r) => setTimeout(r, 3)); // ensure a distinct created_at ordering

    const followUp = makeQueued({ resume_of: first.id }); // createDispatch copies the parent's claude_session
    expect(followUp.claude_session).toBe('sess-shared');

    const map = latestDispatchIdBySession();
    expect(map.get('sess-shared')).toBe(followUp.id); // newest wins
  });
});

describe('cancelDispatch', () => {
  test('cancels a queued dispatch', () => {
    const d = makeQueued();
    expect(cancelDispatch(d.id).status).toBe('cancelled');
    expect(getDispatch(d.id)?.status).toBe('cancelled');
  });
  test('cannot cancel a claimed dispatch (v1 limitation)', () => {
    const d = makeQueued();
    claimDispatch(d.id, 'host1');
    expect(cancelDispatch(d.id).status).toBe('notcancellable');
  });
  test('cancelling an unknown id is notfound', () => {
    expect(cancelDispatch('nope').status).toBe('notfound');
  });
});

describe('targets', () => {
  test('replaceTargetsForHost is wholesale — dropping a target removes it', () => {
    replaceTargetsForHost('host1', [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ]);
    expect(listTargets().map((t) => t.id).sort()).toEqual(['a', 'b']);
    replaceTargetsForHost('host1', [{ id: 'a', label: 'A' }]);
    expect(listTargets().map((t) => t.id).sort()).toEqual(['a']);
  });

  test('listTargets unions across hosts, de-duped by id', () => {
    replaceTargetsForHost('host1', [{ id: 'shared', label: 'from host1' }]);
    replaceTargetsForHost('host2', [{ id: 'shared', label: 'from host2' }, { id: 'only-host2', label: 'Only host2' }]);
    const ids = listTargets().map((t) => t.id).sort();
    expect(ids).toEqual(['only-host2', 'shared']);
  });

  test('listTargets returns host + updatedAt (ISO string) alongside id/label', () => {
    replaceTargetsForHost('host1', [{ id: 'a', label: 'A' }]);
    const [t] = listTargets();
    expect(t.id).toBe('a');
    expect(t.label).toBe('A');
    expect(t.host).toBe('host1');
    expect(typeof t.updatedAt).toBe('string');
    expect(new Date(t.updatedAt!).toString()).not.toBe('Invalid Date');
  });

  test('listTargets picks host/label from the SAME row as the winning MAX(updated_at)', () => {
    // host2 announces 'shared' strictly after host1 — the surviving row (host, label, updatedAt)
    // must all come from host2's row, not a mix of host1's label with host2's timestamp. Backdate
    // host1's row explicitly (rather than relying on wall-clock ordering between two calls) so the
    // MAX(updated_at) winner is deterministic.
    replaceTargetsForHost('host1', [{ id: 'shared', label: 'from host1' }]);
    db.query("UPDATE dispatch_targets SET updated_at = '2020-01-01T00:00:00.000Z' WHERE host = 'host1'").run();
    replaceTargetsForHost('host2', [{ id: 'shared', label: 'from host2' }]);
    const [t] = listTargets();
    expect(t.host).toBe('host2');
    expect(t.label).toBe('from host2');
  });
});

describe('pruneDispatches — retention', () => {
  test('deletes terminal dispatches past the retention window; leaves recent + non-terminal alone', () => {
    const old = makeQueued({ body: 'old' });
    claimDispatch(old.id, 'host1');
    updateDispatchStatus(old.id, { status: 'running', claude_session: null, result_summary: null, result_card_id: null });
    updateDispatchStatus(old.id, { status: 'done', claude_session: null, result_summary: null, result_card_id: null });
    // Backdate finished_at past the retention window directly (bypassing the store's own clock).
    const ancient = new Date(Date.now() - 400 * 86_400_000).toISOString();
    db.query('UPDATE dispatches SET finished_at = $t WHERE id = $id').run({ $t: ancient, $id: old.id });

    const recent = makeQueued({ body: 'recent' }); // still queued — never pruned regardless of age

    pruneDispatches();
    expect(getDispatch(old.id)).toBeNull();
    expect(getDispatch(recent.id)).not.toBeNull();
  });
});

// --- attachments (phone -> runner upload) ----------------------------------

const B64_HI = Buffer.from('hi').toString('base64'); // small, non-empty payload

describe('decodeDispatchAssets', () => {
  test('returns [] for undefined/null (no assets is legal)', () => {
    const a = decodeDispatchAssets(undefined);
    const b = decodeDispatchAssets(null);
    expect(a.ok && a.value).toEqual([]);
    expect(b.ok && b.value).toEqual([]);
  });

  test('decodes a valid asset to bytes', () => {
    const r = decodeDispatchAssets([{ filename: 'note.txt', mime: 'text/plain', data: B64_HI }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0].filename).toBe('note.txt');
      expect(r.value[0].mime).toBe('text/plain');
      expect(Buffer.from(r.value[0].bytes).toString('utf8')).toBe('hi');
    }
  });

  test('accepts a non-image mime (files, not just pictures)', () => {
    const r = decodeDispatchAssets([{ filename: 'a.pdf', mime: 'application/pdf', data: B64_HI }]);
    expect(r.ok).toBe(true);
  });

  test('rejects a non-array', () => {
    expect(decodeDispatchAssets('nope').ok).toBe(false);
  });

  test('rejects more than the max count', () => {
    const many = Array.from({ length: MAX_DISPATCH_ASSETS + 1 }, (_, i) => ({ filename: `f${i}`, mime: 'text/plain', data: B64_HI }));
    const r = decodeDispatchAssets(many);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('too many');
  });

  test('rejects a missing filename or mime', () => {
    expect(decodeDispatchAssets([{ mime: 'text/plain', data: B64_HI }]).ok).toBe(false);
    expect(decodeDispatchAssets([{ filename: 'x', data: B64_HI }]).ok).toBe(false);
  });

  test('rejects missing/empty data', () => {
    expect(decodeDispatchAssets([{ filename: 'x', mime: 'text/plain' }]).ok).toBe(false);
    expect(decodeDispatchAssets([{ filename: 'x', mime: 'text/plain', data: '' }]).ok).toBe(false);
  });

  test('rejects an oversized asset with an "exceeds" error (route maps that to 413)', () => {
    const big = Buffer.alloc(DISPATCH_ASSET_MAX_BYTES + 1, 0x41).toString('base64');
    const r = decodeDispatchAssets([{ filename: 'big.bin', mime: 'application/octet-stream', data: big }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('exceeds');
  });
});

describe('createDispatch with assets', () => {
  test('persists assets, hydrates metadata (no bytes), and serves bytes via getDispatchAsset', () => {
    const v = validateDispatchInput({ body: 'see attached', target: 't1' });
    if (!v.ok) throw new Error(v.error);
    const decoded = decodeDispatchAssets([
      { filename: 'photo.png', mime: 'image/png', data: B64_HI },
      { filename: 'log.txt', mime: 'text/plain', data: Buffer.from('log line').toString('base64') },
    ]);
    if (!decoded.ok) throw new Error(decoded.error);
    const created = createDispatch(v.value, decoded.value);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // hydrate returns metadata only — id/filename/mime, never bytes
    expect(created.value.assets).toHaveLength(2);
    expect(created.value.assets[0]).toMatchObject({ filename: 'photo.png', mime: 'image/png' });
    expect(created.value.assets[0].id).toBeTruthy();
    expect((created.value.assets[0] as any).bytes).toBeUndefined();

    // getDispatch round-trips the same metadata
    const fetched = getDispatch(created.value.id);
    expect(fetched?.assets).toHaveLength(2);

    // bytes fetched separately, scoped by dispatch id
    const aid = created.value.assets[1].id;
    const bytes = getDispatchAsset(created.value.id, aid);
    expect(bytes?.filename).toBe('log.txt');
    expect(Buffer.from(bytes!.bytes).toString('utf8')).toBe('log line');

    // wrong dispatch id must not dereference a real asset id
    expect(getDispatchAsset('someone-elses-dispatch', aid)).toBeNull();
  });

  test('a dispatch with no assets hydrates to an empty array', () => {
    const v = validateDispatchInput({ body: 'plain', target: 't1' });
    if (!v.ok) throw new Error(v.error);
    const created = createDispatch(v.value);
    expect(created.ok && created.value.assets).toEqual([]);
  });
});
