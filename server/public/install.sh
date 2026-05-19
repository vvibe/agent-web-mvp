#!/bin/sh
# vvibe installer (macOS + Linux).
#
# Usage:
#   curl -fsSL https://<server>/install.sh | sh
#
# What it does:
#   1. Detects OS / arch
#   2. Downloads the latest vvibe release tarball from GitHub
#   3. Verifies the binary against checksums.txt
#   4. Installs into /usr/local/bin (falls back to $HOME/.local/bin if
#      /usr/local/bin isn't writable)
#   5. Prints the next two commands (`install` + `login`)
#
# It does NOT register the service or run `login` for you — those need a
# TTY for the device-code prompt, and `install` may want sudo. Doing them
# inline would surprise the user.

set -eu

REPO="vvibe/agent-web-mvp"
ASSET_PREFIX="vvibe"
BINARY="vvibe"
# Substituted at serve-time by the HTTP server with the WS URL derived from the
# request that fetched this script (e.g. wss://<host>/client). When you run
# install.sh from a local copy (not via curl|sh), the placeholder remains and
# config-seeding is skipped — set the server manually via `vvibe login --server=...`.
SERVER_URL='__VVIBE_SERVER_URL__'
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# ── Detect platform ────────────────────────────────────────────────────────
uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Linux)  os=linux ;;
  Darwin) os=darwin ;;
  *) die "Unsupported OS: $uname_s. Build from source: https://github.com/$REPO/tree/main/client-go" ;;
esac

case "$uname_m" in
  x86_64|amd64)         arch=amd64 ;;
  aarch64|arm64)        arch=arm64 ;;
  *) die "Unsupported arch: $uname_m" ;;
esac

# Used by interactive prompts below. `curl | sh` pipes the script over stdin,
# so prompts must read from /dev/tty — skip prompts entirely without one.
have_tty=1
[ -r /dev/tty ] || have_tty=0

asset="${ASSET_PREFIX}_${os}_${arch}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"
checksums_url="https://github.com/${REPO}/releases/latest/download/checksums.txt"

# ── Pick install location ──────────────────────────────────────────────────
# Prefer /usr/local/bin so the daemon is on PATH for `vvibe` invocations from
# any shell. Fall back to ~/.local/bin if we can't write there.
install_dir=/usr/local/bin
needs_path=0
if ! { [ -w "$install_dir" ] || ([ ! -e "$install_dir" ] && [ -w "$(dirname "$install_dir")" ]); }; then
  install_dir="$HOME/.local/bin"
  mkdir -p "$install_dir"
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) needs_path=1 ;;
  esac
fi

# ── Download + verify ──────────────────────────────────────────────────────
log "Detected: $os/$arch"
log "Downloading $asset"
if ! curl -fsSL -o "$TMPDIR/$asset" "$url"; then
  die "Download failed. URL: $url
   If this is the first release, the binary may not be published yet."
fi

log "Verifying checksum"
if curl -fsSL -o "$TMPDIR/checksums.txt" "$checksums_url"; then
  expected="$(grep "  $asset\$" "$TMPDIR/checksums.txt" | awk '{print $1}')"
  if [ -z "$expected" ]; then
    warn "Could not find $asset in checksums.txt — skipping verification"
  else
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$TMPDIR/$asset" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$TMPDIR/$asset" | awk '{print $1}')"
    else
      warn "No sha256sum/shasum available — skipping verification"
      actual="$expected"
    fi
    [ "$expected" = "$actual" ] || die "Checksum mismatch.
   expected: $expected
   actual:   $actual"
  fi
else
  warn "Could not download checksums.txt — skipping verification"
fi

# ── Extract + install ──────────────────────────────────────────────────────
log "Extracting"
tar -xzf "$TMPDIR/$asset" -C "$TMPDIR"

bin="$TMPDIR/$BINARY"
[ -f "$bin" ] || die "Extracted archive does not contain $BINARY binary"
chmod +x "$bin"

