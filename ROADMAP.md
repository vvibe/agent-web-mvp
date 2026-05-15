# Roadmap

The product today is a working multi-user SaaS: a cloud-hosted web UI
(`agent-web-mvp-renddi.fly.dev`) where users sign in with GitHub, pair their
own laptops via a device-code flow, and drive Claude / Codex agents that run
on those laptops with file-system access. Sessions and chat history survive
server restarts.

What's left is hardening, Codex feature parity, cross-platform daemon
validation, UX polish, and the breakouts that block real multi-instance
deployment (audit log, persistent message pruning, shared state for HA).

Tags:

- **P0** — blocks the next major capability
- **P1** — should land before the capability ships to more users
- **P2** — polish, can wait
- **R**  — research / unknowns

---

## Shipped

### M1 — Daemon owns agent spawning (commit `d3d0775`)

`RemoteRunner` in `server/agents/` forwards prompts over the existing
`/client` WS to a connected daemon, which runs Claude SDK (via an embedded
Node bridge script) or Codex on the user's own machine and streams output
back. Six `daemon_*` message types, runId-keyed for cancel + permission
routing. Single-machine local mode still works when no daemon is connected
(dev / anon).

### M2 — Cloud deployment (commit `e907607`)

Multi-stage `Dockerfile` (`node:22-alpine`), tsx as a production
dependency, `fly.toml` pinned to a single always-on machine in `nrt` (256
MB shared-cpu-1x). Auto-generated GitHub Actions workflow at
`.github/workflows/fly-deploy.yml`. HTTPS + WSS work end-to-end via Fly's
proxy.

### M3 — GitHub OAuth + per-user device pairing (commit `46a8950`)

`better-sqlite3` opens at `DB_PATH` on a `/data` Fly volume. Schema tracks
`users`, `browser_sessions`, `device_tokens`, `pairing_codes`. Browser /ws
gated on `sid` cookie; daemon /client gated on Bearer device-token. New
`/pair` page approves a daemon-initiated code; `DeviceRegistry` and
`SessionStore` are scoped per `user_id` so one user never sees another
user's machines or chats. `agent-client login` drives the device-code flow
end-to-end (POST `/pair-init`, poll `/pair-status`, store the token).

### M4 — Persistence + resume across restart (commit `137e39d`)

`agent_sessions` + `agent_messages` tables. Sessions persist on create;
messages persist on append; `resume_token` lives on the session row so
Claude continues multi-turn context after the server reboots.
`SessionStore.rehydrate()` runs at boot, reconstructs in-memory Session
objects with full history at status='idle'.

### M4.5 — Security hotfix pass

Triggered by the audit done before opening up install-script-driven
onboarding. Five immediate fixes:

- **C-1** `Origin` allowlist on the `/ws` upgrade (browser only — `/client`
  has no Origin header from Go). Allowlist derived from `PUBLIC_URL` plus
  the Vite dev origin, overridable via `ALLOWED_ORIGINS`. Closes
  cross-site WebSocket hijacking (CSWSH) → otherwise any site a logged-in
  user visits could open an authenticated WS and drive `claude`/`codex`
  on their machine.
- **C-3** OAuth `return_to` constrained to same-origin relative paths via
  `safeReturnTo()`: must start with single `/`, rejects `//evil` and
  `/\evil`. Closes open redirect from `/auth/github?return_to=…`.
- **H-2** Boot guard: if `HOST=0.0.0.0` or `PUBLIC_URL` is https and
  GitHub OAuth env is unset, exit 1. Override with `ALLOW_ANON=1` for
  the rare deliberate case. Closes the "Fly deploy without secrets =
  every visitor shares one anon account that owns every paired daemon"
  failure mode.
- **H-6** `helmet` middleware with `frame-ancestors 'none'`, restricted
  CSP, and the usual defensive headers. Closes clickjacking of the
  permission-approval modal.
- **WS payload cap** — both servers run with `maxPayload: 1 MB` instead of
  the default 100 MB so a single hostile frame can't OOM the 256 MB Fly
  VM.

