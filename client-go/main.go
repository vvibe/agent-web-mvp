// agent-client: cross-platform daemon that connects the local machine to the
// Agent Web server. Handles its own OS-level service registration so it auto-
// starts on boot (Windows Service / launchd / systemd --user).
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

const (
	serviceName        = "AgentWebClient"
	serviceDisplayName = "Agent Web Client"
	serviceDescription = "Connects local AI coding agents (Claude Code, Codex) to the Agent Web server."
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
	case "show-config":
		runShowConfig()
	case "version":
		fmt.Println("agent-client 0.1.0")
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", cmd)
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Print(`agent-client — local daemon for Agent Web

Usage:
  agent-client <command> [args]

Commands:
  install            Register this binary as an OS service (auto-start on boot)
  uninstall          Remove the OS service
  start / stop       Control the service
  restart            Restart the service
  status             Show service status
  run                Run in the foreground (used by the service manager; also
                     useful for testing without installing)
  login --token=X --server=URL
                     Save auth token and server URL to the config file
  show-config        Print the config file path and current contents
  version            Print version
  help               Show this help

Examples:
  agent-client login --token=abc123 --server=ws://127.0.0.1:8787/client
  sudo agent-client install        # macOS / Linux user-service usually does not need sudo
  agent-client status
`)
}

func runLogin(args []string) {
	fs := flag.NewFlagSet("login", flag.ExitOnError)
	token := fs.String("token", "", "auth token for the server")
	server := fs.String("server", "", "WebSocket URL of the Agent Web server, e.g. ws://127.0.0.1:8787/client")
	_ = fs.Parse(args)

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if *token != "" {
		cfg.Token = *token
	}
	if *server != "" {
		cfg.Server = *server
	}
	if cfg.Server == "" {
		cfg.Server = defaultServer
	}
	if err := saveConfig(cfg); err != nil {
		log.Fatalf("save config: %v", err)
	}
	p, _ := configPath()
	fmt.Printf("saved → %s\n  server: %s\n  token:  %s\n", p, cfg.Server, maskToken(cfg.Token))
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
