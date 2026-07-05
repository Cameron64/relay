# Wiring the Relay hooks into Claude Code

These hooks make your phone ping automatically — and, for PreToolUse, let you approve/deny
tool calls from the phone when you're AFK. SessionStart/SessionEnd are the odd ones out: they
never push, they only feed the Sessions dashboard's audit trail.

- **Notification** → "Claude Code: &lt;message&gt;" whenever Claude is waiting on you.
- **Stop** → "✅ &lt;label&gt; — done" when a turn ends, **but only if** you ran
  `relay arm "<label>"` earlier in that session. No arm = no ping.
- **PreToolUse** (`pretool-hook.mjs`) → **triple-gated**: only intercepts when config exists AND
  `relay afk on` is flagged AND `~/.relay/permission-rules.json` has a matching rule. See
  "PreToolUse — the AFK permission bridge" below for the full picture.
- **SessionStart** (`session-start-hook.mjs`) / **SessionEnd** (`session-end-hook.mjs`) →
  relay-roadmap Plan 03: silent (`deliver:false`) audit-trail rows, no push, no approval flow.
  They're what lets the PWA's Sessions view show "which sessions exist right now" and flip a
  session to 'ended' when it closes cleanly.

All are **inert until `~/.relay/config.json` exists** (run `relay init` first), hard-timeout
fast, and always exit 0 — they can't hang or break a session. (PreToolUse's *decision* — allow /
deny / ask — is JSON on stdout, not a non-zero exit; see below.)

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
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "node \"/path/to/relay/hooks/pretool-hook.mjs\"", "timeout": 600 } ] }
    ],
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"/path/to/relay/hooks/session-start-hook.mjs\"", "timeout": 10 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node \"/path/to/relay/hooks/session-end-hook.mjs\"", "timeout": 10 } ] }
    ]
  }
}
```

`PreToolUse`'s matcher is `*` (every tool) — the hook itself filters via the three gates above, so
the rule logic lives in ONE place (`~/.relay/permission-rules.json`) instead of being duplicated
across settings matchers. Its `timeout` is 600s (not 10s like the other two) to give a human on
the phone real time to answer; the hook's own poll deadline (`RELAY_PERM_DEADLINE_SECS`, default
540s) stays comfortably under that.

## Option B — global (every session, everywhere)

This is what makes "Claude pings my phone whenever it needs me" true for *all* your work. Add the
**same `hooks` object** to your global **`~/.claude/settings.json`**.

- **Back it up first** (`cp settings.json settings.json.bak`).
- If a `hooks` key already exists, MERGE — append to the `Notification` / `Stop` / `PreToolUse` /
  `SessionStart` / `SessionEnd` arrays rather than replacing the object. Don't touch other keys.
- `timeout` is in **seconds**.

## PreToolUse — the AFK permission bridge

Wiring the hook (above) is only step 1 — it does nothing until you opt in:

```bash
# 2. opt in: copy the example rules file and edit it to taste
cp "/path/to/relay/hooks/permission-rules.example.json" ~/.relay/permission-rules.json
```

Each rule is `{ "tool": "Bash", "inputMatch": "<regex, optional>" }`. `tool` must match the Claude
Code tool name exactly (`Bash`, `Write`, `Edit`, …). Omit `inputMatch` to intercept EVERY call of
that tool; include it to test a regex against `JSON.stringify(tool_input)` (always matched
case-insensitively). No file at `~/.relay/permission-rules.json` → the hook never intercepts, even
while AFK — this file is the second half of the opt-in (the first half is `relay afk on`).

With the hook wired and rules in place:

```bash
relay afk on                          # flip the flag — this hook is a no-op until you do
# ... run a session; trigger a call that matches a rule (e.g. a Write) ...
# → phone gets a sticky "⚠ project — allow Write?" approval card
# Allow  → the tool runs
# Deny (+ optional note) → the call is denied; Claude sees the note and can redirect
relay afk off                         # back at your desk — hook goes silent again, terminal prompts as normal
```

If nothing happens: confirm `relay afk status` reports AFK, confirm
`~/.relay/permission-rules.json` has a rule for that exact tool name, and confirm the
`PreToolUse` block landed in the settings file you expected (project-local vs. global).

## Verify it fired

After wiring, trigger a permission prompt (or wait for Claude to ask for input) and confirm a
push lands on a subscribed device. For the Stop ping:

```bash
relay arm "smoke test"     # then end the turn → expect "✅ smoke test — done"
```

For PreToolUse, do the `relay afk on` smoke test above.

For SessionStart/SessionEnd: start (then end) a Claude Code session with the hooks wired, open
the PWA, and check Activity for two `session` rows (`Session started` / `Session ended`) tagged
🔕 silenced — they never buzz the phone. The Sessions view (Plan 03) should show that session as
`ended` once the SessionEnd row lands.

## Turn it off

- Temporary: `rm ~/.relay/config.json` (hooks go inert, no edits needed); for PreToolUse alone,
  `relay afk off` or `rm ~/.relay/permission-rules.json` also suffices.
- Permanent: remove the `hooks` block from the settings file (restore your `.bak`).

## Notes

- The Stop arm-flag is keyed by the session's working directory (CLAUDE_SESSION_ID isn't
  reliably exported to subprocesses), so run `relay arm` from the repo you're working in.
- Hooks `.mjs` are run by `node` directly, so CRLF/LF doesn't matter (unlike `.sh` hooks).
- PreToolUse fires on EVERY tool call of every session with the hook wired — its three gates
  (config / AFK / rule match) are all fast local file reads, so an unmatched call costs
  effectively nothing beyond `node` process startup.
- Verified (2026 Claude Code docs) that PreToolUse can't override a call Claude Code has already
  allowlisted in settings — those proceed without ever reaching this hook. That's correct: we only
  want to intercept calls that would otherwise stall at a prompt, not calls you've already decided
  are always fine.
