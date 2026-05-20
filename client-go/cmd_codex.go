package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/kardianos/service"
)

// codexDefaultArgs is the conservative baseline we write when the user
// runs `vvibe codex enable` without supplying their own --args. Read-only
// sandbox + per-tool approval is the closest analogue to what Claude
// gives the user out of the box (interactive permission per tool).
const codexDefaultArgs = "--sandbox read-only --ask-for-approval on-request"

// runCodex dispatches the `vvibe codex …` subcommand. We use a sub-verb
// (enable / disable / status) rather than flags on the bare command so
// the intent is obvious from the command line — `vvibe codex enable` reads
// less ambiguously than `vvibe codex --on`.
//
// Why a dedicated subcommand at all: codex is gated behind a daemon-side
// opt-in (see runner_codex.go). The old way was an env var, which on
// Windows means an admin PowerShell and `[Environment]::SetEnvironmentVariable(…,'Machine')`
// — too high a bar for a CLI tool. Persisting to client.json is equivalent
// for the runner and needs zero elevation.
func runCodex(args []string) {
	verb := "status"
	if len(args) > 0 {
		verb = args[0]
		args = args[1:]
	}
	switch verb {
	case "status":
		runCodexStatus()
	case "enable":
		runCodexEnable(args)
	case "disable":
		runCodexDisable()
	case "help", "-h", "--help":
		printCodexUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown codex subcommand: %s\n\n", verb)
		printCodexUsage()
		os.Exit(2)
	}
}

func printCodexUsage() {
	fmt.Print(`vvibe codex — manage the codex policy gate on this daemon

Usage:
  vvibe codex                       Show current policy state.
  vvibe codex enable [--args ARGS]  Allow codex sessions on this daemon. If
                                    --args is omitted you'll be prompted
                                    interactively; press Enter to accept
                                    the safe default.
  vvibe codex disable               Refuse codex sessions on this daemon.

Notes:
  - Codex has no per-tool permission UI yet; whatever you pass via --args
    is the entire security model for that session. The default
    "--sandbox read-only --ask-for-approval on-request" mirrors Claude's
    interactive-per-tool feel.
  - This only controls the daemon side. The server has its own
    CODEX_TRUST_DEFAULTS flag and will refuse codex sessions independently
    if the operator hasn't opted in there.
  - Changes take effect after ` + "`vvibe restart`" + ` (or next start).
`)
}

func runCodexStatus() {
	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}
	p, _ := configPath()
	fmt.Printf("config file: %s\n\n", p)

	if cfg.CodexTrustDefaults {
		fmt.Println("  enabled  yes (codex sessions allowed on this daemon)")
	} else {
		fmt.Println("  enabled  no  (codex sessions will be refused — run `vvibe codex enable`)")
	}
	if cfg.CodexArgs != "" {
		fmt.Printf("  args     %s\n", cfg.CodexArgs)
	} else {
		fmt.Printf("  args     (none — codex would run with built-in defaults)\n")
	}

	// Legacy env-var fallback. Don't lie about what's in effect: if the
	// user already wired CODEX_TRUST_DEFAULTS=1 into their service env,
	// say so — otherwise they'll wonder why disabling didn't stick.
	envTrust := os.Getenv("CODEX_TRUST_DEFAULTS")
	envArgs := os.Getenv("CODEX_ARGS")
	if envTrust != "" || envArgs != "" {
		fmt.Println("\nLegacy env vars seen in this process:")
		if envTrust != "" {
			fmt.Printf("  CODEX_TRUST_DEFAULTS=%s\n", envTrust)
		}
		if envArgs != "" {
			fmt.Printf("  CODEX_ARGS=%s\n", envArgs)
		}
		fmt.Println("  (env-var path still works as a fallback for back-compat.)")
	}

	// Bonus: warn if codex isn't actually installed. Easy to miss.
	if _, err := exec.LookPath("codex"); err != nil {
		fmt.Println("\nnote: codex CLI is not on PATH right now — enabling won't help until it's installed.")
	}
}

func runCodexEnable(args []string) {
	fs := flag.NewFlagSet("codex enable", flag.ExitOnError)
	argFlag := fs.String("args", "", "extra arguments injected before the prompt (e.g. \"--full-auto\")")
	yes := fs.Bool("yes", false, "skip the interactive confirmation; use default args if --args is empty")
	_ = fs.Parse(args)

	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}

	chosen := *argFlag
	if chosen == "" && !*yes {
		chosen = promptForCodexArgs(cfg.CodexArgs)
	}
	if chosen == "" {
		chosen = codexDefaultArgs
	}

	cfg.CodexTrustDefaults = true
	cfg.CodexArgs = chosen
	if err := saveConfig(cfg); err != nil {
		die("save config: %v", err)
	}

	p, _ := configPath()
	fmt.Printf("\nsaved → %s\n", p)
	fmt.Println("  codex enabled: yes")
	fmt.Printf("  codex args:    %s\n", chosen)
	printCodexRestartHint()
}

func runCodexDisable() {
	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}
	cfg.CodexTrustDefaults = false
	if err := saveConfig(cfg); err != nil {
		die("save config: %v", err)
	}
	fmt.Println("codex disabled on this daemon.")

	// If the legacy env var is still set, the runner will fall back to it
	// and our disable does nothing — call that out instead of silently
	// having our config-write be a no-op.
	if os.Getenv("CODEX_TRUST_DEFAULTS") == "1" {
		fmt.Println()
		fmt.Println("warning: CODEX_TRUST_DEFAULTS=1 is still set as an env var on this")
		fmt.Println("process. The runner accepts either signal, so codex will still be")
		fmt.Println("allowed at runtime. Unset the env var to fully disable.")
	}
	printCodexRestartHint()
}

// promptForCodexArgs reads one line from stdin asking the user for codex
// args. The existing config value (if any) wins over the hard-coded
// baseline as the suggested default — re-running `vvibe codex enable`
// after tweaks shouldn't silently revert previous customisation.
func promptForCodexArgs(existing string) string {
	suggested := existing
	if suggested == "" {
		suggested = codexDefaultArgs
	}
	fmt.Println("Codex has no per-tool permission UI; the args below ARE the entire")
	fmt.Println("safety model for sessions run via this daemon. The default mirrors")
	fmt.Println("Claude's interactive-per-tool behaviour.")
	fmt.Println()
	fmt.Printf("  args [%s]: ", suggested)
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		// EOF or read error — fall back silently to the suggestion.
		return suggested
	}
	line = strings.TrimRight(line, "\r\n")
	if strings.TrimSpace(line) == "" {
		return suggested
	}
	return line
}

// printCodexRestartHint mirrors printPostLoginHint: tells the user what
// to do *next*. Without this, a successful save reads like a no-op since
// the running daemon hasn't picked up the new config.
func printCodexRestartHint() {
	fmt.Println()
	if svc, err := newService(); err == nil {
		if s, sErr := svc.Status(); sErr == nil {
			switch s {
			case service.StatusRunning:
				fmt.Println("Next: restart the daemon to pick up the change.")
				fmt.Println("  vvibe restart")
				return
			case service.StatusStopped:
				fmt.Println("Next: start the daemon to pick up the change.")
				fmt.Println("  vvibe start")
				return
			}
		}
	}
	fmt.Println("Next: restart whatever vvibe process is running so the new config applies.")
	fmt.Println("  (foreground) Ctrl-C, then `vvibe run`")
	fmt.Println("  (service)    `vvibe restart`")
}
