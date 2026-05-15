package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// pairInteractive runs the OAuth 2.0 device-flow-style pairing:
//
//	1. POST <httpBase>/api/device/pair-init  → { code, verification_uri }
//	2. Print URL+code and open browser
//	3. Poll <httpBase>/api/device/pair-status?code=...  every poll_interval
//	   seconds until { status: 'approved', token }
//	4. Mutate cfg.Token in place.
func pairInteractive(cfg *Config) error {
	httpBase, err := httpBaseFromWS(cfg.Server)
	if err != nil {
		return fmt.Errorf("derive http base from server URL: %w", err)
	}

	displayName := cfg.DisplayName
	if displayName == "" {
		if h, err := os.Hostname(); err == nil {
			displayName = h
		}
	}

	initResp, err := pairInitRequest(httpBase, displayName)
	if err != nil {
		return err
	}

	fmt.Println()
	fmt.Println("To finish pairing this machine with your account:")
	fmt.Println()
	fmt.Printf("  1. Open in a browser:  %s\n", initResp.VerificationURI)
	fmt.Printf("  2. Confirm the code:   %s\n", initResp.Code)
	fmt.Println()
	tryOpenBrowser(initResp.VerificationURI)
	fmt.Println("Waiting for approval (Ctrl-C to cancel)…")

	interval := time.Duration(initResp.PollInterval) * time.Second
	if interval < time.Second {
		interval = 2 * time.Second
	}
	deadline := time.Now().Add(time.Duration(initResp.ExpiresIn) * time.Second)
	if initResp.ExpiresIn == 0 {
		deadline = time.Now().Add(10 * time.Minute)
	}

	for {
		if time.Now().After(deadline) {
			return fmt.Errorf("pairing code expired before approval")
		}
		time.Sleep(interval)

		status, err := pairStatusRequest(httpBase, initResp.Code)
		if err != nil {
			// Transient network blip — keep polling. Print one dot per attempt
			// so the user sees something is happening.
			fmt.Print("·")
			continue
		}
		switch status.Status {
		case "pending":
			fmt.Print(".")
		case "approved":
			fmt.Println()
			cfg.Token = status.Token
			if cfg.DisplayName == "" && displayName != "" {
				cfg.DisplayName = displayName
			}
			return nil
		case "denied":
			return fmt.Errorf("pairing denied")
		case "expired":
			return fmt.Errorf("pairing code expired")
		default:
			return fmt.Errorf("unexpected status: %s", status.Status)
		}
	}
}

type pairInitResponse struct {
	Code            string `json:"code"`
	VerificationURI string `json:"verification_uri"`
	PollInterval    int    `json:"poll_interval"`
	ExpiresIn       int    `json:"expires_in"`
}

type pairStatusResponse struct {
	Status      string `json:"status"`
	Token       string `json:"token,omitempty"`
	DisplayName string `json:"display_name,omitempty"`
}

func pairInitRequest(httpBase, displayName string) (*pairInitResponse, error) {
	body, _ := json.Marshal(map[string]string{"display_name": displayName})
	req, err := http.NewRequest("POST", httpBase+"/api/device/pair-init", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("pair-init: HTTP %d — %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out pairInitResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("pair-init: decode: %w", err)
	}
	return &out, nil
}

func pairStatusRequest(httpBase, code string) (*pairStatusResponse, error) {
	u := httpBase + "/api/device/pair-status?code=" + url.QueryEscape(code)
	resp, err := http.Get(u)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 404 {
		return nil, fmt.Errorf("pair-status: code not found")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("pair-status: HTTP %d — %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var out pairStatusResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("pair-status: decode: %w", err)
	}
	return &out, nil
}

// httpBaseFromWS converts a "ws(s)://host[:port]/client" URL into the
// matching "http(s)://host[:port]" base for REST calls.
func httpBaseFromWS(wsURL string) (string, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
		// already an HTTP URL — accept it
	default:
		return "", fmt.Errorf("unsupported scheme: %s", u.Scheme)
	}
	u.Path = ""
	u.RawQuery = ""
	return u.String(), nil
}

func tryOpenBrowser(rawURL string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", rawURL)
	case "darwin":
		cmd = exec.Command("open", rawURL)
	default:
		cmd = exec.Command("xdg-open", rawURL)
	}
	_ = cmd.Start()
}