Body size on Express JSON is also capped at `1mb`.

### M4.6 — Auth + abuse-surface hardening

Follow-up to M4.5; closes the remaining critical/high items from the same
audit before opening up CLI-driven onboarding.

- **C-2** `pair-status` now returns the device token exactly once.
  Approved row transitions to a new `claimed` status via
  `claimPairingCode` *before* responding so a concurrent attacker poll on
  the same code sees `claimed` instead of the token. Pairing code length
  bumped from 8 → 12 chars over the same 32-symbol alphabet (~10^18
  space).
- **C-5** Device tokens are now `<id>.<secret>` (16+48 hex). `device_tokens`
  table stores only `secret_hash = sha256(secret)` and looks up by `id`;
  the `/client` upgrade verifies via constant-time compare. A leaked DB
  cannot impersonate any daemon. One-shot migration in `db.ts` drops the
  legacy row shape and forces an `agent-client login` on each daemon.
- **C-4** Codex agent is gated behind `CODEX_TRUST_DEFAULTS=1`. Server
  refuses to create codex sessions without it; daemon refuses to spawn
  codex without it. Operator must consciously vouch for their
  `CODEX_ARGS` (e.g. `--sandbox read-only --ask-for-approval on-request`)
  before exposing Codex. Proper in-UI Codex permission flow is still
  M5 P1.
- **H-4** `claude-bridge.mjs` resolves the SDK from the bridge script's
  directory and the Node global path only — the agent cwd is never
  consulted. Closes the "clone a hostile repo, prompt Claude in it,
  malicious `node_modules/@anthropic-ai/claude-agent-sdk` runs inside the
  daemon" RCE.
- **H-5** `express-rate-limit` on `/auth/github*`, `/api/device/pair-init`
  (5/min/IP), `/api/device/pair-status` (90/min/IP). `app.set('trust proxy', 1)`
  so Fly's edge IP doesn't collapse all clients into one bucket.

After M4.6, the install-script milestone (GoReleaser + curl|sh / iwr|iex)
can land safely.

---

## Open

### Milestone 5 — Codex parity

**Why:** today Codex is "stateless per prompt" and has no permission UI.

- **P0** Switch from `codex exec "<prompt>"` to `codex exec --json` (stream-
  json output). Adapter parses the same shape as Claude.
- **P0** Move stderr UTF-8 / CP950 decoding (lost in the M1 daemon rewrite)
  into a small utility on the daemon side using
  `golang.org/x/sys/windows.MultiByteToWideChar`. The current daemon Codex
  runner passes raw bytes through, so localized error messages on Windows
  render as mojibake.
- **P1** Codex session resume (multi-turn chat memory). The Session
  already persists a `resume_token` field — wire the Codex CLI's resume
  flag through `daemon_run_prompt` + `runner_codex.go`.
- **P1** Surface Codex's own approval flow in the UI (it has
  `--ask-for-approval` modes). Either route through our permission modal
  or expose its yes/no inline.

### Milestone 6 — Cross-platform daemon validation

**Why:** the Windows SCM register/install/run path is the only one
end-to-end tested; M1's Node-bridge approach also assumes Node is on PATH.

- **P0** macOS install / reboot / register / uninstall on Apple-silicon
  and Intel boxes. Confirm Gatekeeper handling for the unsigned binary.
- **P0** Linux install on at least Ubuntu + Arch (systemd user service).
  `sudo loginctl enable-linger $USER` to confirm pre-login start works.
- **P1** Code-signing pipeline for macOS (Developer ID + notarisation)
  and Windows (Authenticode). Without these the daemon is annoying to
  install.
- **P1** Make the Claude bridge work when Node isn't on PATH. Today it's
  spawned via `exec.LookPath("node")`. Options: bundle a tiny Node
  runtime (~50 MB), depend on the user having Claude CLI installed (which
  pulls Node), or document the assumption clearly.
