package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
)

const defaultServer = "ws://127.0.0.1:8787/client"

// Config is persisted to disk between runs. Tokens are stored in plaintext —
// this is intentional for the MVP; replace with OS keychain (keyring, Windows
// Credential Manager, macOS Keychain) before shipping to real users.
type Config struct {
	Server      string `json:"server"`
	Token       string `json:"token"`
	DisplayName string `json:"display_name,omitempty"`
	// AllowedCwds is the union of filesystem roots an incoming
	// daemon_run_prompt is permitted to target. Empty means "no
	// restriction" for backwards compatibility — the daemon logs a
	// warning at startup so the operator notices. See allowlist.go for
	// the resolution + match semantics; managed via the `vvibe allow`
	// / `vvibe deny` / `vvibe allowed` CLI commands.
	AllowedCwds []string `json:"allowed_cwds,omitempty"`
}

// appDir returns the directory that holds client.json and client.log.
//
// On Windows we deliberately use %ProgramData%\vvibe so the LocalSystem
// service and the interactive user read the same file. os.UserConfigDir
// returns %AppData% (per-user) — under LocalSystem that resolves to
// C:\Windows\System32\config\systemprofile\AppData\Roaming and the service
// silently misses any token the user paired interactively.
//
// On macOS/Linux the service runs as the user (launchd/systemd user mode),
// so os.UserConfigDir is the right place.
func appDir() (string, error) {
	if runtime.GOOS == "windows" {
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "vvibe"), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "vvibe"), nil
}

// legacyWinAppDir is the pre-fix Windows location (%AppData%\vvibe). Kept
// solely so loadConfig can one-shot migrate users who paired before the
// switch to %ProgramData% — once migrated, this path is never read again.
func legacyWinAppDir() (string, error) {
	if runtime.GOOS != "windows" {
		return "", errors.New("legacy app dir is windows-only")
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "vvibe"), nil
}

func configPath() (string, error) {
	d, err := appDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "client.json"), nil
}

func logPath() (string, error) {
	d, err := appDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "client.log"), nil
}

func mustLogPath() string {
	p, err := logPath()
	if err != nil {
		return "(unavailable)"
	}
	return p
}

func loadConfig() (*Config, error) {
	p, err := configPath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// First run after the Windows %AppData%→%ProgramData% switch:
			// pull the user's existing client.json across so they don't have
			// to re-pair. Only the interactive process (running as the user)
			// can see the legacy path; the LocalSystem service can't, so we
			// rely on this being triggered by `vvibe install` / `status` /
			// `login` before the service next reads config.
			if migrateLegacyWinConfig() {
				if data, err = os.ReadFile(p); err == nil {
					goto parsed
				}
				if errors.Is(err, os.ErrNotExist) {
					return &Config{Server: defaultServer}, nil
				}
				return nil, err
			}
			return &Config{Server: defaultServer}, nil
		}
		return nil, err
	}
parsed:
	// Strip UTF-8 BOM if present. Windows PowerShell 5.1's `Set-Content
	// -Encoding UTF8` and Notepad-saved-as-UTF-8 both prepend one, and
	// encoding/json rejects it as "invalid character 'ï'".
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", p, err)
	}
	if c.Server == "" {
		c.Server = defaultServer
	}
	return &c, nil
}

// migrateLegacyWinConfig copies client.json from the pre-fix Windows location
// (%AppData%\vvibe) into the new shared location (%ProgramData%\vvibe) if
// the new one is missing and the legacy one exists. Returns true if a
// migration happened. Errors are swallowed (best-effort) — failures simply
// fall through to the "no config yet" path.
func migrateLegacyWinConfig() bool {
	if runtime.GOOS != "windows" {
		return false
	}
	legacyDir, err := legacyWinAppDir()
	if err != nil {
		return false
	}
	legacyPath := filepath.Join(legacyDir, "client.json")
	data, err := os.ReadFile(legacyPath)
	if err != nil {
		return false
	}
	newDir, err := appDir()
	if err != nil {
		return false
	}
	if newDir == legacyDir {
		return false
	}
	if err := os.MkdirAll(newDir, 0o700); err != nil {
		return false
	}
	newPath := filepath.Join(newDir, "client.json")
	if err := os.WriteFile(newPath, data, 0o600); err != nil {
		return false
	}
	log.Printf("migrated config: %s → %s", legacyPath, newPath)
	return true
}

func saveConfig(c *Config) error {
	p, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}

// openLogger sets log output to a file in the app config dir. When running
// under a service manager there is no stdout, so this is the only way to
// retain diagnostics across reboots.
func openLogger() (io.Closer, error) {
	p, err := logPath()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	return f, nil
}
