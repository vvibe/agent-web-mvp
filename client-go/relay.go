package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// maxRunDuration is the wall-clock cap for a single prompt turn, honoring
// the VVIBE_MAX_RUN_SECONDS override. Bad/zero/negative env values fall
// back to defaultMaxRunDuration silently — we'd rather over-cap than let
// a typo turn the safeguard off.
func maxRunDuration() time.Duration {
	if raw := os.Getenv("VVIBE_MAX_RUN_SECONDS"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return defaultMaxRunDuration
}

const (
	pingInterval = 30 * time.Second
	pongTimeout  = 60 * time.Second
	writeTimeout = 10 * time.Second

	// Wall-clock cap on a single prompt turn. Backstops the "sleeping tab
	// keeps an agent looping forever" / "prompt-injection-driven runaway
	// tool use" cases — combined with maxTurns on the SDK side, a single
	// run can't quietly chew through tokens for hours. Override per-machine
	// with VVIBE_MAX_RUN_SECONDS.
	defaultMaxRunDuration = 30 * time.Minute
)

// runs tracks in-flight prompt turns by runId so daemon_cancel and
// daemon_permission_response can route to the right Runner. Lives at package
// scope because the relay reconnects but in-flight runs persist across
// reconnects in principle (today they're cancelled on close — see cleanup).
var runs = newRunManager()

// runRelay maintains a long-lived WebSocket connection to the server with
// exponential backoff. Returns only when ctx is cancelled.
func runRelay(ctx context.Context, cfg *Config) {
	// Windows-only: prepend user-scope Node / agent dirs so the LocalSystem
	// service sees `claude` / `codex` / `node` even though SCM didn't hand
	// it the user's PATH. No-op on other platforms.
	augmentPATHForAgents()

	// One-shot startup warning if the cwd allowlist is empty. Back-compat
	// for existing daemons (refusing every prompt at upgrade time would be
	// a hostile surprise), but the operator should add `vvibe allow <path>`
	// before exposing the web UI beyond themselves.
	if len(cfg.AllowedCwds) == 0 {
		log.Printf("[allowlist] no cwd allowlist set — any cwd from the server will be accepted. " +
			"Add roots with `vvibe allow <path>` to gate sessions.")
	}

	backoff := time.Second
	const maxBackoff = 30 * time.Second

	for {
		if ctx.Err() != nil {
			return
		}

		log.Printf("connecting to %s", cfg.Server)
		err := connectOnce(ctx, cfg)
		if err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("connection ended: %v", err)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func connectOnce(ctx context.Context, cfg *Config) error {
	header := http.Header{}
	if cfg.Token != "" {
		header.Set("Authorization", "Bearer "+cfg.Token)
	}

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 10 * time.Second

	conn, _, err := dialer.DialContext(ctx, cfg.Server, header)
	if err != nil {
		return err
	}
	defer conn.Close()

	log.Println("connected")

	// Send hello.
	hostname, _ := os.Hostname()
	displayName := cfg.DisplayName
	if displayName == "" {
		displayName = hostname
	}
	hello := map[string]any{
		"type":        "hello",
		"hostname":    hostname,
		"displayName": displayName,
		"os":          runtime.GOOS,
		"arch":        runtime.GOARCH,
		"version":     "0.1.0",
		"agents":      detectAgents(),
		"pid":         os.Getpid(),
	}
	if err := writeJSON(conn, hello); err != nil {
		return err
	}

	// Set up read deadline + pong handler for heartbeat.
	_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongTimeout))
		return nil
	})

	var writeMu sync.Mutex
	sender := &wsSender{conn: conn, mu: &writeMu}

	// Reader goroutine.
	readErr := make(chan error, 1)
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
			var msg map[string]any
			if err := json.Unmarshal(data, &msg); err != nil {
				log.Printf("malformed message from server: %v", err)
				continue
			}
			handleServerMessage(sender, msg)
		}
	}()

	// Heartbeat ticker.
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-readErr:
			return err
		case <-ticker.C:
			writeMu.Lock()
			_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			err := conn.WriteMessage(websocket.PingMessage, nil)
			writeMu.Unlock()
			if err != nil {
				return err
			}
		}
	}
}

func writeJSON(conn *websocket.Conn, v any) error {
	_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return conn.WriteJSON(v)
}

// wsSender is a tiny mutex-guarded JSON sender shared between the reader
// goroutine and the per-run goroutines that stream agent output back.
type wsSender struct {
	conn *websocket.Conn
	mu   *sync.Mutex
}

func (s *wsSender) send(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return s.conn.WriteJSON(v)
}