- **P1** Fix `agents=none` when the daemon runs as a Windows service.
  Carry-over from the previous-session ROADMAP — service runs as
  `LocalSystem`, can't see the user's PATH, so `exec.LookPath("claude")`
  fails. Options: install via Task Scheduler under the user account, or
  store absolute paths to the agent binaries in `client.json`.

### Milestone 7 — UX gaps

**Why:** quality-of-life things flagged during MVP validation.

- **P2** Show connected devices in the web UI. Hello already carries
  `displayName`; the UI just doesn't render the list. Useful when a user
  has more than one machine.
- **P2** Device picker on new-session if the user has multiple daemons.
  `DeviceRegistry.pickRunner(userId)` currently returns the first.
- **P2** `agent-client status` returns "Access is denied" without admin
  on Windows because it queries SCM. Fall back to `sc query` for the read
  path, or remember the install location and probe the OS-appropriate way.
- **P2** File / dir browser when picking `cwd` for a new session (today
  it's a free-text input that's easy to mistype).
- **P2** File-diff viewer for `Edit` tool use results.
- **P2** Notifications when a permission request lands (browser
  `Notification` API; the UI is otherwise easy to leave open and miss).
- **R**  Tauri tray app to wrap the daemon with a visible icon, login UI,
  device naming. Includes the code-signing work above.

### Milestone 8 — Reliability & ops

- **P0** Rate-limit `/api/device/pair-init`. Today anyone can spam it and
  fill the `pairing_codes` table; expiry sweeps clean up but the burst
  cost is unbounded.
- **P1** Reconnect on the browser side: `WSClient` does exponential
  backoff up to 10s; verify it survives long backgrounded tabs and
  laptop sleeps. (Also check cookie expiry vs. WS lifetime — sid cookie
  is 30 days but a stale session would still get 401 on upgrade.)
- **P1** Daemon heartbeat from server side: server should evict devices
  that miss N pongs.
- **P2** Pruning: keep last N messages per session in memory, the rest
  on disk; lazy-load on session select. Carried over from M4 P1.
- **P2** Audit log of agent invocations (who, when, what cwd, what
  tools). Carried over from M3 P2.
- **P2** Export / import a session as JSON (debugging, support).
- **P2** Structured logs (JSON to stderr in prod), shipped via the
  daemon's log file or a cloud sink.
- **P2** Metrics: prompt count, tool invocations, error rate per session.

### Milestone 9 — Horizontal scale (when we actually need it)

**Why:** today everything's in a single Fly machine and `fly.toml` pins
`min_machines_running = 1` with no HA. The constraint is structural:
`DeviceRegistry` and the in-memory `RemoteRunner` correlation tables only
exist on the machine the daemon WS landed on. A browser routed to a
sibling machine has no path to the daemon.

- **R**  Pick a shared-state substrate. Cheapest: a Redis pub/sub fanout
  for `daemon_*` events keyed by `runId`, plus a `device_id → machine_id`
  lookup so a browser request can be sticky-routed or proxied.
- **R**  Or sidestep with sticky sessions at the Fly proxy layer — but
  Fly's HTTP-based affinity doesn't carry into long-lived WS, and
  daemon connection isn't tied to a browser session anyway.
- **P2** Until that lands, do not raise `min_machines_running`.

---

## Cross-cutting follow-ups (caught during M1–M4 implementation)

- **/client endpoint trust**: a leaked `device_token` lets anyone
  impersonate that user's daemon. Currently tokens never rotate or
  expire. Add a "revoke device" action in the UI + a rotation mechanic
  before any wider rollout.
- **Local server fallback**: when no daemon is connected for an authed
  user, sessions go to `RemoteRunner` which errors immediately with
  "No daemon connected." That's intentional — but the UI doesn't pre-empt
  it with "Pair a device first." Worth a banner.
- **Windows file-content visibility weirdness** observed during M3 token
  debugging: PowerShell `Get-Content` and the Go binary's `loadConfig()`
  reported divergent contents for `client.json` for a brief window
  (Get-Content showed empty token; show-config showed the real token,
  same path). Couldn't isolate to OneDrive vs. Defender vs. FS cache.
  Worth re-checking if it recurs.
