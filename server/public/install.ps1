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
# Substituted at serve-time by the HTTP server with the WS URL derived from
# the request that fetched this script. When you run install.ps1 from a local
# copy (not via iwr|iex) the placeholder remains and config-seeding is skipped.
$ServerUrl = '__VVIBE_SERVER_URL__'

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

  # If the daemon is already running we can't overwrite the binary — the
  # service holds an exclusive lock on Windows, and silently clobbering would
  # leave a confusing Move-Item error. Detect and point at `vvibe upgrade`,
  # which handles the stop/replace/start dance properly.
  $destPath = Join-Path $InstallDir $Binary
  if (Test-Path $destPath) {
    $svc = Get-Service -Name 'Vvibe' -ErrorAction SilentlyContinue
    $procs = Get-Process -Name 'vvibe' -ErrorAction SilentlyContinue
    if (($svc -and $svc.Status -eq 'Running') -or $procs) {
      Write-Warn "vvibe is already installed and currently running."
      Write-Warn "  - To update in place, run: vvibe upgrade"
      Write-Warn "  - Or stop it first: vvibe uninstall  (service)  /  Ctrl-C  (foreground)"
      Fail "Aborting to avoid clobbering a running daemon."
    }
  }

  Write-Step "Installing to $InstallDir"
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Move-Item -Path $exe -Destination $destPath -Force

  # Add to user PATH (persisted) AND refresh the current session so `vvibe`
  # is immediately callable from this PowerShell window — including by the
  # post-install `vvibe login` prompt below.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -ieq $InstallDir })) {
    Write-Step "Adding $InstallDir to user PATH"
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
  }
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

# ── Seed daemon config with server URL ─────────────────────────────────────
# When this script was served by the vvibe HTTP server it substitutes its own
# WS URL into $ServerUrl above. Write it into the daemon config so
# `vvibe login` doesn't need --server. Skipped if the placeholder is still
# present or a config file already exists.
if ($ServerUrl -ne '__VVIBE_SERVER_URL__' -and -not [string]::IsNullOrWhiteSpace($ServerUrl)) {
  $configDir = Join-Path $env:APPDATA 'vvibe'
  $configFile = Join-Path $configDir 'client.json'
  if (Test-Path $configFile) {
    Write-Step "Config already exists at $configFile — keeping existing server URL"
  } else {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    @{ server = $ServerUrl } | ConvertTo-Json -Compress | Set-Content -Path $configFile -Encoding UTF8
    Write-Step "Seeded config -> $configFile"
    Write-Host "   server: $ServerUrl"
  }
}

# ── Agent CLI detection ────────────────────────────────────────────────────
# The vvibe daemon spawns claude / codex on PATH; missing ones simply won't
# appear in the agent picker on the web UI. Surfaced here so the user sees
# what's usable before pairing.
Write-Step "Checking for agent CLIs"
$missingTools = @()
foreach ($tool in @('claude', 'codex')) {
  $cmd = Get-Command $tool -ErrorAction SilentlyContinue
  if ($cmd) {
    $v = try { (& $tool --version 2>$null | Select-Object -First 1) } catch { '' }
    if ($v) { Write-Host "   [ok] $tool ($v)" -ForegroundColor Green }
    else    { Write-Host "   [ok] $tool"      -ForegroundColor Green }
  } else {
    Write-Host "   [--] $tool not found on PATH" -ForegroundColor Yellow
    $missingTools += $tool
  }
}

# Offer to install missing CLIs via npm. Node is a hard prerequisite for the
# agent CLIs themselves, so we offer to install it first via winget if it's
# missing — otherwise the user is stuck reading nodejs.org docs to come back.
if ($missingTools.Count -gt 0) {
  $npmPkg = @{ 'claude' = '@anthropic-ai/claude-code'; 'codex' = '@openai/codex' }
  $npm = Get-Command npm -ErrorAction SilentlyContinue

  if (-not $npm) {
    Write-Host ""
    Write-Warn "Node.js is required to install the agent CLIs but npm isn't on PATH."
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    if ($winget) {
      $reply = Read-Host "Install Node.js LTS now via 'winget install OpenJS.NodeJS.LTS'? [y/N]"
      if ($reply -match '^[Yy]') {
        Write-Step "Installing Node.js LTS via winget"
        & winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0) {
          # winget updates machine/user PATH but the current PS session's
          # $env:Path is stale. Re-read from the registry so npm is callable
          # without telling the user to open a new window.
          $env:Path = ([Environment]::GetEnvironmentVariable('Path', 'Machine')
                       + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))
          $npm = Get-Command npm -ErrorAction SilentlyContinue
          if (-not $npm) {
            Write-Warn "Node installed but npm still not on PATH in this session. Open a new PowerShell window and re-run this installer to finish."
          }
        } else {
          Write-Warn "winget install failed (exit $LASTEXITCODE). Install Node manually from https://nodejs.org/ then re-run this installer."
        }
      } else {
        Write-Warn "Install Node.js (https://nodejs.org/) then re-run this installer to finish."
      }
    } else {
      Write-Warn "winget not available. Install Node.js LTS from https://nodejs.org/ then re-run this installer."
    }
  }

  if ($npm) {
    Write-Host ""
    foreach ($tool in $missingTools) {
      $pkg = $npmPkg[$tool]
      $reply = Read-Host "Install $tool via 'npm install -g $pkg'? [y/N]"
      if ($reply -match '^[Yy]') {
        Write-Step "Installing $pkg"
        & npm install -g $pkg
        if ($LASTEXITCODE -ne 0) {
          Write-Warn "npm install -g $pkg failed (exit $LASTEXITCODE). Install manually before pairing."
        }
      } else {
        Write-Warn "Skipped $tool. vvibe will report it as unavailable in the web UI until you install it."
      }
    }
  }
}

# ── Offer to pair this machine now ─────────────────────────────────────────
# `vvibe login` is the obvious next step — the device-code flow opens a
# browser and writes the paired token to disk. Doing it inline saves the
# user a copy/paste and exercises the freshly installed binary.
$loginDone = $false
Write-Host ""
$reply = Read-Host "Pair this machine with your account now ('vvibe login')? [Y/n]"
if ($reply -notmatch '^[Nn]') {
  Write-Step "Running vvibe login"
  & $installedExe login
  if ($LASTEXITCODE -eq 0) {
    $loginDone = $true
  } else {
    Write-Warn "vvibe login exited with code $LASTEXITCODE. Run 'vvibe login' manually when ready."
  }
}

Write-Host ""
Write-Host "Next:"
if ($loginDone) {
  Write-Host "  [done] Paired."
} else {
  Write-Host "  1. Pair this machine:"
  Write-Host "       vvibe login"
}
Write-Host ""
Write-Host "  $(if ($loginDone) { '1' } else { '2' }). Register as a Windows service (needs Administrator PowerShell):"
Write-Host "       vvibe install"
Write-Host "       vvibe status"
Write-Host ""
Write-Host "Note: SmartScreen may warn on first run because the binary is unsigned."
Write-Host "Code signing is on the roadmap (M6 P1)."
