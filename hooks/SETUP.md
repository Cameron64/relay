# Wiring the Relay hooks into Claude Code

The two hooks make your phone ping automatically:

- **Notification** → "Claude Code: &lt;message&gt;" whenever Claude is waiting on you.
- **Stop** → "✅ &lt;label&gt; — done" when a turn ends, **but only if** you ran
  `relay arm "<label>"` earlier in that session. No arm = no ping.

Both are **inert until `~/.relay/config.json` exists** (run `relay init` first), hard-timeout in
2.5s, and always exit 0 — they can't hang or break a session.

## Prereqs

```bash
# 1. point relay at your server (local or the deployed Railway URL)
node "/path/to/relay/bin/relay.mjs" init \
  --url https://<your-app>.up.railway.app --token <WRITE_TOKEN>
```

`node` is used (not `bun`) because it's reliably on the Windows system PATH that Claude Code's
Git-Bash hook shell sees.

## Option A — project-local (scoped to one repo)

Put this in **`<repo>/.claude/settings.json`**. The hooks fire only for Claude Code sessions
started in that repo. Good for trying it out.

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [ { "type": "command", "command": "node \"/path/to/relay/hooks/notify-hook.mjs\"", "timeout": 10 } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node \"/path/to/relay/hooks/stop-hook.mjs\"", "timeout": 10 } ] }
    ]
  }
}
```

## Option B — global (every session, everywhere)

This is what makes "Claude pings my phone whenever it needs me" true for *all* your work. Add the
**same `hooks` object** to your global **`~/.claude/settings.json`**.

- **Back it up first** (`cp settings.json settings.json.bak`).
- If a `hooks` key already exists, MERGE — append to the `Notification` / `Stop` arrays rather
  than replacing the object. Don't touch other keys.
- `timeout` is in **seconds**.

## Verify it fired

After wiring, trigger a permission prompt (or wait for Claude to ask for input) and confirm a
push lands on a subscribed device. For the Stop ping:

```bash
relay arm "smoke test"     # then end the turn → expect "✅ smoke test — done"
```

## Turn it off

- Temporary: `rm ~/.relay/config.json` (hooks go inert, no edits needed).
- Permanent: remove the `hooks` block from the settings file (restore your `.bak`).

## Notes

- The Stop arm-flag is keyed by the session's working directory (CLAUDE_SESSION_ID isn't
  reliably exported to subprocesses), so run `relay arm` from the repo you're working in.
- Hooks `.mjs` are run by `node` directly, so CRLF/LF doesn't matter (unlike `.sh` hooks).
