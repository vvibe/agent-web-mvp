package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestSnapshotAgentBinDirsRoundtrip exercises the install-time snapshot
// (snapshotAgentBinDirs) and the daemon-time read (loadSnapshotAgentBinDirs)
// against a real on-disk client.json under a temp %ProgramData%.
//
// The motivating bug: claude installed via Anthropic's native installer
// lands in %USERPROFILE%\.local\bin, which the heuristic Windows scanner
// in discoverWindowsAgentDirs did not enumerate — so the LocalSystem
// service couldn't see claude even when the interactive shell could.
// Snapshotting `exec.LookPath` results during install bypasses the
// scanner's coverage gaps entirely.
//
// Windows-only: snapshotAgentBinDirs is a no-op elsewhere.
func TestSnapshotAgentBinDirsRoundtrip(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("snapshotAgentBinDirs is windows-only")
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

	snapshotAgentBinDirs()

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

	// Token/server must be preserved — the install path saves the config
	// back, so a sloppy implementation that zeroes other fields would
	// brick the user's pairing.
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
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
		t.Skip("snapshotAgentBinDirs is windows-only")
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
	snapshotAgentBinDirs()

	got := loadSnapshotAgentBinDirs()
	if len(got) != 0 {
		t.Fatalf("expected stale dir to be cleared, got %v", got)
	}
}
