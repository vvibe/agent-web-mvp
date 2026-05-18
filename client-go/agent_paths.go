package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// augmentPATHForAgents prepends discovered Node / agent install directories
// to the process PATH. On Windows the daemon often runs as LocalSystem
// (registered as a service) whose PATH lacks per-user installs like nvs,
// nvm-windows, volta, scoop, and npm globals. Without this augmentation
// exec.LookPath misses `claude` / `codex` / `node`, detectAgents() returns
// an empty list, and the web UI tells the user there are no agent CLIs on
// PATH — even when their own shell can see both.
//
// No-op on macOS/Linux: launchd/systemd user-mode services run as the
// invoking user and inherit a sensible PATH already.
func augmentPATHForAgents() {
	if runtime.GOOS != "windows" {
		return
	}
	// Snapshot from `vvibe install` runs first: these are dirs that
	// actually held a working `claude` / `codex` / `node` when the
	// interactive user ran install. Heuristic discovery comes second as
	// a fallback for fresh installs that pre-date the snapshot field, or
	// for binaries added after install.
	dirs := loadSnapshotAgentBinDirs()
	dirs = append(dirs, discoverWindowsAgentDirs()...)
	if len(dirs) == 0 {
		return
	}
	sep := string(os.PathListSeparator)
	seen := map[string]struct{}{}
	for _, p := range strings.Split(os.Getenv("PATH"), sep) {
		seen[strings.ToLower(p)] = struct{}{}
	}
	var add []string
	for _, d := range dirs {
		if _, ok := seen[strings.ToLower(d)]; ok {
			continue
		}
		seen[strings.ToLower(d)] = struct{}{}
		add = append(add, d)
	}
	if len(add) == 0 {
		return
	}
	_ = os.Setenv("PATH", strings.Join(add, sep)+sep+os.Getenv("PATH"))
	log.Printf("PATH augmented with %d agent install dir(s): %s",
		len(add), strings.Join(add, " ; "))
}

// snapshotInteractiveUserEnv records what the daemon won't be able to
// figure out for itself once it's running under a different identity:
//   - agent bin dirs (Windows only — see snapshotAgentBinDirs comment)
//   - the interactive user's home dir (every platform; defensive against
//     `vvibe install` being run as root on Unix, where the daemon would
//     otherwise think /root is "home" and offer a useless folder picker
//     default)
//
// Called from `vvibe install`. Best-effort: any individual step that
// fails is logged and skipped so install can still succeed.
func snapshotInteractiveUserEnv() {
	cfg, err := loadConfig()
	if err != nil || cfg == nil {
		if err != nil {
			log.Printf("snapshot: skip (config load failed: %v)", err)
		}
		return
	}

	// Always refresh — re-running install means "this is the canonical
	// user/agent layout now", not "merge with whatever was there".
	cfg.AgentBinDirs = collectAgentBinDirs()
	if home, herr := os.UserHomeDir(); herr == nil && home != "" {
		cfg.UserHomeDir = home
	}

	if err := saveConfig(cfg); err != nil {
		log.Printf("snapshot: skip (config save failed: %v)", err)
		return
	}

	if runtime.GOOS == "windows" {
		if len(cfg.AgentBinDirs) == 0 {
			fmt.Println("note: no claude/codex/node found on PATH yet — install one, then re-run `vvibe install` to refresh the snapshot.")
		} else {
			fmt.Printf("snapshot: recorded %d agent bin dir(s) for the service to inherit.\n", len(cfg.AgentBinDirs))
		}
	}
	if cfg.UserHomeDir != "" {
		fmt.Printf("snapshot: user home recorded as %s (folder picker default).\n", cfg.UserHomeDir)
	}
}

// collectAgentBinDirs returns the directories that contain working
// `claude` / `codex` / `node` on the *current* process's PATH. The
// caller (snapshotInteractiveUserEnv) persists the result. Windows-only:
// on macOS/Linux the daemon runs as the same user, so its own
// exec.LookPath at runtime is just as good as snapshotting at install
// time and skipping the file write saves a config-version bump for
// users who paired before this field existed.
func collectAgentBinDirs() []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	seen := map[string]struct{}{}
	var dirs []string
	for _, name := range []string{"claude", "codex", "node"} {
		p, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		d := filepath.Dir(p)
		key := strings.ToLower(d)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		dirs = append(dirs, d)
	}
	return dirs
}

// loadSnapshotAgentBinDirs reads Config.AgentBinDirs without exposing
// the rest of the config to augmentPATHForAgents (which has no need
// for tokens / server URL). Errors are swallowed: a missing or
// corrupt config falls back to heuristic discovery.
func loadSnapshotAgentBinDirs() []string {
	cfg, err := loadConfig()
	if err != nil || cfg == nil {
		return nil
	}
	return cfg.AgentBinDirs
}

