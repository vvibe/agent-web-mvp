package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// resolveCwdRoot canonicalises a path the user typed at the CLI: absolute,
// EvalSymlinks where possible, expanded with ~ from the home dir. Returns
// an error if the path doesn't exist OR isn't a directory — refusing a
// non-existent allowlist entry is friendlier than silently saving a typo.
func resolveCwdRoot(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("path is empty")
	}
	expanded := raw
	if strings.HasPrefix(raw, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve ~: %w", err)
		}
		expanded = home + raw[1:]
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		return "", fmt.Errorf("absolute path: %w", err)
	}
	fi, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("stat %s: %w", abs, err)
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("not a directory: %s", abs)
	}
	// Best-effort symlink resolution so an entry like ~/code that's actually
	// a symlink into /Volumes/SSD/code stores the real target. Skip on error
	// — Windows junctions etc. are quirky and we'd rather store the typed
	// path than refuse.
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	return filepath.Clean(abs), nil
}

// isCwdAllowed reports whether `cwd` falls inside the union of `allowed`
// roots. Empty allowlist returns true for backwards compatibility (the
// daemon already warns at startup when this happens). Comparisons run on
// canonicalised absolute paths so symlink shenanigans (and Windows case
// differences) can't be used to bypass.
func isCwdAllowed(cwd string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	canonCwd, ok := canonicalisePath(cwd)
	if !ok {
		return false
	}
	for _, root := range allowed {
		canonRoot, ok := canonicalisePath(root)
		if !ok {
			continue
		}
		if isSubpath(canonCwd, canonRoot) {
			return true
		}
	}
	return false
}

func canonicalisePath(p string) (string, bool) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", false
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		abs = real
	}
	return filepath.Clean(abs), true
}

// isSubpath returns true if `child` is the same as `parent` or strictly
// inside it. Uses filepath.Rel so the separator-boundary case is handled
// correctly — a naïve strings.HasPrefix(child, parent) would let
// `/home/user/codex` slip past an allowlist entry of `/home/user/code`.
func isSubpath(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	// `Rel` uses "/.." segments to denote leaving the parent — any leading
	// ".." means child is outside parent. The check also covers "../sibling"
	// and "../../..".
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

// ─── CLI handlers ────────────────────────────────────────────────────────────

func runAllow(args []string) {
	if len(args) == 0 {
		die("usage: vvibe allow <path>\n\nAdds a directory to the allowlist for agent cwd. Sessions targeting\na cwd outside the union of allowed roots are refused.")
	}
	root, err := resolveCwdRoot(args[0])
	if err != nil {
		die("resolve %s: %v", args[0], err)
	}
	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}
	for _, existing := range cfg.AllowedCwds {
		if existing == root {
			fmt.Printf("already allowed: %s\n", root)
			return
		}
	}
	cfg.AllowedCwds = append(cfg.AllowedCwds, root)
	if err := saveConfig(cfg); err != nil {
		die("save config: %v", err)
	}
	fmt.Printf("allowed: %s\n", root)
	fmt.Println("(takes effect on next prompt — no restart needed)")
}

func runDeny(args []string) {
	if len(args) == 0 {
		die("usage: vvibe deny <path>\n\nRemoves a directory from the allowlist. The path must match an\nentry already in the list (use `vvibe allowed` to see them).")
	}
	root, err := resolveCwdRoot(args[0])
	if err != nil {
		// Even if the path no longer exists, allow removal by string match
		// so the operator can clean up stale entries.
		root = filepath.Clean(args[0])
	}
	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}
	out := cfg.AllowedCwds[:0]
	removed := false
	for _, existing := range cfg.AllowedCwds {
		if existing == root {
			removed = true
			continue
		}
		out = append(out, existing)
	}
	if !removed {
		die("not in allowlist: %s\n(use `vvibe allowed` to list current entries)", root)
	}
	cfg.AllowedCwds = out
	if err := saveConfig(cfg); err != nil {
		die("save config: %v", err)
	}
	fmt.Printf("denied: %s\n", root)
}

func runAllowed() {
	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}
	if len(cfg.AllowedCwds) == 0 {
		fmt.Println("no allowlist set — any cwd from the server will be accepted.")
		fmt.Println("Add a root with: vvibe allow <path>")
		return
	}
	fmt.Printf("allowed cwd roots (%d):\n", len(cfg.AllowedCwds))
	for _, p := range cfg.AllowedCwds {
		fmt.Printf("  %s\n", p)
	}
}
