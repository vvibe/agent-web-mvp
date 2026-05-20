package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// captured holds what handleCodexEvent would have streamed to the
// websocket. The test substitutes its own emit closure for the real one.
type captured struct {
	role string
	text string
}

func collectEmit(out *[]captured) func(role, text string, meta map[string]any) {
	return func(role, text string, _ map[string]any) {
		*out = append(*out, captured{role: role, text: text})
	}
}

// TestCodexAgentMessage covers the happy path: an `item.completed` of
// type `agent_message` becomes one "assistant" emit with the model's
// text, and the sawAgentMessage flag flips true.
func TestCodexAgentMessage(t *testing.T) {
	ev := mustJSON(t, `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hi there."}}`)
	var out []captured
	saw := false
	handleCodexEvent(ev, collectEmit(&out), &saw)

	if !saw {
		t.Fatalf("sawAgentMessage should be true after an agent_message item")
	}
	if len(out) != 1 || out[0].role != "assistant" || out[0].text != "Hi there." {
		t.Fatalf("unexpected emits: %+v", out)
	}
}

// TestCodexErrorEventSurfaced reproduces the codex 400 we saw locally
// when picking a model not licensed for ChatGPT-account auth. The error
// message is a nested JSON envelope inside the event's `message` field;
// the runner must reach into it and surface a human sentence to chat.
// We also flip sawAgentMessage so the "exited before any reply" fallback
// in Run() doesn't double-print.
func TestCodexErrorEventSurfaced(t *testing.T) {
	rawEnvelope := `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5' model is not supported when using Codex with a ChatGPT account."}}`
	ev := map[string]any{
		"type":    "error",
		"message": rawEnvelope,
	}
	var out []captured
	saw := false
	handleCodexEvent(ev, collectEmit(&out), &saw)

	if !saw {
		t.Fatalf("error event should flip sawAgentMessage to suppress duplicate fallback")
	}
	if len(out) != 1 {
		t.Fatalf("expected exactly one chat emit, got %+v", out)
	}
	if out[0].role != "system" {
		t.Fatalf("error should surface as system, got role=%q", out[0].role)
	}
	if !strings.Contains(out[0].text, "not supported when using Codex with a ChatGPT account") {
		t.Fatalf("error text didn't include the nested message: %q", out[0].text)
	}
}

// TestCodexTurnFailedSurfaced verifies the parallel envelope codex
// sometimes emits — `turn.failed` carries the error nested under
// .error.message (not .message), so the runner must handle both shapes.
func TestCodexTurnFailedSurfaced(t *testing.T) {
	ev := mustJSON(t, `{"type":"turn.failed","error":{"message":"sandbox refusal: workspace-write needed write access outside cwd"}}`)
	var out []captured
	saw := false
	handleCodexEvent(ev, collectEmit(&out), &saw)

	if len(out) != 1 || out[0].role != "system" {
		t.Fatalf("expected one system emit, got %+v", out)
	}
	if !strings.Contains(out[0].text, "sandbox refusal") {
		t.Fatalf("error text missing nested message: %q", out[0].text)
	}
}

// TestCodexNoiseSuppressed makes sure the items we deliberately drop —
// reasoning, tool calls, lifecycle plumbing — emit nothing to chat.
// These would otherwise re-introduce the spam the JSONL refactor was
// supposed to remove.
func TestCodexNoiseSuppressed(t *testing.T) {
	noiseLines := []string{
		`{"type":"thread.started","thread_id":"x"}`,
		`{"type":"turn.started"}`,
		`{"type":"turn.completed","usage":{"input_tokens":1}}`,
		`{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"thinking..."}}`,
		`{"type":"item.completed","item":{"id":"c","type":"command_execution","command":"ls"}}`,
		`{"type":"unknown.future.event","payload":42}`,
	}
	var out []captured
	saw := false
	for _, line := range noiseLines {
		handleCodexEvent(mustJSON(t, line), collectEmit(&out), &saw)
	}
	if len(out) != 0 {
		t.Fatalf("noise events should not emit to chat, got %+v", out)
	}
	if saw {
		t.Fatalf("sawAgentMessage must stay false after only noise events")
	}
}

// TestFormatCodexErrorFallback handles the case where codex hands us
// something that *isn't* a JSON envelope — we shouldn't blow up; we
// should just pass the raw string through so the user sees something.
func TestFormatCodexErrorFallback(t *testing.T) {
	got := formatCodexError("plain text from an older codex version")
	if got != "plain text from an older codex version" {
		t.Fatalf("non-JSON fallback shouldn't transform text: %q", got)
	}
	got = formatCodexError("")
	if !strings.Contains(got, "no detail") {
		t.Fatalf("empty input should yield an informative placeholder, got %q", got)
	}
}

// mustJSON unmarshals a literal JSONL line into a map for handleCodexEvent.
// Fails the test on parse error rather than papering over it.
func mustJSON(t *testing.T, line string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("test input not parseable: %v\nline: %s", err, line)
	}
	return m
}
