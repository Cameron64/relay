import { useState } from 'react';
import type { CSSProperties } from 'react';
import { ActionIcon, Group, Modal } from '@mantine/core';

// kind:'page' cards carry a full agent-authored HTML+JS document (card.page_html), rendered in a
// SANDBOXED iframe. The security boundary is the ABSENCE of allow-same-origin: with
// sandbox="allow-scripts" only, the document runs in a unique OPAQUE origin — it can load CDN
// scripts, run JS, fetch public CORS APIs, and use canvas/SVG/WebGL, but it CANNOT read the Relay
// session cookie, call /api with credentials, touch localStorage, reach the service worker, or read
// the parent DOM. We deliberately omit:
//   • allow-same-origin    — or the frame could remove its own sandbox and reach Relay's origin
//   • allow-top-navigation — or the page could navigate the parent PWA away
//   • allow-modals         — or a page could freeze the UI with a blocking alert()/confirm()/prompt()
//   • allow-popups/-forms  — unneeded for charts / sims / explainers
// DO NOT add allow-same-origin. The PageFrame.test.tsx guard fails the build if the token set drifts.
//
// SandboxedPageIframe is intentionally Mantine-free so that security-regression test can mount it and
// assert the sandbox attribute without needing a MantineProvider wrapper.
const SANDBOX = 'allow-scripts';

export function SandboxedPageIframe({
  pageHtml,
  title,
  style,
}: {
  pageHtml: string;
  title: string;
  style?: CSSProperties;
}) {
  return (
    <iframe
      sandbox={SANDBOX}
      srcDoc={pageHtml}
      referrerPolicy="no-referrer"
      title={title}
      style={{ width: '100%', border: 'none', display: 'block', background: '#fff', ...style }}
    />
  );
}

export function PageFrame({ pageHtml, title }: { pageHtml?: string | null; title: string }) {
  const [full, setFull] = useState(false);
  if (!pageHtml) return null;
  return (
    <>
      <div style={{ marginTop: 8 }}>
        <SandboxedPageIframe
          pageHtml={pageHtml}
          title={title}
          style={{ height: 'min(60vh, 480px)', borderRadius: 8 }}
        />
        <Group justify="flex-end" mt={6}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Open page fullscreen"
            onClick={() => setFull(true)}
          >
            <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>
              ⛶
            </span>
          </ActionIcon>
        </Group>
      </div>
      <Modal opened={full} onClose={() => setFull(false)} fullScreen withinPortal title={title} padding="xs">
        <SandboxedPageIframe pageHtml={pageHtml} title={title} style={{ height: 'calc(100vh - 64px)' }} />
      </Modal>
    </>
  );
}
