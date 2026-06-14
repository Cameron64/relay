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
        // htmlLabels:false renders labels as SVG <text> instead of <foreignObject> HTML — the
        // foreignObject would otherwise be stripped by the SVG-only DOMPurify pass below, leaving
        // empty boxes with no labels.
        mermaid.initialize({
          securityLevel: 'strict',
          startOnLoad: false,
          theme: 'dark',
          flowchart: { htmlLabels: false },
        });
        const id = 'mmd-' + crypto.randomUUID();
        const { svg: rendered } = await mermaid.render(id, code);
        const clean = DOMPurify.sanitize(rendered, { USE_PROFILES: { svg: true, svgFilters: true } });
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
