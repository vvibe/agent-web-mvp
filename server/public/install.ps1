# vvibe installer (Windows).
#
# Usage (in any PowerShell, NOT necessarily admin):
#   iwr https://<server>/install.ps1 | iex
#
# What it does:
#   1. Detects arch (amd64 / arm64)
#   2. Downloads the latest vvibe zip from GitHub Releases
#   3. Verifies sha256 against checksums.txt
#   4. Installs into %LOCALAPPDATA%\Programs\Vvibe\ (no admin needed for
#      placement; PATH is updated for the current user)
#   5. Prints the next two commands (`install` needs admin PowerShell; `login`
#      does not)

$ErrorActionPreference = 'Stop'

$Repo = 'vvibe/agent-web-mvp'
$AssetPrefix = 'vvibe'
$Binary = 'vvibe.exe'
$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Vvibe'

function Write-Step { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn { param($msg) Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail      { param($msg) Write-Host "xx  $msg" -ForegroundColor Red; exit 1 }

# ── Detect platform ────────────────────────────────────────────────────────
if (-not [Environment]::Is64BitOperatingSystem) {
  Fail "32-bit Windows is not supported."
}
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'ARM64' { 'arm64' }
  'AMD64' { 'amd64' }
  default { 'amd64' }
}

$asset = "${AssetPrefix}_windows_${arch}.zip"
$url = "https://github.com/$Repo/releases/latest/download/$asset"
$checksumsUrl = "https://github.com/$Repo/releases/latest/download/checksums.txt"
$tempDir = Join-Path $env:TEMP "vvibe-install-$(Get-Random)"
New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  Write-Step "Detected: windows/$arch"
  Write-Step "Downloading $asset"
  $archivePath = Join-Path $tempDir $asset
  try {
    Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing
  } catch {
    Fail "Download failed. URL: $url`n   $($_.Exception.Message)"
  }

  Write-Step "Verifying checksum"
  $checksumsPath = Join-Path $tempDir 'checksums.txt'
  try {
    Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath -UseBasicParsing
    $line = Select-String -Path $checksumsPath -Pattern "  $([regex]::Escape($asset))$"
    if (-not $line) {
      Write-Warn "Could not find $asset in checksums.txt — skipping verification"
    } else {
      $expected = ($line.Line -split '\s+')[0]
      $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLower()
      if ($expected -ne $actual) {
        Fail "Checksum mismatch.`n   expected: $expected`n   actual:   $actual"
      }
    }
  } catch {
    Write-Warn "Could not verify checksum: $($_.Exception.Message)"
  }

  Write-Step "Extracting"
  Expand-Archive -Path $archivePath -DestinationPath $tempDir -Force
  $exe = Join-Path $tempDir $Binary
  if (-not (Test-Path $exe)) {
    Fail "Extracted archive does not contain $Binary"
  }

  Write-Step "Installing to $InstallDir"
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  # Move/replace the binary. If the file is in use (service running), this
  # will fail loudly — the user should stop the service first.
  Move-Item -Path $exe -Destination (Join-Path $InstallDir $Binary) -Force

  # Add to user PATH if not already there.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -ieq $InstallDir })) {
    Write-Step "Adding $InstallDir to user PATH"
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
  }
  # Update the *current* session's PATH too so `vvibe` works immediately,
  # without forcing a new shell. New windows pick up the User-scoped value
  # set above.
  if (-not ($env:Path -split ';' | Where-Object { $_ -ieq $InstallDir })) {
    $env:Path = "$env:Path;$InstallDir"
  }
} finally {
  Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}

$installedExe = Join-Path $InstallDir $Binary
$ver = try { & $installedExe version } catch { 'unknown' }

Write-Host ""
Write-Host "Installed -> $installedExe"
Write-Host "Version:     $ver"

# ── Agent CLI detection ────────────────────────────────────────────────────
# The vvibe daemon spawns claude / codex on PATH; missing ones simply won't
# appear in the agent picker on the web UI. Surfaced here so the user sees
# what's usable before pairing.
Write-Step "Checking for agent CLIs"
$missing = 0
foreach ($tool in @('claude', 'codex')) {
  $cmd = Get-Command $tool -ErrorAction SilentlyContinue
  if ($cmd) {
    $v = try { (& $tool --version 2>$null | Select-Object -First 1) } catch { '' }
    if ($v) { Write-Host "   [ok] $tool ($v)" -ForegroundColor Green }
    else    { Write-Host "   [ok] $tool"      -ForegroundColor Green }
  } else {
    Write-Host "   [--] $tool not found on PATH" -ForegroundColor Yellow
    $missing++
  }
}
if ($missing -gt 0) {
  Write-Warn "Install the missing CLIs before sending prompts, or vvibe will report them as unavailable in the web UI."
}

Write-Host ""
Write-Host "Next:"
Write-Host "  1. Pair this machine:"
Write-Host "       vvibe login"
Write-Host ""
Write-Host "  2. Register as a Windows service (needs Administrator PowerShell):"
Write-Host "       vvibe install"
Write-Host "       vvibe status"
Write-Host ""
Write-Host "Note: SmartScreen may warn on first run because the binary is unsigned."
Write-Host "Code signing is on the roadmap (M6 P1)."
