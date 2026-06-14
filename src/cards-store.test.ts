// Run with: DB_PATH=:memory: bun test  (the test script sets DB_PATH so store.ts opens an
// in-memory DB and never touches a real volume).
import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { db } from './store.ts';
import {
  ensureCardsSchema,
  validateButtons,
  validateCardInput,
  createCard,
  getCard,
  respondCard,
  getAsset,
  pruneCards,
  __resetForTests,
} from './cards-store.ts';

beforeAll(() => {
  ensureCardsSchema();
});
beforeEach(() => {
  __resetForTests();
});

describe('validateButtons', () => {
  test('accepts a valid respond button', () => {
    const r = validateButtons([{ id: 'approved', label: 'Approve', behavior: 'respond', verdict: 'approved', style: 'primary' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].behavior).toBe('respond');
  });
  test('rejects unknown behavior', () => {
    const r = validateButtons([{ id: 'x', label: 'X', behavior: 'detonate' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('behavior');
  });
  test('rejects unknown style', () => {
    const r = validateButtons([{ id: 'x', label: 'X', behavior: 'respond', style: 'neon' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('style');
  });
  test('rejects unknown verdict', () => {
    const r = validateButtons([{ id: 'x', label: 'X', behavior: 'respond', verdict: 'maybe' }]);
    expect(r.ok).toBe(false);
  });
  test('rejects javascript: link value', () => {
    const r = validateButtons([{ id: 'l', label: 'go', behavior: 'link', value: 'javascript:alert(1)' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('http');
  });
  test('rejects data: link value', () => {
    const r = validateButtons([{ id: 'l', label: 'go', behavior: 'link', value: 'data:text/html,<x>' }]);
    expect(r.ok).toBe(false);
  });
  test('accepts https link value', () => {
    const r = validateButtons([{ id: 'l', label: 'go', behavior: 'link', value: 'https://example.com' }]);
    expect(r.ok).toBe(true);
  });
  test('rejects more than 10 buttons', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: 'b' + i, label: 'b' + i, behavior: 'respond' }));
    const r = validateButtons(many);
    expect(r.ok).toBe(false);
  });
});

describe('validateCardInput', () => {
  test('rejects unknown kind', () => {
    const r = validateCardInput({ kind: 'explosion', title: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('kind');
  });
  test('requires a title', () => {
    const r = validateCardInput({ kind: 'note' });
    expect(r.ok).toBe(false);
  });
  test('accepts a minimal note', () => {
    const r = validateCardInput({ title: 'hello' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('note');
  });
});

describe('respondCard — first-response-wins', () => {
  test('records verdict from the matching button, then 409s the second time', () => {
    const card = createCard({
      kind: 'approval',
      title: 'Approve?',
      body: null,
      buttons: [{ id: 'approved', label: 'Approve', behavior: 'respond', verdict: 'approved' }],
      copy_text: null,
      mermaid: null,
      source: null,
      priority: 'normal',
      expires_at: null,
    });
    const first = respondCard(card.id, { action: 'approved', note: 'lgtm' });
    expect(first.status).toBe('responded');
    if (first.status === 'responded') {
      expect(first.response.verdict).toBe('approved');
      expect(first.response.note).toBe('lgtm');
    }
    const second = respondCard(card.id, { action: 'changes_requested' });
    expect(second.status).toBe('conflict');
    if (second.status === 'conflict') expect(second.response?.verdict).toBe('approved'); // original preserved

    const fresh = getCard(card.id);
    expect(fresh?.status).toBe('responded');
    expect(fresh?.response?.verdict).toBe('approved');
  });

  test('custom action without a matching button records the raw action as verdict', () => {
    const card = createCard({
      kind: 'choice',
      title: 'Pick',
      body: null,
      buttons: [{ id: 'opt-a', label: 'A', behavior: 'respond', verdict: undefined as any }],
      copy_text: null,
      mermaid: null,
      source: null,
      priority: 'normal',
      expires_at: null,
    });
    const r = respondCard(card.id, { action: 'opt-a' });
    expect(r.status).toBe('responded');
    if (r.status === 'responded') expect(r.response.verdict).toBe('opt-a');
  });

  test('responding to a missing card returns notfound', () => {
    expect(respondCard('nope', { action: 'approved' }).status).toBe('notfound');
  });
});

describe('assets', () => {
  test('createCard stores assets and getAsset returns bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const card = createCard(
      { kind: 'image', title: 'shot', body: null, buttons: [], copy_text: null, mermaid: null, source: null, priority: 'normal', expires_at: null },
      [{ mime: 'image/png', bytes }],
    );
    expect(card.assets.length).toBe(1);
    const a = getAsset(card.id, card.assets[0].id);
    expect(a?.mime).toBe('image/png');
    expect(Array.from(a!.bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('pruneCards', () => {
  function insertOld(id: string, daysAgo: number) {
    const ts = new Date(Date.now() - daysAgo * 86400_000).toISOString();
    db.query(
      "INSERT INTO cards (id, created_at, kind, title, buttons, status, priority, push_sent) VALUES ($id,$t,'note',$id,'[]','pending','normal',0)",
    ).run({ $id: id, $t: ts });
  }
  test('deletes cards older than CARD_RETENTION_DAYS and cascades their assets', () => {
    process.env.CARD_RETENTION_DAYS = '30';
    process.env.CARD_MAX = '500';
    insertOld('old1', 60);
    db.query("INSERT INTO card_assets (id, card_id, mime, bytes, created_at) VALUES ('a-old','old1','image/png',$b,datetime('now'))").run({
      $b: new Uint8Array([9]),
    });
    insertOld('recent1', 1);
    pruneCards();
    expect(getCard('old1')).toBeNull();
    expect(getCard('recent1')).not.toBeNull();
    // asset cascaded
    const orphan = db.query("SELECT COUNT(*) AS n FROM card_assets WHERE id='a-old'").get() as any;
    expect(orphan.n).toBe(0);
  });
  test('caps total cards to CARD_MAX (oldest pruned)', () => {
    process.env.CARD_RETENTION_DAYS = '0'; // disable age prune for this test
    process.env.CARD_MAX = '2';
    insertOld('c1', 3);
    insertOld('c2', 2);
    insertOld('c3', 1);
    pruneCards();
    const n = (db.query('SELECT COUNT(*) AS n FROM cards').get() as any).n;
    expect(n).toBe(2);
    expect(getCard('c1')).toBeNull(); // oldest gone
    expect(getCard('c3')).not.toBeNull(); // newest kept
    process.env.CARD_RETENTION_DAYS = '30';
    process.env.CARD_MAX = '500';
  });
});
