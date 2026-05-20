//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/kardianos/service"
)

// taskName is the Task Scheduler entry name. Matches serviceName so users
// who run mixed-vintage docs ("Vvibe service" / "Vvibe task") see the
// same identifier in Task Manager / `schtasks /Query`.
const taskName = serviceName // "Vvibe"

// runWindowsTaskInstall is the Windows-native install path. We chose Task
// Scheduler over kardianos' SCM service because:
//
//   - The SCM service runs as LocalSystem regardless of who invoked
//     `vvibe install`. Several codex paths (auth verification, project
//     trust, possibly sandbox enforcement) check the OS user identity
//     rather than just `%USERPROFILE%`, so they misbehave under
//     LocalSystem even when we splice the interactive user's home back
//     into the child's env. Switching to Task Scheduler means the daemon
//     runs as the actual interactive user — same identity codex uses
//     when invoked from the shell.
//
//   - Task Scheduler doesn't require elevation when created via the
//     PowerShell ScheduledTasks module (Register-ScheduledTask). The
//     schtasks.exe CLI on the same host refuses /SC ONLOGON without
//     admin, so we deliberately use PowerShell for create/delete and
//     schtasks for run/end/query (which are fine without admin once the
//     task is owned by the current user).
//
// We deliberately don't try to silently migrate users off the old SCM
// service: stopping or deleting a service installed under a different
// identity usually requires admin, and trying to do that here would
// either succeed silently in the admin case or fail confusingly in the
// non-admin case. Instead we refuse the install with a clear instruction.
func runWindowsTaskInstall(args []string) {
	force := false
	for _, a := range args {
		if a == "--force" {
			force = true
		}
	}

	cfg, _ := loadConfig()
	if (cfg == nil || cfg.Token == "") && !force {
		fmt.Fprintln(os.Stderr, "!!  no token configured — pair this machine first:")
		fmt.Fprintln(os.Stderr, "      vvibe login --server=wss://your-app/client")
		fmt.Fprintln(os.Stderr, "    or pass --force to install now and login later.")
		os.Exit(1)
	}

	// Refuse if the old LocalSystem SCM service is still installed. Two
	// daemons fighting for the same token would race on the WebSocket
	// reconnect, and the SCM one wins on cold boot since it starts before
	// the user logs on. Better to make the user explicitly retire it.
	if oldSCMServiceInstalled() {
		fmt.Fprintln(os.Stderr, "!!  An older LocalSystem-based Vvibe service is still installed.")
		fmt.Fprintln(os.Stderr, "    It would conflict with the new per-user task on next boot.")
		fmt.Fprintln(os.Stderr, "    Remove it first (admin PowerShell):")
		fmt.Fprintln(os.Stderr, "        sc.exe stop Vvibe")
		fmt.Fprintln(os.Stderr, "        sc.exe delete Vvibe")
		fmt.Fprintln(os.Stderr, "    Then re-run `vvibe install` from a normal (non-admin) shell.")
		os.Exit(1)
	}

	// Refuse if admin-owned artifacts from the old install are still in
	// the shared appDir — specifically claude-bridge.mjs (rewritten every
	// Claude session) and node_modules/. The user-mode daemon can read
	// them (Users:Read is in the inherited ACL) but cannot overwrite or
	// delete them, so Claude sessions would fail with "Access is denied"
	// the moment a session is created. Catch it now instead of letting
	// the first Claude session blow up at runtime.
	if blockers := adminOwnedAppDirArtifacts(); len(blockers) > 0 {
		fmt.Fprintln(os.Stderr, "!!  The old install left admin-owned files in the shared app dir.")
		fmt.Fprintln(os.Stderr, "    The user-mode daemon can't overwrite them, so Claude sessions")
		fmt.Fprintln(os.Stderr, "    would fail with 'Access is denied'. Clean them up first")
		fmt.Fprintln(os.Stderr, "    (admin PowerShell):")
		for _, b := range blockers {
			fmt.Fprintf(os.Stderr, "        Remove-Item -Recurse -Force %q\n", b)
		}
		fmt.Fprintln(os.Stderr, "    Then re-run `vvibe install` from a normal (non-admin) shell.")
		fmt.Fprintln(os.Stderr, "    (client.json with your pairing token is owned by you and stays.)")
		os.Exit(1)
	}

	snapshotInteractiveUserEnv()

	exe, err := os.Executable()
	if err != nil {
		die("locate vvibe binary: %v", err)
	}

	// Write the .vbs launcher next to client.json. It exists for one
	// reason: hide the daemon's console window when Task Scheduler fires
	// at logon. vvibe.exe is a console-subsystem Go binary so the user
	// can still run `vvibe status` from PowerShell and see output (the
	// `-H windowsgui` alternative breaks that — PowerShell doesn't relay
	// stdout from GUI-subsystem natives). wscript.exe is itself GUI
	// subsystem and the WScript.Shell.Run with intWindowStyle=0 starts
	// the child with SW_HIDE, so neither the wrapper nor the daemon is
	// ever visible.
	launcherPath, err := writeWindowsHiddenLauncher(exe)
	if err != nil {
		die("write hidden launcher: %v", err)
	}

	// Register-ScheduledTask via PowerShell. The cmdlet accepts the user
	// name in DOMAIN\User form via $env:USERNAME / $env:USERDOMAIN; we
	// build that here so the task is principal'd to the *current* user
	// (the install-time invoker), which matches the AtLogOn trigger.
	//
	// LogonType Interactive + RunLevel Limited is the unprivileged
	// equivalent of "run only when logged on, no elevation".
	ps := strings.Join([]string{
		fmt.Sprintf(`$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '"%s"' -WorkingDirectory "%s"`, launcherPath, filepathDirOf(exe)),
		`$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
		`$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited`,
		// Hidden = task hidden in Scheduler UI (cosmetic). Window
		// suppression is handled by the wscript wrapper, not here.
		// StartWhenAvailable + RestartCount cover transient logon-time
		// failures (laptop just-woken, network not yet ready).
		`$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)`,
		fmt.Sprintf(`Register-ScheduledTask -TaskName "%s" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`, taskName),
	}, "; ")

	if out, err := runPowershell(ps); err != nil {
		die("Register-ScheduledTask: %v\n%s", err, out)
	}
	fmt.Printf("installed Task Scheduler entry: %s\n  trigger: at logon of current user\n  binary:  %s\n", taskName, exe)

	ensureClaudeSDK()

	if out, err := runSchtasks("/Run", "/TN", taskName); err != nil {
		fmt.Printf("warning: could not start immediately: %v\n%s\n", err, out)
		fmt.Println("you can run `vvibe start` manually, or log out and back in.")
	} else {
		fmt.Println("started.")
	}
}

func runWindowsTaskUninstall() {
	installed := taskInstalled()
	if !installed && !oldSCMServiceInstalled() {
		fmt.Println("nothing to uninstall (no Task Scheduler entry or SCM service registered).")
		return
	}
	if installed {
		// Best-effort stop first; schtasks /End is a no-op if the task
		// isn't running and we don't care to surface that.
		_, _ = runSchtasks("/End", "/TN", taskName)
		ps := fmt.Sprintf(`Unregister-ScheduledTask -TaskName "%s" -Confirm:$false`, taskName)
		if out, err := runPowershell(ps); err != nil {
			die("Unregister-ScheduledTask: %v\n%s", err, out)
		}
		fmt.Println("uninstalled Task Scheduler entry.")
	}
	if oldSCMServiceInstalled() {
		fmt.Println()
		fmt.Println("note: An older LocalSystem-based Vvibe service is also installed.")
		fmt.Println("      Remove it with an admin PowerShell:")
		fmt.Println("        sc.exe stop Vvibe")
		fmt.Println("        sc.exe delete Vvibe")
	}
}

func runWindowsTaskAction(action string) {
	switch action {
	case "start":
		if out, err := runSchtasks("/Run", "/TN", taskName); err != nil {
			die("schtasks /Run: %v\n%s", err, out)
		}
	case "stop":
		// /End terminates the most recent task instance. If nothing is
		// running, it returns non-zero with a "task is not currently
		// running" message — we don't surface that as an error since
		// the user's intent (stop the daemon) is satisfied either way.
		_, _ = runSchtasks("/End", "/TN", taskName)
		// Belt-and-suspenders: /End sometimes leaves a daemon child
		// process behind on Windows when the task action itself has
		// already exited (the daemon detached from the shell that
		// `vvibe run` started). Kill any stray vvibe.exe owned by us.
		_ = killUserVvibeProcesses()
	case "restart":
		_, _ = runSchtasks("/End", "/TN", taskName)
		_ = killUserVvibeProcesses()
		if out, err := runSchtasks("/Run", "/TN", taskName); err != nil {
			die("schtasks /Run: %v\n%s", err, out)
		}
	default:
		die("unknown action: %s", action)
	}
	fmt.Println(action, "ok")
}

func runWindowsTaskStatus() {
	if !taskInstalled() {
		fmt.Println("status:  not installed")
	} else if vvibeProcessRunning() {
		fmt.Println("status:  running (Task Scheduler entry registered, daemon process up)")
	} else {
		fmt.Println("status:  stopped (Task Scheduler entry registered, no daemon process)")
	}

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

	if oldSCMServiceInstalled() {
		fmt.Println()
		fmt.Println("note: An older LocalSystem-based Vvibe service is also installed.")
		fmt.Println("      Remove it (admin PS): `sc.exe stop Vvibe; sc.exe delete Vvibe`.")
	}
}

// sectionWindowsTask reports the Task Scheduler entry's state inside the
// doctor's "--- Service ---" block. Mirrors the columns the non-Windows
// branch prints (State / RunAs) so the report stays parallel across OSes.
func sectionWindowsTask(out io.Writer) {
	switch {
	case !taskInstalled():
		fmt.Fprintln(out, "State:    not installed (no Task Scheduler entry)")
	case vvibeProcessRunning():
		fmt.Fprintln(out, "State:    Running (task registered, daemon process up)")
	default:
		fmt.Fprintln(out, "State:    Stopped (task registered, no daemon process)")
	}
	fmt.Fprintln(out, "RunAs:    interactive user (Task Scheduler, /RL Limited, AtLogOn)")
	if oldSCMServiceInstalled() {
		fmt.Fprintln(out, "[!!] An older LocalSystem-based service is also installed (would conflict on next boot).")
		fmt.Fprintln(out, "     Remove (admin PS): sc.exe stop Vvibe; sc.exe delete Vvibe")
	}
}

// taskInstalled reports whether the named scheduled task exists. We use
// schtasks /Query rather than PowerShell here because the call happens
// in hot paths (every doctor invocation, every status query) and a
// `powershell.exe` cold-start is ~200ms vs schtasks' ~20ms.
func taskInstalled() bool {
	_, err := runSchtasks("/Query", "/TN", taskName)
	return err == nil
}

// vvibeProcessRunning returns true if a daemon process matching our own
// image name is currently running — *excluding our own PID*. The
// self-exclusion matters because `vvibe status` shares the image name
// (vvibe.exe) with the daemon, so a naive tasklist match would always
// see at least one entry (this very process) and falsely report
// "running" even when the daemon is stopped.
//
// Reads our own image name via os.Executable() so `go build -o
// vvibe-debug.exe` smoke-tests work, and doesn't bound to user via
// tasklist /FI USERNAME (that filter requires elevation on Windows).
func vvibeProcessRunning() bool {
	imageName := daemonImageName()
	selfPID := os.Getpid()
	out, err := exec.Command(
		"tasklist.exe",
		"/FI", "IMAGENAME eq "+imageName,
		"/FI", fmt.Sprintf("PID ne %d", selfPID),
		"/NH",
	).Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), strings.ToLower(imageName))
}

