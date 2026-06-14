import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeSanitize from 'rehype-sanitize';
import { TypographyStylesProvider } from '@mantine/core';

// Display markdown: GFM + remark-breaks (single newline -> <br>, matching the old marked breaks:true)
// + rehype-sanitize (safe HTML, no dangerouslySetInnerHTML). Links open in a new tab.
export function Markdown({ children }: { children: string }) {
  return (
    <TypographyStylesProvider>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a({ node: _node, ...props }) {
            return <a {...props} target="_blank" rel="noopener noreferrer" />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </TypographyStylesProvider>
  );
}