# If the daemon is already running, overwriting still "works" on Unix
# (the open inode survives until the process exits) but the running
# instance won't pick up the new binary until restart. Better to bail
# with a clear pointer at `vvibe upgrade`, which handles stop/replace/start.
if [ -e "$install_dir/$BINARY" ] && command -v pgrep >/dev/null 2>&1 \
   && pgrep -x "$BINARY" >/dev/null 2>&1; then
  warn "vvibe is already installed and currently running."
  warn "  - To update in place, run: vvibe upgrade"
  warn "  - Or stop it first: vvibe uninstall  (service)  /  Ctrl-C  (foreground)"
  die "Aborting to avoid clobbering a running daemon."
fi

log "Installing to $install_dir/$BINARY"
if [ -w "$install_dir" ]; then
  mv "$bin" "$install_dir/$BINARY"
else
  log "  (sudo needed to write $install_dir)"
  sudo mv "$bin" "$install_dir/$BINARY"
fi

# Refresh PATH for the rest of this script (and any child it spawns, like the
# post-install `vvibe login` prompt). Persistence across future shells is
# handled separately by the shell-rc writer below.
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) export PATH="$install_dir:$PATH" ;;
esac

cat <<EOF

Installed → $install_dir/$BINARY
Version:    $("$install_dir/$BINARY" version 2>/dev/null || echo unknown)
EOF

# ── Update shell PATH (when installed to ~/.local/bin and not on PATH) ─────
# Mirrors what bun / deno / rustup do: append an export to the user's shell
# rc file with a clear marker so it can be removed by deleting that block.
# Skip with VVIBE_NO_MODIFY_PATH=1 for users who manage PATH themselves.
path_modified_file=""
if [ "$needs_path" = 1 ]; then
  if [ "${VVIBE_NO_MODIFY_PATH:-0}" = 1 ]; then
    cat <<EOF

PATH not updated (VVIBE_NO_MODIFY_PATH=1). Add this line to your shell rc:
   export PATH="$install_dir:\$PATH"
EOF
  else
    shell_name="$(basename "${SHELL:-}")"
    rc=""
    line=""
    case "$shell_name" in
      zsh)
        rc="$HOME/.zshrc"
        line='export PATH="$HOME/.local/bin:$PATH"'
        ;;
      bash)
        # macOS Terminal launches bash as a *login* shell which reads
        # .bash_profile (not .bashrc); Linux interactive shells read .bashrc.
        if [ "$os" = darwin ]; then
          if [ -f "$HOME/.bash_profile" ]; then rc="$HOME/.bash_profile"
          elif [ -f "$HOME/.bashrc" ];      then rc="$HOME/.bashrc"
          else rc="$HOME/.bash_profile"
          fi
        else
          rc="$HOME/.bashrc"
        fi
        line='export PATH="$HOME/.local/bin:$PATH"'
        ;;
      fish)
        rc="$HOME/.config/fish/config.fish"
        mkdir -p "$(dirname "$rc")"
        line='fish_add_path -aU $HOME/.local/bin'
        ;;
    esac

    if [ -n "$rc" ]; then
      touch "$rc"
      if grep -Fq "# vvibe (added by installer)" "$rc" 2>/dev/null; then
        path_modified_file="$rc"  # marker already present from a prior run
      else
        {
          printf '\n# vvibe (added by installer) — remove this block to undo\n'
          printf '%s\n' "$line"
        } >> "$rc"
        path_modified_file="$rc"
      fi
    fi

    if [ -n "$path_modified_file" ]; then
      cat <<EOF

PATH updated → added $install_dir to $path_modified_file
   To use vvibe in this shell right now, run:
       source $path_modified_file
   (Or just open a new terminal window.)
   To opt out next time, re-run with VVIBE_NO_MODIFY_PATH=1.
EOF
    else
      cat <<EOF

$install_dir is not on your PATH and shell '$shell_name' is unrecognized.
Add this line to your shell rc file manually:
   export PATH="$install_dir:\$PATH"
EOF
    fi
  fi
fi

