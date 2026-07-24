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

  it('flattens top-level paragraphs to <br> so line breaks survive a Slack paste', () => {
    const clean = sanitizeForClipboard('<p>one</p><p>two</p>');
    expect(clean).not.toContain('<p>'); // top-level <p> wrappers removed
    expect(clean).toContain('one');
    expect(clean).toContain('two');
    expect(clean).toMatch(/<br\s*\/?>/); // separated by explicit break(s)
    expect(clean).not.toMatch(/<br\s*\/?>\s*$/); // no trailing break after the last paragraph
  });

  it('preserves lists and nested paragraphs (only top-level <p> are flattened)', () => {
    const clean = sanitizeForClipboard('<p>intro</p><ul><li>item</li></ul>');
    expect(clean).toContain('<ul>');
    expect(clean).toContain('<li>item</li>');
    expect(clean).toContain('intro');
  });

  it('keeps inline <br> soft breaks inside a paragraph', () => {
    const clean = sanitizeForClipboard('<p>a<br>b</p>');
    expect(clean).toContain('a');
    expect(clean).toContain('b');
    expect(clean).toMatch(/a\s*<br\s*\/?>\s*b/);
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
