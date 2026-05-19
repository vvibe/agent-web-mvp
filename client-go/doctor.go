package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kardianos/service"
)

// runDoctor is the user-facing `vvibe doctor` command. It walks the daemon's
// world from the perspective of *this* process (config dir, PATH, agents,
// SDK, server reachability, recent log) and prints a copy-pastable report.
//
// The output is intentionally chatty: every line is something a maintainer
// reading a GitHub issue would otherwise have to ask for in a back-and-forth.
// Sections are fenced with === so the user can dump everything between the
// fences without reading it.
//
// Tokens are masked. Hostnames and paths (which on Windows contain the user
// name) are printed as-is — the user can scrub before pasting.
func runDoctor() {
	// augmentPATHForAgents emits a log line on success; in interactive
	// doctor output that comes out timestamped and breaks up sections.
	// Silence the standard logger for the duration of this command — the
	// information ends up in the "PATH discovery" section anyway.
	prev := log.Writer()
	log.SetOutput(io.Discard)
	defer log.SetOutput(prev)

	out := os.Stdout
	fmt.Fprintln(out, "=== vvibe doctor ====================================================")
	fmt.Fprintf(out, "Generated: %s\n", time.Now().Format(time.RFC3339))

	problems := 0
	problems += sectionIdentity(out)
	problems += sectionConfig(out)
	problems += sectionService(out)
	if runtime.GOOS == "windows" {
		problems += sectionPathDiscovery(out)
	}
	problems += sectionAgents(out)
	problems += sectionAgentAuth(out)
	problems += sectionSDK(out)
	problems += sectionReachability(out)
	sectionLogTail(out)

	fmt.Fprintln(out, "=====================================================================")
	if problems == 0 {
		fmt.Fprintln(out, "No problems detected.")
	} else {
		fmt.Fprintf(out, "Detected %d problem(s) (marked with [!!] above).\n", problems)
	}
	fmt.Fprintln(out)
	fmt.Fprintln(out, "If you're filing a bug at https://github.com/vvibe/agent-web-mvp/issues,")
	fmt.Fprintln(out, "copy everything between the === lines above.")
}

// ─── Sections ────────────────────────────────────────────────────────────────

func sectionIdentity(out io.Writer) int {
	fmt.Fprintln(out, "\n--- Process identity ------------------------------------------------")
	hostname, _ := os.Hostname()
	fmt.Fprintf(out, "vvibe:    %s (commit %s, built %s)\n", version, commit, date)
	fmt.Fprintf(out, "Platform: %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Fprintf(out, "Hostname: %s\n", hostname)
	if u, err := user.Current(); err == nil {
		// On Windows under LocalSystem this prints "NT AUTHORITY\SYSTEM",
		// which is the single most useful signal for "is the service or
		// the user shell looking?".
		fmt.Fprintf(out, "Running as: %s (uid=%s)\n", u.Username, u.Uid)
	}
	fmt.Fprintf(out, "PID:      %d\n", os.Getpid())
	return 0
}

func sectionConfig(out io.Writer) int {
	fmt.Fprintln(out, "\n--- Configuration ---------------------------------------------------")
	problems := 0
	p, err := configPath()
	if err != nil {
		fmt.Fprintf(out, "[!!] cannot resolve config path: %v\n", err)
		return 1
	}
	fmt.Fprintf(out, "Config:   %s\n", p)
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintf(out, "[!!] cannot load config: %v\n", err)
		return 1
	}
	if cfg.Server == "" || cfg.Server == defaultServer {
		fmt.Fprintf(out, "[!!] Server: %s (looks unpaired — run 'vvibe login')\n", cfg.Server)
		problems++
	} else {
		fmt.Fprintf(out, "Server:   %s\n", cfg.Server)
	}
	if cfg.Token == "" {
		fmt.Fprintln(out, "[!!] Token: (empty — daemon will be rejected with 401)")
		problems++
	} else {
		fmt.Fprintf(out, "Token:    %s\n", maskToken(cfg.Token))
	}
	if cfg.DisplayName != "" {
		fmt.Fprintf(out, "Name:     %s\n", cfg.DisplayName)
	}
	return problems
}