// daemonImageName returns the executable's filename (e.g. "vvibe.exe").
// Falls back to the canonical name if os.Executable fails for any reason
// — a wrong filename here only matters for status reporting, never for
// install/uninstall correctness.
func daemonImageName() string {
	exe, err := os.Executable()
	if err != nil {
		return "vvibe.exe"
	}
	// Use the basename. Avoid filepath import to keep this file's
	// imports minimal — strings is already in scope.
	i := strings.LastIndexByte(exe, '\\')
	if i < 0 {
		i = strings.LastIndexByte(exe, '/')
	}
	if i < 0 {
		return exe
	}
	return exe[i+1:]
}

// killUserVvibeProcesses terminates any other vvibe.exe owned by the
// current user — *excluding our own PID*. Called from stop/restart
// because `schtasks /End` only kills the task's direct child, and the
// daemon spawned via `vvibe run` is a separate process from the
// `vvibe stop` we're running right now.
//
// The self-exclusion matters because the CLI and the daemon share the
// same image name (vvibe.exe). Without the PID filter, `vvibe stop`
// would also kill its own process before printing "stop ok", leaving
// the user with an exit code 1 and no output — looks like a crash.
func killUserVvibeProcesses() error {
	imageName := daemonImageName()
	selfPID := os.Getpid()
	args := []string{"/IM", imageName, "/F", "/FI", fmt.Sprintf("PID ne %d", selfPID)}
	if user := strings.ToLower(os.Getenv("USERNAME")); user != "" {
		filter := user
		if domain := os.Getenv("USERDOMAIN"); domain != "" {
			filter = domain + "\\" + user
		}
		args = append(args, "/FI", "USERNAME eq "+filter)
	}
	// We swallow errors: "not found" after a clean stop is the common
	// case and not worth surfacing to the user.
	_ = exec.Command("taskkill.exe", args...).Run()
	return nil
}

