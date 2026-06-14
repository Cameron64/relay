# Relay — a Claude Code ⇄ phone / desktop bridge

Relay is a small installable PWA + a CLI + Claude Code hooks that bridge two gaps:

1. **Claude Code → your phone.** When a long task finishes or Claude needs input, a Web Push
   notification lands on your phone — fired automatically by Claude Code *hooks* or
   deliberately with `relay notify`.
2. **Claude Code → your desktop / phone.** Claude pushes **cards** — markdown, screenshots,
   Mermaid diagrams, drafts — with **dynamic buttons** (Approve / Request changes / Copy /
   open link). Cards appear live in the open app, and your answer **feeds back to Claude**,
   who can block on it (`relay card --wait`) when asking for approval.

Built on the `pwa-push-app` scaffold: **Bun + Hono + SQLite**, deployed on **Railway** (HTTPS,
required for service workers + Web Push).

```
Claude Code ──(hooks: needs-input / task-done)──┐
            └──(relay notify / relay card --wait)─┤
                                                  ▼
                                   relay CLI  ──HTTP+x-write-token──▶  Relay server (Railway)
                                                                          │  Web Push + SSE
                                                                          ▼
                                                              Phone + Desktop PWA (card inbox)
```

## Two tokens

| Token | Who holds it | Can | Where it lives |
|---|---|---|---|
| `WRITE_TOKEN` | Claude / CLI / hooks | create cards, broadcast push, read verdicts | server env + `~/.relay/config.json` — **never** in the browser |
| `UI_TOKEN` | the browser (you) | read the feed, respond, subscribe | server env + an **httpOnly cookie** set at unlock — never in JS-readable storage |

Both are compared in constant time. The UI cookie (not localStorage) is what lets the live
SSE feed authenticate, and keeps the token out of reach of any page-script.

## Local dev

```bash
bun install
bunx web-push generate-vapid-keys           # if regenerating; values already in .env
bun run dev                                   # http://localhost:3000
```

`localhost` is a secure context, so the service worker + push subscribe work on desktop.
Point the CLI at it and try a card:

```bash
bun bin/relay.mjs init --url http://localhost:3000 --token "$WRITE_TOKEN"
bun bin/relay.mjs card --kind approval --title "Approve?" --body "**test**" --wait
# open http://localhost:3000, paste the UI_TOKEN to unlock, tap Approve → the CLI prints the verdict
```

Tests + typecheck:

```bash
bun run test         # DB_PATH=:memory: bun test
bun run typecheck
```

## The CLI (`bin/relay.mjs`)

Zero-dependency, runs under `node` or `bun`. Reads `~/.relay/config.json`
(`{ "url", "writeToken" }`), overridable by `RELAY_URL` / `RELAY_WRITE_TOKEN`.

```
relay init  --url <https://...> --token <WRITE_TOKEN>
relay notify [--title T] [--body B] [--url U]          # body from stdin if piped
relay card  --title T [--body B|--body-stdin] [--kind note|approval|draft|diagram|image|choice]
            [--image PATH]... [--mermaid FILE|-]
            [--button "Label=action[:style]"]... [--link "Label=https://url"]...
            [--copy TEXT|--copy-stdin] [--no-push] [--high] [--wait[=SECS]]
relay poll  <cardId> [--wait=SECS]                     # re-poll an existing card's verdict
relay arm "<label>" | relay disarm                    # arm/clear the Stop-hook "done" ping
```

`--wait` / `poll` exit codes: **0**=approved · **20**=changes_requested · **1**=other/dismissed · **3**=timeout.

### Bounded-poll pattern (waiting for a human without tripping the harness)

A single tool call can't block forever (the Bash tool caps at 600s). So `relay card --wait=50`
does ONE bounded long-poll (≤50s). If you don't answer in time it exits **3** and prints the
card id; Claude then re-issues `relay poll <id> --wait=50` in a fresh call, repeating until you
respond. Arbitrarily long deliberation, every call within the limit. The verdict is persisted
server-side, so a re-poll always reads the final answer.

## Claude Code hooks

Two hooks (in `hooks/`) make the phone ping automatic. They are **inert until
`~/.relay/config.json` exists**, hard-timeout fast, and always exit 0 — so they can never hang
or break a session.

- **Notification** → pushes "Claude needs you" when Claude is waiting on you.
- **Stop** → if you ran `relay arm "<label>"` this session, pushes "✅ &lt;label&gt; — done" when
  the turn ends (and clears the flag). No arm = no ping, so ordinary turns stay quiet.

Wiring is opt-in (see `hooks/SETUP.md`): project-local `relay/.claude/settings.json` scopes the
hooks to this repo; promote to `~/.claude/settings.json` for every session everywhere. To turn
them off, remove the `hooks` block (or delete `~/.relay/config.json` to make them inert again).

## Deploy (Railway)

See `hooks/SETUP.md` and the `pwa-push-app` skill. In short: `railway init`, set the 5 secrets
(`VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT`, `WRITE_TOKEN`, `UI_TOKEN`), attach a volume at `/data`,
`railway up`, `railway domain`. Then `relay init --url <https-url> --token <WRITE_TOKEN>` and
subscribe on your phone (install to the home screen — iOS requires that for push).

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Railway healthcheck (DB-free) |
| GET | `/api/push/public-key` | — | VAPID public key |
| POST | `/api/push/subscribe` · `/unsubscribe` | — | manage a push subscription |
| POST | `/api/notify` | write | broadcast a push |
| POST | `/api/unlock` | UI_TOKEN body | set the httpOnly session cookie |
| POST | `/api/cards` | write | create a card (+ optional push) |
| GET | `/api/cards` · `/api/cards/:id` | UI | feed / one card |
| POST | `/api/cards/:id/respond` | UI | record a verdict |
| GET | `/api/cards/:id/response?wait=N` | write | long-poll the verdict |
| GET | `/api/cards/:id/asset/:aid` | UI | image bytes |
| GET | `/api/stream` | UI | SSE live feed |
