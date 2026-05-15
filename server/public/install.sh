#!/bin/sh
# agent-client installer (macOS + Linux).
#
# Usage:
#   curl -fsSL https://<server>/install.sh | sh
#
# What it does:
#   1. Detects OS / arch
#   2. Downloads the latest agent-client release tarball from GitHub
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
ASSET_PREFIX="agent-client"
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

asset="${ASSET_PREFIX}_${os}_${arch}.tar.gz"
url="https://github.com/${REPO}/releases/latest/download/${asset}"
checksums_url="https://github.com/${REPO}/releases/latest/download/checksums.txt"

# ── Pick install location ──────────────────────────────────────────────────
# Prefer /usr/local/bin so the daemon is on PATH for `agent-client` invocations
# from any shell. Fall back to ~/.local/bin if we can't write there.
install_dir=/usr/local/bin
if ! { [ -w "$install_dir" ] || ([ ! -e "$install_dir" ] && [ -w "$(dirname "$install_dir")" ]); }; then
  install_dir="$HOME/.local/bin"
  mkdir -p "$install_dir"
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) warn "$install_dir is not on your PATH — add it to your shell profile after install" ;;
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

bin="$TMPDIR/agent-client"
[ -f "$bin" ] || die "Extracted archive does not contain agent-client binary"
chmod +x "$bin"

log "Installing to $install_dir/agent-client"
if [ -w "$install_dir" ]; then
  mv "$bin" "$install_dir/agent-client"
else
  log "  (sudo needed to write $install_dir)"
  sudo mv "$bin" "$install_dir/agent-client"
fi

# ── Next steps ─────────────────────────────────────────────────────────────
cat <<EOF

Installed → $install_dir/agent-client
Version:    $("$install_dir/agent-client" version 2>/dev/null || echo unknown)

Next:
  1. Pair this machine:
       agent-client login

  2. Register as a service (auto-start on boot):
       agent-client install
       agent-client status

For Windows: see install.ps1.
Manual / source builds: https://github.com/$REPO/tree/main/client-go
EOF
