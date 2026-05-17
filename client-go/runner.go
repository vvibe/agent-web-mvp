package main

import (
	"context"
	"fmt"
	"log"
	"sync"
)

// Runner executes a single prompt turn for one agent.
//
// Run blocks until the turn ends (either successfully, with error, or after
// being cancelled). It streams output via emit and asks for permission via
// askPermission. Permission responses arrive out-of-band via Permission(); the
// implementation correlates by requestID.
type Runner interface {
	// model is empty string when the server didn't pin one — the runner falls
	// back to its default. Codex ignores model (CLI doesn't accept it yet).
	Run(ctx context.Context, prompt string, cwd string, resumeToken string, model string,
		emit func(role, text string, meta map[string]any),
		askPermission func(requestID, toolName string, input any),
	) (newResumeToken string, err error)
	Permission(requestID string, allow bool)
}

// runManager tracks in-flight runs by runId so daemon_cancel and
// daemon_permission_response can route to the right Runner.
type runManager struct {
	mu   sync.Mutex
	runs map[string]*runHandle
}

type runHandle struct {
	runner Runner
	cancel context.CancelFunc
}

func newRunManager() *runManager {
	return &runManager{runs: map[string]*runHandle{}}
}

func (m *runManager) start(runId string, runner Runner, cancel context.CancelFunc) {
	m.mu.Lock()
	m.runs[runId] = &runHandle{runner: runner, cancel: cancel}
	m.mu.Unlock()
}

func (m *runManager) finish(runId string) {
	m.mu.Lock()
	delete(m.runs, runId)
	m.mu.Unlock()
}

func (m *runManager) cancel(runId string) {
	m.mu.Lock()
	h := m.runs[runId]
	m.mu.Unlock()
	if h == nil {
		return
	}
	h.cancel()
}

func (m *runManager) permission(runId, requestId string, allow bool) {
	m.mu.Lock()
	h := m.runs[runId]
	m.mu.Unlock()
	if h == nil {
		return
	}
	h.runner.Permission(requestId, allow)
}

// makeRunner returns a fresh Runner for the given agent kind. Returns an
// error if the agent isn't supported on this daemon.
func makeRunner(agent string) (Runner, error) {
	switch agent {
	case "claude":
		return newClaudeRunner()
	case "codex":
		return newCodexRunner(), nil
	default:
		return nil, fmt.Errorf("unsupported agent: %s", agent)
	}
}

// logRunErr is a small helper to keep error logging consistent.
func logRunErr(runId string, err error) {
	if err != nil {
		log.Printf("run %s error: %v", runId, err)
	}
}