func sectionService(out io.Writer) int {
	fmt.Fprintln(out, "\n--- Service ---------------------------------------------------------")
	svc, err := newService()
	if err != nil {
		fmt.Fprintf(out, "cannot construct service handle: %v\n", err)
		return 0
	}
	st, err := svc.Status()
	switch {
	case err != nil && isAccessDenied(err):
		// Windows: SCM Query rights require elevation. On non-admin shells
		// kardianos surfaces "Access is denied." Reporting that as "not
		// installed" is misleading — the service may well be running fine
		// and the user just lacks permission to read its state.
		fmt.Fprintf(out, "State:    unknown (could not query SCM — re-run from an Administrator shell)\n")
	case err != nil:
		fmt.Fprintf(out, "State:    not installed (%v)\n", err)
	case st == service.StatusRunning:
		fmt.Fprintln(out, "State:    Running")
	case st == service.StatusStopped:
		fmt.Fprintln(out, "State:    Stopped")
	default:
		fmt.Fprintf(out, "State:    %v\n", st)
	}
	if runtime.GOOS == "windows" {
		fmt.Fprintln(out, "RunAs:    LocalSystem (Windows service default)")
	}
	exe, _ := os.Executable()
	fmt.Fprintf(out, "Binary:   %s\n", exe)
	lp, _ := logPath()
	if fi, err := os.Stat(lp); err == nil {
		age := time.Since(fi.ModTime()).Truncate(time.Second)
		fmt.Fprintf(out, "Log:      %s (%d bytes, last write %s ago)\n", lp, fi.Size(), age)
	} else {
		fmt.Fprintf(out, "Log:      %s (does not exist yet)\n", lp)
	}
	return 0
}

func sectionPathDiscovery(out io.Writer) int {
	fmt.Fprintln(out, "\n--- PATH discovery (Windows) ----------------------------------------")
	dirs := discoverWindowsAgentDirs()
	if len(dirs) == 0 {
		fmt.Fprintln(out, "[!!] no node/claude/codex install dirs found anywhere reachable.")
		fmt.Fprintln(out, "     Install Node.js LTS, then `npm install -g @anthropic-ai/claude-code`.")
		return 1
	}
	fmt.Fprintf(out, "Found %d agent install dir(s):\n", len(dirs))
	for _, d := range dirs {
		fmt.Fprintf(out, "  - %s\n", d)
	}
	return 0
}

func sectionAgents(out io.Writer) int {
	fmt.Fprintln(out, "\n--- Agents on PATH --------------------------------------------------")
	augmentPATHForAgents() // make discovery consistent with how relay sees it
	problems := 0
	for _, name := range []string{"node", "claude", "codex"} {
		p, err := exec.LookPath(name)
		if err != nil {
			fmt.Fprintf(out, "[!!] %-7s not found on PATH\n", name)
			if name != "node" {
				// node missing is the upstream cause; flagging claude/codex too
				// would double-count, but we still want it visible.
			}
			problems++
			continue
		}
		ver := probeVersion(name)
		fmt.Fprintf(out, "  ok  %-7s %s  %s\n", name, p, ver)
	}
	return problems
}

// probeVersion runs `<name> --version` with a short timeout and returns the
// first line of stdout, or "(version probe failed)" if it errors. Some CLIs
// print pages of help on `--version` mistakes — we cap by reading once.
func probeVersion(name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, "--version").Output()
	if err != nil {
		return "(version probe failed)"
	}
	line := strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0]
	if line == "" {
		return "(empty version output)"
	}
	return "v" + strings.TrimPrefix(line, "v")
}

// sectionAgentAuth heuristically checks whether each agent CLI is signed in
// on this machine. There is no authoritative "am I logged in" command for
// either CLI today, so we rely on two cheap signals:
//
//  1. The agent's config dir (~/.claude, ~/.codex) exists with at least one
//     file in it. Absence is a strong "definitely not signed in" signal
//     (this is the exact state that produced the "Not logged in · Please
//     run /login" trip-up that motivated adding this section).
//  2. The corresponding API-key env var is set. Either signal is enough to
//     count as "looks signed in".
//
// Neither signal is authoritative — a stale or expired token still presents
// as a directory full of files. So a "looks signed in" report is a soft
// pass, not a guarantee. The flagged-bad case is what matters: it catches
// the newcomer who installed the CLI but never ran `claude /login`.
func sectionAgentAuth(out io.Writer) int {
	fmt.Fprintln(out, "\n--- Agent auth (heuristic) ------------------------------------------")
	problems := 0
	home, _ := os.UserHomeDir()
	checks := []struct {
		agent      string
		dirName    string
		envVar     string
		loginCmd   string
		installCmd string
	}{
		{"claude", ".claude", "ANTHROPIC_API_KEY", "claude /login", "@anthropic-ai/claude-code"},
		{"codex", ".codex", "OPENAI_API_KEY", "codex login", "@openai/codex"},
	}
	for _, c := range checks {
		// Skip the check entirely if the binary isn't on PATH — sectionAgents
		// will already have flagged that as a problem and we'd just be
		// double-counting.
		if _, err := exec.LookPath(c.agent); err != nil {
			fmt.Fprintf(out, "  --  %-6s skipped (CLI not on PATH)\n", c.agent)
			continue
		}
		dir := filepath.Join(home, c.dirName)
		dirHasFiles := false
		if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
			dirHasFiles = true
		}
		envSet := os.Getenv(c.envVar) != ""
		switch {
		case dirHasFiles && envSet:
			fmt.Fprintf(out, "  ok  %-6s %s exists + %s is set\n", c.agent, dir, c.envVar)
		case dirHasFiles:
			fmt.Fprintf(out, "  ok  %-6s %s exists (token may still be expired — only the CLI itself can confirm)\n", c.agent, dir)
		case envSet:
			fmt.Fprintf(out, "  ok  %-6s %s is set (config dir absent — that's fine for API-key auth)\n", c.agent, c.envVar)
		default:
			fmt.Fprintf(out, "[!!] %-6s no sign of sign-in — run `%s` (or set %s) on the machine the daemon runs on\n", c.agent, c.loginCmd, c.envVar)
			problems++
		}
	}
	return problems
}

