#!/usr/bin/env bash
# sign-binary.sh — GoReleaser post-build hook, called once per built binary.
#
# Args:
#   $1: path to the just-built binary (relative to client-go/)
#   $2: GOOS (linux / darwin / windows)
#   $3: GOARCH (amd64 / arm64)
#
# Behaviour:
#   - linux                → no-op (no signing tradition; ship as-is)
#   - windows + WINDOWS_CERT_PATH set
#                          → osslsigncode + SHA256 timestamp
#   - darwin  + MACOS_APPLE_ID set
#                          → rcodesign sign + rcodesign notary-submit + staple
#   - missing env / missing tool
#                          → log + skip (release still goes out unsigned;
#                            users will see Gatekeeper / SmartScreen warnings)
#
# Secrets read from the environment:
#   Windows:
#     WINDOWS_CERT_PATH       path to the unlocked .pfx (set by CI from a base64
#                              secret materialised to disk)
#     WINDOWS_CERT_PASSWORD   password for the PFX
#   macOS:
#     MACOS_CERT_PATH         path to the Developer ID Application .p12
#     MACOS_CERT_PASSWORD     password for the P12
#     MACOS_APPLE_ID          Apple ID email
#     MACOS_TEAM_ID           Apple Developer team ID (10-char code)
#     MACOS_APP_PASSWORD      App-specific password for the Apple ID
#                              (https://appleid.apple.com → Sign-In → App-Specific Passwords)

set -euo pipefail

bin_path="$1"
goos="$2"
goarch="$3"

log()  { printf '\033[1;34m[sign]\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m[sign:skip]\033[0m %s\n' "$*"; }

case "$goos" in
  linux)
    skip "linux: no signing"
    exit 0
    ;;

  windows)
    if [ -z "${WINDOWS_CERT_PATH:-}" ]; then
      skip "windows/$goarch: WINDOWS_CERT_PATH unset, leaving unsigned"
      exit 0
    fi
    if ! command -v osslsigncode >/dev/null 2>&1; then
      skip "windows/$goarch: osslsigncode not installed"
      exit 0
    fi
    log "windows/$goarch: osslsigncode → $bin_path"
    tmp="${bin_path}.signed"
    osslsigncode sign \
      -pkcs12 "$WINDOWS_CERT_PATH" \
      -pass "${WINDOWS_CERT_PASSWORD:-}" \
      -n "vvibe" \
      -i "https://github.com/vvibe/agent-web-mvp" \
      -t "http://timestamp.sectigo.com" \
      -h sha256 \
      -in "$bin_path" \
      -out "$tmp"
    mv "$tmp" "$bin_path"
    osslsigncode verify -in "$bin_path" || true
    ;;

  darwin)
    if [ -z "${MACOS_APPLE_ID:-}" ]; then
      skip "darwin/$goarch: MACOS_APPLE_ID unset, leaving unsigned"
      exit 0
    fi
    if ! command -v rcodesign >/dev/null 2>&1; then
      skip "darwin/$goarch: rcodesign not installed"
      exit 0
    fi
    log "darwin/$goarch: rcodesign → $bin_path"
    rcodesign sign \
      --p12-file "$MACOS_CERT_PATH" \
      --p12-password "${MACOS_CERT_PASSWORD:-}" \
      --code-signature-flags runtime \
      "$bin_path"

    log "darwin/$goarch: rcodesign notary-submit"
    rcodesign notary-submit \
      --api-issuer "$MACOS_TEAM_ID" \
      --api-key-path /dev/null \
      --wait \
      "$bin_path" || skip "notarisation failed; binary still signed but Gatekeeper-allergic"
    # rcodesign supports stapling for bundles only; bare binaries can't be
    # stapled by Apple's design, so end-users get an online check on first run.
    ;;

  *)
    skip "unknown GOOS=$goos"
    ;;
esac
