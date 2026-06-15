import { describe, test, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SandboxedPageIframe } from './PageFrame';

afterEach(cleanup);

// SECURITY REGRESSION GUARD — do not weaken. kind:'page' runs agent-authored JS, so the iframe must
// stay in an OPAQUE origin: agent code can never be allowed to reach the Relay session cookie, the
// write/UI tokens, the API, localStorage, the service worker, or the parent DOM. That requires
// sandbox="allow-scripts" with NONE of allow-same-origin / allow-top-navigation / allow-modals /
// allow-popups. If this test ever fails, the sandbox was widened — fix the component, not the test.
describe('SandboxedPageIframe — sandbox boundary', () => {
  test('sandbox is exactly "allow-scripts" and carries the html via srcdoc', () => {
    const html = '<!doctype html><p>hi</p>';
    const { container } = render(<SandboxedPageIframe pageHtml={html} title="Test page" />);
    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();

    const sandbox = iframe!.getAttribute('sandbox'); // string compare — portable across jsdom/browser
    expect(sandbox).toBe('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-modals');
    expect(sandbox).not.toContain('allow-popups');

    expect(iframe!.getAttribute('srcdoc')).toBe(html);
    expect(iframe!.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(iframe!.getAttribute('title')).toBe('Test page');
  });
});
