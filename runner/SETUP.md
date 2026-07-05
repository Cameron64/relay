# Setting up the relay runner (desktop side of the phone-brainstorm bridge)

The runner is an always-on daemon (`bin/relay-runner.mjs`) that long-polls Relay's server for
queued **dispatches** — text you send from the phone with no Claude session open — and spawns a
headless `claude -p` locally to work on them. See the design doc at
`.claude-work/plans/2026/07/05/relay-roadmap/02-inbox-dispatch-runner.md` for the full picture.

**Security model**: the server only ever hands the runner a target *id* + free text. Every actual
filesystem path lives in `~/.relay/runner.json`, on THIS machine, never in the database — a
compromised server can feed odd text to a pre-approved project, never run an arbitrary command or
leave that project. See `src/dispatch-store.ts`'s header comment for the full invariant.

## 1. Configure Relay itself (if you haven't already)

```bash
node "C:/Users/you/source/repos/personal/relay/bin/relay.mjs" init \
  --url https://<your-app>.up.railway.app --token <WRITE_TOKEN>
```

This writes `~/.relay/config.json` — the runner reads the SAME file (same `WRITE_TOKEN`
the CLI/hooks/MCP server use). Never embed the write token in anything served to the browser.

## 2. Write your runner config

Copy the example and edit it:

```bash
cp "C:/Users/you/source/repos/personal/relay/runner/runner.example.json" ~/.relay/runner.json
```

```json
{
  "host": "my-desktop",
  "concurrency": 1,
  "targets": [
    { "id": "personal", "label": "personal repos", "cwd": "C:/Users/you/source/repos/personal", "permissionMode": "acceptEdits" },
    { "id": "notes", "label": "brainstorm triage", "cwd": "C:/Users/you/source/repos/personal", "permissionMode": "plan",
      "promptPrefix": "Triage this phone brainstorm: organize it, identify action items, and propose next steps. Do not modify files.\n\n" }
  ]
}
```

- `id` is what shows up in the phone's compose picker (via `GET /api/dispatch-targets`) — pick
  short, stable ids; they get baked into any dispatch you compose against them.
- `label` is the human-readable picker text.
- `cwd` is where `claude -p` is spawned — this NEVER leaves your machine (see the security note
  above). Pick directories you're comfortable an agent editing unattended, scoped by...
- `permissionMode` — `acceptEdits` (edits happen without asking), `plan` (read-only planning, no
  edits — good for a "just triage this" target), or `default`/`bypassPermissions` if you know what
  you're doing. Unset defaults to `default`.
- `promptPrefix` (optional) — prepended to every job on this target; use it to steer tone/scope
  (e.g. "don't touch files" for a read-only triage target).
- `concurrency` is parsed but not yet enforced beyond 1 — v1 always runs one job at a time (the
  plan's explicit choice: two headless sessions colliding in the same repo is worse than a queue).

## 3. Smoke-test it in a foreground terminal first

```bash
node "C:/Users/you/source/repos/personal/relay/bin/relay-runner.mjs"
```

You should see `relay-runner starting — host="..." targets=[...]` and an "announced N target(s)"
line on stderr. Leave it running, then from the phone (or `curl`) compose a dispatch and watch it
get claimed within a few seconds. Ctrl+C to stop.

## 4. Install it to start automatically on login (Windows)

```bat
runner\install-startup.bat
```

This drops a shortcut in your Startup folder that launches `runner\start-hidden.vbs` (no visible
console window) → `runner\start.bat` → `node bin/relay-runner.mjs`. Logs go to
`%USERPROFILE%\.relay\runner.log` (rotated once at ~5 MB), not a console window, since there isn't
one. Re-run `install-startup.bat` any time you move the repo — it just overwrites the shortcut.

To start it right now without logging out again, double-click `runner\start-hidden.vbs`.

## Troubleshooting

- **Nothing gets claimed**: check `~/.relay/runner.log` — the most common cause is `runner.json`
  missing/invalid (the runner refuses to start and logs why) or the write token not matching the
  server's `WRITE_TOKEN`.
- **"unknown target" failures**: the phone's compose picker only shows targets THIS runner most
  recently announced (`POST /api/dispatch-targets` on startup) — if you edited `runner.json`,
  restart the runner so the new target list gets pushed.
- **A job never finishes**: it's killed after `RUNNER_JOB_TIMEOUT_MIN` (default 30; override via
  the environment before starting the runner) and reported back as `failed`.
