// vvibe: cross-platform daemon that connects the local machine to the
// Agent Web server. Handles its own OS-level service registration so it
// auto-starts on boot (Windows Service / launchd / systemd --user).
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/kardianos/service"
)

// die prints a one-line error to stderr and exits with a non-zero status.
// Replaces log.Fatalf in user-facing command paths — log.Fatalf prefixes
// timestamp + file:line, which reads like a crash to end users. Service
// runtime code (relay, program.Start, etc.) still uses log.* so messages
// land in the log file.
func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "xx  "+format+"\n", args...)
	os.Exit(1)
}

const (
	serviceName        = "Vvibe"
	serviceDisplayName = "Vvibe Daemon"
	serviceDescription = "Connects local AI coding agents (Claude Code, Codex) to the Vvibe / Agent Web server."
)

// Version metadata. Overridden at build time via -ldflags "-X main.version=..."
// by GoReleaser. The defaults below are what `go build` produces locally.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}

	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "install":
		runInstall(args)
	case "uninstall":
		runUninstall()
	case "start":
		runSvcAction("start")
	case "stop":
		runSvcAction("stop")
	case "restart":
		runSvcAction("restart")
	case "status":
		runStatus()
	case "run":
		runForeground()
	case "login":
		runLogin(args)
	case "upgrade":
		runUpgrade(args)
	case "show-config":
		runShowConfig()
	case "sdk":
		runSdkInstall()
	case "doctor":
		runDoctor()
	case "version":
		fmt.Printf("vvibe %s (commit %s, built %s)\n", version, commit, date)
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Print(`vvibe — local daemon for Agent Web

Usage:
  vvibe <command> [args]

Commands:
  login --server=URL [--name=NAME]
                     Pair this machine with your account. Opens a browser for
                     device-code approval, then saves the token to the config.
  login --token=TOKEN --server=URL [--name=NAME]
                     (advanced) Save a pre-existing token, skipping the
                     interactive flow. Used for scripting / migration.
  run                Run in the foreground (prints logs to this terminal).
                     Used by service managers; handy for testing without
                     installing.
  install [--force]  Register this binary as an OS service (auto-start on
                     boot). Refuses if no token is configured — use --force
                     to install anyway and login later.
  uninstall          Remove the OS service. Leaves the config file in place.
  start / stop / restart
                     Control the installed service.
  status             Show service state, configured server, token, log path.
  show-config        Print the config file path and current contents.
  sdk                Install @anthropic-ai/claude-agent-sdk next to the
                     bridge so Claude sessions can resolve it. Runs
                     implicitly during 'install'; rerun manually if it
                     failed (e.g. you didn't have npm yet).
  doctor             Print a diagnostic report (config, agents on PATH,
                     SDK, server reachability, recent log). Paste it
                     into a GitHub issue when filing a bug.
  upgrade [--check]  Download and install the latest release from GitHub
                     (stops + restarts the service around the swap).
  version            Print version.
  help               Show this help.

Examples:
  vvibe login --server=wss://your-app.fly.dev/client
  vvibe run                  # foreground test
  vvibe install              # register as service (Windows: needs Admin PS)
  vvibe status
  vvibe upgrade --check      # report available update without applying
`)
}

func runLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	token := fs.String("token", "", "(advanced) pre-existing device token; skips the interactive flow")
	server := fs.String("server", "", "WebSocket URL of the Agent Web server, e.g. wss://your-app.fly.dev/client")
	name := fs.String("name", "", "human-friendly display name for this machine (e.g. \"My MacBook\")")
	_ = fs.Parse(args)

	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}
	if *server != "" {
		cfg.Server = *server
	}
	if *name != "" {
		cfg.DisplayName = *name
	}
	if cfg.Server == "" {
		cfg.Server = defaultServer
	}

	// Manual token override: useful for scripting / migration. Skips the
	// interactive device-code flow.
	if *token != "" {
		cfg.Token = *token
		if err := saveConfig(cfg); err != nil {
			die("save config: %v", err)
		}
		p, _ := configPath()
		fmt.Printf("saved → %s\n  server: %s\n  token:  %s\n  name:   %s\n", p, cfg.Server, maskToken(cfg.Token), cfg.DisplayName)
		return
	}

	// Interactive device-code flow.
	if err := pairInteractive(cfg); err != nil {
		die("pair: %v", err)
	}
	if err := saveConfig(cfg); err != nil {
		die("save config: %v", err)
	}
	p, _ := configPath()
	fmt.Printf("\nsaved → %s\n  server: %s\n  token:  %s\n  name:   %s\n", p, cfg.Server, maskToken(cfg.Token), cfg.DisplayName)

	printPostLoginHint()
}

// printPostLoginHint nudges the user toward actually starting the daemon
// after pairing. Without this, `vvibe login` silently exits and the device
// never appears in the web UI — a common "why isn't my machine showing up?"
// trap. The hint adapts to whether the service is already installed.
func printPostLoginHint() {
	fmt.Println()
	fmt.Println("Next: start the daemon so this machine appears in the web UI.")
	if svc, err := newService(); err == nil {
		if s, sErr := svc.Status(); sErr == nil {
			switch s {
			case service.StatusRunning:
				fmt.Println("  Service is already running — restart it to pick up the new token:")
				fmt.Println("    vvibe restart")
				return
			case service.StatusStopped:
				fmt.Println("  Service is installed but stopped. Start it with:")
				fmt.Println("    vvibe start")
				return
			}
		}
	}
	fmt.Println("  Foreground (quick test, prints logs to this terminal):")
	fmt.Println("    vvibe run")
	fmt.Println("  Or register as a service so it auto-starts on boot:")
	fmt.Println("    vvibe install")
}

func runShowConfig() {
	p, err := configPath()
	if err != nil {
		die("config path: %v", err)
	}
	cfg, err := loadConfig()
	if err != nil {
		die("load config: %v", err)
	}
	fmt.Printf("config file: %s\n", p)
	fmt.Printf("server:      %s\n", cfg.Server)
	fmt.Printf("token:       %s\n", maskToken(cfg.Token))
	fmt.Printf("log file:    %s\n", mustLogPath())
}

func maskToken(t string) string {
	if t == "" {
		return "(unset)"
	}
	if len(t) <= 8 {
		return "****"
	}
	return t[:4] + "…" + t[len(t)-4:]
}
