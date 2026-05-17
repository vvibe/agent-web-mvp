package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

//go:embed helpers/claude-bridge.mjs
var claudeBridgeSource []byte

// claudeRunner spawns a Node.js child process running claude-bridge.mjs to
// drive @anthropic-ai/claude-agent-sdk. One bridge process per prompt turn.
type claudeRunner struct {
	stdin    io.WriteCloser
	writeMu  sync.Mutex
	bridgePath string
}

func newClaudeRunner() (Runner, error) {
	// Materialize the embedded bridge script to a stable location on disk
	// the first time we're called. Reuse it across turns. We write to the
	// daemon's config dir so the file persists across reboots without
	// needing temp-dir cleanup logic.
	dir, err := appDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	p := filepath.Join(dir, "claude-bridge.mjs")
	// Always overwrite — embedded version is the source of truth.
	if err := os.WriteFile(p, claudeBridgeSource, 0o600); err != nil {
		return nil, err
	}
	return &claudeRunner{bridgePath: p}, nil
}

func (r *claudeRunner) Permission(requestID string, allow bool) {
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	if r.stdin == nil {
		return
	}
	_ = writeJSONLine(r.stdin, map[string]any{
		"type":      "permission_response",
		"requestId": requestID,
		"allow":     allow,
	})
}

func (r *claudeRunner) Run(
	ctx context.Context, prompt string, cwd string, resumeToken string, model string,
	emit func(role, text string, meta map[string]any),
	askPermission func(requestID, toolName string, input any),
) (string, error) {
	// Validate cwd before spawning so we can return a specific error. Without
	// this, exec returns a generic "chdir <path>: no such file or directory"
	// which gets wrapped into "Cannot start Node bridge: …", misleading users
	// into thinking the issue is node-on-PATH (it isn't — they likely opened
	// the UI from a different machine where this path doesn't exist).
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		hostname, _ := os.Hostname()
		// Use backticks rather than %q for the cwd because %q escapes
		// backslashes on Windows paths (C:\\Users\\...) and reads as noise.
		msg := fmt.Sprintf("Working directory `%s` does not exist on this machine (%s). The session may have been created on a different device — bring that daemon online, or create a new session here.", cwd, hostname)
		emit("system", msg, nil)
		return "", fmt.Errorf("cwd does not exist: %s", cwd)
	}

	nodeBin := os.Getenv("AGENT_WEB_NODE")
	if nodeBin == "" {
		nodeBin = "node"
	}

	cmd := exec.CommandContext(ctx, nodeBin, r.bridgePath)
	cmd.Dir = cwd
	cmd.Env = os.Environ()

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}

	if err := cmd.Start(); err != nil {
		emit("system", "Cannot start Node bridge: "+err.Error()+" (set AGENT_WEB_NODE if node is not on PATH)", nil)
		return "", err
	}

	r.writeMu.Lock()
	r.stdin = stdinPipe
	r.writeMu.Unlock()

	// Send the initial prompt. Empty `model` means "let the SDK choose" so
	// we omit it rather than passing the empty string through.
	payload := map[string]any{
		"type":   "prompt",
		"prompt": prompt,
		"cwd":    cwd,
		"resume": resumeToken,
	}
	if model != "" {
		payload["model"] = model
	}
	if err := writeJSONLine(stdinPipe, payload); err != nil {
		_ = cmd.Process.Kill()
		return "", err
	}

	var newResume string
	var bridgeErr string

	// Forward stderr verbatim so npm/Node errors show up in the daemon log
	// AND surface as system messages so the user sees them in the web UI.
	go func() {
		s := bufio.NewScanner(stderrPipe)
		s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for s.Scan() {
			line := s.Text()
			if line == "" {
				continue
			}
			emit("system", "[claude-bridge] "+line, nil)
		}
	}()

	// Read JSON-line messages from the bridge.
	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		dec := bufio.NewScanner(stdoutPipe)
		dec.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // SDK messages can be large
		for dec.Scan() {
			line := dec.Bytes()
			if len(line) == 0 {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal(line, &m); err != nil {
				continue
			}
			t, _ := m["type"].(string)
			switch t {
			case "message":
				role, _ := m["role"].(string)
				text, _ := m["text"].(string)
				var meta map[string]any
				if v, ok := m["meta"].(map[string]any); ok {
					meta = v
				}
				emit(role, text, meta)
			case "permission_request":
				reqId, _ := m["requestId"].(string)
				tool, _ := m["toolName"].(string)
				askPermission(reqId, tool, m["input"])
			case "done":
				if v, ok := m["resumeToken"].(string); ok {
					newResume = v
				}
				if v, ok := m["error"].(string); ok {
					bridgeErr = v
				}
			}
		}
	}()

	<-stdoutDone

	r.writeMu.Lock()
	r.stdin = nil
	r.writeMu.Unlock()

	_ = cmd.Wait()

	if ctx.Err() != nil {
		return newResume, ctx.Err()
	}
	if bridgeErr != "" && bridgeErr != "cancelled" {
		return newResume, fmt.Errorf("%s", bridgeErr)
	}
	return newResume, nil
}

func writeJSONLine(w io.Writer, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = w.Write(data)
	return err
}
