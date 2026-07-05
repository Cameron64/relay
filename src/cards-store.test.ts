// Run with: DB_PATH=:memory: bun test  (the test script sets DB_PATH so store.ts opens an
// in-memory DB and never touches a real volume).
import { test, expect, describe, beforeAll, beforeEach } from 'bun:test';
import { db } from './store.ts';
import {
  ensureCardsSchema,
  PAGE_HTML_MAX,
  validateButtons,
  validateOptions,
  validateCardInput,
  createCard,
  getCard,
  listCards,
  respondCard,
  dismissCard,
  sweepExpired,
  getAsset,
  pruneCards,
  validateCardEventInput,
  appendCardEvent,
  listCardEvents,
  __resetForTests,
} from './cards-store.ts';

// Minimal CardInput factory so the expiry tests aren't 8 lines of nulls each.
function input(over: Partial<Parameters<typeof createCard>[0]> = {}) {
  return {
    kind: 'note',
    title: 'x',
    body: null,
    buttons: [],
    options: [],
    copy_text: null,
    mermaid: null,
    page_html: null,
    source: null,
    priority: 'normal' as const,
    expires_at: null,
    ...over,
  };
}

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

describe('validateOptions', () => {
  test('accepts rich options', () => {
    const r = validateOptions([
      { id: 'a', label: 'Plan A', description: 'cheap', body: '# details', mermaid: 'graph TD;X-->Y', link: 'https://x.io' },
      { id: 'b', label: 'Plan B' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });
  test('treats missing/empty as an empty array', () => {
    expect(validateOptions(undefined).ok).toBe(true);
    const r = validateOptions(null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
  test('requires id and label', () => {
    expect(validateOptions([{ label: 'no id' }]).ok).toBe(false);
    expect(validateOptions([{ id: 'x' }]).ok).toBe(false);
  });
  test('rejects duplicate ids', () => {
    const r = validateOptions([{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('duplicate');
  });
  test('rejects a non-http option link', () => {
    expect(validateOptions([{ id: 'x', label: 'A', link: 'javascript:alert(1)' }]).ok).toBe(false);
  });
  test('rejects more than 10 options and non-arrays', () => {
    expect(validateOptions(Array.from({ length: 11 }, (_, i) => ({ id: 'o' + i, label: 'o' + i }))).ok).toBe(false);
    expect(validateOptions('nope').ok).toBe(false);
  });
});

describe('choice cards', () => {
  test('createCard stores and hydrates options', () => {
    const card = createCard(
      input({ kind: 'choice', title: 'Pick a plan', options: [{ id: 'a', label: 'A', body: '# A' }, { id: 'b', label: 'B' }] }),
    );
    const fresh = getCard(card.id);
    expect(fresh?.options).toHaveLength(2);
    expect(fresh?.options[0]).toMatchObject({ id: 'a', label: 'A', body: '# A' });
  });
  test('responding with an option id records it as the verdict', () => {
    const card = createCard(input({ kind: 'choice', title: 'Pick', options: [{ id: 'opt-a', label: 'A' }, { id: 'opt-b', label: 'B' }] }));
    const r = respondCard(card.id, { action: 'opt-b' });
    expect(r.status).toBe('responded');
    if (r.status === 'responded') expect(r.response.verdict).toBe('opt-b');
  });
});

describe('prompt cards (free-text reply)', () => {
  test('responding with action "reply" records verdict "reply" + the text in note', () => {
    const card = createCard(input({ kind: 'prompt', title: 'What next?', source: { placeholder: 'your call…' } }));
    expect(card.kind).toBe('prompt');
    const r = respondCard(card.id, { action: 'reply', note: 'ship the choice card' });
    expect(r.status).toBe('responded');
    if (r.status === 'responded') {
      expect(r.response.verdict).toBe('reply');
      expect(r.response.action).toBe('reply');
      expect(r.response.note).toBe('ship the choice card');
    }
  });
  test('a reserved "__"-prefixed action (e.g. __reply from a stale SW) is rejected, card stays pending', () => {
    const card = createCard(input({ kind: 'prompt', title: 'Q' }));
    const r = respondCard(card.id, { action: '__reply' });
    expect(r.status).toBe('reserved');
    expect(getCard(card.id)?.status).toBe('pending'); // not resolved — old SW will fall back to opening the app
  });
});

describe('validateCardInput', () => {
  test('rejects unknown kind', () => {
    const r = validateCardInput({ kind: 'explosion', title: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('kind');
  });
  test('accepts kind "prompt"', () => {
    const r = validateCardInput({ kind: 'prompt', title: 'What next?' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.kind).toBe('prompt');
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

describe('page cards (kind:page)', () => {
  test('requires non-empty page_html for kind "page"', () => {
    expect(validateCardInput({ kind: 'page', title: 'P' }).ok).toBe(false);
    expect(validateCardInput({ kind: 'page', title: 'P', page_html: '   ' }).ok).toBe(false);
    const ok = validateCardInput({ kind: 'page', title: 'P', page_html: '<!doctype html><p>hi</p>' });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.kind).toBe('page');
      expect(ok.value.page_html).toBe('<!doctype html><p>hi</p>');
    }
  });

  test('rejects page_html over the size cap', () => {
    const huge = 'x'.repeat(PAGE_HTML_MAX + 1);
    const r = validateCardInput({ kind: 'page', title: 'P', page_html: huge });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('exceeds');
  });

  test('ignores page_html on non-page kinds', () => {
    const r = validateCardInput({ kind: 'note', title: 'N', page_html: '<p>nope</p>' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.page_html).toBeNull();
  });

  test('createCard round-trips page_html through getCard (equality, not truthy)', () => {
    const html = '<!doctype html><html><body><h1>Chart</h1><script>1+1</script></body></html>';
    const card = createCard(input({ kind: 'page', title: 'Viz', page_html: html }));
    const fresh = getCard(card.id);
    expect(fresh?.kind).toBe('page');
    expect(fresh?.page_html).toBe(html); // guards a forgotten INSERT bind / hydrate mapping
  });
});

describe('page-submit bridge (expects_response — Plan 05)', () => {
  test('validateCardInput reads expects_response as a plain boolean, defaulting false', () => {
    const plain = validateCardInput({ kind: 'page', title: 'Viz', page_html: '<p>x</p>' });
    expect(plain.ok).toBe(true);
    if (plain.ok) expect(plain.value.expects_response).toBe(false);
    const asking = validateCardInput({ kind: 'page', title: 'Q', page_html: '<p>x</p>', expects_response: true });
    expect(asking.ok).toBe(true);
    if (asking.ok) expect(asking.value.expects_response).toBe(true);
  });

  test('a page with expects_response:true gets no default expiry, like an approval', () => {
    const asking = createCard(input({ kind: 'page', page_html: '<p>x</p>', expects_response: true }));
    expect(asking.expires_at).toBeNull();
  });

  test('a plain page (expects_response omitted/false) keeps the normal 24h-bucket default expiry', () => {
    const plain = createCard(input({ kind: 'page', page_html: '<p>x</p>' }));
    expect(plain.expires_at).not.toBeNull();
    expect(plain.expects_response).toBe(false);
  });

  test('createCard round-trips expects_response through getCard', () => {
    const card = createCard(input({ kind: 'page', page_html: '<p>x</p>', expects_response: true }));
    expect(getCard(card.id)?.expects_response).toBe(true);
  });

  test('an explicit expires_at still wins over expects_response (caller opt-out)', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const card = createCard(input({ kind: 'page', page_html: '<p>x</p>', expects_response: true, expires_at: future }));
    expect(card.expires_at).toBe(future);
  });

  test('respondCard passthrough: a page-submit "submit" action records verdict "submit"', () => {
    // Pages carry no buttons (view-only), so 'submit' hits the same unknown-action passthrough
    // used by choice options — no VALID_VERDICTS change needed (master doc §4 / plan's Design
    // section: that list only constrains *button-declared* verdicts).
    const card = createCard(input({ kind: 'page', page_html: '<p>x</p>', expects_response: true }));
    const r = respondCard(card.id, { action: 'submit' });
    expect(r.status).toBe('responded');
    if (r.status === 'responded') {
      expect(r.response.verdict).toBe('submit');
      expect(r.response.action).toBe('submit');
    }
  });
});

describe('respondCard — first-response-wins', () => {
  test('records verdict from the matching button, then 409s the second time', () => {
    const card = createCard({
      kind: 'approval',
      title: 'Approve?',
      body: null,
      buttons: [{ id: 'approved', label: 'Approve', behavior: 'respond', verdict: 'approved' }],
      options: [],
      copy_text: null,
      mermaid: null,
      page_html: null,
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
      options: [],
      copy_text: null,
      mermaid: null,
      page_html: null,
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

describe('expiry & dismiss', () => {
  test('default TTL applies to notes but not to approvals/choices/prompts', () => {
    expect(createCard(input({ kind: 'note' })).expires_at).not.toBeNull();
    expect(createCard(input({ kind: 'diagram' })).expires_at).not.toBeNull();
    expect(createCard(input({ kind: 'page', page_html: '<p>x</p>' })).expires_at).not.toBeNull();
    expect(createCard(input({ kind: 'approval' })).expires_at).toBeNull();
    expect(createCard(input({ kind: 'choice' })).expires_at).toBeNull();
    expect(createCard(input({ kind: 'prompt' })).expires_at).toBeNull();
  });

  test('an explicit expires_at overrides the default', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(createCard(input({ kind: 'note', expires_at: future })).expires_at).toBe(future);
  });

  test('listCards excludes expired and dismissed cards', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const live = createCard(input({ kind: 'approval', title: 'live', expires_at: future }));
    const expired = createCard(input({ kind: 'note', title: 'old', expires_at: past }));
    const gone = createCard(input({ kind: 'approval', title: 'gone' }));
    dismissCard(gone.id);
    const ids = listCards().map((c) => c.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(gone.id);
  });

  test('dismissCard marks dismissed + expires the card; unknown id returns false', () => {
    const c = createCard(input({ kind: 'approval' }));
    expect(dismissCard(c.id)).toBe(true);
    const fresh = getCard(c.id);
    expect(fresh?.status).toBe('dismissed');
    expect(fresh?.expires_at).not.toBeNull();
    expect(dismissCard('nope')).toBe(false);
  });

  test('sweepExpired deletes lapsed cards (returning ids) and keeps live ones', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const dead = createCard(input({ kind: 'note', title: 'dead', expires_at: past }));
    const alive = createCard(input({ kind: 'approval', title: 'alive', expires_at: future }));
    const swept = sweepExpired();
    expect(swept).toContain(dead.id);
    expect(swept).not.toContain(alive.id);
    expect(getCard(dead.id)).toBeNull();
    expect(getCard(alive.id)).not.toBeNull();
  });

  test('respondCard pulls a never-expiring card into a grace window', () => {
    const c = createCard(input({ kind: 'approval', buttons: [{ id: 'approved', label: 'A', behavior: 'respond', verdict: 'approved' }] }));
    expect(c.expires_at).toBeNull();
    respondCard(c.id, { action: 'approved' });
    expect(getCard(c.id)?.expires_at).not.toBeNull();
  });
});

describe('assets', () => {
  test('createCard stores assets and getAsset returns bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const card = createCard(
      { kind: 'image', title: 'shot', body: null, buttons: [], options: [], copy_text: null, mermaid: null, page_html: null, source: null, priority: 'normal', expires_at: null },
      [{ mime: 'image/png', bytes }],
    );
    expect(card.assets.length).toBe(1);
    const a = getAsset(card.id, card.assets[0].id);
    expect(a?.mime).toBe('image/png');
    expect(Array.from(a!.bytes)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('card_events', () => {
  test('append assigns seq 1..n in order', () => {
    const card = createCard(input({ kind: 'note' }));
    const e1 = appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'hi' });
    const e2 = appendCardEvent(card.id, { role: 'user', type: 'message', body: 'hi back' });
    expect(e1.ok && e1.value.seq).toBe(1);
    expect(e2.ok && e2.value.seq).toBe(2);
    expect(listCardEvents(card.id).map((e) => e.seq)).toEqual([1, 2]);
  });

  test('sinceSeq filters to events after that seq', () => {
    const card = createCard(input({ kind: 'note' }));
    appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'one' });
    appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'two' });
    appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'three' });
    const after1 = listCardEvents(card.id, { sinceSeq: 1 });
    expect(after1.map((e) => e.body)).toEqual(['two', 'three']);
  });

  test('user-role append requires status pending; agent-role append works on any status', () => {
    const card = createCard(
      input({ kind: 'approval', buttons: [{ id: 'approved', label: 'A', behavior: 'respond', verdict: 'approved' }] }),
    );
    respondCard(card.id, { action: 'approved' });
    const userAppend = appendCardEvent(card.id, { role: 'user', type: 'message', body: 'too late' });
    expect(userAppend.ok).toBe(false);
    const agentAppend = appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'got it, thanks' });
    expect(agentAppend.ok).toBe(true);
  });

  test('append to an unknown card fails with "card not found"', () => {
    const r = appendCardEvent('nope', { role: 'agent', type: 'message', body: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not found');
  });

  test('rejects a message body over its cap; allows a payload body up to its larger cap', () => {
    const card = createCard(input({ kind: 'note' }));
    const overMessage = appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'x'.repeat(16 * 1024 + 1) });
    expect(overMessage.ok).toBe(false);
    const atPayloadCap = appendCardEvent(card.id, { role: 'agent', type: 'payload', body: 'x'.repeat(64 * 1024) });
    expect(atPayloadCap.ok).toBe(true);
  });

  test('caps a card at CARD_EVENT_MAX_PER_CARD events', () => {
    const card = createCard(input({ kind: 'note' }));
    for (let i = 0; i < 200; i++) {
      expect(appendCardEvent(card.id, { role: 'agent', type: 'message', body: `m${i}` }).ok).toBe(true);
    }
    expect(appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'one too many' }).ok).toBe(false);
  });

  test('events are deleted when their card is swept', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const card = createCard(input({ kind: 'note', expires_at: past }));
    appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'bye' });
    sweepExpired();
    const orphan = db.query('SELECT COUNT(*) AS n FROM card_events WHERE card_id = $id').get({ $id: card.id }) as any;
    expect(orphan.n).toBe(0);
  });

  test('events are deleted when their card is pruned', () => {
    process.env.CARD_RETENTION_DAYS = '30';
    process.env.CARD_MAX = '500';
    const card = createCard(input({ kind: 'note' }));
    appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'bye' });
    db.query('UPDATE cards SET created_at = $t WHERE id = $id').run({
      $t: new Date(Date.now() - 60 * 86400_000).toISOString(),
      $id: card.id,
    });
    pruneCards();
    const orphan = db.query('SELECT COUNT(*) AS n FROM card_events WHERE card_id = $id').get({ $id: card.id }) as any;
    expect(orphan.n).toBe(0);
  });

  test('validateCardEventInput defaults type to message and enforces the cap', () => {
    const ok = validateCardEventInput({ body: 'hi' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.type).toBe('message');
    expect(validateCardEventInput({ type: 'nonsense', body: 'hi' }).ok).toBe(false);
    expect(validateCardEventInput({ type: 'message' }).ok).toBe(false);
  });

  test('getCard reports event_count; listCards never includes it', () => {
    const card = createCard(input({ kind: 'note' }));
    appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'a' });
    appendCardEvent(card.id, { role: 'agent', type: 'message', body: 'b' });
    expect(getCard(card.id)?.event_count).toBe(2);
    const fromList = listCards().find((c) => c.id === card.id) as any;
    expect(fromList?.event_count).toBeUndefined();
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
