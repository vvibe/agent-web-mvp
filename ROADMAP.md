# Roadmap

> **2026-05-18 — closeout notice.** This repo validated the
> embedded-agent-driving concept (M1–M4.9 shipped). The polished product is
> being built in a new repo `vvibe` (greenfield per
> [portaly-vibe ADR-001](../portaly-vibe/docs/oss/ADR-001-architecture.md)),
> targeting non-technical creators with an in-dashboard agent driver that
> replaces the original MCP+skill copy-paste flow.
>
> This roadmap is frozen except for **Milestone 6 (cross-platform daemon
> validation)** and a small set of M10 security items whose work carries to
> the new repo. Everything else is listed under "Won't do — deferred to
> vvibe new repo" below; those items either don't apply to the creator
> product or get reframed against Postgres + Drizzle + Better Auth in the
> new repo.

The product today is a working multi-user SaaS: a cloud-hosted web UI
(`agent-web-mvp-renddi.fly.dev`) where users sign in with GitHub, pair their
own laptops via a device-code flow, and drive Claude / Codex agents that run
on those laptops with file-system access. Sessions and chat history survive
server restarts.

What's left in this repo is the daemon-side closeout work that the new
repo will inherit: cross-platform service registration validation and the
protocol-level security hardening that travels with the daemon binary and
the WS contract.

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

### M4.7 — Token-budget defense + second-round audit fixes

Tier-1 follow-up to a token-budget threat model. The audit listed ~30
items; this milestone ships the six with the highest impact-to-effort
ratio. Rest deferred to **Milestone 10**.

- **B-2** Claude Agent SDK runs with `maxTurns: 25` per prompt. Hard cap
  on tool-use chains — defense against prompt-injection-driven fanout
  (e.g. a hostile README that tricks Claude into 200 chained file reads)
  and against runaway agent loops chewing through tokens. 25 is plenty
  for normal coding tasks (most resolve in <10).
- **B-3** Daemon-side wall-clock cap on a single run via
  `context.WithTimeout(defaultMaxRunDuration)` (30 min, overridable via
  `VVIBE_MAX_RUN_SECONDS`). Backstops the "tab went to sleep but the
  agent kept looping" case. `daemon_done` reports the timeout with a
  readable message instead of `context deadline exceeded`.
- **O-3** "Stop all (N)" emergency-brake button appears in the sidebar
  whenever ≥1 session is `running` or `awaiting_permission`. Server-side
  `cancel_all` message iterates `store.listForUser(userId)` and calls
  `.cancel()` on each active session. One click brake for "I think
  something's wrong" without hunting through individual sessions.
- **N-1** Cross-tenant guard on `pendingDirListings`. Map now keys on
  `(requestId, userId)` so a malicious user's daemon can't brute-force
  the 6-char requestId space and inject directory entries into another
  user's picker.
- **N-3** Install script substitution uses `PUBLIC_URL` instead of
  `req.get('host')`. Host is attacker-controllable in principle, and a
  quote/newline in it would break out of the single-quoted shell/PS
  string in install.sh/.ps1 — at minimum a supply-chain-style trust
  assumption we don't need.
- **N-8** `GET /auth/logout` removed; only POST remains. Eliminates
  `<img src=".../logout">` CSRF nuisance from third-party pages.
  Frontend now POSTs via `fetch` and navigates to `/`.

### M4.7 follow-up — Model picker + ANSI strip

Two small UX gaps that showed up immediately after M4.7 shipped:

- **Model selection** end-to-end. `NewSessionDialog` gains a "Model" dropdown
  (only when agent = Claude) listing the current Claude family — Opus 4.7 /
  Sonnet 4.6 / Haiku 4.5 — with "Default" as the no-pick option (lets the
  SDK pick, currently Opus). Picked model flows through `create_session` →
  `Session` (persisted in `agent_sessions.model`) → `RemoteRunner` →
  `daemon_run_prompt` → bridge → SDK `options.model`. Server-side allowlist
  via `isAllowedClaudeModel` in `shared/types.ts` rejects anything outside
  the dropdown, so a malicious client can't pass arbitrary strings to the
  SDK. Local `ClaudeRunner` (anon dev path) honors the same field, plus
  picks up the `maxTurns: 25` cap so dev mirrors prod.
