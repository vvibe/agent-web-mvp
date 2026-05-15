# Roadmap

The MVP today drives Claude / Codex CLIs from a browser on a single machine,
with a cross-platform Go daemon (`agent-client`) that registers itself as an
OS service. The goal is a multi-machine SaaS where a cloud-hosted UI controls
agents running on the user's own laptops / workstations. Everything below is
the path between those two states.

Items are tagged:

- **P0** — blocks the next major capability
- **P1** — should land before the capability ships to anyone
- **P2** — polish, can wait
- **R** — research / unknowns

---

## Milestone 1 — Daemon owns agent spawning (the actual SaaS pivot)

**Why:** today the Node server spawns `claude` / `codex` locally. That only
works when the server *is* the user's machine. For multi-machine SaaS the
server lives in the cloud and the daemon must run the agents on the user's
machine, streaming output back over its `/client` WebSocket.

- **P0** Add a `RemoteRunner` implementing `AgentRunner` in `server/agents/`.
  It forwards `send(prompt)` to a specific daemon via WS and yields messages
  from the daemon's responses. Pick the daemon from the device registry.
- **P0** Daemon-side: handle `run_prompt` / `cancel` / `permission_response`
  messages. Spawn the existing Claude Agent SDK / Codex subprocess on the
  daemon, stream messages back. Pull the Claude SDK into `client-go` either
  via an embedded Node runtime or by shelling out to a small Node helper.
- **P0** Cross-process protocol additions in `shared/types.ts`:
  `daemon_run_prompt`, `daemon_message`, `daemon_permission_request`,
  `daemon_permission_response`, `daemon_done`, `daemon_error`.
- **P1** When the server receives a `create_session` and the cwd looks like
  a remote-daemon path, route to `RemoteRunner` instead of `ClaudeRunner` /
  `CodexRunner`. Otherwise stay local (single-machine mode still works).