# ── Seed daemon config with server URL ─────────────────────────────────────
# When this script was served by the vvibe HTTP server it knows its own
# externally-reachable URL and substitutes it into SERVER_URL above. We seed
# the daemon config from that so `vvibe login` doesn't need --server.
#
# We deliberately check the SHAPE of SERVER_URL (must start with ws:// or
# wss://) rather than comparing against the placeholder string — the latter
# would itself get substituted by the server (the placeholder literal in the
# pattern is just text from the server's PoV), inverting the check and
# silently skipping the seed. Shape-matching is also robust to future
# placeholder renames.
case "$SERVER_URL" in
  ws://*|wss://*)
    if [ "$os" = darwin ]; then
      config_dir="$HOME/Library/Application Support/vvibe"
    else
      config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/vvibe"
    fi
    config_file="$config_dir/client.json"
    # Don't clobber a working install — the existing token + server stay put.
    if [ -f "$config_file" ]; then
      log "Config already exists at $config_file — keeping existing server URL"
    else
      mkdir -p "$config_dir"
      cat > "$config_file" <<JSON
{
  "server": "$SERVER_URL"
}
JSON
      chmod 600 "$config_file"
      log "Seeded config → $config_file"
      log "  server: $SERVER_URL"
    fi
    ;;
esac

# ── Agent CLI detection ────────────────────────────────────────────────────
# The vvibe daemon spawns claude / codex on PATH; missing ones simply won't
# appear in the agent picker on the web UI. Reported here so the user sees
# what's actually usable before pairing.
log "Checking for agent CLIs"
missing_tools=''
present_tools=''
for tool in claude codex; do
  if command -v "$tool" >/dev/null 2>&1; then
    ver="$("$tool" --version 2>/dev/null | head -n1 || true)"
    printf '   [ok] %s%s\n' "$tool" "${ver:+ ($ver)}"
    present_tools="${present_tools} ${tool}"
  else
    printf '   [--] %s not found on PATH\n' "$tool"
    missing_tools="${missing_tools} ${tool}"
  fi
done

# Sign-in reminder. `--version` doesn't require auth, so detecting the binary
# tells us nothing about whether the user has actually logged in. The web UI
# now surfaces "Not logged in" as a friendly modal, but flagging it up-front
# here saves the round-trip of "install → pair → send first prompt → see
# error → come back to terminal".
if [ -n "$present_tools" ]; then
  printf '\n'
  # shellcheck disable=SC2086 # word-splitting is intentional here
  printf '   Note: %s --version succeeded, but that does not prove sign-in.\n' "$(printf '%s' $present_tools | tr ' ' '/')"
  printf '   Before sending a prompt, make sure you have run:\n'
  for t in $present_tools; do
    case "$t" in
      claude) printf '     claude /login\n' ;;
      codex)  printf '     codex login\n' ;;
    esac
  done
fi