func handleServerMessage(s *wsSender, msg map[string]any) {
	t, _ := msg["type"].(string)
	switch t {
	case "echo":
		_ = s.send(map[string]any{
			"type": "echo_reply",
			"data": msg["data"],
			"ts":   time.Now().UnixMilli(),
		})
	case "detect_agents":
		_ = s.send(map[string]any{
			"type":   "agents",
			"agents": detectAgents(),
		})
	case "daemon_run_prompt":
		handleRunPrompt(s, msg)
	case "daemon_cancel":
		if runId, ok := msg["runId"].(string); ok {
			runs.cancel(runId)
		}
	case "daemon_permission_response":
		runId, _ := msg["runId"].(string)
		reqId, _ := msg["requestId"].(string)
		allow, _ := msg["allow"].(bool)
		runs.permission(runId, reqId, allow)
	case "daemon_list_dir":
		// Runs inline since os.ReadDir is fast and we don't want to leak
		// goroutines on a malformed/spammy server. If this ever blocks the
		// reader loop, move to a worker pool.
		handleListDir(s, msg)
	default:
		log.Printf("ignoring message type %q", t)
	}
}

// handleRunPrompt spawns a Runner for the requested agent and streams its
// output back to the server. Runs in its own goroutine so the reader loop
// stays responsive.
func handleRunPrompt(s *wsSender, msg map[string]any) {
	runId, _ := msg["runId"].(string)
	agent, _ := msg["agent"].(string)
	cwd, _ := msg["cwd"].(string)
	prompt, _ := msg["prompt"].(string)
	resume, _ := msg["resumeToken"].(string)
	model, _ := msg["model"].(string)
	if runId == "" {
		return
	}

	// cwd allowlist gate (M10 H-3). Re-loads config per run so `vvibe allow
	// <path>` takes effect without a daemon restart. A failed config read
	// is treated as "no allowlist" — refusing every run on a transient
	// disk hiccup would be worse than the marginal weakening.
	if cfg, err := loadConfig(); err == nil && !isCwdAllowed(cwd, cfg.AllowedCwds) {
		log.Printf("run %s refused: cwd %q not in allowlist (%d allowed roots)", runId, cwd, len(cfg.AllowedCwds))
		_ = s.send(map[string]any{
			"type":  "daemon_done",
			"runId": runId,
			"error": fmt.Sprintf(
				"Daemon refused: cwd %q is outside the allowed roots configured on this machine. "+
					"Run `vvibe allow %s` on the daemon machine to permit it, "+
					"or pick a different working directory.",
				cwd, cwd,
			),
		})
		return
	}

	runner, err := makeRunner(agent)
	if err != nil {
		_ = s.send(map[string]any{
			"type":  "daemon_done",
			"runId": runId,
			"error": err.Error(),
		})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), maxRunDuration())
	runs.start(runId, runner, cancel)

	emit := func(role, text string, meta map[string]any) {
		payload := map[string]any{
			"type":  "daemon_message",
			"runId": runId,
			"role":  role,
			"text":  text,
		}
		if meta != nil {
			payload["meta"] = meta
		}
		_ = s.send(payload)
	}

	askPermission := func(requestID, toolName string, input any) {
		_ = s.send(map[string]any{
			"type":      "daemon_permission_request",
			"runId":     runId,
			"requestId": requestID,
			"toolName":  toolName,
			"input":     input,
		})
	}

	go func() {
		defer runs.finish(runId)
		defer cancel()

		newResume, runErr := runner.Run(ctx, prompt, cwd, resume, model, emit, askPermission)

		done := map[string]any{
			"type":  "daemon_done",
			"runId": runId,
		}
		if newResume != "" {
			done["resumeToken"] = newResume
		}
		// Translate context.DeadlineExceeded into a user-readable message
		// before surfacing it; "context deadline exceeded" reads like an
		// internal panic. context.Canceled is suppressed because that's
		// the normal user-pressed-Cancel path.
		if runErr != nil && !errors.Is(runErr, context.Canceled) {
			if errors.Is(runErr, context.DeadlineExceeded) {
				done["error"] = "Run hit the wall-clock limit (" +
					maxRunDuration().String() +
					") and was aborted. Override with VVIBE_MAX_RUN_SECONDS."
			} else {
				done["error"] = runErr.Error()
			}
		}
		logRunErr(runId, runErr)
		_ = s.send(done)
	}()
}

