package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"

	"github.com/kardianos/service"
)

// program implements the service.Interface. Start must return quickly — kick
// off the real work in a goroutine.
type program struct {
	ctx    context.Context
	cancel context.CancelFunc
	logCl  interface{ Close() error }
}

func (p *program) Start(_ service.Service) error {
	closer, err := openLogger()
	if err == nil {
		p.logCl = closer
	}
	log.Printf("vvibe starting (pid=%d, os=%s)", os.Getpid(), runtimeLabel())
	p.ctx, p.cancel = context.WithCancel(context.Background())
	go p.run()
	return nil
}

func (p *program) Stop(_ service.Service) error {
	log.Println("vvibe stopping")
	if p.cancel != nil {
		p.cancel()
	}
	if p.logCl != nil {
		_ = p.logCl.Close()
	}
	return nil
}

func (p *program) run() {
	cfg, err := loadConfig()
	if err != nil {
		log.Printf("config error: %v", err)
		return
	}
	if cfg.Token == "" {
		log.Println("no token configured — run `vvibe login` first. " +
			"daemon will keep retrying so once you set it, restart the service.")
	}
	runRelay(p.ctx, cfg)
}

// newService builds the service.Service handle. We default to user-mode
// service so installation does not require root/admin on macOS and Linux.
// On Windows, kardianos/service still uses the system service manager and
// will need an elevated shell to install.
func newService() (service.Service, error) {
	cfg := &service.Config{
		Name:        serviceName,
		DisplayName: serviceDisplayName,
		Description: serviceDescription,
		// Windows SCM launches the registered binary with the args we configure
		// here. Without this, `vvibe.exe` is invoked with no args, hits
		// the "print usage and exit 2" branch in main, and SCM kills the service
		// after the 30s start-timeout. The "run" subcommand calls svc.Run() so
		// kardianos can talk to SCM properly.
		Arguments: []string{"run"},
		Option: service.KeyValue{
			"UserService": true,
			// macOS: KeepAlive + RunAtLoad ensure launchd restarts us after crashes.
			"KeepAlive": true,
			"RunAtLoad": true,
		},
	}
	return service.New(&program{}, cfg)
}

func runInstall(args []string) {
	// Windows: register a Task Scheduler entry that runs as the
	// interactive user, NOT an SCM service running as LocalSystem.
	// Several codex paths (auth, project trust) check the OS user
	// identity directly and misbehave under LocalSystem regardless of
	// USERPROFILE override. See service_task_windows.go for the why.
	if runtime.GOOS == "windows" {
		runWindowsTaskInstall(args)
		return
	}

	fs := flag.NewFlagSet("install", flag.ExitOnError)
	force := fs.Bool("force", false, "register the service even if no token is configured (login later)")
	_ = fs.Parse(args)

	// Without a token the daemon will start, log "no token configured" once,
	// and idle forever — leaving the user staring at a green service with
	// no device in the web UI. Refuse by default and point at `vvibe login`.
	cfg, _ := loadConfig()
	if (cfg == nil || cfg.Token == "") && !*force {
		fmt.Fprintln(os.Stderr, "!!  no token configured — pair this machine first:")
		fmt.Fprintln(os.Stderr, "      vvibe login --server=wss://your-app/client")
		fmt.Fprintln(os.Stderr, "    or pass --force to install now and login later.")
		os.Exit(1)
	}

	// Snapshot the interactive user's environment (agent bin dirs +
	// home dir) into client.json. The daemon runs under a different
	// identity (LocalSystem on Windows; potentially root on Unix if
	// install was sudoed) and can't reconstruct either of these on its
	// own. Done before svc.Install so a non-admin first attempt still
	// leaves the snapshot behind for the admin retry and for doctor.
	snapshotInteractiveUserEnv()

	svc, err := newService()
	if err != nil {
		die("create service: %v", err)
	}
	exe, _ := os.Executable()
	fmt.Printf("installing service:\n  name:   %s\n  binary: %s\n", serviceName, exe)
	if err := svc.Install(); err != nil {
		// "service already exists" is the common case when re-running
		// `vvibe install` to refresh the SDK / repair a half-broken setup.
		// Don't abort — let the rest of this function (SDK install, start)
		// still run. Other errors (permission denied, etc.) are still fatal.
		if strings.Contains(strings.ToLower(err.Error()), "already") {
			fmt.Printf("note: service already installed (%v) — continuing.\n", err)
		} else {
			die("install: %v", err)
		}
	} else {
		fmt.Println("installed.")
	}

	// Bridge needs @anthropic-ai/claude-agent-sdk reachable. Install it now
	// while we have the interactive user's npm; the LocalSystem service that
	// runs later can only *read* node_modules, not provision it.
	ensureClaudeSDK()

	if err := svc.Start(); err != nil {
		fmt.Printf("warning: could not start immediately: %v\n", err)
		fmt.Println("you can run `vvibe start` manually, or reboot.")
	} else {
		fmt.Println("started.")
	}
}

func runUninstall() {
	if runtime.GOOS == "windows" {
		runWindowsTaskUninstall()
		return
	}
	svc, err := newService()
	if err != nil {
		die("create service: %v", err)
	}
	if err := svc.Stop(); err != nil {
		fmt.Printf("stop: %v (continuing)\n", err)
	}
	if err := svc.Uninstall(); err != nil {
		die("uninstall: %v", err)
	}
	fmt.Println("uninstalled.")
}

func runSvcAction(action string) {
	if runtime.GOOS == "windows" {
		runWindowsTaskAction(action)
		return
	}
	svc, err := newService()
	if err != nil {
		die("create service: %v", err)
	}
	switch action {
	case "start":
		err = svc.Start()
	case "stop":
		err = svc.Stop()
	case "restart":
		err = svc.Restart()
	}
	if err != nil {
		die("%s: %v", action, err)
	}
	fmt.Println(action, "ok")
}

// runStatus reports service state plus enough config to diagnose the common
// "service is running but my device isn't in the web UI" trap — almost
// always a missing token or wrong server URL. Showing both inline saves a
// second `vvibe show-config` round-trip.
func runStatus() {
	if runtime.GOOS == "windows" {
		runWindowsTaskStatus()
		return
	}
	svc, err := newService()
	if err != nil {
		die("create service: %v", err)
	}
	stateStr := "unknown"
	if s, sErr := svc.Status(); sErr != nil {
		stateStr = fmt.Sprintf("not installed (%v)", sErr)
	} else {
		switch s {
		case service.StatusRunning:
			stateStr = "running"
		case service.StatusStopped:
			stateStr = "stopped"
		}
	}
	fmt.Printf("status:  %s\n", stateStr)

	cfg, cfgErr := loadConfig()
	if cfgErr != nil {
		fmt.Printf("config:  error (%v)\n", cfgErr)
	} else {
		fmt.Printf("server:  %s\n", cfg.Server)
		fmt.Printf("token:   %s\n", maskToken(cfg.Token))
		if cfg.DisplayName != "" {
			fmt.Printf("name:    %s\n", cfg.DisplayName)
		}
	}
	fmt.Printf("log:     %s\n", mustLogPath())
}

func runForeground() {
	svc, err := newService()
	if err != nil {
		die("create service: %v", err)
	}
	// svc.Run() blocks. It detects whether we're under a service manager and
	// integrates with it; if not, it runs as a regular process and we can Ctrl-C.
	if err := svc.Run(); err != nil {
		die("run: %v", err)
	}
}
