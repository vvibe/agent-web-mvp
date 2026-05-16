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
		home, err := os.UserHomeDir()
		if err != nil {
			sendListing(s, requestID, "", "", nil, err.Error())
			return
		}
		path = home
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
