import { useEffect, useState } from 'react';
import { Button, Modal, Select, Stack, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { composeDispatch, fetchDispatchTargets } from '../api';
import { useFeed } from '../store/feed';
import type { DispatchTarget } from '../types';

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
  const [busy, setBusy] = useState(false);
  const upsertDispatch = useFeed((s) => s.upsertDispatch);

  // Load the target list + restore any mirrored draft each time the composer opens.
  useEffect(() => {
    if (!opened) return;
    setTarget(lockedTarget);
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

  const submit = async () => {
    if (!body.trim() || !target) return;
    setBusy(true);
    const r = await composeDispatch({
      title: title.trim() || null,
      body,
      target,
      resume_of: resumeOf,
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
        />
        <Button onClick={submit} loading={busy} disabled={!body.trim() || !target}>
          Send
        </Button>
      </Stack>
    </Modal>
  );
}
