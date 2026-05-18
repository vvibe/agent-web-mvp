package main

import (
	"os"
	"path/filepath"
	"sort"
)

// handleListDir reads a directory and sends a daemon_dir_listing reply.
// Empty path means "user's home dir" so the browser doesn't need to know
// OS-specific defaults. Filters to directories only since cwd must be a dir.
func handleListDir(s *wsSender, msg map[string]any) {
	requestID, _ := msg["requestId"].(string)
	if requestID == "" {
		return
	}
	path, _ := msg["path"].(string)
	if path == "" {
		// Prefer the home dir snapshotted at `vvibe install`. The
		// daemon's own os.UserHomeDir() returns the wrong thing under
		// LocalSystem (C:\WINDOWS\system32\config\systemprofile) and
		// under any sudoed Unix install (/root) — both nominally exist
		// but contain nothing the user wants to start a session in.
		path = resolvedHomeDir()
		if path == "" {
			sendListing(s, requestID, "", "", nil, "no home dir available")
			return
		}
	} else {
		// Reject relative paths — they'd resolve against the daemon's cwd,
		// which is unpredictable when running as a service.
		if !filepath.IsAbs(path) {
			sendListing(s, requestID, path, "", nil, "path must be absolute")
			return
		}
		path = filepath.Clean(path)
	}

	entries, err := os.ReadDir(path)
	if err != nil {
		sendListing(s, requestID, path, "", nil, err.Error())
		return
	}

	dirs := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		// Hide dotfiles by default; the user can still type the path manually.
		if len(name) > 0 && name[0] == '.' {
			continue
		}
		dirs = append(dirs, map[string]any{"name": name, "isDir": true})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return dirs[i]["name"].(string) < dirs[j]["name"].(string)
	})

	parent := filepath.Dir(path)
	if parent == path {
		// At a filesystem root (POSIX "/" or Windows "C:\\"); omit parent so
		// the UI hides the "Up" button.
		parent = ""
	}

	sendListing(s, requestID, path, parent, dirs, "")
}

// resolvedHomeDir returns the home directory the folder picker should
// default to. Resolution order:
//
//  1. Config.UserHomeDir — recorded by `vvibe install` from the
//     interactive user's process. Authoritative when set.
//  2. os.UserHomeDir() — the daemon's own home. Right on macOS/Linux
//     when the daemon runs as the user; wrong (but harmless) on Windows
//     LocalSystem.
//
// Returns "" only when both fail.
func resolvedHomeDir() string {
	if cfg, err := loadConfig(); err == nil && cfg != nil && cfg.UserHomeDir != "" {
		if fi, err := os.Stat(cfg.UserHomeDir); err == nil && fi.IsDir() {
			return cfg.UserHomeDir
		}
		// Snapshot is stale (user dir moved/deleted) — fall through to
		// the runtime lookup. Worth logging once because this is the
		// kind of state where the user will be confused why the picker
		// keeps landing somewhere weird.
	}
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return ""
}

func sendListing(s *wsSender, requestID, path, parent string, entries []map[string]any, errMsg string) {
	payload := map[string]any{
		"type":      "daemon_dir_listing",
		"requestId": requestID,
		"path":      path,
		"entries":   entries,
	}
	if parent != "" {
		payload["parent"] = parent
	}
	if errMsg != "" {
		payload["error"] = errMsg
	}
	_ = s.send(payload)
}
