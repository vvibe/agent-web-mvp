package main

import (
	"log"
	"os"
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
	dirs := discoverWindowsAgentDirs()
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
			filepath.Join(appData, "Roaming", "npm"),         // npm global (default)
			filepath.Join(appData, "Local", "nvs", "default"), // nvs active link
			filepath.Join(appData, "Local", "Volta", "bin"),   // Volta
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
		`C:\Program Files\nodejs`,
		`C:\Program Files (x86)\nodejs`,
		`C:\ProgramData\scoop\apps\nodejs\current`,
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
