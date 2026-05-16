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
# Prefer /usr/local/bin so the daemon is on PATH for `vvibe` invocations from
# any shell. Fall back to ~/.local/bin if we can't write there.
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

bin="$TMPDIR/$BINARY"
[ -f "$bin" ] || die "Extracted archive does not contain $BINARY binary"
chmod +x "$bin"

log "Installing to $install_dir/$BINARY"
if [ -w "$install_dir" ]; then
  mv "$bin" "$install_dir/$BINARY"
else
  log "  (sudo needed to write $install_dir)"
  sudo mv "$bin" "$install_dir/$BINARY"
fi

cat <<EOF

Installed → $install_dir/$BINARY
Version:    $("$install_dir/$BINARY" version 2>/dev/null || echo unknown)
EOF

# ── Agent CLI detection ────────────────────────────────────────────────────
# The vvibe daemon spawns claude / codex on PATH; missing ones simply won't
# appear in the agent picker on the web UI. Reported here so the user sees
# what's actually usable before pairing.
log "Checking for agent CLIs"
missing=0
for tool in claude codex; do
  if command -v "$tool" >/dev/null 2>&1; then
    ver="$("$tool" --version 2>/dev/null | head -n1 || true)"
    printf '   [ok] %s%s\n' "$tool" "${ver:+ ($ver)}"
  else
    printf '   [--] %s not found on PATH\n' "$tool"
    missing=$((missing + 1))
  fi
done
if [ "$missing" -gt 0 ]; then
  warn "Install the missing CLIs before sending prompts, or vvibe will report them as unavailable in the web UI."
fi

# ── Next steps ─────────────────────────────────────────────────────────────
cat <<EOF

Next:
  1. Pair this machine:
       vvibe login

  2. Register as a service (auto-start on boot):
       vvibe install
       vvibe status

For Windows: see install.ps1.
Manual / source builds: https://github.com/$REPO/tree/main/client-go
EOF