- **P1** Fix `agents=none` when the daemon runs as a Windows service. The
  service runs as `LocalSystem` and can't see the user's PATH, so
  `exec.LookPath("claude")` fails. Options:
  - Install via Task Scheduler under the user account instead of SCM service
    (kardianos's `UserService: true` only works on systemd today).
  - Or store absolute paths to the agent binaries in `client.json` and skip
    PATH lookup entirely.
- **P2** Cancel propagation needs to round-trip cleanly: browser → server →
  daemon → SDK abort. Test under flaky tunnel conditions.

## Milestone 2 — Cloud deployment

**Why:** "from anywhere" means the Node server is on someone else's machine.

- **P0** Containerize `server/` (Dockerfile + a `node:22-alpine` base, build
  `dist/web/` and `dist/server/`).
- **P0** Pick a target: Fly.io / Railway / Render / Cloudflare Containers.
  Decide based on WebSocket support, persistent disk for SQLite, and pricing.
- **P0** Daemon's `--server` URL now points at the cloud host. Update
  `client-go/README.md` examples.
- **P1** TLS / `wss://` end-to-end. `gorilla/websocket` in `client-go` works
  with `wss://` out of the box; just check certificate handling on Linux
  service installs.
- **P1** Replace the Cloudflare quick-tunnel validation route with a named
  Cloudflare Tunnel + Cloudflare Access (email gate) for any user-facing
  testing of the local-server-via-tunnel path.

## Milestone 3 — Multi-user auth

**Why:** today there is no auth on `/ws`. Anyone with the URL controls the
agent.

- **P0** Pick an identity provider. Cheapest: Cloudflare Access (zero auth
  code in the app; trust the `Cf-Access-Authenticated-User-Email` header).
- **P0** `/client` WebSocket: replace the static `CLIENT_TOKEN` with per-user
  long-lived tokens. `agent-client login` pulls a token from the server via
  a one-time device-code flow.
- **P1** Scope: each user only sees their own devices, sessions, history.
  Update `DeviceRegistry` + `SessionStore` to be per-user-id.
- **P2** Audit log of agent invocations (who, when, what cwd, what tools).

## Milestone 4 — Persistence

**Why:** today sessions live in memory; server restart loses everything.

- **P0** SQLite (`better-sqlite3`) for sessions, messages, devices, users.
- **P0** Migrations folder + a tiny migrator at startup.
- **P1** Pruning: keep last N messages per session in memory, the rest on
  disk; lazy-load on session select.
- **P2** Export / import a session as JSON (debugging, support).

## Milestone 5 — Codex parity

**Why:** today Codex is "stateless per prompt" and has no permission UI.

- **P0** Switch from `codex exec "<prompt>"` to `codex exec --json` (stream-
  json output). Adapter parses the same shape as Claude.
- **P1** Codex session resume (multi-turn chat memory).
- **P1** Surface Codex's own approval flow in the UI (it has `--ask-for-
  approval` modes). Either route through our permission modal or expose its
  yes/no inline.

## Milestone 6 — Cross-platform daemon validation

**Why:** `Arguments: []string{"run"}` fix is verified on Windows only.

- **P0** macOS install / reboot / register / uninstall on Apple-silicon and
  Intel boxes. Confirm Gatekeeper handling for the unsigned binary.
- **P0** Linux install on at least Ubuntu + Arch (systemd user service).
  `sudo loginctl enable-linger $USER` to confirm pre-login start works.
- **P1** Code-signing pipeline for macOS (Developer ID + notarisation) and
  Windows (Authenticode). Without these the daemon is annoying to install.

## Milestone 7 — UX gaps

**Why:** quality-of-life things flagged during MVP validation.

- **P2** Show connected devices in the web UI. Device registry already
  exists in `server/devices.ts`; the UI just isn't wired up.
- **P2** `agent-client status` returns "Access is denied" without admin on
  Windows because it queries SCM. Fall back to `sc query` for the read path,
  or remember the install location and probe the OS-appropriate way.
- **P2** File / dir browser when picking `cwd` for a new session (today it's
  a free-text input that's easy to mistype).
- **P2** File-diff viewer for `Edit` tool use results.
- **P2** Notifications when a permission request lands (browser
  `Notification` API; the UI is otherwise easy to leave open and miss).
- **R**  Tauri tray app to wrap the daemon with a visible icon, login UI,
  device naming. Includes the code-signing work above.

## Milestone 8 — Reliability & ops

- **P1** Reconnect on the browser side: today `WSClient` does exponential
  backoff up to 10s; verify it survives long backgrounded tabs and laptop
  sleeps.
- **P1** Daemon heartbeat from server side: server should evict devices that
  miss N pongs.
- **P2** Structured logs (JSON to stderr in prod), shipped via the daemon's
  log file or a cloud sink.
- **P2** Metrics: prompt count, tool invocations, error rate per session.

---

## Recently shipped (this session, 2026-05-15)

- ✅ Cross-platform service-registration milestone validated on **Windows**
  (install / reboot / auto-start / reconnect / uninstall).
- ✅ Fix Windows SCM 30s start-timeout (`Arguments: []string{"run"}` in
  `client-go/service.go`). Commit `b1b876a`.
- ✅ Web MVP end-to-end on Windows: streaming, permission modal, reload
  restore, cancel, Codex graceful error.
- ✅ Bug fixes shipped in commit `24f7379`:
  - `dev:server` now uses `nodemon` instead of `tsx watch` (was leaking the
    old server on Windows → EADDRINUSE on every save).
  - User-initiated cancel now lands on `idle`, not `error`. Surfaces
    "Cancelled." instead of "Error: Claude Code process aborted by user".
  - Codex stderr decoded via Windows OEM codepage so the "command not
    recognized" error renders correctly on non-UTF-8 locales (CP950, etc.).
- ✅ Validated "cloud webpage controls local agent" via Cloudflare quick
  tunnel. Phone → trycloudflare URL → permission modal → Allow → file
  written to disk. Quick-tunnel route is dev-only; named tunnel + Access is
  the productionish path (see M2/M3).
