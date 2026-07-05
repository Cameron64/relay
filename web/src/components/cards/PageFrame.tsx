import { forwardRef, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ActionIcon, Badge, Group, Modal, Text } from '@mantine/core';
import { postCardEvent, respond } from '../../api';
import { useFeed } from '../../store/feed';
import type { Card } from '../../types';

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

export const SandboxedPageIframe = forwardRef<HTMLIFrameElement, { pageHtml: string; title: string; style?: CSSProperties }>(
  function SandboxedPageIframe({ pageHtml, title, style }, ref) {
    return (
      <iframe
        ref={ref}
        sandbox={SANDBOX}
        srcDoc={pageHtml}
        referrerPolicy="no-referrer"
        title={title}
        style={{ width: '100%', border: 'none', display: 'block', background: '#fff', ...style }}
      />
    );
  },
);

// Plan 05 — the page-submit bridge. A page can postMessage a structured answer back to the parent:
//   window.parent.postMessage({ __relay: 'submit', payload: {...} }, '*')
//   window.parent.postMessage({ __relay: 'ready', expectsResponse: true }, '*')   // optional
// '*' is correct on the SENDING side (the sandboxed iframe has an opaque origin and cannot name
// the parent's). Validation happens entirely on this, the RECEIVING side.
//
// Mirrors CARD_EVENT_BODY_MAX.payload in cards-store.ts — a client-side pre-check so an oversize
// submit fails fast (silently ignored, per the protocol) instead of round-tripping a 400.
const MAX_PAYLOAD_JSON_LEN = 64 * 1024;

type SubmitState = 'idle' | 'sending' | 'sent' | 'conflict' | 'error';

export function PageFrame({ card }: { card: Card }) {
  const applyResolved = useFeed((s) => s.applyResolved);
  // Two iframes can exist for the same card at once (the always-mounted inline one + the
  // fullscreen Modal's, which loads a FRESH copy of the document when opened) — the source-identity
  // check below must accept a submit from either.
  const inlineRef = useRef<HTMLIFrameElement>(null);
  const fullRef = useRef<HTMLIFrameElement>(null);
  const [full, setFull] = useState(false);
  const [expectsResponse, setExpectsResponse] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>(card.status === 'responded' ? 'sent' : 'idle');
  // Guards "first submit wins" synchronously against a second postMessage landing before the
  // setSubmitState('sending') re-render takes effect — a plain ref, not state, so the check inside
  // the message handler always sees the up-to-date value on the very next event.
  const submittedRef = useRef(card.status === 'responded');

  const pageHtml = card.page_html;

  useEffect(() => {
    if (!pageHtml) return;
    function onMessage(event: MessageEvent) {
      // SECURITY BOUNDARY: identity, not origin. The sandboxed iframe's origin is opaque ('null')
      // — unforgeable-looking, but shared by every sandboxed same-tab frame, so an origin check
      // would accept a message from an unrelated embed elsewhere on the page. Comparing
      // event.source against OUR iframe's own contentWindow is the only check a same-tab attacker
      // frame can't spoof.
      const src = event.source;
      if (src !== inlineRef.current?.contentWindow && src !== fullRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const tag = (data as Record<string, unknown>).__relay;
      if (tag === 'ready') {
        if ((data as Record<string, unknown>).expectsResponse === true) setExpectsResponse(true);
        return;
      }
      if (tag !== 'submit') return; // wrong/unknown shape — ignore
      if (submittedRef.current) return; // first submit wins; every later one is silently ignored
      const payload = (data as Record<string, unknown>).payload;
      let json: string;
      try {
        json = JSON.stringify(payload === undefined ? null : payload);
      } catch {
        return; // not JSON-serializable — ignore (the page can retry with a valid payload)
      }
      if (json.length > MAX_PAYLOAD_JSON_LEN) return; // oversize — ignore
      submittedRef.current = true;
      setSubmitState('sending');
      void submitPayload(json);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHtml, card.id]);

  // Order matters (master doc §4): the payload's permanent home is the card_events row, never
  // `response` (which stays a bare verdict forever). Store the payload FIRST, then respond — so
  // anything that wakes on the verdict (relay_page's blocking poll) can already find the payload
  // when it looks. A 409 from respond means another client (or another tab) answered first.
  async function submitPayload(json: string) {
    await postCardEvent(card.id, 'payload', json);
    const r = await respond(card.id, 'submit', null);
    if (r.status === 'conflict') {
      setSubmitState('conflict');
      if (r.response) applyResolved(card.id, r.response);
      return;
    }
    if (r.status === 'error') {
      setSubmitState('error');
      return;
    }
    setSubmitState('sent');
    applyResolved(card.id, r.response);
  }

  if (!pageHtml) return null;

  const showBanner =
    card.status === 'pending' && (card.expects_response || expectsResponse) && submitState !== 'sent' && submitState !== 'conflict';

  return (
    <>
      <div style={{ marginTop: 8 }}>
        <SandboxedPageIframe
          ref={inlineRef}
          pageHtml={pageHtml}
          title={card.title}
          style={{ height: 'min(60vh, 480px)', borderRadius: 8 }}
        />
        <Group justify="space-between" align="center" mt={6} wrap="nowrap">
          <div>
            {showBanner ? (
              <Badge variant="light" color="indigo" size="sm" tt="none">
                waiting for your input
              </Badge>
            ) : submitState === 'sending' ? (
              <Text size="xs" c="dimmed">
                Sending…
              </Text>
            ) : submitState === 'sent' ? (
              <Text size="xs" c="teal">
                Answer sent ✓
              </Text>
            ) : submitState === 'conflict' ? (
              <Text size="xs" c="dimmed">
                Already answered
              </Text>
            ) : submitState === 'error' ? (
              <Text size="xs" c="red">
                Could not send
              </Text>
            ) : null}
          </div>
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
      <Modal opened={full} onClose={() => setFull(false)} fullScreen withinPortal title={card.title} padding="xs">
        <SandboxedPageIframe ref={fullRef} pageHtml={pageHtml} title={card.title} style={{ height: 'calc(100vh - 64px)' }} />
      </Modal>
    </>
  );
}
