import { describe, it, expect, vi } from 'vitest';
import { CLIPBOARD_ALLOWED_TAGS, markdownToSafeHtml, sanitizeForClipboard, timeAgo } from './markdown';

describe('markdownToSafeHtml', () => {
  it('renders bold and converts single newlines to <br> (breaks:true)', () => {
    const html = markdownToSafeHtml('**hi**\nthere');
    expect(html).toContain('<strong>hi</strong>');
    expect(html).toMatch(/<br\s*\/?>/);
  });

  it('strips script tags', () => {
    const html = markdownToSafeHtml('ok <script>alert(1)</script>');
    expect(html).not.toContain('<script');
  });

  it('returns empty string for empty input', () => {
    expect(markdownToSafeHtml('')).toBe('');
  });
});

describe('sanitizeForClipboard', () => {
  it('keeps semantic tags + href but strips style/class/handlers/script', () => {
    const dirty =
      '<p class="x" style="color:red">a <strong>b</strong> <a href="https://e.com" onclick="x()">l</a></p><script>1</script>';
    const clean = sanitizeForClipboard(dirty);
    expect(clean).toContain('<strong>b</strong>');
    expect(clean).toContain('href="https://e.com"');
    expect(clean).not.toContain('class=');
    expect(clean).not.toContain('style=');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('<script');
  });

  it('allows GFM table tags (drafts may contain tables)', () => {
    expect(CLIPBOARD_ALLOWED_TAGS).toContain('table');
    const clean = sanitizeForClipboard('<table><tr><td>a</td></tr></table>');
    expect(clean).toContain('<td>a</td>');
  });

  // Slack collapses a top-level <p> boundary to a single line break, so paragraph breaks are
  // flattened to <br><br> to keep the blank line on paste.
  it('separates top-level paragraphs with <br><br> so the blank line survives a paste', () => {
    const clean = sanitizeForClipboard('<p>one</p><p>two</p>');
    expect(clean).not.toContain('<p>');
    expect(clean).toBe('one<br><br>two');
  });

  it('emits no trailing break after the last paragraph', () => {
    expect(sanitizeForClipboard('<p>only</p>')).toBe('only');
  });

  // Regression: marked() leaves "\n" text nodes between block tags, which used to stop the
  // trailing-break cleanup and leak a blank line onto the end of every card-button copy.
  it('strips the trailing break even when whitespace text nodes separate the blocks', () => {
    const clean = sanitizeForClipboard('<p>one</p>\n<p>two</p>\n');
    expect(clean).not.toMatch(/<br\s*\/?>\s*$/);
    expect(clean).toMatch(/one<br><br>\s*two/);
  });

  it('flattens the paragraphs produced by real markdown input', () => {
    const clean = sanitizeForClipboard(markdownToSafeHtml('para one\n\npara two'));
    expect(clean).toMatch(/para one<br><br>\s*para two/);
    expect(clean).not.toMatch(/<br\s*\/?>\s*$/);
  });

  it('keeps inline <br> soft breaks inside a paragraph', () => {
    expect(sanitizeForClipboard('<p>a<br>b</p>')).toBe('a<br>b');
  });

  it('gives a paragraph that FOLLOWS a list its blank line too', () => {
    const clean = sanitizeForClipboard(markdownToSafeHtml('- a\n- b\n\nclosing line'));
    expect(clean).toMatch(/<\/ul><br><br>closing line$/);
  });

  it('does not separate two adjacent non-paragraph blocks (they break themselves)', () => {
    const clean = sanitizeForClipboard('<h2>head</h2><ul><li>item</li></ul>');
    expect(clean).toBe('<h2>head</h2><ul><li>item</li></ul>');
  });

  it('leaves lists, headings, and nested paragraphs intact', () => {
    const clean = sanitizeForClipboard('<p>intro</p><h2>head</h2><ul><li><p>item</p></li></ul>');
    expect(clean).toContain('<h2>head</h2>');
    expect(clean).toContain('<ul>');
    expect(clean).toContain('<li><p>item</p></li>'); // nested <p> untouched
    expect(clean).toMatch(/^intro<br><br>/);
  });
});

describe('timeAgo', () => {
  it('handles naive-UTC timestamps (no trailing Z)', () => {
    vi.setSystemTime(new Date('2026-06-14T12:00:30Z'));
    expect(timeAgo('2026-06-14T12:00:00')).toBe('just now');
    vi.useRealTimers();
  });

  it('formats minutes and hours', () => {
    vi.setSystemTime(new Date('2026-06-14T12:30:00Z'));
    expect(timeAgo('2026-06-14T12:00:00Z')).toBe('30m ago');
    expect(timeAgo('2026-06-14T09:00:00Z')).toBe('3h ago');
    vi.useRealTimers();
  });
});
