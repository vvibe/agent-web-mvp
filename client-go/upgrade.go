package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/creativeprojects/go-selfupdate"
	"github.com/kardianos/service"
)

// upgradeRepo is the GitHub repository that hosts our release archives.
// Mirrors the values used by the install scripts and .goreleaser.yaml.
const (
	upgradeRepoOwner = "vvibe"
	upgradeRepoName  = "agent-web-mvp"
)

// runUpgrade implements `vvibe upgrade [--check] [--yes]`. It looks up the
// latest GitHub release, compares its version to the binary's own embedded
// `version` (set via -ldflags at build time), and — when the user says yes —
// stops the OS service, atomically replaces the binary using
// creativeprojects/go-selfupdate, then starts the service again.
//
// Flags are parsed manually instead of via flag.FlagSet because we want the
// `--check` and `--yes` long forms only; FlagSet would add `-help` noise we
// don't need for this very small command.
func runUpgrade(args []string) {
	check := false
	yes := false
	for _, a := range args {
		switch a {
		case "--check", "-n":
			check = true
		case "--yes", "-y":
			yes = true
		case "-h", "--help":
			fmt.Print(`vvibe upgrade — update to the latest release

Usage:
  vvibe upgrade [--check] [--yes]

Flags:
  --check, -n   Only report whether an update is available; do not download.
  --yes,   -y   Skip the y/N prompt before applying the update.
`)
			return
		default:
			fmt.Fprintf(os.Stderr, "unknown flag: %s\n", a)
			os.Exit(2)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	source, err := selfupdate.NewGitHubSource(selfupdate.GitHubConfig{})
	if err != nil {
		log.Fatalf("init github source: %v", err)
	}
	updater, err := selfupdate.NewUpdater(selfupdate.Config{
		Source: source,
		// GoReleaser ships a single `checksums.txt` alongside the archives.
		// ChecksumValidator parses it and verifies the downloaded asset's
		// sha256 before swapping the binary.
		Validator: &selfupdate.ChecksumValidator{UniqueFilename: "checksums.txt"},
	})
	if err != nil {
		log.Fatalf("init updater: %v", err)
	}

	repo := selfupdate.NewRepositorySlug(upgradeRepoOwner, upgradeRepoName)
	release, found, err := updater.DetectLatest(ctx, repo)
	if err != nil {
		log.Fatalf("look up latest release: %v", err)
	}
	if !found {
		fmt.Println("No releases published yet.")
		return
	}

	// `version` is the ldflag-injected current version. When built locally
	// without ldflags it is "dev", which compares as less than any real
	// release; that's actually what we want for testing snapshot builds.
	current := version
	fmt.Printf("Current: %s\nLatest:  %s\n", current, release.Version())

	if release.LessOrEqual(current) {
		fmt.Println("\nAlready on the latest version.")
		return
	}
	if check {
		fmt.Println("\nRun `vvibe upgrade` (without --check) to apply.")
		return
	}

	if !yes && !confirm(fmt.Sprintf("\nUpdate %s → %s? [y/N] ", current, release.Version())) {
		fmt.Println("Cancelled.")
		return
	}

	exe, err := os.Executable()
	if err != nil {
		log.Fatalf("locate own executable: %v", err)
	}

	// If the daemon is registered as an OS service, the running copy holds
	// an open handle to the binary; on Windows we *must* stop it before
	// replacing the file. macOS/Linux can replace a running ELF in place
	// thanks to inode swapping, but stopping is still cleaner so the
	// service comes back on the new version without a kill -HUP.
	svcRestart := stopServiceIfRunning()

	fmt.Println("Downloading + verifying…")
	if err := updater.UpdateTo(ctx, release, exe); err != nil {
		// Best-effort: try to bring the service back up on the OLD binary
		// before we exit, so the user isn't left with a dead daemon.
		if svcRestart {
			tryStartService()
		}
		log.Fatalf("update failed: %v", err)
	}

	if svcRestart {
		tryStartService()
	}

	fmt.Printf("\nUpdated to %s. Run `vvibe version` in a new shell to confirm.\n", release.Version())
}

// stopServiceIfRunning attempts to stop the registered OS service if it is
// installed and currently running. Returns true if the caller should start
// it again after the upgrade.
//
// Errors are intentionally swallowed: the most common case is "service not
// installed" (foreground / dev usage), and there is nothing useful we can do
// about a transient SCM error here beyond noting it.
func stopServiceIfRunning() bool {
	svc, err := newService()
	if err != nil {
		return false
	}
	status, err := svc.Status()
	if err != nil {
		// Likely "service not installed". Nothing to stop.
		return false
	}
	if status != service.StatusRunning {
		return false
	}
	fmt.Println("Stopping service…")
	if err := svc.Stop(); err != nil {
		fmt.Printf("warning: failed to stop service (%v) — continuing, but you may need to restart it manually.\n", err)
		return false
	}
	return true
}

func tryStartService() {
	svc, err := newService()
	if err != nil {
		return
	}
	fmt.Println("Starting service…")
	if err := svc.Start(); err != nil {
		fmt.Printf("warning: failed to start service (%v) — run `vvibe start` manually.\n", err)
	}
}

func confirm(prompt string) bool {
	// Non-TTY (piped, scripted): refuse to ask. The user must pass --yes.
	if !isTerminal(os.Stdin) {
		fmt.Fprintln(os.Stderr, "stdin is not a TTY; pass --yes to apply non-interactively.")
		return false
	}
	fmt.Print(prompt)
	scanner := bufio.NewScanner(os.Stdin)
	if !scanner.Scan() {
		return false
	}
	answer := strings.ToLower(strings.TrimSpace(scanner.Text()))
	return answer == "y" || answer == "yes"
}

// isTerminal reports whether the given file is a terminal. We avoid pulling
// in golang.org/x/term just for this one call and instead use a Stat-based
// approximation that's good enough for "stdin is not a pipe".
func isTerminal(f *os.File) bool {
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

