// Relay PWA — card-feed inbox.
//
// Reads the feed from /api/cards (gated by the relay_session httpOnly cookie set at
// /api/unlock), renders cards by kind (markdown / image / Mermaid / draft / approval),
// and stays live via an EventSource on /api/stream. Responding to a card POSTs the verdict,
// which resolves any `relay card --wait` parked on the server side.
//
// marked + DOMPurify are loaded as globals by index.html. Mermaid is lazy-loaded here only
// when a diagram card appears, and is rendered with securityLevel:'strict' (a separate trust
// path from the DOMPurify-sanitized markdown).

const feedEl = document.getElementById('feed');
const emptyEl = document.getElementById('empty');
const unlockEl = document.getElementById('unlock');
const unlockForm = document.getElementById('unlock-form');
const unlockInput = document.getElementById('unlock-token');
const unlockError = document.getElementById('unlock-error');
const lockBtn = document.getElementById('lock-btn');
const toastEl = document.getElementById('toast');

const cardsById = new Map();
let newestCursor = null;
let es = null;
let sseConnectedOnce = false;
let mermaidPromise = null;

const focusCardId = new URLSearchParams(location.search).get('card');
let focusHandled = false;

// Id of the editable-draft card currently being edited. The SSE refresh path checks this so an
// incoming card-updated/backfill can't rebuild (and wipe) the editor the user is typing in.
let activeDraftEditId = null;

// Tags kept when copying the editor's rich HTML to the clipboard. Deliberately a SMALL semantic
// allowlist (no style/class) so the result pastes cleanly into Teams/Slack/Outlook, which ignore
// page CSS and strip unknown attributes. Separate from the in-page display sanitize.
const CLIPBOARD_ALLOWED_TAGS = ['b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'p', 'br', 'h1', 'h2', 'h3', 'code', 'pre', 'blockquote'];

// --- helpers ---------------------------------------------------------------
function api(path, opts = {}) {
  return fetch(path, { credentials: 'include', ...opts });
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.classList.add('hidden'), 250);
  }, 1800);
}

function timeAgo(iso) {
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderMarkdown(md) {
  if (!md) return '';
  const raw = window.marked ? window.marked.parse(md, { breaks: true }) : md;
  return window.DOMPurify ? window.DOMPurify.sanitize(raw) : '';
}

function escapeText(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

async function loadMermaid() {
  if (window.mermaid) return window.mermaid;
  if (!mermaidPromise) {
    mermaidPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid.min.js';
      s.onload = () => {
        try {
          window.mermaid.initialize({ securityLevel: 'strict', startOnLoad: false, theme: 'default' });
          resolve(window.mermaid);
        } catch (e) {
          reject(e);
        }
      };
      s.onerror = () => reject(new Error('failed to load mermaid'));
      document.head.appendChild(s);
    });
  }
  return mermaidPromise;
}

// --- card rendering --------------------------------------------------------
function verdictLabel(v) {
  return { approved: '✓ Approved', changes_requested: '✎ Changes requested', dismissed: '✕ Dismissed' }[v] || ('• ' + v);
}
function verdictClass(v) {
  return ['approved', 'changes_requested', 'dismissed'].includes(v) ? v : 'other';
}

