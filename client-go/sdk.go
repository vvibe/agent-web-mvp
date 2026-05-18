package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// claudeSDKPkg is the npm package the bridge dynamically imports. The
// bridge intentionally restricts SDK resolution to its own directory (and
// global Node paths) — see helpers/claude-bridge.mjs — so we install the
// SDK *next to* the bridge under appDir() rather than relying on the
// service's per-account npm prefix (which under LocalSystem is wrong).
const claudeSDKPkg = "@anthropic-ai/claude-agent-sdk"

// sdkInstalled returns true if appDir()/node_modules/@anthropic-ai/claude-agent-sdk
// looks valid — that's exactly where the bridge's createRequire() walk lands.
func sdkInstalled() bool {
	dir, err := appDir()
	if err != nil {
		return false
	}
	pkg := filepath.Join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json")
	if fi, err := os.Stat(pkg); err == nil && !fi.IsDir() {
		return true
	}
	return false
}

// ensureClaudeSDK runs `npm install --prefix <appDir> @anthropic-ai/claude-agent-sdk`
// so the bridge can resolve the SDK without depending on the user's npm
// global prefix (which the service can't reliably reach under LocalSystem).
//
// Best-effort: prints warnings on failure but never aborts the caller. The
// intended call site is `vvibe install` — that runs in the user's
// interactive shell where npm is on PATH and writes are allowed under
// %ProgramData%\vvibe. Calling it from the LocalSystem service would
// usually fail (no npm on PATH, no network deps cached for SYSTEM user).
//
// Returns true when, after this call, the SDK is in place.
func ensureClaudeSDK() bool {
	if sdkInstalled() {
		return true
	}
	dir, err := appDir()
	if err != nil {
		fmt.Fprintf(os.Stderr, "!!  cannot resolve config dir: %v\n", err)
		return false
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "!!  mkdir %s: %v\n", dir, err)
		return false
	}

	// Make sure npm is findable even when invoked from a service-style PATH.
	augmentPATHForAgents()

	if _, err := exec.LookPath("npm"); err != nil {
		fmt.Fprintf(os.Stderr,
			"!!  npm not found on PATH — can't install %s automatically.\n"+
				"    Install Node.js LTS, then run:\n"+
				"      npm install --prefix %q %s\n",
			claudeSDKPkg, dir, claudeSDKPkg)
		return false
	}

	fmt.Printf("==> Installing %s to %s (may take ~20s)\n", claudeSDKPkg, dir)
	cmd := exec.Command("npm", "install", "--silent", "--no-audit", "--no-fund",
		"--prefix", dir, claudeSDKPkg)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr,
			"!!  npm install failed: %v\n"+
				"    Claude sessions will not work until you retry:\n"+
				"      npm install --prefix %q %s\n",
			err, dir, claudeSDKPkg)
		return false
	}
	fmt.Println("    SDK installed.")
	return true
}

// runSdkInstall is the user-facing `vvibe sdk` command. Stands alone so
// users who installed before this version can repair their setup without
// uninstalling first.
func runSdkInstall() {
	if !ensureClaudeSDK() {
		os.Exit(1)
	}
	fmt.Println("ok: Claude SDK ready.")
}
