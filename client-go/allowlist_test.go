package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestIsSubpath nails down the path-boundary check that gates whether a
// daemon_run_prompt cwd falls inside an allowlist root. The "/home/u/code"
// vs "/home/u/codex" case is the prefix-trap the implementation has to
// avoid; the parent/sibling cases cover the more obvious negatives.
func TestIsSubpath(t *testing.T) {
	cases := []struct {
		name   string
		child  string
		parent string
		want   bool
	}{
		{"identical", "/a/b/c", "/a/b/c", true},
		{"direct child", "/a/b/c/d", "/a/b/c", true},
		{"nested child", "/a/b/c/d/e/f", "/a/b/c", true},
		{"parent of", "/a/b", "/a/b/c", false},
		{"sibling", "/a/b/d", "/a/b/c", false},
		{"prefix-collision (the trap)", "/home/u/codex", "/home/u/code", false},
		{"unrelated", "/x/y", "/a/b/c", false},
		{"root-vs-root same", "/", "/", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			child := filepath.FromSlash(c.child)
			parent := filepath.FromSlash(c.parent)
			got := isSubpath(child, parent)
			if got != c.want {
				t.Fatalf("isSubpath(%q, %q) = %v, want %v", child, parent, got, c.want)
			}
		})
	}
}

func TestIsCwdAllowed_EmptyList(t *testing.T) {
	// Back-compat: empty allowlist permits everything. The daemon logs a
	// warning at startup so the operator notices the unguarded state.
	if !isCwdAllowed("/anywhere", nil) {
		t.Fatal("empty allowlist should permit any cwd (back-compat)")
	}
	if !isCwdAllowed("/anywhere", []string{}) {
		t.Fatal("empty (non-nil) allowlist should also permit")
	}
}

func TestIsCwdAllowed_PrefixTrap(t *testing.T) {
	// Skip on platforms where the absolute-path semantics would make the
	// test paths nonsensical. The logic is the same; we just need real
	// abs paths to feed in.
	if runtime.GOOS == "windows" {
		// Windows abs-path test: use the temp dir as a known-good root.
		base := t.TempDir()
		code := filepath.Join(base, "code")
		codex := filepath.Join(base, "codex")
		if err := mkdirAll(t, code); err != nil {
			t.Fatal(err)
		}
		if err := mkdirAll(t, codex); err != nil {
			t.Fatal(err)
		}
		allowed := []string{code}
		if isCwdAllowed(codex, allowed) {
			t.Fatalf("codex must NOT be allowed when only code is in the list: code=%q codex=%q", code, codex)
		}
		if !isCwdAllowed(filepath.Join(code, "sub"), allowed) {
			t.Fatal("subdir of code must be allowed")
		}
		return
	}
	base := t.TempDir()
	code := filepath.Join(base, "code")
	codex := filepath.Join(base, "codex")
	if err := mkdirAll(t, code); err != nil {
		t.Fatal(err)
	}
	if err := mkdirAll(t, codex); err != nil {
		t.Fatal(err)
	}
	allowed := []string{code}
	if isCwdAllowed(codex, allowed) {
		t.Fatal("codex must NOT match an allowlist entry of code")
	}
	if !isCwdAllowed(code, allowed) {
		t.Fatal("the root itself must be allowed")
	}
	if !isCwdAllowed(filepath.Join(code, "deep", "tree"), allowed) {
		t.Fatal("subdirs of the root must be allowed")
	}
}

func mkdirAll(t *testing.T, p string) error {
	t.Helper()
	return os.MkdirAll(p, 0o755)
}
