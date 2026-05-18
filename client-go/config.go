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
)

const defaultServer = "ws://127.0.0.1:8787/client"

// Config is persisted to disk between runs. Tokens are stored in plaintext —
// this is intentional for the MVP; replace with OS keychain (keyring, Windows
// Credential Manager, macOS Keychain) before shipping to real users.
type Config struct {
	Server      string `json:"server"`
	Token       string `json:"token"`
	DisplayName string `json:"display_name,omitempty"`
}

func appDir() (string, error) {
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
			return &Config{Server: defaultServer}, nil
		}
		return nil, err
	}
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
