# vvibe (the Go daemon)

`vvibe` is the local-side daemon for Agent Web. It auto-starts on boot,
holds a WebSocket to the server, and spawns `claude` / `codex` on the
user's machine when prompts arrive.

The shipping path is the [one-line installer](../README.md#installing-the-daemon-on-a-new-machine).
Everything below is for source builds, hacking, and CI.

## Why Go

- One binary per `GOOS/GOARCH`, no runtime to ship.
- [`kardianos/service`](https://github.com/kardianos/service) wraps Windows
  Service Manager / launchd / systemd behind one API.

## Build

```sh
cd client-go
go mod tidy

# native build
go build -o vvibe .

# cross-compile matrix (the Makefile covers all six combinations)
make all   # → dist/vvibe-<os>-<arch>[.exe]
```

GoReleaser drives the real releases (`.goreleaser.yaml` here +
`.github/workflows/release-client.yml`) — tag `client-vX.Y.Z` to ship.

## First run (any OS)

```sh
./vvibe login                   # interactive device-code pairing
./vvibe run                     # foreground — verify it connects, then Ctrl-C
```

If the server console prints something like:
```
[client] device registered: yrj19-pc (windows/amd64) — agents=claude,codex
```
…the WebSocket path works. Now register as a service.

## Install as a service

### Windows

`kardianos/service` uses the Windows Service Manager. Installing requires
an **elevated** PowerShell (the daemon itself runs under your user
account, but `sc create` needs admin):

```powershell
# Run PowerShell as Administrator
.\vvibe.exe install
.\vvibe.exe status     # should say "running"
```

The service binary path is recorded as the absolute path of the exe you
ran `install` from — keep the binary in a stable location (e.g.
`%LOCALAPPDATA%\Programs\Vvibe\vvibe.exe`, which is where install.ps1
puts it) before installing.

Uninstall:
```powershell
.\vvibe.exe uninstall
```

### macOS

Installs a per-user LaunchAgent — **no sudo required**:

```sh
./vvibe install
./vvibe status
```

This writes `~/Library/LaunchAgents/Vvibe.plist` and loads it with
`launchctl`. It will auto-start on the next login (and immediately).

Logs: `tail -f "~/Library/Application Support/vvibe/client.log"`

Uninstall:
```sh
./vvibe uninstall
```

### Linux (systemd)

Installs a systemd **user** unit — no sudo:

```sh
./vvibe install
./vvibe status
```

This writes `~/.config/systemd/user/Vvibe.service` and runs
`systemctl --user enable --now`.

To make it survive after you log out (i.e. start on boot), enable
linger once:
```sh
sudo loginctl enable-linger "$USER"
```

Logs:
```sh
journalctl --user -u Vvibe -f
# or
tail -f "$HOME/.config/vvibe/client.log"
```

Uninstall:
```sh
./vvibe uninstall
```

## Subcommands

| Command | What it does |
|---|---|
| `install` | Register OS service (also starts it) |
| `uninstall` | Stop + deregister |
| `start` / `stop` / `restart` | Control a registered service |
| `status` | Print service state |
| `run` | Run in foreground (used by the service manager; also handy for debugging) |
| `login [--token=X --server=URL]` | Device-code pairing, or persist a pre-existing token directly |
| `show-config` | Print config path + current values |
| `version` | Print version (built with `-X main.version=…` ldflags) |

## Config & log paths

| Platform | Config | Logs |
|---|---|---|
| Windows | `%AppData%\vvibe\client.json` | `%AppData%\vvibe\client.log` |
| macOS   | `~/Library/Application Support/vvibe/client.json` | …`/client.log` |
| Linux   | `~/.config/vvibe/client.json` | `~/.config/vvibe/client.log` |

## Verifying after a reboot

This is the actual validation criterion for this MVP step.

1. `vvibe install` on each target OS.
2. Reboot.
3. Open the server (`npm run dev` in the parent project).
4. Server console should print `[client] device registered: …` within ~5s.
5. Kill the network briefly → daemon should reconnect with backoff.

If all three platforms pass that, we know the service-registration story
is solid and we can build the rest of the SaaS on top of it.

## Known gaps (intentional, for now)

- No code signing → Windows SmartScreen / macOS Gatekeeper warnings on
  first run. Address before any public release (M6 P1).
- Token stored in plain text. Move to OS keychain before shipping (M4.7).
- No auto-update yet. `vvibe upgrade` planned for M4.9.
