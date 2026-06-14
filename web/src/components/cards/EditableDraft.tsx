import { useEffect } from 'react';
import { Button, Group, Stack } from '@mantine/core';
import { RichTextEditor } from '@mantine/tiptap';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import { assetUrl } from '../../api';
import { copyImage, copyRich, copyText } from '../../utils/clipboard';
import { markdownToSafeHtml } from '../../utils/markdown';
import type { Card } from '../../types';

// The `relay draft` template — a WYSIWYG editor Cam edits directly, then copies with formatting.
//
// EDIT-WIPE GUARD: the editor is created ONCE (useEditor with empty deps) and seeded from the
// card's markdown at mount. It never re-reads card.body, so an SSE card-updated for this card (which
// replaces the card object in the store and re-renders this component) can never wipe in-progress
// edits. The Feed keys each card by id, so this component instance is stable per card.
export function EditableDraft({ card, autoFocus }: { card: Card; autoFocus: boolean }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: markdownToSafeHtml(card.body ?? ''),
  });

  useEffect(() => {
    if (!autoFocus || !editor) return;
    const t = setTimeout(() => editor.commands.focus('end'), 300);
    return () => clearTimeout(t);
  }, [autoFocus, editor]);

  return (
    <Stack gap="sm">
      {card.assets?.length ? (
        <Stack gap="xs">
          {card.assets.map((a, i) => {
            const url = assetUrl(card.id, a.id);
            return (
              <Stack key={a.id} gap={6} align="flex-start">
                <img className="relay-asset-img" loading="lazy" alt={card.title} src={url} />
                <Button variant="outline" size="xs" onClick={() => copyImage(url)} aria-label={`Copy image ${i + 1}`}>
                  Copy image
                </Button>
              </Stack>
            );
          })}
        </Stack>
      ) : null}

      <RichTextEditor editor={editor} aria-label="Editable draft message">
        <RichTextEditor.Toolbar sticky={false}>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Bold />
            <RichTextEditor.Italic />
            <RichTextEditor.Strikethrough />
            <RichTextEditor.Code />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.H1 />
            <RichTextEditor.H2 />
            <RichTextEditor.H3 />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.BulletList />
            <RichTextEditor.OrderedList />
            <RichTextEditor.Blockquote />
          </RichTextEditor.ControlsGroup>
          <RichTextEditor.ControlsGroup>
            <RichTextEditor.Link />
            <RichTextEditor.Unlink />
          </RichTextEditor.ControlsGroup>
        </RichTextEditor.Toolbar>
        <RichTextEditor.Content />
      </RichTextEditor>

      <Group gap="xs">
        <Button onClick={() => editor && copyRich(editor.getHTML(), editor.getText())} disabled={!editor}>
          Copy formatted
        </Button>
        <Button variant="light" onClick={() => editor && copyText(editor.getText())} disabled={!editor}>
          Copy plain
        </Button>
      </Group>
    </Stack>
  );
}
