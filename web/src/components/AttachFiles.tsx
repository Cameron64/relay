import { ActionIcon, Button, FileButton, Group, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { MAX_FILES, MAX_FILE_BYTES, humanSize } from '../utils/files';

// Controlled multi-file picker shared by the dispatch composer and the card-reply composers.
// The parent owns the File[] (so it can base64 them on submit and clear them after) — this only
// renders the picker button + a removable chip per selected file, and enforces the count/size caps
// with a toast. Any mime is accepted (a reply may be a screenshot, a log, a PDF).
export function AttachFiles({
  files,
  onChange,
  label = 'Attach files',
  size = 'sm',
}: {
  files: File[];
  onChange: (files: File[]) => void;
  label?: string;
  size?: 'xs' | 'sm';
}) {
  const add = (picked: File[]) => {
    if (!picked.length) return;
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) {
      notifications.show({ message: `Too large (max ${humanSize(MAX_FILE_BYTES)}): ${tooBig.map((f) => f.name).join(', ')}` });
    }
    const ok = picked.filter((f) => f.size <= MAX_FILE_BYTES);
    const merged = [...files];
    for (const f of ok) {
      if (!merged.some((e) => e.name === f.name && e.size === f.size)) merged.push(f);
    }
    if (merged.length > MAX_FILES) {
      notifications.show({ message: `At most ${MAX_FILES} files — keeping the first ${MAX_FILES}` });
    }
    onChange(merged.slice(0, MAX_FILES));
  };

  const remove = (idx: number) => onChange(files.filter((_, i) => i !== idx));

  return (
    <>
      <Group gap="xs">
        <FileButton onChange={add} accept="image/*,*/*" multiple>
          {(props) => (
            <Button {...props} variant="light" size="xs" disabled={files.length >= MAX_FILES}>
              {label}
            </Button>
          )}
        </FileButton>
        {files.length > 0 && (
          <Text size="xs" c="dimmed">
            {files.length}/{MAX_FILES}
          </Text>
        )}
      </Group>
      {files.map((f, i) => (
        <Group key={`${f.name}-${f.size}-${i}`} gap="xs" wrap="nowrap" justify="space-between">
          <Text size={size} truncate style={{ flex: 1 }}>
            {f.name}
          </Text>
          <Text size="xs" c="dimmed">
            {humanSize(f.size)}
          </Text>
          <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => remove(i)} aria-label={`Remove ${f.name}`}>
            ✕
          </ActionIcon>
        </Group>
      ))}
    </>
  );
}