// discoverWindowsAgentDirs enumerates likely install locations of node /
// claude / codex across every real user profile on this machine plus the
// well-known system-wide nodejs locations. Returns only directories that
// actually contain one of the binaries we care about, so adding everything
// to PATH doesn't bloat it with empty dirs.
func discoverWindowsAgentDirs() []string {
	var candidates []string

	for _, userHome := range enumerateWindowsUserHomes() {
		appData := filepath.Join(userHome, "AppData")
		candidates = append(candidates,
			filepath.Join(appData, "Roaming", "npm"),          // npm global (default)
			filepath.Join(appData, "Local", "nvs", "default"), // nvs active link
			filepath.Join(appData, "Local", "Volta", "bin"),   // Volta
			filepath.Join(userHome, ".local", "bin"),          // anthropic claude.exe native installer
			filepath.Join(userHome, "scoop", "shims"),         // Scoop user install
			filepath.Join(userHome, "scoop", "apps", "nodejs", "current"),
		)
		if d := latestSubdir(filepath.Join(appData, "Local", "nvs", "node")); d != "" {
			if arch := pickNvsArchDir(d); arch != "" {
				candidates = append(candidates, arch)
			}
		}
		if d := latestSubdir(filepath.Join(appData, "Roaming", "nvm")); d != "" {
			candidates = append(candidates, d)
		}
	}

	candidates = append(candidates,
		`C:\Program Files\nodejs`,           // standard installer + nvm-windows symlink target
		`C:\Program Files (x86)\nodejs`,     // 32-bit installer
		`C:\ProgramData\scoop\apps\nodejs\current`,
		`C:\ProgramData\chocolatey\bin`,     // chocolatey shims (node, npm, claude/codex if user `choco install`'d)
		`C:\ProgramData\chocolatey\lib\nodejs\tools`,
	)

	var out []string
	for _, d := range candidates {
		if dirContainsAgentBinary(d) {
			out = append(out, d)
		}
	}
	return out
}

// enumerateWindowsUserHomes lists C:\Users\<name> dirs that look like real
// interactive accounts. Skips the well-known system pseudo-accounts and
// anything without an AppData subdir (which all real Windows accounts have).
func enumerateWindowsUserHomes() []string {
	entries, err := os.ReadDir(`C:\Users`)
	if err != nil {
		return nil
	}
	skip := map[string]bool{
		"default":            true,
		"default user":       true,
		"public":             true,
		"defaultuser0":       true,
		"wdagutilityaccount": true,
		"all users":          true,
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() || skip[strings.ToLower(e.Name())] {
			continue
		}
		p := filepath.Join(`C:\Users`, e.Name())
		if _, err := os.Stat(filepath.Join(p, "AppData")); err != nil {
			continue
		}
		out = append(out, p)
	}
	return out
}

// latestSubdir returns the subdirectory of root with the highest version
// number, or "". Version comparison is numeric per-component so "20.19.3"
// beats "8.17.0" (which it wouldn't under plain lexicographic ordering).
func latestSubdir(root string) string {
	entries, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	var best string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if best == "" || versionLess(best, e.Name()) {
			best = e.Name()
		}
	}
	if best == "" {
		return ""
	}
	return filepath.Join(root, best)
}

// versionLess returns true if a sorts before b under numeric-aware version
// ordering. Splits each name into its digit runs and compares them as
// integers, so "v20.11.0" > "v8.17.0" and "20.19.3" > "8.17.0". Non-digit
// separators ('.', 'v', '-', etc.) are skipped.
func versionLess(a, b string) bool {
	ai := splitDigitRuns(a)
	bi := splitDigitRuns(b)
	for i := 0; i < len(ai) || i < len(bi); i++ {
		var x, y int
		if i < len(ai) {
			x = ai[i]
		}
		if i < len(bi) {
			y = bi[i]
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func splitDigitRuns(s string) []int {
	var out []int
	cur := ""
	for _, r := range s {
		if r >= '0' && r <= '9' {
			cur += string(r)
			continue
		}
		if cur != "" {
			n, _ := strconv.Atoi(cur)
			out = append(out, n)
			cur = ""
		}
	}
	if cur != "" {
		n, _ := strconv.Atoi(cur)
		out = append(out, n)
	}
	return out
}

// pickNvsArchDir picks the architecture subdir under an nvs version dir.
// Layout: %LOCALAPPDATA%\nvs\node\<version>\<arch>\node.exe.
func pickNvsArchDir(versionDir string) string {
	for _, arch := range []string{"x64", "arm64", "x86"} {
		p := filepath.Join(versionDir, arch)
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			return p
		}
	}
	return ""
}

// dirContainsAgentBinary returns true if d has node / claude / codex in any
// of the Windows-executable extensions. We check `node` too so we don't
// leave the bin dir out just because the user installed claude globally via
// a different node-version-manager.
func dirContainsAgentBinary(d string) bool {
	for _, base := range []string{"node", "claude", "codex"} {
		for _, ext := range []string{".exe", ".cmd", ".bat", ".ps1", ""} {
			if fi, err := os.Stat(filepath.Join(d, base+ext)); err == nil && !fi.IsDir() {
				return true
			}
		}
	}
	return false
}
