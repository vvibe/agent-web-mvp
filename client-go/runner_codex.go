package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
)

// codexRunner spawns `codex exec --json <prompt>` per turn and parses the
// JSONL event stream, surfacing only meaningful chat content (agent_message
// items). Per-turn process, no resume token.
type codexRunner struct{}

func newCodexRunner() *codexRunner {
	return &codexRunner{}
}

func (r *codexRunner) Permission(string, bool) {
	// Codex doesn't surface permission via this protocol — it has its own
	// approval modes controlled by CODEX_ARGS. No-op.
}

func (r *codexRunner) Run(
	ctx context.Context, prompt string, cwd string, _ string, model string,
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
	// Self-heal config written by v0.1.17 (which baked in a non-existent
	// `--ask-for-approval` flag against `codex exec`). One-shot rewrite to
	// a working baseline so existing users don't have to do the
	// disable→enable shuffle after `vvibe upgrade`.
	if cfg != nil && strings.Contains(cfg.CodexArgs, "--ask-for-approval") {
		broken := cfg.CodexArgs
		cfg.CodexArgs = "--sandbox workspace-write"
		if err := saveConfig(cfg); err == nil {
			emit("system", fmt.Sprintf(
				"note: rewrote codex args from %q to %q (the previous default included a flag that codex exec doesn't accept).",
				broken, cfg.CodexArgs), nil)
		}
	}
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
	// --json switches codex into a JSONL event stream on stdout — that's
	// the entire reason this runner is a structured parser rather than a
	// blind pass-through. Inject it ourselves rather than expecting users
	// to remember it in their CODEX_ARGS.
	args := append([]string{"exec", "--json"}, extra...)
	// Per-session model picker. Server-validated against CODEX_MODELS
	// allowlist before reaching us, so any non-empty value is safe to
	// pass through. Empty means "let codex pick its default".
	if model != "" {
		args = append(args, "--model", model)
	}
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

	// Track whether we ever emitted a user-visible message. If codex
	// exits with a non-zero status and we said nothing in the chat, we
	// surface a fallback so the user isn't left staring at silence.
	var sawAgentMessage bool

	done := make(chan struct{}, 2)
	go func() {
		readCodexEvents(stdoutPipe, emit, &sawAgentMessage)
		done <- struct{}{}
	}()
	go func() {
		// Stderr is for diagnostics — codex normally prints nothing
		// there once --json is on. Anything that does appear (panic,
		// auth error before the JSONL stream starts, etc.) goes to the
		// daemon log so it survives reboots and shows up in `doctor`.
		s := bufio.NewScanner(stderrPipe)
		s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for s.Scan() {
			log.Printf("codex stderr: %s", s.Text())
		}
		done <- struct{}{}
	}()

	<-done
	<-done

	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		// Failure without any chat output (e.g. auth error printed only
		// to stderr): surface a generic notice so the user knows the
		// turn ended in failure. The exact reason lives in client.log.
		if !sawAgentMessage {
			emit("system", "Codex exited with an error before producing a reply. Check `vvibe doctor` and the daemon log for details.", nil)
		}
		return "", err
	}
	return "", nil
}

// readCodexEvents consumes one JSON event per line from `codex exec --json`
// and forwards the user-visible ones to the chat. Everything else (thread
// lifecycle plumbing, internal reasoning chunks, tool call records) is
// either logged to the daemon log for diagnostics or dropped.
//
// We deliberately stay tolerant: a malformed line is logged and skipped
// rather than terminating the read loop, because a single bad line from
// codex shouldn't kill a session. Future codex versions may add event
// types we don't recognise yet; those land in the default branch and are
// logged so we notice them in the daemon log without breaking the user's
// session in the meantime.
func readCodexEvents(r io.Reader, emit func(role, text string, meta map[string]any), sawAgentMessage *bool) {
	s := bufio.NewScanner(r)
	// Default scanner buffer is 64 KB; agent messages can easily exceed
	// that with longer responses. Bump to 4 MB to match the protocol-
	// level cap in DaemonClientMessageSchema.
	s.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for s.Scan() {
		line := s.Bytes()
		if len(line) == 0 {
			continue
		}
		var ev map[string]any
		if err := json.Unmarshal(line, &ev); err != nil {
			// Not JSON — codex CLI printed something to stdout that
			// shouldn't be there in --json mode (maybe a banner from
			// an older version). Log and skip; don't pollute the chat.
			log.Printf("codex stdout non-json: %s", truncateForLog(string(line)))
			continue
		}
		handleCodexEvent(ev, emit, sawAgentMessage)
	}
	if err := s.Err(); err != nil && err != io.EOF {
		log.Printf("codex stdout scan error: %v", err)
	}
}

