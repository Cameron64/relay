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

// Sanitize the editor's HTML for the clipboard (rich copy). Small allowlist + href only.
// Slack's paste handler collapses top-level <p> boundaries (the whole message lands on one line),
// whereas Teams/Outlook honor them. <br> is honored everywhere, so we flatten top-level paragraphs
// into <br>-separated inline content to preserve line breaks across all three apps. Lists, headings,
// tables, blockquotes, and any nested <p> (e.g. inside <li>) are left intact.
export function sanitizeForClipboard(html: string): string {
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS: CLIPBOARD_ALLOWED_TAGS, ALLOWED_ATTR: ['href'] });
  return flattenTopLevelParagraphs(clean);
}

// Replace each TOP-LEVEL <p> with its inner content followed by a blank line (<br><br>), so paragraph
// breaks survive a paste into Slack. Nested paragraphs (inside <li>/<blockquote>) are untouched.
function flattenTopLevelParagraphs(html: string): string {
  if (typeof document === 'undefined') return html; // non-DOM context (safety) — leave as-is
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;
  for (const el of Array.from(root.children)) {
    if (el.tagName !== 'P') continue;
    const frag = document.createDocumentFragment();
    while (el.firstChild) frag.appendChild(el.firstChild);
    frag.appendChild(document.createElement('br'));
    frag.appendChild(document.createElement('br'));
    el.replaceWith(frag);
  }
  while (root.lastChild && root.lastChild.nodeName === 'BR') root.lastChild.remove();
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
