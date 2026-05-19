# Agent Web MVP

> **Experimental project.**

Self-hosted web UI for driving local AI coding agents (Claude Code, Codex
CLI) from a browser.

## Architecture

```
┌─────────────┐   /ws    ┌──────────────────┐   /client   ┌──────────────────┐
│   Browser   │ ◄───────►│  Node.js server  │ ◄─────────► │  Go daemon       │
│  (React)    │          │  (Express + ws)  │             │    (vvibe)       │
└─────────────┘          └──────────────────┘             └────────┬─────────┘
                                                                   ▼
                                                      ┌──────────────────────────┐
                                                      │ Claude Agent SDK / codex │
                                                      │    (daemon machine)      │
                                                      └──────────────────────────┘
```

Two execution paths share one server + session model. Which one a session
uses is decided by `userId` at construction time
([`server/sessions.ts`](./server/sessions.ts) `makeRunnerFactory`):

- **Authed path** — Browser ↔ server ↔ paired Go daemon ↔ Claude/Codex on
  the daemon's machine. `RemoteRunner` on the server relays prompts over
  `/client` WS; the daemon runs the agent in the user's cwd. The daemon
  registers as an OS service (`vvibe install`), holds the pairing token,
  enforces a cwd allowlist before spawning, and auto-reconnects after
  reboots. **This is the production path** — any non-`anon` user goes
  through it.
- **Anonymous dev mode** — Single-machine fallback when no OAuth env vars
  are set. The server spawns `claude` / `codex` directly via local
  `ClaudeRunner` / `CodexRunner`; any paired daemon shown in the sidebar
  is decorative (`RemoteRunner` is bypassed). Exists so `npm run dev`
  works without setting up GitHub OAuth.

- **Sessions** live on the server (SQLite-backed, including Claude resume
  token + history) and survive page reloads *and* daemon reconnects.
- **Claude** uses `@anthropic-ai/claude-agent-sdk` with the `canUseTool`
  callback. On the authed path, the daemon spawns a small embedded Node
  bridge ([`client-go/helpers/claude-bridge.mjs`](./client-go/helpers/claude-bridge.mjs))
  to host the SDK; permission prompts are forwarded all the way back to
  the browser as a modal.
- **Codex** spawns `codex exec` per turn (no permission UI yet — relies
  on Codex's own `--ask-for-approval` / `--full-auto` flags via
  `CODEX_ARGS`). Gated behind `CODEX_TRUST_DEFAULTS=1`, enforced on both
  server and daemon.

## Prerequisites

- Node.js 20+
- One or both of:
  - `claude` CLI logged in (`claude login`) **or** an `ANTHROPIC_API_KEY`
  - `codex` CLI on PATH (override with `CODEX_BIN`)

## Install

```sh
npm install
cp .env.example .env   # edit if you want
```

## Run (dev)

```sh
npm run dev
```

- Backend: http://127.0.0.1:8787
- Frontend (Vite dev server with HMR): http://localhost:5173

Open the frontend URL. Vite proxies `/ws`, `/api`, `/auth`, and the install
scripts to the backend automatically.

### Local dev modes (anonymous vs authenticated)

Two flavours of local dev — pick based on what you're trying to test:

**Anonymous mode** (no GitHub OAuth env vars, the default):
- The whole app maps to a single synthetic `anon` user.
- Sessions run **on the dev server itself** (local `ClaudeRunner` /
  `CodexRunner` spawning your machine's `claude` / `codex` binaries).
- A paired daemon, if any, shows up in the sidebar but is **decorative**:
  `RemoteRunner` is bypassed for `anon`. So device pinning, daemon routing,
  and the cwd directory picker (when targeting a remote daemon) are not
  exercised in this mode.
- Best for: iterating on chat UI, session list, prompts against your local
  Claude/Codex.

**Authenticated mode** (set `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`):
- Real GitHub OAuth + per-user device pairing. Sessions go through
  `RemoteRunner` → daemon → agent CLI on the daemon's machine.
- Setup: create a GitHub OAuth App
  (https://github.com/settings/developers → New OAuth App) with:
  - Homepage: `http://127.0.0.1:8787`
  - Callback: `http://127.0.0.1:8787/auth/github/callback`
  Then drop the credentials into `.env`.
- Best for: testing the daemon path, multi-device picker, cwd browser,
  permission flow, anything that touches `/client` WS.

The two modes use the same SQLite DB but different `user_id`s (`anon`
vs your GitHub UUID), so they don't interfere. Switching just means
restarting the server after changing `.env`.

## Run (production build)

```sh
npm run build       # builds the frontend into dist/web
npm start           # backend serves the built frontend + WebSocket
```

Then open http://127.0.0.1:8787.

## Configuration (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP + WS port |
| `HOST` | `127.0.0.1` | **Keep on localhost.** Only change if tunnelling. |
| `DEFAULT_CWD` | `process.cwd()` | Pre-filled working dir for new sessions |
| `ANTHROPIC_API_KEY` | — | API key for Claude (falls back to `claude` CLI auth) |
| `CODEX_BIN` | `codex` | Path to the Codex binary |
| `CODEX_ARGS` | — | Extra args injected before the prompt, e.g. `--full-auto` |

## Remote access (the careful way)

The server binds to `127.0.0.1` on purpose: this app runs *real* shell
commands inside your `cwd` via the agent. Do **not** expose it to the public
internet directly. Recommended:

- **Tailscale / Tailscale Funnel** — install Tailscale on this machine and your
  phone/laptop, then hit `http://<tailnet-name>:8787` from anywhere.
- **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:8787`,
  protect with Cloudflare Access (email / IdP).
- **VS Code Tunnel** — if you only need terminal access, this is simpler.

If you set `HOST=0.0.0.0`, anyone on the network can run code on your
machine. Always pair that with one of the above.

## Installing the daemon on a new machine

The hosted server only renders the UI; it can't see your filesystem. To
actually drive `claude` / `codex` against your code, install the
**`vvibe`** daemon on each machine you want to drive from the web UI.

One-line install from the hosted server (downloads a release tarball from
GitHub, verifies sha256, drops the binary on PATH). The URLs below point
at the maintainer's hosted instance; if you're running your own server,
substitute its origin.

```sh
# macOS / Linux
curl -fsSL https://agent-web-mvp-renddi.fly.dev/install.sh | sh

# Windows (PowerShell, no admin needed for this step)
iwr https://agent-web-mvp-renddi.fly.dev/install.ps1 | iex
```

Then pair the machine with your account:

```sh
vvibe login                  # pair: opens device-code flow, browser-side approval
vvibe run                    # foreground run — verify it works before installing
```

You should immediately see the device appear in the web UI sidebar with a
green dot. Ctrl-C to stop.

To make the daemon auto-start at boot, register it as an OS service:

```sh
vvibe install                # macOS / Linux: no admin needed
                             # Windows: needs Administrator PowerShell
vvibe status                 # confirm it's running
```

Skipping `install` is fine for casual / single-machine use — `vvibe run`
in a terminal works the same way.

The daemon stores its config under your user profile (`%AppData%\vvibe\`,
`~/Library/Application Support/vvibe/`, `~/.config/vvibe/`) and
auto-reconnects after reboots. Binaries are not yet code-signed — Windows
SmartScreen / macOS Gatekeeper may warn on first run. The release
pipeline is wired for signing once the certs exist; see
[client-go/SIGNING.md](./client-go/SIGNING.md) for procurement + setup.

The install scripts also check whether `claude` and `codex` are on PATH
on the same machine, and report `[ok]` / `[--]` per agent. Missing CLIs
won't block installation but will surface as `not installed` in the web
UI's agent picker until you add them.

### Updating

```sh
vvibe upgrade --check   # report whether a new version is available
vvibe upgrade           # download, verify sha256, restart the service
vvibe upgrade --yes     # skip the y/N prompt (for scripts)
```

`upgrade` stops the OS service (if registered + running), atomically
replaces the binary, and starts the service back up. If the daemon
isn't running as a service (`vvibe run` foreground), it just swaps the
file.

If you want to build from source instead, see
[`client-go/README.md`](./client-go/README.md).

### Uninstalling

`vvibe uninstall` removes the OS service but intentionally leaves the
binary, config, log, and PATH edit in place — handy if you just want to
stop auto-start without losing your pairing. To remove everything:

**macOS**

```sh
vvibe uninstall                                       # 1. stop + remove service (skip if never `vvibe install`-ed)
rm "$(command -v vvibe)"                              # 2. binary (sudo if it's in /usr/local/bin)
rm -rf "$HOME/Library/Application Support/vvibe"     # 3. token, log, client.json
# 4. open ~/.zshrc and delete this block (only present if installer added it):
#       # vvibe (added by installer) — remove this block to undo
#       export PATH="$HOME/.local/bin:$PATH"
# 5. (optional) remove the now-orphaned device from the web UI's device list.
```

**Linux** — same as macOS, except step 3 is `rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/vvibe"`, and step 4's block lives in `~/.bashrc` (or fish's `config.fish`).

**Windows (PowerShell)**

```powershell
vvibe uninstall                                       # admin PS; skip if never `vvibe install`-ed
Remove-Item -Recurse "$env:LOCALAPPDATA\Programs\Vvibe"   # binary
Remove-Item -Recurse "$env:APPDATA\vvibe"                 # token, log, client.json
# Remove from User PATH:
$p = [Environment]::GetEnvironmentVariable('Path','User') -split ';' |
     Where-Object { $_ -ne "$env:LOCALAPPDATA\Programs\Vvibe" }
[Environment]::SetEnvironmentVariable('Path', ($p -join ';'), 'User')
```

The server still has a record of the paired device until you remove it
from the web UI's device list; otherwise it just shows offline forever.

## Known limitations (this MVP)

- Codex sessions are stateless per prompt (no chat memory). Codex is
  also gated behind `CODEX_TRUST_DEFAULTS=1` server-side until proper
  in-UI permission flow lands.
- Tool permission UI exists only for Claude.
- No file diff viewer, no git integration, no notifications.
- Daemon binaries are unsigned (SmartScreen / Gatekeeper warnings).

These are intentional cuts to keep the MVP small. See [`ROADMAP.md`](./ROADMAP.md)
for the prioritised next-step plan.

## Project layout

```
agent-web-mvp/
├── server/                  # Node + tsx backend
│   ├── index.ts             # Express + ws entry (/ws for browser, /client for daemon)
│   ├── sessions.ts          # Session manager + RunnerFactory (anon vs authed)
│   ├── devices.ts           # Connected-daemon registry
│   ├── auth.ts              # GitHub OAuth + browser session cookies
│   ├── pairing.ts           # Device-code pairing flow
│   ├── db.ts                # better-sqlite3 schema + statements
│   └── agents/
│       ├── base.ts          # AgentRunner interface
│       ├── claude.ts        # Local Claude Agent SDK adapter (anon dev path)
│       ├── codex.ts         # Local Codex subprocess adapter (anon dev path)
│       └── remote.ts        # RemoteRunner — relays to a paired daemon
├── web/                     # React + Vite frontend
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── ws.ts            # WebSocket client w/ auto-reconnect
│       ├── styles.css
│       └── components/      # ChatPane, SessionList, NewSessionDialog,
│                            # PermissionModal, DevicesPanel, DirectoryPicker,
│                            # LoginGate, PairPage
├── client-go/               # Cross-platform Go daemon (see client-go/README.md)
│   ├── main.go              # CLI: install/uninstall/run/login/status/upgrade/
│   │                        #      doctor/allow/deny/allowed/sdk/show-config/…
│   ├── service.go           # kardianos/service integration
│   ├── relay.go             # WebSocket relay + heartbeat + reconnect
│   ├── pair.go              # Device-code pairing client
│   ├── runner.go            # Runner interface + runManager (runId → handle)
│   ├── runner_claude.go     # Spawns embedded Node bridge for Claude SDK
│   ├── runner_codex.go      # Spawns `codex exec` per turn
│   ├── helpers/
│   │   └── claude-bridge.mjs # Embedded Node host for @anthropic-ai/claude-agent-sdk
│   ├── allowlist.go         # cwd allowlist enforcement (H-3)
│   ├── upgrade.go           # `vvibe upgrade` self-update
│   ├── doctor.go            # `vvibe doctor` environment check
│   ├── sdk.go               # `vvibe sdk` Claude SDK install helper
│   ├── agent_paths.go       # Resolve claude / codex binaries
│   ├── dir.go               # Directory listing for the UI picker
│   ├── config.go            # OS-appropriate config + log paths
│   ├── platform.go
│   ├── Makefile             # Cross-compile matrix
│   └── go.mod
└── shared/
    └── types.ts             # Shared protocol types + zod schemas (client + server)
```

## Validating the Go daemon

Build & install on each OS (see `client-go/README.md` for details), then:

1. Start the Node server: `npm run dev`.
2. Run `vvibe install` on Windows / macOS / Linux.
3. Reboot.
4. Server console should print `[client] device registered: …` within ~5s.