// writeWindowsHiddenLauncher materialises a tiny VBScript that the Task
// Scheduler action invokes via wscript.exe. The VBScript calls
// WScript.Shell.Run with intWindowStyle=0 (SW_HIDE), which starts
// vvibe.exe with no visible window — neither the wrapper nor the daemon
// flash a console on logon. Returns the absolute path of the written
// launcher so the install step can wire it into the task action.
//
// The path of the daemon binary is embedded into the .vbs at install
// time. If the binary moves later, re-running `vvibe install` rewrites
// this file with the new path; `vvibe upgrade` doesn't move the binary
// (it overwrites in place via go-selfupdate), so no separate refresh
// is needed for the common upgrade case.
func writeWindowsHiddenLauncher(daemonExe string) (string, error) {
	d, err := appDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return "", err
	}
	launcherPath := d + `\launch.vbs`
	// VBScript string escaping: " inside a string literal is doubled.
	// daemonExe is a Windows path like C:\Users\foo\vvibe.exe — backslashes
	// are NOT special in VBScript string literals, so we just need to
	// double any double-quotes (there shouldn't be any in a real path).
	escaped := strings.ReplaceAll(daemonExe, `"`, `""`)
	content := "' Auto-generated by `vvibe install`. Hides the daemon's console window when\r\n" +
		"' Task Scheduler fires at logon. Don't edit; re-run `vvibe install` to refresh.\r\n" +
		"' SW_HIDE = 0; bWaitOnReturn = False means fire-and-forget.\r\n" +
		`CreateObject("WScript.Shell").Run """` + escaped + `"" run", 0, False` + "\r\n"
	if err := os.WriteFile(launcherPath, []byte(content), 0o600); err != nil {
		return "", err
	}
	return launcherPath, nil
}