function buildCard(card) {
  const el = document.createElement('article');
  el.className = 'card kind-' + card.kind;
  el.dataset.id = card.id;

  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML =
    '<h2 class="card-title">' +
    escapeText(card.title) +
    (card.kind && card.kind !== 'note' ? '<span class="card-kind">' + escapeText(card.kind) + '</span>' : '') +
    '</h2><span class="card-meta">' +
    escapeText(timeAgo(card.created_at)) +
    '</span>';
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'card-body';

  const isEditableDraft = card.kind === 'draft' && card.source && card.source.editable;

  // images — the editable-draft template renders its own images (each with a Copy image button)
  if (!isEditableDraft && card.assets && card.assets.length) {
    const wrap = document.createElement('div');
    wrap.className = 'assets';
    for (const a of card.assets) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = card.title;
      img.src = '/api/cards/' + card.id + '/asset/' + a.id;
      wrap.appendChild(img);
    }
    body.appendChild(wrap);
  }

  if (isEditableDraft) {
    // the `relay draft` template — WYSIWYG editor + copy toolbar (incl. its own images)
    buildEditableDraft(card, body);
  } else if (card.kind === 'draft' && card.body) {
    // plain draft = read-only monospace block (copyable)
    const pre = document.createElement('div');
    pre.className = 'draft';
    pre.textContent = card.body;
    body.appendChild(pre);
  } else if (card.body) {
    const md = document.createElement('div');
    md.innerHTML = renderMarkdown(card.body);
    body.appendChild(md);
  }

  // mermaid diagram
  if (card.mermaid) {
    const host = document.createElement('div');
    host.className = 'mermaid-host';
    host.textContent = 'Rendering diagram…';
    body.appendChild(host);
    loadMermaid()
      .then((m) => m.render('mmd-' + card.id, card.mermaid))
      .then(({ svg }) => {
        host.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }) : svg;
      })
      .catch(() => {
        host.textContent = '';
        const pre = document.createElement('pre');
        pre.textContent = card.mermaid;
        host.appendChild(pre);
      });
  }

  el.appendChild(body);

  // resolved banner OR actions
  if (card.status === 'responded' && card.response) {
    el.appendChild(resolvedBanner(card.response));
  } else if (card.buttons && card.buttons.length) {
    el.appendChild(actionsRow(card));
  }

  return el;
}

function resolvedBanner(resp) {
  const div = document.createElement('div');
  div.className = 'resolved ' + verdictClass(resp.verdict);
  div.innerHTML = '<span>' + escapeText(verdictLabel(resp.verdict)) + '</span>';
  if (resp.note) {
    const n = document.createElement('span');
    n.className = 'note';
    n.textContent = '“' + resp.note + '”';
    div.appendChild(n);
  }
  return div;
}

function actionsRow(card) {
  const row = document.createElement('div');
  row.className = 'card-actions';
  for (const b of card.buttons) {
    const btn = document.createElement('button');
    btn.className = b.style || (b.behavior === 'respond' ? 'secondary' : 'outline');
    btn.textContent = b.label;
    btn.addEventListener('click', () => onButton(card, b, row));
    row.appendChild(btn);
  }
  return row;
}

function onButton(card, b, row) {
  if (b.behavior === 'copy') {
    const text = b.value != null ? b.value : card.copy_text != null ? card.copy_text : card.body || '';
    copyText(text);
    return;
  }
  if (b.behavior === 'link') {
    window.open(b.value, '_blank', 'noopener');
    return;
  }
  // respond
  if (b.style === 'note') {
    openNoteEditor(card, b, row);
  } else {
    submitResponse(card, b.id, null);
  }
}

function openNoteEditor(card, b, row) {
  const cardEl = row.closest('.card');
  row.classList.add('hidden');
  const ed = document.createElement('div');
  ed.className = 'note-editor';
  const ta = document.createElement('textarea');
  ta.placeholder = 'What should change? (optional)';
  const rowBtns = document.createElement('div');
  rowBtns.className = 'row';
  const cancel = document.createElement('button');
  cancel.className = 'outline';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    ed.remove();
    row.classList.remove('hidden');
  });
  const send = document.createElement('button');
  send.className = 'primary';
  send.textContent = b.sendLabel || 'Send';
  send.addEventListener('click', () => submitResponse(card, b.id, ta.value.trim() || null));
  rowBtns.append(cancel, send);
  ed.append(ta, rowBtns);
  cardEl.appendChild(ed);
  ta.focus();
}

async function submitResponse(card, action, note) {
  try {
    const res = await api('/api/cards/' + card.id + '/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, note }),
    });
    if (res.status === 409) {
      const data = await res.json();
      toast('Already answered');
      if (data.response) applyResolved(card.id, data.response);
      return;
    }
    if (!res.ok) {
      toast('Could not send');
      return;
    }
    const data = await res.json();
    applyResolved(card.id, data.response);
    toast('Sent');
  } catch {
    toast('Network error');
  }
}

function applyResolved(id, response) {
  const card = cardsById.get(id);
  if (card) {
    card.status = 'responded';
    card.response = response;
  }
  const el = feedEl.querySelector('.card[data-id="' + cssEscape(id) + '"]');
  if (el) {
    el.querySelectorAll('.card-actions, .note-editor').forEach((n) => n.remove());
    if (!el.querySelector('.resolved')) el.appendChild(resolvedBanner(response));
  }
}

function cssEscape(s) {
  return (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed');
  }
}

