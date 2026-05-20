//go:build !windows

package main

import "io"

// These stubs exist so platform-neutral call sites can reference the
// Windows Task Scheduler helpers behind a runtime.GOOS check without
// separate files per platform. On non-Windows they're never reached at
// runtime (the compiler folds away the guarded branch), but they need
// to exist at compile time for the build to succeed.
//
// If you add a new helper in service_task_windows.go, add its stub
// here too — the cross-build to linux/darwin is part of the release
// pipeline (.github/workflows/release-client.yml).

const taskName = serviceName

func taskInstalled() bool       { return false }
func vvibeProcessRunning() bool { return false }

func runSchtasks(_ ...string) (string, error) { return "", nil }
func killUserVvibeProcesses() error            { return nil }

func runWindowsTaskInstall(_ []string) {}
func runWindowsTaskUninstall()         {}
func runWindowsTaskAction(_ string)    {}
func runWindowsTaskStatus()            {}
func sectionWindowsTask(_ io.Writer)   {}