// runSchtasks runs schtasks.exe with the given args, returns its combined
// stdout+stderr, and surfaces a non-zero exit as a Go error.
func runSchtasks(args ...string) (string, error) {
	cmd := exec.Command("schtasks.exe", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// runPowershell runs the given PowerShell command (a single string,
// semicolon-separated for compound statements) with -NoProfile so user
// profile customisation can't break our cmdlet calls. Returns combined
// stdout+stderr.
func runPowershell(command string) (string, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

// filepathDirOf is a tiny helper to avoid importing path/filepath solely
// for one call inside the install function. Returns the directory part
// of a Windows absolute path, e.g. "C:\\foo\\bar.exe" -> "C:\\foo".
func filepathDirOf(p string) string {
	// Trim trailing slash if any, then find the last backslash.
	i := strings.LastIndexByte(p, '\\')
	if i < 0 {
		return "."
	}
	if i == 0 {
		return "\\"
	}
	return p[:i]
}

// adminOwnedAppDirArtifacts returns paths inside the shared appDir that
// the *current* (interactive) user can't write to — typically files that
// an admin-elevated `vvibe install` (the old SCM-service path) created
// and that the user-mode daemon now needs to overwrite at runtime.
//
// Returns an empty slice when nothing's in the way, which is the common
// case for fresh user-mode installs.
func adminOwnedAppDirArtifacts() []string {
	d, err := appDir()
	if err != nil {
		return nil
	}
	var blockers []string
	// claude-bridge.mjs is the canary: runner_claude.go rewrites it on
	// every newClaudeRunner() call. If we can't write here, every Claude
	// session is dead. node_modules is the other half — the bridge
	// imports @anthropic-ai/claude-agent-sdk from there.
	candidates := []string{
		filepathDirOf(d) + "\\" + lastSegment(d) + "\\claude-bridge.mjs",
		filepathDirOf(d) + "\\" + lastSegment(d) + "\\node_modules",
	}
	for _, p := range candidates {
		if !pathExists(p) {
			continue
		}
		if !isWritableByUs(p) {
			blockers = append(blockers, p)
		}
	}
	return blockers
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// isWritableByUs probes whether the current process can write to `p`.
// For files: open O_WRONLY|O_APPEND (which doesn't truncate, so it's
// safe even on the running config). For directories: try to create a
// short-lived probe file inside. Returns true on success.
func isWritableByUs(p string) bool {
	fi, err := os.Stat(p)
	if err != nil {
		return false
	}
	if fi.IsDir() {
		probe := p + "\\.vvibe-write-probe"
		f, err := os.OpenFile(probe, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return false
		}
		_ = f.Close()
		_ = os.Remove(probe)
		return true
	}
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

// lastSegment returns the trailing path component, used to assemble
// candidate paths without pulling in path/filepath for one call.
func lastSegment(p string) string {
	if i := strings.LastIndexByte(p, '\\'); i >= 0 {
		return p[i+1:]
	}
	if i := strings.LastIndexByte(p, '/'); i >= 0 {
		return p[i+1:]
	}
	return p
}

// oldSCMServiceInstalled returns true if the legacy kardianos SCM service
// is still registered. Used to refuse a Task Scheduler install when the
// old service is around (they'd race for the same token) and to nudge
// the user toward cleanup during uninstall/status.
//
// We treat any error from svc.Status() as "old service likely absent"
// except for an explicit "access denied", which means it does exist but
// we can't query it. False positives are worse than false negatives
// here — wrongly blocking install on a phantom service strands the user.
func oldSCMServiceInstalled() bool {
	svc, err := newService()
	if err != nil {
		return false
	}
	_, statusErr := svc.Status()
	if statusErr == nil {
		return true
	}
	msg := strings.ToLower(statusErr.Error())
	if strings.Contains(msg, "access is denied") || strings.Contains(msg, "access denied") {
		return true
	}
	if errors.Is(statusErr, service.ErrNotInstalled) {
		return false
	}
	return false
}