// --- editable rich draft (the `relay draft` template) ----------------------
function buildEditableDraft(card, body) {
  // images first, each with its own (uniquely-named) Copy image button
  if (card.assets && card.assets.length) {
    const wrap = document.createElement('div');
    wrap.className = 'assets';
    card.assets.forEach((a, i) => {
      const fig = document.createElement('div');
      fig.className = 'asset-fig';
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = card.title;
      const assetUrl = '/api/cards/' + card.id + '/asset/' + a.id;
      img.src = assetUrl;
      const copyImg = document.createElement('button');
      copyImg.className = 'outline';
      copyImg.textContent = 'Copy image';
      copyImg.setAttribute('aria-label', 'Copy image ' + (i + 1)); // disambiguate N buttons
      copyImg.addEventListener('click', () => copyImage(assetUrl));
      fig.append(img, copyImg);
      wrap.appendChild(fig);
    });
    body.appendChild(wrap);
  }

  // WYSIWYG editor seeded with sanitized markdown — Cam edits the rendered view directly
  const editor = document.createElement('div');
  editor.className = 'editable-draft';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.setAttribute('aria-label', 'Editable draft message');
  editor.innerHTML = renderMarkdown(card.body || '');

  editor.addEventListener('focus', () => {
    activeDraftEditId = card.id;
  });
  editor.addEventListener('input', () => {
    activeDraftEditId = card.id;
    editor.dataset.dirty = '1';
  });
  editor.addEventListener('blur', () => {
    if (!editor.dataset.dirty) activeDraftEditId = null;
  });
  // sanitize pasted HTML so the editor can't accumulate unsafe/dirty markup
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const cd = e.clipboardData || window.clipboardData;
    const html = cd ? cd.getData('text/html') : '';
    const text = cd ? cd.getData('text/plain') : '';
    let insert;
    if (html) insert = window.DOMPurify ? window.DOMPurify.sanitize(html) : escapeText(text);
    else insert = escapeText(text).replace(/\n/g, '<br>');
    document.execCommand('insertHTML', false, insert);
    activeDraftEditId = card.id;
    editor.dataset.dirty = '1';
  });
  body.appendChild(editor);

  // toolbar: Copy formatted (rich) / Copy plain (reuses copyText)
  const bar = document.createElement('div');
  bar.className = 'draft-toolbar';
  const fmt = document.createElement('button');
  fmt.className = 'secondary';
  fmt.textContent = 'Copy formatted';
  fmt.addEventListener('click', () => copyRich(editor.innerHTML, editor.innerText));
  const plain = document.createElement('button');
  plain.className = 'outline';
  plain.textContent = 'Copy plain';
  plain.addEventListener('click', () => copyText(editor.innerText));
  bar.append(fmt, plain);
  body.appendChild(bar);
}