# Offer to install missing CLIs via npm. Node is a hard prerequisite for the
# agent CLIs themselves, so we offer to install it first via brew (macOS)
# when possible — otherwise we point the user at concrete commands for their
# distro rather than leaving them to guess.
#
# `curl | sh` pipes the script over stdin, so prompts must read from /dev/tty
# — skip the interactive offer entirely when there's no controlling tty (CI,
# fully non-interactive installs) and just print the manual commands.
if [ -n "$missing_tools" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    printf '\n'
    warn "Node.js is required to install the agent CLIs but npm isn't on PATH."
    if [ "$os" = "darwin" ] && command -v brew >/dev/null 2>&1 && [ "$have_tty" -eq 1 ]; then
      printf "Install Node.js now via 'brew install node'? [y/N] " >/dev/tty
      reply=''
      read -r reply </dev/tty || reply=''
      case "$reply" in
        [Yy]*)
          log "Installing Node.js via brew"
          if ! brew install node; then
            warn "brew install node failed. Install manually from https://nodejs.org/ then re-run this installer."
          fi
          ;;
        *)
          warn "Install Node.js (https://nodejs.org/) then re-run this installer to finish."
          ;;
      esac
    else
      warn "Install Node.js LTS, then re-run this installer to finish. Examples:"
      case "$os" in
        darwin)
          printf '     brew install node\n' >&2
          printf '     # or download installer from https://nodejs.org/\n' >&2
          ;;
        linux)
          printf '     # Debian/Ubuntu:  sudo apt install -y nodejs npm\n' >&2
          printf '     # Fedora/RHEL:    sudo dnf install -y nodejs npm\n' >&2
          printf '     # Arch:           sudo pacman -S nodejs npm\n' >&2
          printf '     # User-scope, no sudo: https://github.com/Schniz/fnm\n' >&2
          ;;
      esac
    fi
  fi

  if command -v npm >/dev/null 2>&1; then
    if [ "$have_tty" -eq 0 ]; then
      warn "Missing CLIs detected, but no TTY available to prompt. Install manually:"
      for tool in $missing_tools; do
        case "$tool" in
          claude) printf '     npm install -g @anthropic-ai/claude-code\n' ;;
          codex)  printf '     npm install -g @openai/codex\n' ;;
        esac
      done
    else
      printf '\n'
      for tool in $missing_tools; do
        case "$tool" in
          claude) pkg='@anthropic-ai/claude-code' ;;
          codex)  pkg='@openai/codex' ;;
        esac
        printf "Install %s via 'npm install -g %s'? [y/N] " "$tool" "$pkg" >/dev/tty
        reply=''
        read -r reply </dev/tty || reply=''
        case "$reply" in
          [Yy]*)
            log "Installing $pkg"
            if ! npm install -g "$pkg"; then
              warn "npm install -g $pkg failed. Install manually before pairing."
            fi
            ;;
          *)
            warn "Skipped $tool. vvibe will report it as unavailable in the web UI until you install it."
            ;;
        esac
      done
    fi
  fi
fi

# ── Offer to pair this machine now ─────────────────────────────────────────
# `vvibe login` opens a device-code flow in the browser. Doing it inline
# saves a copy/paste and exercises the freshly installed binary. Stdin is
# wired to /dev/tty in case the daemon ever reads from it during pairing.
login_done=0
if [ "$have_tty" -eq 1 ]; then
  printf '\n'
  printf "Pair this machine with your account now ('vvibe login')? [Y/n] " >/dev/tty
  reply=''
  read -r reply </dev/tty || reply=''
  case "$reply" in
    [Nn]*) ;;
    *)
      log "Running vvibe login"
      if "$install_dir/$BINARY" login </dev/tty; then
        login_done=1
      else
        warn "vvibe login exited with a non-zero status. Run 'vvibe login' manually when ready."
      fi
      ;;
  esac
fi

# ── Next steps ─────────────────────────────────────────────────────────────
printf '\n'
printf 'Next:\n'
if [ "$login_done" -eq 1 ]; then
  printf '  [done] Paired.\n\n'
  printf '  1. Register as a service (auto-start on boot):\n'
else
  printf '  1. Pair this machine:\n'
  printf '       vvibe login\n\n'
  printf '  2. Register as a service (auto-start on boot):\n'
fi
printf '       vvibe install\n'
printf '       vvibe status\n\n'
printf 'If anything looks wrong:\n'
printf '       vvibe doctor    # prints a diagnostic report; paste it into a bug report\n'

# If the installer just appended to a shell rc, the user's current terminal
# can't see vvibe yet — only new shells will. The post-install commands
# above will fail with `command not found` until they reload, so reprint
# the hint right before they reach for it.
if [ -n "$path_modified_file" ]; then
  printf '\n'
  printf "Heads up: vvibe is on PATH only in NEW terminal windows (%s was\n" "$path_modified_file"
  printf "updated, but your current shell hasn't reloaded it). To run the\n"
  printf "commands above in *this* terminal first:\n"
  printf '    source %s\n' "$path_modified_file"
fi

printf '\nFor Windows: see install.ps1.\n'
printf 'Manual / source builds: https://github.com/%s/tree/main/client-go\n' "$REPO"
