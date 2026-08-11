import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Tags kept when copying the editor's rich HTML to the clipboard. Deliberately a SMALL semantic
// allowlist (no style/class) so the result pastes cleanly into Teams/Slack/Outlook, which ignore
// page CSS and strip unknown attributes. Tables are included because `relay draft` markdown may
// contain GFM tables. Separate from the in-page display sanitize (react-markdown + rehype-sanitize).
export const CLIPBOARD_ALLOWED_TAGS = [
  'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'p', 'br',
  'h1', 'h2', 'h3', 'code', 'pre', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

// Markdown -> sanitized HTML. Used to seed the TipTap editor with the draft body. `breaks:true`
// matches the old marked behavior (single newline -> <br>); equivalent to remark-breaks for display.
export function markdownToSafeHtml(md: string): string {
  if (!md) return '';
  const raw = marked.parse(md, { breaks: true, async: false }) as string;
  return DOMPurify.sanitize(raw);
}

// Sanitize the editor's HTML for the clipboard (rich copy). Small allowlist + href only, then
// flatten paragraphs so blank lines survive the paste (see flattenTopLevelParagraphs).
export function sanitizeForClipboard(html: string): string {
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS: CLIPBOARD_ALLOWED_TAGS, ALLOWED_ATTR: ['href'] });
  return flattenTopLevelParagraphs(clean);
}

// Rich targets prefer the clipboard's text/html flavor, and Slack's paste handler treats a top-level
// <p> boundary as a SINGLE line break — so the blank line between two paragraphs is lost, and a
// multi-paragraph draft pastes as consecutive lines. <br> is honored literally everywhere
// (Slack/Teams/Outlook/Gmail), so replace each top-level <p> with its inline content followed by
// <br><br>. Nested <p> (inside <li>/<blockquote>/<td>) and every other block — lists, headings,
// tables, pre — are left untouched.
//
// The <br><br> is inserted as a separator BETWEEN top-level nodes, never appended after one, so
// there is no trailing break and a paragraph FOLLOWING a list still gets its blank line.
function flattenTopLevelParagraphs(html: string): string {
  if (typeof document === 'undefined') return html; // non-DOM context (safety) — leave as-is
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;

  // Top-level nodes, ignoring the whitespace-only text nodes marked() leaves between block tags.
  const nodes = Array.from(root.childNodes).filter(
    (n) => !(n.nodeType === Node.TEXT_NODE && !(n.textContent ?? '').trim()),
  );

  const out = document.createDocumentFragment();
  let prevWasParagraph = false;
  nodes.forEach((node, i) => {
    const isParagraph = node.nodeName === 'P';
    // One blank line between siblings when either side was a paragraph. Two adjacent real blocks
    // (e.g. list -> heading) already break themselves, so they get no separator.
    if (i > 0 && (isParagraph || prevWasParagraph)) {
      out.append(document.createElement('br'), document.createElement('br'));
    }
    if (isParagraph) {
      while (node.firstChild) out.appendChild(node.firstChild); // unwrap to inline content
    } else {
      out.appendChild(node);
    }
    prevWasParagraph = isParagraph;
  });

  root.replaceChildren(out);
  return tpl.innerHTML;
}

// "just now" / "5m ago" / "3h ago" / "Jun 14". created_at may be naive UTC (no trailing Z).
export function timeAgo(iso: string): string {
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
