// vvibe: cross-platform daemon that connects the local machine to the
// Agent Web server. Handles its own OS-level service registration so it
// auto-starts on boot (Windows Service / launchd / systemd --user).
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

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
		runInstall()
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
  install            Register this binary as an OS service (auto-start on boot)
  uninstall          Remove the OS service
  start / stop       Control the service
  restart            Restart the service
  status             Show service status
  run                Run in the foreground (used by the service manager; also
                     useful for testing without installing)
  login --token=X --server=URL [--name=NAME]
                     Save auth token, server URL, and display name to the config file
  upgrade [--check]  Download and install the latest release from GitHub
                     (stops + restarts the service around the swap)
  show-config        Print the config file path and current contents
  version            Print version
  help               Show this help

Examples:
  vvibe login --token=abc123 --server=ws://127.0.0.1:8787/client
  sudo vvibe install        # macOS / Linux user-service usually does not need sudo
  vvibe status
  vvibe upgrade --check     # show if an update is available without applying
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
		log.Fatalf("load config: %v", err)
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
			log.Fatalf("save config: %v", err)
		}
		p, _ := configPath()
		fmt.Printf("saved → %s\n  server: %s\n  token:  %s\n  name:   %s\n", p, cfg.Server, maskToken(cfg.Token), cfg.DisplayName)
		return
	}

	// Interactive device-code flow.
	if err := pairInteractive(cfg); err != nil {
		log.Fatalf("pair: %v", err)
	}
	if err := saveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}
	p, _ := configPath()
	fmt.Printf("\nsaved → %s\n  server: %s\n  token:  %s\n  name:   %s\n", p, cfg.Server, maskToken(cfg.Token), cfg.DisplayName)
}

func runShowConfig() {
	p, err := configPath()
	if err != nil {
		log.Fatalf("config path: %v", err)
	}
	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
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