- **Strip ANSI on tool output.** CLI tools like `npx skills` emit color +
  cursor + spinner escape sequences (`\x1b[34m`, `\x1b[?25l`, `\x1b[999D[J`).
  The leading ESC gets dropped by HTML rendering, leaving `[34m...[39m`
  garbage in the chat log. `ChatPane.MessageBubble` now runs a regex
  strip on `tool_use` / `tool_result` roles only (user/assistant prose
  shouldn't contain ANSI; skipping them saves regex work per render).
  The stored text is unchanged so a future ansi-to-html renderer can
  drop in.

### M4.8 — One-line daemon installer + CLI rename to `vvibe`

GoReleaser config (`client-go/.goreleaser.yaml`) builds the daemon for
linux/darwin/windows × amd64/arm64, archives without version in the
filename so `releases/latest/download/<asset>` always resolves, writes a
`checksums.txt`. GitHub Actions workflow `.github/workflows/release-client.yml`
fires on `client-v*` tags.

`server/public/install.sh` and `install.ps1` are served by Express at
`/install.sh` and `/install.ps1` (text/plain). They detect OS/arch,
download from GitHub Releases, verify sha256, and place the binary
on PATH. Neither runs `login` or `install` for the user — both need
a TTY (or admin PowerShell) and surprising the user there is worse than
the extra step.

Daemon `main.go` learns `version`/`commit`/`date` vars set via ldflags.
`agent-client version` now prints all three.

The first usable URL is:

```
curl -fsSL https://agent-web-mvp-renddi.fly.dev/install.sh | sh
iwr https://agent-web-mvp-renddi.fly.dev/install.ps1 | iex
```

To cut a release: `git tag v0.1.0 && git push --tags`. We initially tried
a `client-` prefix to separate daemon and server tags, but GoReleaser
OSS rejects non-semver tags (its prefix-stripping `monorepo.tag_prefix`
is Pro-only). If the server ever needs versioned tags later, give them
a different prefix like `server-v*`.

### M4.9 — `vvibe upgrade` self-update

[`creativeprojects/go-selfupdate`](https://github.com/creativeprojects/go-selfupdate)
fetches the latest release from GitHub, downloads the per-OS/arch
archive, sha256-verifies against `checksums.txt`, and atomically
replaces the running binary. `upgrade` stops the kardianos service
(if installed + running), swaps the file, then starts it again.

`upgrade --check` reports without applying. `upgrade --yes` skips the
y/N prompt for scripted use; non-TTY stdin without `--yes` refuses
rather than guessing.

Background / automatic update is intentionally not in scope — needs
code signing first so each update doesn't re-trigger SmartScreen /
Gatekeeper.

### M4.8 follow-up — CLI renamed to `vvibe`

Renamed the CLI from `agent-client` to **`vvibe`** in the same pass:
binary name, service ID (`Vvibe`), config dir (`~/.config/vvibe/`),
asset filenames (`vvibe_<os>_<arch>.<ext>`), and every user-facing string
in help/UI. Existing daemons must `uninstall` the old `AgentWebClient`
service and re-pair; this is acceptable because M4.6 already forced a
re-pair via the device-token hash migration.

---

## Closeout milestones

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

### Milestone 10 (selected) — Protocol & daemon security hardening

**Why:** three P0 items from the M4.7 follow-up audit whose work *carries
to the vvibe new repo* — the daemon binary and the WS protocol shape both
travel forward, so hardening here means the new repo inherits a validated
contract instead of having to rediscover the threat model. Everything else
from the original Milestone 10 is listed under "Won't do" below; the
audit/observability tail reframes under PRD-002 in the new repo.

- **P0** **N-6** zod schema for `daemon_message` / `daemon_done`. Even
  a user's own malicious daemon can spoof `role: 'user'` to inject fake
  history rows; the JSON shape is currently trust-on-faith. Protocol
  contract carries to new repo.
- **P0** **H-3** Daemon cwd allowlist. `vvibe allow ~/code` adds a
  permitted root; daemon refuses any `cwd` outside the union of allowed
  roots. Closes "attacker hijacks session → `find / -name id_rsa`"
  paths. Daemon-side, travels with `client-go/`. Needs CLI subcommand,
  config file format, startup-time validation, UI hint when a session
  targets a denied cwd.
- **P0** **B-5** WebSocket rate limit on `send_prompt`. Per-(userId,
  sessionId) token bucket, ~10/min. Borderline (server-side, throwaway
  Express stack), but the threat-model + token-bucket pattern reuses in
  the new repo — cheap to ship here as a reference.

---

## Won't do — deferred to vvibe new repo

These milestones do not advance in this repo. Each entry notes where the
work goes in the new repo (or why it dissolves). Full historical content
is preserved in git history before this commit.

- **Milestone 5 — Codex parity.** Creator product targets non-technical
  users; Claude Code is the primary embedded agent. Codex / Cursor
  remain an open architectural question in the new repo, not committed
  work.
- **Milestone 7 — UX gaps** (device picker, dir browser, diff viewer,
  notifications, Tauri tray). Current web UI is throwaway. Equivalent
  needs reappear inside the new repo's creator dashboard (PRD-001 §6.8);
  re-scope from creator-first principles rather than porting.
- **Milestone 8 — Reliability & ops.** Server-side reliability work
  (rate-limit on pair-init, cookie-vs-WS lifetime, persistent message
  pruning, audit log, structured logs, metrics) doesn't carry — the
  Express server is being thrown away. Daemon-side reliability
  (heartbeat, reconnect) folds into M6.
- **Milestone 9 — Horizontal scale.** The constraint (in-memory
  `DeviceRegistry` and `browsers` maps) dissolves in the new repo's
  Postgres + multi-process design (ADR-001 §3.3). No explicit milestone
  needed; it's a property of the new stack.
- **Milestone 10 remainder** (O-1/O-2 token+cost counting, O-4 anomaly
  detector, O-5 audit log UI, B-1 quota_events, B-4 cancel watchdog,
  N-2 CSP tightening, N-5 Origin middleware, D-1 daemon `budget.json`,
  D-2 `vvibe usage` CLI, P-5 per-session tool allowlist, P-3 cwd-change
  modal, L-7 Codex sandbox-args enforcement, A-1 onboarding budget
  docs, A-4 event push, N-4 release trust root). Audit / observability
  tail reframes under PRD-002 in the new repo; per-user quotas and
  budget caps fold into new-repo Stripe + Audit milestones; CSP /
  Origin tightening is server-side throwaway and reappears when the
  new Next.js app is written; daemon-side `budget.json` + `vvibe usage`
  travel with the daemon to the new repo and re-enter as daemon-track
  milestones.
- **Milestone 11 — Deployment portability.** New repo gets its own
  deployment story per ADR-001 §4.10: `docker-compose` baseline plus
  reference deployments for Fly.io, Render, Cloud Run. The Workers + DO
  alternative remains consciously rejected (creator product still
  needs to be self-hostable on commodity infrastructure).
- **Cross-cutting follow-ups (M1–M4):**
  - *device-token rotation* — carries; new repo's Better Auth rotates
    user session tokens natively, but the daemon device-token rotation
    is its own design.
  - *"Pair a device first" UI banner* — throwaway (current web UI gone).
  - *Windows file-content visibility quirk* (OneDrive/Defender) — keep
    as a known issue for the daemon; re-check if it surfaces in the
    new repo's pairing flow.


