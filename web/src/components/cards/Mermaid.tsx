import { useEffect, useState } from 'react';
import { Text } from '@mantine/core';
import DOMPurify from 'dompurify';

// Lazily code-split Mermaid (large) — only loaded when a diagram card actually renders. Rendered
// with securityLevel:'strict' (a separate trust path from the markdown sanitize), then the SVG is
// DOMPurify-sanitized before injection. A unique render id per invocation avoids id collisions
// across React re-renders. On failure, falls back to showing the diagram source.
export function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        // theme:'dark' gives light text + edge strokes that are visible on Relay's dark card.
        // Keep Mermaid's DEFAULT html labels: flowchart.htmlLabels:false lays node text out at zero
        // size in v11, leaving empty boxes (edge labels still render, node labels don't).
        mermaid.initialize({
          securityLevel: 'strict',
          startOnLoad: false,
          theme: 'dark',
        });
        const id = 'mmd-' + crypto.randomUUID();
        const { svg: rendered } = await mermaid.render(id, code);
        // Mermaid renders node/edge labels as HTML inside <foreignObject>. A svg-only DOMPurify pass
        // keeps the <foreignObject> shell but strips its <div>/<span> contents — empty boxes. Add the
        // html profile (and foreignObject itself) so the label markup survives sanitization.
        const clean = DOMPurify.sanitize(rendered, {
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
          ADD_TAGS: ['foreignObject'],
        });
        if (!cancelled) setSvg(clean);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) return <pre className="mermaid-fallback">{code}</pre>;
  if (svg === null) return <Text c="dimmed" size="sm">Rendering diagram…</Text>;
  return <div className="mermaid-host" dangerouslySetInnerHTML={{ __html: svg }} />;
}
