package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestSnapshotInteractiveUserEnvRoundtrip exercises the install-time
// snapshot and the daemon-time read against a real on-disk client.json
// under a temp %ProgramData%.
//
// Motivating bugs:
//   - claude installed via Anthropic's native installer lands in
//     %USERPROFILE%\.local\bin, which the heuristic Windows scanner in
//     discoverWindowsAgentDirs did not enumerate. The LocalSystem
//     service couldn't see claude even when the interactive shell
//     could. Snapshotting exec.LookPath bypasses the scanner.
//   - The folder picker defaulted to whatever os.UserHomeDir returned
//     under the daemon's identity — C:\WINDOWS\system32\config\
//     systemprofile under LocalSystem. Snapshotting the interactive
//     user's home dir fixes the default.
func TestSnapshotInteractiveUserEnvRoundtrip(t *testing.T) {
	if runtime.GOOS != "windows" {
		// On macOS/Linux the agent-bin-dirs path is intentionally
		// nil (daemon runs as the same user) — but home dir snapshot
		// still runs everywhere. Keeping the test Windows-only for
		// now because the fakeBin setup needs .exe semantics; the
		// home-dir branch is covered separately by TestResolvedHomeDir.
		t.Skip("agent-bin-dir snapshot is windows-only")
	}

	// Redirect appDir() onto a clean temp tree so we don't clobber the
	// caller's real client.json. appDir reads %ProgramData% directly.
	tmp := t.TempDir()
	t.Setenv("ProgramData", tmp)

	// Plant a fake `claude.exe` inside a dir on PATH so exec.LookPath
	// returns a deterministic location. We don't actually execute it.
	fakeBin := filepath.Join(tmp, "fakebin")
	if err := os.MkdirAll(fakeBin, 0o700); err != nil {
		t.Fatalf("mkdir fakebin: %v", err)
	}
	fakeClaude := filepath.Join(fakeBin, "claude.exe")
	if err := os.WriteFile(fakeClaude, []byte("MZ"), 0o600); err != nil {
		t.Fatalf("write fake claude.exe: %v", err)
	}
	// Prepend fakeBin so it wins over any real `claude` on PATH —
	// otherwise the test silently asserts against the developer's
	// machine state and fails on CI.
	t.Setenv("PATH", fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))

	// Seed a minimal config so saveConfig keeps the file shape.
	if err := saveConfig(&Config{Server: defaultServer, Token: "test-token"}); err != nil {
		t.Fatalf("seed config: %v", err)
	}

	snapshotInteractiveUserEnv()

	got := loadSnapshotAgentBinDirs()
	if len(got) == 0 {
		t.Fatalf("expected at least one dir from snapshot, got none")
	}

	// fakeBin must be present. Compare case-insensitive on Windows.
	want := strings.ToLower(fakeBin)
	found := false
	for _, d := range got {
		if strings.ToLower(d) == want {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("snapshot missing %s; got %v", fakeBin, got)
	}

	// Home dir must be captured (every platform).
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if cfg.UserHomeDir == "" {
		t.Fatalf("expected UserHomeDir to be recorded, got empty")
	}

	// Token/server must be preserved — the install path saves the config
	// back, so a sloppy implementation that zeroes other fields would
	// brick the user's pairing.
	if cfg.Token != "test-token" {
		t.Fatalf("token clobbered: got %q", cfg.Token)
	}
	if cfg.Server != defaultServer {
		t.Fatalf("server clobbered: got %q", cfg.Server)
	}
}

// TestSnapshotAgentBinDirsRefreshes verifies that re-running install
// replaces (not appends to) the saved dir list. A user who reinstalls
// claude in a different location should not have the stale dir linger.
func TestSnapshotAgentBinDirsRefreshes(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("agent-bin-dir snapshot is windows-only")
	}
	tmp := t.TempDir()
	t.Setenv("ProgramData", tmp)

	// First snapshot with a stale dir that does not exist on PATH.
	if err := saveConfig(&Config{
		Server:       defaultServer,
		AgentBinDirs: []string{`C:\stale\bin`},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Run snapshot with an empty PATH — claude/codex/node won't resolve,
	// so the resulting dir list should be empty (and overwrite the stale
	// entry, not append to it).
	t.Setenv("PATH", "")
	snapshotInteractiveUserEnv()

	got := loadSnapshotAgentBinDirs()
	if len(got) != 0 {
		t.Fatalf("expected stale dir to be cleared, got %v", got)
	}
}

// TestResolvedHomeDirPrefersSnapshot covers the folder-picker default.
// Without the snapshot, the daemon's own os.UserHomeDir wins — under
// LocalSystem that's systemprofile, which is useless. With the
// snapshot, the picker should use the recorded path.
func TestResolvedHomeDirPrefersSnapshot(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("ProgramData", tmp)

	// Create a real dir to act as the user's "home", because
	// resolvedHomeDir validates the path exists before returning it.
	fakeHome := filepath.Join(tmp, "fakeHome")
	if err := os.MkdirAll(fakeHome, 0o700); err != nil {
		t.Fatalf("mkdir fakeHome: %v", err)
	}
	if err := saveConfig(&Config{
		Server:      defaultServer,
		UserHomeDir: fakeHome,
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got := resolvedHomeDir()
	if got != fakeHome {
		t.Fatalf("resolvedHomeDir = %q, want %q", got, fakeHome)
	}
}

// TestResolvedHomeDirFallsBackOnStaleSnapshot ensures we don't blindly
// trust a recorded path that no longer exists (e.g. user dir got
// renamed). Falling back to os.UserHomeDir at least gets the user
// somewhere they can navigate from.
func TestResolvedHomeDirFallsBackOnStaleSnapshot(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("ProgramData", tmp)

	if err := saveConfig(&Config{
		Server:      defaultServer,
		UserHomeDir: filepath.Join(tmp, "does-not-exist"),
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got := resolvedHomeDir()
	if got == "" {
		t.Fatalf("expected fallback to os.UserHomeDir, got empty")
	}
	if got == filepath.Join(tmp, "does-not-exist") {
		t.Fatalf("returned the stale snapshot instead of falling back")
	}
}
