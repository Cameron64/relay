import { useEffect, useState } from 'react';
import { Text, useComputedColorScheme } from '@mantine/core';

// Lazily code-split Mermaid (large) — only loaded when a diagram card actually renders.
//
// Rendered with securityLevel:'strict', which makes Mermaid run DOMPurify on its OWN output
// internally (escaping label text, disabling click handlers / scripts). That internal pass IS the
// security boundary, and it's sufficient here: diagram source only ever arrives via the local,
// write-token-gated relay CLI, so there is no untrusted third-party input.
//
// We deliberately do NOT re-sanitize the SVG ourselves. An external DOMPurify pass treats the
// output as a pure-SVG tree and strips the HTML-namespaced <div>/<span> children inside Mermaid's
// <foreignObject> node/edge labels, leaving empty boxes. This was verified empirically against
// mermaid@11.15.0 + dompurify@3.4.10: every USE_PROFILES / ADD_TAGS / html-profile combination
// preserved the <foreignObject> shells but emptied them (foVisible 0/9); only the un-re-sanitized
// output rendered all labels (9/9). flowchart.htmlLabels:false does NOT help — strict mode still
// emits foreignObject labels and never falls back to <text>.
//
// The theme follows the active Mantine color scheme so label text contrasts the card background in
// both light ('default') and dark ('dark') mode; the effect re-runs on a scheme toggle.
export function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          securityLevel: 'strict',
          startOnLoad: false,
          theme: scheme === 'dark' ? 'dark' : 'default',
        });
        const id = 'mmd-' + crypto.randomUUID();
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) setSvg(rendered);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, scheme]);

  if (failed) return <pre className="mermaid-fallback">{code}</pre>;
  if (svg === null) return <Text c="dimmed" size="sm">Rendering diagram…</Text>;
  return <div className="mermaid-host" dangerouslySetInnerHTML={{ __html: svg }} />;
}