// detectAgents reports which supported CLIs are reachable from the daemon.
//
// First we try $PATH (where the user installed `claude` / `codex`), then
// fall back to a curated list of common per-user install locations. The
// fallback matters because on macOS the daemon runs under launchd, whose
// process PATH is just `/usr/bin:/bin:/usr/sbin:/sbin` — the user's npm
// globals (~/.npm-global/bin, ~/.nvm/versions/node/<v>/bin) and Homebrew
// (/opt/homebrew/bin, /usr/local/bin) are not inherited from the shell.
// Without the fallback the UI shows "0 agents" right after install even
// though the installer's own shell saw both CLIs.
//
// Returns an initialised empty slice (never nil) so the JSON wire form is
// `[]` rather than `null` — the browser DevicesPanel reads `.length` and
// must not crash when no agents are found.
func detectAgents() []map[string]string {
	out := []map[string]string{}
	for _, name := range []string{"claude", "codex"} {
		if p, err := exec.LookPath(name); err == nil {
			out = append(out, map[string]string{"name": name, "path": p})
			continue
		}
		if p := findAgentInFallbackPaths(name); p != "" {
			out = append(out, map[string]string{"name": name, "path": p})
		}
	}
	return out
}

// findAgentInFallbackPaths searches common per-user install locations for an
// agent CLI that wasn't found on $PATH. Returns "" if not found.
//
// Order matters: prefer the user's own installs (~/.npm-global, nvm's active
// version, ~/.local) over system-wide locations (Homebrew, /usr/local). nvm
// is special-cased because each Node version lives at a different path and
// the user is unlikely to have only one — we pick the alphabetically last
// directory under ~/.nvm/versions/node/, which approximates "newest Node".
func findAgentInFallbackPaths(name string) string {
	home, _ := os.UserHomeDir()

	candidates := []string{}
	if home != "" {
		candidates = append(candidates,
			home+"/.npm-global/bin/"+name,
			home+"/.local/bin/"+name,
		)
		if nvmBin := latestNvmNodeBin(home); nvmBin != "" {
			candidates = append(candidates, nvmBin+"/"+name)
		}
	}
	candidates = append(candidates,
		"/opt/homebrew/bin/"+name, // Apple Silicon brew
		"/usr/local/bin/"+name,    // Intel brew + generic Unix
	)

	for _, p := range candidates {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	return ""
}

// augmentPATH prepends common per-user install dirs to the daemon's own
// PATH so that ALL subprocess spawns (node, claude, codex, npm, future
// CLIs) can find them. On macOS the daemon runs under launchd whose
// inherited PATH is just `/usr/bin:/bin:/usr/sbin:/sbin`, which doesn't
// include nvm's bin, ~/.npm-global, Homebrew, or ~/.local. Without this,
// even after we found `claude` via the fallback search, spawning `node`
// (used by the Claude bridge) would fail with "executable file not found
// in $PATH".
//
// Idempotent: dirs already present are skipped. Safe to call at startup
// regardless of OS or how the daemon was launched (interactive shell,
// systemd, launchd, SCM). Only adds directories that actually exist.
func augmentPATH() {
	home, _ := os.UserHomeDir()
	candidates := []string{}
	if home != "" {
		if nvm := latestNvmNodeBin(home); nvm != "" {
			candidates = append(candidates, nvm)
		}
		candidates = append(candidates,
			home+"/.npm-global/bin",
			home+"/.local/bin",
		)
	}
	candidates = append(candidates,
		"/opt/homebrew/bin", // Apple Silicon brew
		"/usr/local/bin",    // Intel brew + generic Unix
	)

	sep := string(os.PathListSeparator)
	cur := os.Getenv("PATH")
	seen := make(map[string]bool)
	for _, p := range strings.Split(cur, sep) {
		seen[p] = true
	}

	var added []string
	for _, c := range candidates {
		if seen[c] {
			continue
		}
		fi, err := os.Stat(c)
		if err != nil || !fi.IsDir() {
			continue
		}
		added = append(added, c)
		seen[c] = true
	}
	if len(added) == 0 {
		return
	}
	// Prepend so per-user installs win over system ones — same precedence
	// as `export PATH="$HOME/.local/bin:$PATH"` in install.sh.
	os.Setenv("PATH", strings.Join(added, sep)+sep+cur)
}

// latestNvmNodeBin returns ~/.nvm/versions/node/<latest>/bin, or "" if nvm
// isn't installed or has no node versions. Picks the highest version under
// numeric-aware comparison so v20.11.0 wins over v9.x.x (plain
// lexicographic would pick v9 — '9' > '2' in ASCII).
func latestNvmNodeBin(home string) string {
	d := latestSubdir(home + "/.nvm/versions/node")
	if d == "" {
		return ""
	}
	return d + "/bin"
}