// handleCodexEvent routes a single parsed JSONL event from `codex exec
// --json`. Only `item.completed` with `item.type == "agent_message"` is
// promoted to the chat; everything else is logged or ignored.
//
// Future enhancements (not done in this MVP):
//   - tool execution events could surface as collapsed cards with the
//     command + output, like Claude's tool_use bubbles.
//   - reasoning items could appear behind a "show thinking" toggle.
//   - turn.completed.usage could feed a per-session token meter.
// All three would need protocol additions on top of the current
// `role: 'assistant'` emit, so we'd rather ship the noise-reduction
// first and add structure once the shape settles.
func handleCodexEvent(ev map[string]any, emit func(role, text string, meta map[string]any), sawAgentMessage *bool) {
	t, _ := ev["type"].(string)
	switch t {
	case "item.completed":
		item, _ := ev["item"].(map[string]any)
		itemType, _ := item["type"].(string)
		if itemType == "agent_message" {
			text, _ := item["text"].(string)
			if text != "" {
				emit("assistant", text, nil)
				*sawAgentMessage = true
			}
		}
		// Other item types (command_execution, reasoning, file_change,
		// etc.) are intentionally dropped for the MVP. See doc above.
	case "thread.started", "turn.started":
		// Lifecycle plumbing — nothing for the chat. Log so the daemon
		// log shows the session boundaries when debugging.
		log.Printf("codex %s: %s", t, briefEvent(ev))
	case "turn.completed":
		// usage stats are interesting but not for the chat. Logging
		// them gives `vvibe doctor` users a way to grep token counts
		// without us needing a UI.
		log.Printf("codex turn.completed: %s", briefEvent(ev))
	case "error", "turn.failed":
		// Codex hit a server-side error mid-stream (model not allowed
		// for this auth tier, rate limit, sandbox refusal, etc.). The
		// `message` field is a JSON-encoded error envelope — try to
		// extract a human line from it; fall back to the raw payload
		// so the user still gets *something* actionable in chat.
		raw, _ := ev["message"].(string)
		if raw == "" {
			if errObj, ok := ev["error"].(map[string]any); ok {
				raw, _ = errObj["message"].(string)
			}
		}
		emit("system", "Codex error: "+formatCodexError(raw), nil)
		*sawAgentMessage = true // suppress the generic "exited before reply" fallback
		log.Printf("codex %s: %s", t, briefEvent(ev))
	default:
		// Codex versions newer than the one we tested against may add
		// event types we don't recognise yet. Log so we notice; don't
		// crash.
		log.Printf("codex unknown event %q: %s", t, briefEvent(ev))
	}
}

// briefEvent stringifies an event for the daemon log without potentially
// huge fields (a long agent_message text would bloat the log unnecessarily).
// Caps each value at 200 chars to keep log lines a sensible width.
func briefEvent(ev map[string]any) string {
	b, err := json.Marshal(ev)
	if err != nil {
		return fmt.Sprintf("%v", ev)
	}
	return truncateForLog(string(b))
}

// formatCodexError pulls a readable line out of codex's nested error
// envelopes. The `message` field on an `error` event is itself a
// JSON string that looks like:
//
//	{"type":"error","status":400,"error":{"type":"invalid_request_error",
//	 "message":"The 'gpt-5' model is not supported when using Codex
//	 with a ChatGPT account."}}
//
// We try to dig out the innermost human sentence. On any parse trouble
// we just return the raw input — better to surface noise than nothing.
func formatCodexError(s string) string {
	if s == "" {
		return "(no detail; check `vvibe doctor` and the daemon log)"
	}
	var env map[string]any
	if err := json.Unmarshal([]byte(s), &env); err == nil {
		if inner, ok := env["error"].(map[string]any); ok {
			if msg, ok := inner["message"].(string); ok && msg != "" {
				return msg
			}
		}
		if msg, ok := env["message"].(string); ok && msg != "" {
			return msg
		}
	}
	return s
}

func truncateForLog(s string) string {
	const max = 500
	if len(s) <= max {
		return s
	}
	return s[:max] + "…(truncated)"
}