// Copy rich HTML (+ plain fallback) to the clipboard. Sanitized to a small semantic allowlist so
// it pastes cleanly into Teams/Slack/Outlook. Falls back to plain text if ClipboardItem is absent.
async function copyRich(html, text) {
  const clean = window.DOMPurify
    ? window.DOMPurify.sanitize(html, { ALLOWED_TAGS: CLIPBOARD_ALLOWED_TAGS, ALLOWED_ATTR: ['href'] })
    : escapeText(text);
  try {
    if (navigator.clipboard && window.ClipboardItem && window.isSecureContext) {
      const item = new ClipboardItem({
        'text/html': new Blob([clean], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      toast('Copied formatted');
      return;
    }
  } catch {
    // fall through to plain
  }
  copyText(text);
}

// Copy an attached image to the clipboard, normalized to PNG (the only format browsers reliably
// accept). Safari keeps the user gesture only if the ClipboardItem value is a Promise of the blob.
async function copyImage(assetUrl) {
  try {
    if (!(navigator.clipboard && window.ClipboardItem && window.isSecureContext)) throw new Error('no clipboard');
    const pngPromise = (async () => {
      const resp = await fetch(assetUrl, { credentials: 'include' });
      const blob = await resp.blob();
      if (blob.type === 'image/png') return blob;
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      return await new Promise((res) => canvas.toBlob(res, 'image/png'));
    })();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
    toast('Image copied');
  } catch {
    toast('Couldn’t copy image — long-press to copy');
  }
}

// Scroll/flash (and, for an editable draft, focus the editor) the card named by ?card=, no matter
// whether it arrived via the initial feed render or an SSE card-created event. Fires once.
function maybeFocusDraft(el, id) {
  if (focusHandled || !focusCardId || id !== focusCardId || !el) return;
  focusHandled = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  const ed = el.querySelector('.editable-draft');
  if (ed) setTimeout(() => { try { ed.focus(); } catch {} }, 300);
}

// --- feed management -------------------------------------------------------
function upsertCard(card, { flash = false } = {}) {
  cardsById.set(card.id, card);
  if (card.created_at && (!newestCursor || card.created_at > newestCursor)) newestCursor = card.created_at;

  const old = feedEl.querySelector('.card[data-id="' + cssEscape(card.id) + '"]');

  // Per-card edit guard: if THIS card's editable draft is being edited, keep the live editor —
  // rebuilding from the (original) server body would wipe in-progress edits. Scoped to this exact
  // card id, so every other card/kind still refreshes normally.
  if (old && activeDraftEditId === card.id) return old;

  const built = buildCard(card);
  if (flash) built.classList.add('flash');
  if (old) {
    old.replaceWith(built);
  } else {
    // newest first; insert in created_at order
    const before = [...feedEl.children].find((ch) => ch.dataset.id && cardsById.get(ch.dataset.id)?.created_at < card.created_at);
    if (before) feedEl.insertBefore(built, before);
    else feedEl.appendChild(built);
  }
  emptyEl.classList.toggle('hidden', cardsById.size > 0);
  maybeFocusDraft(built, card.id);
  return built;
}

function renderAll(cards) {
  // upsertCard fires maybeFocusDraft per card, so ?card= focus/scroll works on both the initial
  // render and SSE arrival — no separate focus block needed here.
  for (const c of cards.slice().reverse()) upsertCard(c);
  emptyEl.classList.toggle('hidden', cardsById.size > 0);
}

async function loadFeed() {
  const path = '/api/cards' + (newestCursor ? '?since=' + encodeURIComponent(newestCursor) : '');
  const res = await api(path);
  if (res.status === 401) {
    showUnlock();
    return false;
  }
  if (res.status === 503) {
    toast('Server storage warming up…');
    return true;
  }
  if (!res.ok) return false;
  const data = await res.json();
  renderAll(data.cards || []);
  showApp();
  return true;
}

// --- SSE -------------------------------------------------------------------
function connectSSE() {
  if (es) es.close();
  es = new EventSource('/api/stream', { withCredentials: true });
  es.addEventListener('open', () => {
    // On (re)connect after the first, backfill any cards missed while disconnected.
    if (sseConnectedOnce) loadFeed();
    sseConnectedOnce = true;
  });
  es.addEventListener('card-created', (e) => {
    try {
      upsertCard(JSON.parse(e.data), { flash: true });
    } catch {}
  });
  es.addEventListener('card-updated', (e) => {
    try {
      upsertCard(JSON.parse(e.data));
    } catch {}
  });
  // EventSource auto-reconnects on error; nothing to do but let it.
}

// --- unlock / lock ---------------------------------------------------------
function showUnlock() {
  unlockEl.classList.remove('hidden');
  feedEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  lockBtn.classList.add('hidden');
  if (es) {
    es.close();
    es = null;
  }
}
function showApp() {
  unlockEl.classList.add('hidden');
  feedEl.classList.remove('hidden');
  lockBtn.classList.remove('hidden');
  localStorage.setItem('relay_unlocked', '1');
}

unlockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockError.textContent = '';
  const token = unlockInput.value.trim();
  if (!token) return;
  try {
    const res = await api('/api/unlock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      unlockError.textContent = res.status === 401 ? 'Invalid token' : 'Unlock failed';
      return;
    }
    unlockInput.value = '';
    await loadFeed();
    connectSSE();
  } catch {
    unlockError.textContent = 'Network error';
  }
});

lockBtn.addEventListener('click', async () => {
  localStorage.removeItem('relay_unlocked');
  // Best-effort: overwrite the cookie with an expired one isn't possible (httpOnly), so we
  // just forget locally and show the unlock screen. The cookie expires server-side.
  cardsById.clear();
  feedEl.innerHTML = '';
  newestCursor = null;
  sseConnectedOnce = false;
  showUnlock();
});

// --- boot ------------------------------------------------------------------
(async () => {
  const ok = await loadFeed();
  if (ok) connectSSE();
})();