func sectionSDK(out io.Writer) int {
	fmt.Fprintln(out, "\n--- Claude SDK ------------------------------------------------------")
	dir, err := appDir()
	if err != nil {
		fmt.Fprintf(out, "[!!] cannot resolve app dir: %v\n", err)
		return 1
	}
	pkgJSON := filepath.Join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json")
	if _, err := os.Stat(pkgJSON); err != nil {
		fmt.Fprintf(out, "[!!] not installed at %s\n", filepath.Dir(pkgJSON))
		fmt.Fprintln(out, "     Run `vvibe sdk` (or re-run `vvibe install`) to provision it.")
		return 1
	}
	ver := readPackageVersion(pkgJSON)
	fmt.Fprintf(out, "  ok  %s (v%s)\n", filepath.Dir(pkgJSON), ver)
	return 0
}

// readPackageVersion returns the "version" field of a package.json or "?".
// Kept tiny — we don't pull in a JSON dep just for one field.
func readPackageVersion(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return "?"
	}
	s := string(b)
	i := strings.Index(s, `"version"`)
	if i < 0 {
		return "?"
	}
	s = s[i+len(`"version"`):]
	colon := strings.Index(s, ":")
	if colon < 0 {
		return "?"
	}
	s = strings.TrimLeft(s[colon+1:], " ")
	if !strings.HasPrefix(s, `"`) {
		return "?"
	}
	end := strings.Index(s[1:], `"`)
	if end < 0 {
		return "?"
	}
	return s[1 : 1+end]
}

func sectionReachability(out io.Writer) int {
	fmt.Fprintln(out, "\n--- Server reachability ---------------------------------------------")
	cfg, err := loadConfig()
	if err != nil || cfg.Server == "" {
		fmt.Fprintln(out, "(skipped — no server configured)")
		return 0
	}
	// Convert ws://… / wss://… into http(s)://…/api/health
	scheme := "https"
	host := cfg.Server
	if strings.HasPrefix(host, "wss://") {
		host = strings.TrimPrefix(host, "wss://")
		scheme = "https"
	} else if strings.HasPrefix(host, "ws://") {
		host = strings.TrimPrefix(host, "ws://")
		scheme = "http"
	} else if strings.HasPrefix(host, "https://") {
		host = strings.TrimPrefix(host, "https://")
	} else if strings.HasPrefix(host, "http://") {
		host = strings.TrimPrefix(host, "http://")
		scheme = "http"
	}
	// Strip path so /api/health is the only path component.
	if slash := strings.Index(host, "/"); slash >= 0 {
		host = host[:slash]
	}
	url := fmt.Sprintf("%s://%s/api/health", scheme, host)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	elapsed := time.Since(start).Truncate(time.Millisecond)
	if err != nil {
		fmt.Fprintf(out, "[!!] GET %s → %v (%s)\n", url, err, elapsed)
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		fmt.Fprintf(out, "[!!] GET %s → HTTP %d (%s)\n", url, resp.StatusCode, elapsed)
		return 1
	}
	fmt.Fprintf(out, "  ok  GET %s → 200 (%s)\n", url, elapsed)
	return 0
}

func sectionLogTail(out io.Writer) {
	fmt.Fprintln(out, "\n--- Recent log (last 20 lines) --------------------------------------")
	lp, err := logPath()
	if err != nil {
		fmt.Fprintf(out, "(cannot resolve log path: %v)\n", err)
		return
	}
	data, err := readLastBytes(lp, 8*1024)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			fmt.Fprintf(out, "(no log file at %s — service may not have started yet)\n", lp)
			return
		}
		fmt.Fprintf(out, "(cannot read log: %v)\n", err)
		return
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > 20 {
		lines = lines[len(lines)-20:]
	}
	for _, l := range lines {
		fmt.Fprintln(out, l)
	}
}

// isAccessDenied returns true if the error looks like a Windows
// permission failure. kardianos/service wraps SCM errors as plain strings,
// so substring match is the cheapest reliable check.
func isAccessDenied(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "access is denied") || strings.Contains(s, "access denied")
}

// readLastBytes reads up to the last `max` bytes of a file. Used for log tail
// without slurping a multi-MB log into memory just to throw most away.
func readLastBytes(path string, max int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() <= max {
		return io.ReadAll(f)
	}
	if _, err := f.Seek(-max, io.SeekEnd); err != nil {
		return nil, err
	}
	return io.ReadAll(f)
}
