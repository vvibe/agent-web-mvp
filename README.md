# Agent Web MVP

Single-user, self-hosted web UI for driving local AI coding agents
(Claude Code, Codex CLI) from a browser.

This is **step 1** of a longer SaaS roadmap. Right now everything runs on one
machine: the backend talks to local agent binaries, and the frontend connects
to it over WebSocket on `localhost`.

## Architecture

```
┌─────────────┐    /ws      ┌──────────────────┐    /client    ┌──────────────────┐
│   Browser   │ ◄──────────►│  Node.js server  │◄─────────────►│  Go daemon       │
│  (React)    │             │  (Express + ws)  │               │    (vvibe)       │
└─────────────┘             └────────┬─────────┘               └────────┬─────────┘
                                     │ (current MVP spawns here)        │ (will move
                                     ▼                                  │  here next)
                       ┌──────────────────────────┐                     ▼
                       │ Claude Agent SDK / codex │           OS service (systemd /
                       │       (local CLIs)       │           launchd / Win Service)
                       └──────────────────────────┘
```

Two independent pieces:

- **Web app** (`server/` + `web/`) — single-machine MVP. Browser talks to a
  local Node server, which spawns `claude`/`codex` directly.
- **Go daemon** (`client-go/`) — the future-facing piece. Registers itself
  as an OS service so it auto-starts on boot; connects back to the server.
  Right now it only validates the service-registration plumbing. Agent
  spawning will move from the Node server into this daemon once we know
  registration is solid on Windows / macOS / Linux.

- **Sessions** live on the server and survive page reloads.
- **Claude** uses `@anthropic-ai/claude-agent-sdk` with the `canUseTool`
  callback, so tool permission prompts are forwarded to the browser as a modal.
- **Codex** spawns `codex exec` per turn (no permission UI yet — relies on
  Codex's own `--ask-for-approval` / `--full-auto` flags via `CODEX_ARGS`).

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

Open the frontend URL. Vite proxies `/ws` to the backend automatically.

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
GitHub, verifies sha256, drops the binary on PATH):

```sh
# macOS / Linux
curl -fsSL https://agent-web-mvp-renddi.fly.dev/install.sh | sh

# Windows (PowerShell, no admin needed for this step)
iwr https://agent-web-mvp-renddi.fly.dev/install.ps1 | iex
```

Then pair the machine with your account:

```sh
vvibe login                  # opens the device-code flow
vvibe install                # register as an OS service (Windows
                             #   needs Administrator PowerShell;
                             #   macOS / Linux do not)
vvibe status                 # confirm it's running
```

The daemon stores its config under your user profile (`%AppData%\vvibe\`,
`~/Library/Application Support/vvibe/`, `~/.config/vvibe/`) and
auto-reconnects after reboots. Binaries are not yet code-signed — Windows
SmartScreen / macOS Gatekeeper may warn on first run (M6 P1).

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
│   ├── sessions.ts          # Session manager
│   ├── devices.ts           # Connected-daemon registry
│   └── agents/
│       ├── base.ts          # AgentRunner interface
│       ├── claude.ts        # Claude Agent SDK adapter
│       └── codex.ts         # Codex subprocess adapter
├── web/                     # React + Vite frontend
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── ws.ts            # WebSocket client w/ auto-reconnect
│       ├── styles.css
│       └── components/
├── client-go/               # Cross-platform Go daemon (see client-go/README.md)
│   ├── main.go              # CLI: install / uninstall / run / login / status
│   ├── service.go           # kardianos/service integration
│   ├── relay.go             # WebSocket relay + heartbeat + reconnect
│   ├── config.go            # OS-appropriate config + log paths
│   ├── platform.go
│   ├── Makefile             # Cross-compile matrix
│   └── go.mod
└── shared/
    └── types.ts             # Shared protocol types (client + server)
```

## Validating the Go daemon

Build & install on each OS (see `client-go/README.md` for details), then:

1. Start the Node server: `npm run dev`.
2. Run `vvibe install` on Windows / macOS / Linux.
3. Reboot.
4. Server console should print `[client] device registered: …` within ~5s.

That's the success criterion for the cross-platform service-registration milestone.
