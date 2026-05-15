package main

import (
	"context"
	"fmt"
	"log"
	"os"

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

func runInstall() {
	svc, err := newService()
	if err != nil {
		log.Fatalf("create service: %v", err)
	}
	exe, _ := os.Executable()
	fmt.Printf("installing service:\n  name:   %s\n  binary: %s\n", serviceName, exe)
	if err := svc.Install(); err != nil {
		log.Fatalf("install: %v", err)
	}
	fmt.Println("installed.")
	if err := svc.Start(); err != nil {
		fmt.Printf("warning: could not start immediately: %v\n", err)
		fmt.Println("you can run `vvibe start` manually, or reboot.")
	} else {
		fmt.Println("started.")
	}
}

func runUninstall() {
	svc, err := newService()
	if err != nil {
		log.Fatalf("create service: %v", err)
	}
	if err := svc.Stop(); err != nil {
		fmt.Printf("stop: %v (continuing)\n", err)
	}
	if err := svc.Uninstall(); err != nil {
		log.Fatalf("uninstall: %v", err)
	}
	fmt.Println("uninstalled.")
}

func runSvcAction(action string) {
	svc, err := newService()
	if err != nil {
		log.Fatalf("create service: %v", err)
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
		log.Fatalf("%s: %v", action, err)
	}
	fmt.Println(action, "ok")
}

func runStatus() {
	svc, err := newService()
	if err != nil {
		log.Fatalf("create service: %v", err)
	}
	s, err := svc.Status()
	if err != nil {
		fmt.Printf("status: error (%v) — service may not be installed\n", err)
		return
	}
	switch s {
	case service.StatusRunning:
		fmt.Println("status: running")
	case service.StatusStopped:
		fmt.Println("status: stopped")
	default:
		fmt.Println("status: unknown")
	}
}

func runForeground() {
	svc, err := newService()
	if err != nil {
		log.Fatalf("create service: %v", err)
	}
	// svc.Run() blocks. It detects whether we're under a service manager and
	// integrates with it; if not, it runs as a regular process and we can Ctrl-C.
	if err := svc.Run(); err != nil {
		log.Fatalf("run: %v", err)
	}
}
