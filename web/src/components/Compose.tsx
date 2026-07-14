import { useEffect, useState } from 'react';
import { ActionIcon, Button, FileButton, Group, Modal, Select, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { composeDispatch, fetchDispatchTargets } from '../api';
import { useFeed } from '../store/feed';
import type { DispatchTarget } from '../types';

// A target is STALE once its runner hasn't re-announced within this window. Runners heartbeat
// every 5 minutes (see bin/relay-runner.mjs), so 15 minutes tolerates a few missed beats before
// flagging — long enough to avoid false "is it running?" scares, short enough to catch a runner
// that's actually down.
const STALE_TARGET_MS = 15 * 60 * 1000;

function isStale(t: DispatchTarget): boolean {
  if (!t.updatedAt) return false; // no timestamp (shouldn't happen post-migration) — don't flag
  return Date.now() - new Date(t.updatedAt).getTime() > STALE_TARGET_MS;
}

// Coarse "3d ago" / "5m ago" relative-time for the picker description — deliberately imprecise
// (this is a freshness hint, not a clock).
function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Attachment caps — mirror src/dispatch-store.ts (MAX_DISPATCH_ASSETS / DISPATCH_ASSET_MAX_BYTES).
// Enforced client-side for immediate feedback; the server re-enforces regardless.
const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

// Read a File into base64 (no data: prefix) for the compose payload's assets[].data field.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// The "+" compose view (relay-roadmap Plan 02) — the phone's half of the bridge. A long brainstorm
// with NO Claude session open, a target picker, and Send; the desktop runner (bin/relay-runner.mjs)
// picks the queued job up on its own schedule. Reached from TopBar's "+" button for a fresh
// dispatch, or from a DispatchItem's "Follow-up" button (resumeOf + lockedTarget set) once a prior
// job is done.
//
// Draft safety (the plan's explicit requirement): the textarea/title mirror to localStorage on
// every keystroke and are only cleared on a SUCCESSFUL submit — a phone browser evicting this tab
// mid-brainstorm must not eat 20 minutes of typing. The mirror is keyed by resumeOf (or a fixed key
// for a fresh compose) so a follow-up draft can't bleed into a later fresh one.

const LAST_TARGET_KEY = 'relay_last_target';

function draftKey(resumeOf: string | null): string {
  return resumeOf ? `relay_compose_draft_resume_${resumeOf}` : 'relay_compose_draft_new';
}

export function Compose({
  opened,
  onClose,
  resumeOf = null,
  lockedTarget = null,
}: {
  opened: boolean;
  onClose: () => void;
  resumeOf?: string | null;
  lockedTarget?: string | null;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [target, setTarget] = useState<string | null>(lockedTarget);
  const [targets, setTargets] = useState<DispatchTarget[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const upsertDispatch = useFeed((s) => s.upsertDispatch);
  const targetsById = new Map(targets.map((t) => [t.id, t]));

  // Load the target list + restore any mirrored draft each time the composer opens.
  useEffect(() => {
    if (!opened) return;
    setTarget(lockedTarget);
    setFiles([]); // attachments aren't mirrored to the draft (too large) — start each open clean
    (async () => {
      const r = await fetchDispatchTargets();
      if (r.status === 'ok') setTargets(r.targets);
    })();
    const saved = localStorage.getItem(draftKey(resumeOf));
    if (saved) {
      try {
        const d = JSON.parse(saved);
        setTitle(typeof d.title === 'string' ? d.title : '');
        setBody(typeof d.body === 'string' ? d.body : '');
      } catch {
        /* corrupt draft — start fresh rather than throw */
      }
    } else {
      setTitle('');
      setBody('');
    }
    if (!lockedTarget) {
      const last = localStorage.getItem(LAST_TARGET_KEY);
      if (last) setTarget(last);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, resumeOf]);

  // Mirror on every change while open (see the header comment on draft safety).
  useEffect(() => {
    if (!opened) return;
    localStorage.setItem(draftKey(resumeOf), JSON.stringify({ title, body }));
  }, [opened, resumeOf, title, body]);

  // Add newly-picked files, rejecting oversized ones and enforcing the count cap. FileButton hands
  // us the full current selection each time, so we append + de-dupe by name+size rather than replace.
  const addFiles = (picked: File[]) => {
    if (!picked.length) return;
    const tooBig = picked.filter((f) => f.size > MAX_FILE_BYTES);
    if (tooBig.length) {
      notifications.show({ message: `Too large (max ${humanSize(MAX_FILE_BYTES)}): ${tooBig.map((f) => f.name).join(', ')}` });
    }
    const ok = picked.filter((f) => f.size <= MAX_FILE_BYTES);
    setFiles((prev) => {
      const merged = [...prev];
      for (const f of ok) {
        if (!merged.some((e) => e.name === f.name && e.size === f.size)) merged.push(f);
      }
      if (merged.length > MAX_FILES) {
        notifications.show({ message: `At most ${MAX_FILES} files — keeping the first ${MAX_FILES}` });
      }
      return merged.slice(0, MAX_FILES);
    });
  };

  const removeFile = (idx: number) => setFiles((prev) => prev.filter((_, i) => i !== idx));

  const submit = async () => {
    if (!body.trim() || !target) return;
    setBusy(true);
    let assets: { filename: string; mime: string; data: string }[] | undefined;
    try {
      assets = files.length
        ? await Promise.all(
            files.map(async (f) => ({
              filename: f.name,
              mime: f.type || 'application/octet-stream',
              data: await fileToBase64(f),
            })),
          )
        : undefined;
    } catch {
      setBusy(false);
      notifications.show({ message: 'Could not read an attachment — try removing it and resending' });
      return;
    }
    const r = await composeDispatch({
      title: title.trim() || null,
      body,
      target,
      resume_of: resumeOf,
      assets,
    });
    setBusy(false);
    if (r.status === 'error') {
      notifications.show({ message: r.error || 'Could not send' });
      return;
    }
    upsertDispatch(r.dispatch);
    if (!lockedTarget) localStorage.setItem(LAST_TARGET_KEY, target);
    localStorage.removeItem(draftKey(resumeOf));
    setTitle('');
    setBody('');
    setFiles([]);
    notifications.show({ message: 'Sent — the runner will pick it up' });
    onClose();
  };

  return (
    <Modal opened={opened} onClose={onClose} title={resumeOf ? 'Follow up' : 'New dispatch'} size="md">
      <Stack gap="md">
        <TextInput
          label="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          placeholder="What's this about?"
        />
        <Textarea
          label="Brainstorm / instructions"
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
          autosize
          minRows={8}
          styles={{ input: { fontSize: 16 } }} // 16px keeps Android/Chrome from zooming on focus
          placeholder="Paste or type as much as you want — this goes straight to a Claude session on your desktop."
          autoFocus
        />
        <Stack gap="xs">
          <Group gap="xs">
            <FileButton onChange={addFiles} accept="image/*,*/*" multiple>
              {(props) => (
                <Button {...props} variant="light" size="xs" disabled={files.length >= MAX_FILES}>
                  Attach files
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
              <Text size="sm" truncate style={{ flex: 1 }}>
                {f.name}
              </Text>
              <Text size="xs" c="dimmed">
                {humanSize(f.size)}
              </Text>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`}>
                ✕
              </ActionIcon>
            </Group>
          ))}
        </Stack>
        <Select
          label="Target"
          placeholder="Where should this run?"
          data={targets.map((t) => ({ value: t.id, label: t.label }))}
          value={target}
          onChange={setTarget}
          disabled={!!lockedTarget}
          description={lockedTarget ? 'Locked to the original session’s target' : undefined}
          searchable
          nothingFoundMessage="No runner has announced any targets yet"
          renderOption={({ option, checked }) => {
            const t = targetsById.get(option.value);
            const stale = t ? isStale(t) : false;
            return (
              <Group flex="1" gap="xs" justify="space-between" wrap="nowrap">
                <Text size="sm" c={stale ? 'dimmed' : undefined} style={{ flex: 1 }} truncate>
                  {option.label}
                </Text>
                {t?.host && (
                  <Text size="xs" c="dimmed" truncate>
                    {stale && t.updatedAt ? `${t.host} · seen ${relativeAge(t.updatedAt)}` : t.host}
                  </Text>
                )}
                {checked && <Text size="xs">✓</Text>}
              </Group>
            );
          }}
        />
        {!lockedTarget && targets.length > 0 && targets.every(isStale) && (
          <Text size="xs" c="dimmed">
            No runner has announced recently — is your runner running?
          </Text>
        )}
        <Button onClick={submit} loading={busy} disabled={!body.trim() || !target}>
          Send
        </Button>
      </Stack>
    </Modal>
  );
}
