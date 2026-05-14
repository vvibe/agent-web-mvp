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
	hello := map[string]any{
		"type":     "hello",
		"hostname": hostname,
		"os":       runtime.GOOS,
		"arch":     runtime.GOARCH,
		"version":  "0.1.0",
		"agents":   detectAgents(),
		"pid":      os.Getpid(),
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
			handleServerMessage(conn, &writeMu, msg)
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

func handleServerMessage(conn *websocket.Conn, mu *sync.Mutex, msg map[string]any) {
	t, _ := msg["type"].(string)
	switch t {
	case "echo":
		// Simple smoke-test: server says echo, we reply.
		mu.Lock()
		_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		_ = conn.WriteJSON(map[string]any{
			"type": "echo_reply",
			"data": msg["data"],
			"ts":   time.Now().UnixMilli(),
		})
		mu.Unlock()
	case "detect_agents":
		mu.Lock()
		_ = conn.SetWriteDeadline(time.Now().Add(writeTimeout))
		_ = conn.WriteJSON(map[string]any{
			"type":   "agents",
			"agents": detectAgents(),
		})
		mu.Unlock()
	default:
		log.Printf("ignoring message type %q", t)
	}
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
