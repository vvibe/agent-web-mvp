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
	ctx context.Context, prompt string, cwd string, _ string, _ string,
	emit func(role, text string, meta map[string]any),
	_ func(requestID, toolName string, input any),
) (string, error) {
	// Belt-and-suspenders gate: server already refuses to create codex
	// sessions unless CODEX_TRUST_DEFAULTS=1, but the daemon enforces the
	// same constraint locally so a misconfigured / out-of-date server can't
	// trick us into running codex with whatever defaults it ships with.
	//
	// Two opt-in paths, checked in order so the new path takes precedence:
	//   1. Config file (set via `vvibe codex enable`) — preferred, since
	//      it survives reboots and doesn't need admin to write.
	//   2. Legacy env var CODEX_TRUST_DEFAULTS=1 — kept for back-compat with
	//      users who already wired this into their service/shell env.
	cfg, _ := loadConfig()
	trustedByConfig := cfg != nil && cfg.CodexTrustDefaults
	trustedByEnv := os.Getenv("CODEX_TRUST_DEFAULTS") == "1"
	if !trustedByConfig && !trustedByEnv {
		msg := "Codex disabled on this daemon. Run `vvibe codex enable` to opt in " +
			"(no admin needed), then `vvibe restart`. See README for details."
		emit("system", msg, nil)
		return "", fmt.Errorf("codex disabled by daemon policy")
	}

	// Same cwd-existence pre-check as runner_claude — surfaces a clear
	// "session was created on a different device" message instead of the
	// opaque chdir error from exec.
	if info, err := os.Stat(cwd); err != nil || !info.IsDir() {
		hostname, _ := os.Hostname()
		msg := fmt.Sprintf("Working directory `%s` does not exist on this machine (%s). The session may have been created on a different device — bring that daemon online, or create a new session here.", cwd, hostname)
		emit("system", msg, nil)
		return "", fmt.Errorf("cwd does not exist: %s", cwd)
	}

	bin := os.Getenv("CODEX_BIN")
	if bin == "" {
		bin = "codex"
	}
	// Args resolution mirrors the trust-flag precedence: config first,
	// then env, so `vvibe codex enable --args …` wins over a stale env var.
	argsStr := ""
	if cfg != nil && cfg.CodexArgs != "" {
		argsStr = cfg.CodexArgs
	} else {
		argsStr = os.Getenv("CODEX_ARGS")
	}
	extra := strings.Fields(argsStr)
	args := append([]string{"exec"}, extra...)
	args = append(args, prompt)

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = cwd
	// See envForAgentSpawn — points codex at the interactive user's
	// ~/.codex/ instead of LocalSystem's systemprofile.
	cmd.Env = envForAgentSpawn(os.Environ())

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
