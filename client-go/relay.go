package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	pingInterval = 30 * time.Second
	pongTimeout  = 60 * time.Second
	writeTimeout = 10 * time.Second
)

// runs tracks in-flight prompt turns by runId so daemon_cancel and
// daemon_permission_response can route to the right Runner. Lives at package
// scope because the relay reconnects but in-flight runs persist across
// reconnects in principle (today they're cancelled on close — see cleanup).
var runs = newRunManager()

// runRelay maintains a long-lived WebSocket connection to the server with
// exponential backoff. Returns only when ctx is cancelled.
func runRelay(ctx context.Context, cfg *Config) {
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
	if runId == "" {
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

	ctx, cancel := context.WithCancel(context.Background())
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

		newResume, runErr := runner.Run(ctx, prompt, cwd, resume, emit, askPermission)

		done := map[string]any{
			"type":  "daemon_done",
			"runId": runId,
		}
		if newResume != "" {
			done["resumeToken"] = newResume
		}
		if runErr != nil && !errors.Is(runErr, context.Canceled) {
			done["error"] = runErr.Error()
		}
		logRunErr(runId, runErr)
		_ = s.send(done)
	}()
}

// detectAgents reports which supported CLIs are on PATH. This is what the
// server cares about for showing capabilities in the UI.
func detectAgents() []map[string]string {
	var out []map[string]string
	for _, name := range []string{"claude", "codex"} {
		if p, err := exec.LookPath(name); err == nil {
			out = append(out, map[string]string{"name": name, "path": p})
		}
	}
	return out
}
