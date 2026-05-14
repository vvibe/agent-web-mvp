# agent-client (Go daemon)

The local-side daemon for Agent Web. Auto-starts on boot, holds a WebSocket
to the server, and (eventually) is what actually spawns `claude` / `codex` on
the user's machine.

> **MVP scope.** This iteration validates the hardest part of the SaaS
> roadmap: cross-platform service registration. The daemon connects, says
> hello with its OS / detected agents, and heartbeats. Agent spawning still
> lives in the Node server for now — we'll move it here once registration is
> proven on all three platforms.

## Why Go

- One binary per `GOOS/GOARCH`, no runtime to ship.
- [`kardianos/service`](https://github.com/kardianos/service) wraps Windows
  Service Manager / launchd / systemd behind one API.

## Build

```sh
cd client-go
go mod tidy

# native build
go build -o agent-client .

# cross-compile matrix
GOOS=windows GOARCH=amd64 go build -o dist/agent-client-windows-amd64.exe .
GOOS=windows GOARCH=arm64 go build -o dist/agent-client-windows-arm64.exe .
GOOS=darwin  GOARCH=amd64 go build -o dist/agent-client-macos-amd64 .
GOOS=darwin  GOARCH=arm64 go build -o dist/agent-client-macos-arm64 .
GOOS=linux   GOARCH=amd64 go build -o dist/agent-client-linux-amd64 .
GOOS=linux   GOARCH=arm64 go build -o dist/agent-client-linux-arm64 .
```

## First run (any OS)

```sh
./agent-client login --token=YOUR_TOKEN --server=ws://127.0.0.1:8787/client
./agent-client run     # foreground — verify it connects, then Ctrl-C
```

If the server console prints something like:
```
[client] device registered: yrj19-pc (windows/amd64) — agents=claude,codex
```
…the WebSocket path works. Now register as a service.

## Install as a service

### Windows

`kardianos/service` uses the Windows Service Manager. Installing requires
an **elevated** PowerShell (the daemon itself runs under your user account,
but `sc create` needs admin):

```powershell
# Run PowerShell as Administrator
.\agent-client.exe install
.\agent-client.exe status     # should say "running"
```

The service binary path is recorded as the absolute path of the exe you ran
`install` from — keep the binary in a stable location (e.g. `C:\Program Files\AgentWeb\agent-client.exe`)
before installing.

Uninstall:
```powershell
.\agent-client.exe uninstall
```

### macOS

Installs a per-user LaunchAgent — **no sudo required**:

```sh
./agent-client install
./agent-client status
```

This writes `~/Library/LaunchAgents/AgentWebClient.plist` and loads it with
`launchctl`. It will auto-start on the next login (and immediately).

Logs: `tail -f "~/Library/Application Support/agent-web/client.log"`

Uninstall:
```sh
./agent-client uninstall
```

### Linux (systemd)

Installs a systemd **user** unit — no sudo:

```sh
./agent-client install
./agent-client status
```

This writes `~/.config/systemd/user/AgentWebClient.service` and runs
`systemctl --user enable --now`.

To make it survive after you log out (i.e. start on boot), enable
linger once:
```sh
sudo loginctl enable-linger "$USER"
```

Logs:
```sh
journalctl --user -u AgentWebClient -f
# or
tail -f "$HOME/.config/agent-web/client.log"
```

Uninstall:
```sh
./agent-client uninstall
```

## Subcommands

| Command | What it does |
|---|---|
| `install` | Register OS service (also starts it) |
| `uninstall` | Stop + deregister |
| `start` / `stop` / `restart` | Control a registered service |
| `status` | Print service state |
| `run` | Run in foreground (used by the service manager; also handy for debugging) |
| `login --token=X --server=URL` | Persist credentials |
| `show-config` | Print config path + current values |
| `version` | Print version |

## Config & log paths

| Platform | Config | Logs |
|---|---|---|
| Windows | `%AppData%\agent-web\client.json` | `%AppData%\agent-web\client.log` |
| macOS   | `~/Library/Application Support/agent-web/client.json` | …`/client.log` |
| Linux   | `~/.config/agent-web/client.json` | `~/.config/agent-web/client.log` |

## Verifying after a reboot

This is the actual validation criterion for this MVP step.

1. `install` on each target OS.
2. Reboot.
3. Open the server (`npm run dev` in the parent project).
4. Server console should print `[client] device registered: …` within ~5s.
5. Kill the network briefly → daemon should reconnect with backoff.

If all three platforms pass that, we know the service-registration story is
solid and we can build the rest of the SaaS on top of it.

## Known gaps (intentional, for now)

- No code signing → Windows SmartScreen / macOS Gatekeeper warnings on first run.
  Address before any public release.
- Token stored in plain text. Move to OS keychain before shipping.
- No auto-update. Use [`go-update`](https://github.com/inconshreveable/go-update)
  or wrap in a Tauri tray app once we get to v1.
- Daemon does not yet spawn `claude`/`codex` — that work moves here in the
  next iteration once registration is verified.
