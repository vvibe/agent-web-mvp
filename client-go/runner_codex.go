package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// codexRunner spawns `codex exec <prompt>` per turn and streams stdout as
// assistant text, stderr as system text. Per-turn process, no resume token.
type codexRunner struct{}

func newCodexRunner() *codexRunner {
	return &codexRunner{}
}

func (r *codexRunner) Permission(string, bool) {
	// Codex doesn't surface permission via this protocol — it has its own
	// approval modes controlled by CODEX_ARGS. No-op.
}

func (r *codexRunner) Run(
	ctx context.Context, prompt string, cwd string, _ string,
	emit func(role, text string, meta map[string]any),
	_ func(requestID, toolName string, input any),
) (string, error) {
	// Belt-and-suspenders gate: server already refuses to create codex
	// sessions unless CODEX_TRUST_DEFAULTS=1, but the daemon enforces the
	// same constraint locally so a misconfigured / out-of-date server can't
	// trick us into running codex with whatever defaults it ships with.
	if os.Getenv("CODEX_TRUST_DEFAULTS") != "1" {
		msg := "Codex disabled: set CODEX_TRUST_DEFAULTS=1 on the daemon " +
			"environment and configure CODEX_ARGS (e.g. " +
			"`--sandbox read-only --ask-for-approval on-request`) before " +
			"enabling. See README."
		emit("system", msg, nil)
		return "", fmt.Errorf("codex disabled by daemon policy")
	}

	bin := os.Getenv("CODEX_BIN")
	if bin == "" {
		bin = "codex"
	}
	extra := strings.Fields(os.Getenv("CODEX_ARGS"))
	args := append([]string{"exec"}, extra...)
	args = append(args, prompt)

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = cwd
	cmd.Env = os.Environ()

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return "", err
	}

	if err := cmd.Start(); err != nil {
		emit("system", "Cannot start codex: "+err.Error(), nil)
		return "", err
	}

	done := make(chan struct{}, 2)
	go func() {
		streamReader(stdoutPipe, func(b []byte) { emit("assistant", string(b), nil) })
		done <- struct{}{}
	}()
	go func() {
		streamReader(stderrPipe, func(b []byte) { emit("system", string(b), nil) })
		done <- struct{}{}
	}()

	<-done
	<-done

	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", err
	}
	return "", nil
}

func streamReader(r io.Reader, emit func([]byte)) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			emit(chunk)
		}
		if err != nil {
			return
		}
	}
}
