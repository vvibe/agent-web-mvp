# Code-signing the `vvibe` daemon

Out of the box, `vvibe` releases are **unsigned**. On first run users see:

- **Windows**: "Windows protected your PC" SmartScreen dialog. They must click
  "More info" → "Run anyway". Some org-managed machines block this entirely.
- **macOS**: "vvibe cannot be opened because the developer cannot be
  verified" Gatekeeper dialog. They must `xattr -d com.apple.quarantine`
  the binary or right-click → Open → confirm.
- **Linux**: no warning; ELFs don't have a signing ecosystem.

The plumbing in [.goreleaser.yaml](.goreleaser.yaml) and
[../.github/workflows/release-client.yml](../.github/workflows/release-client.yml)
will sign + notarise the binaries **as soon as the cert secrets exist**.
Without them the release still goes out, just unsigned (see the
`[sign:skip]` lines in CI logs).

This doc covers what to procure and how to plug it in.

## Windows (Authenticode)

### What to buy

A **code-signing certificate**. Two grades exist:

| Type | Cost | First-run SmartScreen | Notes |
|---|---|---|---|
| **OV** (Organization Validated) | ~$80-300/yr | Trusted after ~30 days of reputation building | Stored as a PFX file. Issuer ships you a CSR signing email; you import via a browser. |
| **EV** (Extended Validation) | ~$300-700/yr | Trusted **immediately** | Since 2023, EV certs must be stored on a FIPS 140-2 hardware token (e.g. YubiKey FIPS) — you cannot export the private key, so CI signing requires `signtool` from a self-hosted runner with the token plugged in, NOT the ubuntu-latest path documented here. |

For an MVP / side project: **OV is fine**. The reputation phase is annoying
but tolerable for invited testers. Issuers I've used successfully:

- [SSL.com](https://www.ssl.com/certificates/code-signing/) — ~$130/yr OV, no hardware token for OV
- [Sectigo](https://www.sectigo.com/ssl-certificates-tls/code-signing) via resellers — ~$80-200/yr

Skip Comodo / DigiCert direct; their pricing for individuals is brutal.

### Exporting to PFX

After the issuer's portal hands you the certificate, export it as a single
`.pfx` containing both the cert and the private key, password-protected:

1. Windows: `certmgr.msc` → find your cert → All Tasks → Export → "Yes,
   export the private key" → PKCS#12 (.pfx) → set a strong password.
2. macOS Keychain: right-click cert → Export → "Personal Information
   Exchange (.p12)" — same format, different extension. Rename to .pfx.

### Setting GitHub secrets

```sh
# Base64-encode for safe storage in GH secrets (binary cert files don't
# survive the secret editor's text-only input otherwise).
base64 -w 0 windows-cert.pfx > windows-cert.pfx.b64
```

In repo Settings → Secrets and variables → Actions, add:

- `WINDOWS_CERT_PFX_BASE64`: paste the contents of `windows-cert.pfx.b64`
- `WINDOWS_CERT_PASSWORD`: the password you set during export

That's it. Next `v*` tag push will produce signed `vvibe.exe` inside the
`vvibe_windows_*.zip` archives.

### Verifying

After release, on a Windows box:

```powershell
Get-AuthenticodeSignature C:\path\to\vvibe.exe
# Should show: Status = Valid, SignerCertificate = your CN
```

## macOS (Developer ID + notarisation)

### What to buy

An **[Apple Developer Program](https://developer.apple.com/programs/)**
membership: **$99 / year**, individual or company. Pays for the right to
create a "Developer ID Application" certificate that Gatekeeper trusts.

There's no cheaper path. Self-signed certs Apple's Gatekeeper actively
rejects.

### Procuring the cert

1. Enrol at developer.apple.com (1-2 day approval for individuals; longer
   for D-U-N-S-verified companies).
2. https://developer.apple.com/account/resources/certificates → + → choose
   "Developer ID Application". Generate a CSR on your Mac via Keychain
   Access → Certificate Assistant → Request a Certificate From a CA, save
   the .certSigningRequest file, upload it.
3. Download the issued `.cer`, double-click to import into your Mac's
   Keychain.
4. Right-click the certificate in Keychain → Export → P12 format with a
   strong password.

### App-specific password for notarisation

Notarisation calls Apple's API as your Apple ID. To avoid putting your
real Apple ID password in CI:

1. https://appleid.apple.com → Sign-In and Security → App-Specific
   Passwords → Generate.
2. Note the 4-group password (`xxxx-xxxx-xxxx-xxxx`).

### Setting GitHub secrets

```sh
base64 -w 0 macos-cert.p12 > macos-cert.p12.b64
```

In Settings → Secrets and variables → Actions, add:

- `MACOS_CERT_P12_BASE64`: contents of `macos-cert.p12.b64`
- `MACOS_CERT_PASSWORD`: P12 export password
- `MACOS_APPLE_ID`: your Apple ID email
- `MACOS_TEAM_ID`: the 10-character Team ID from
  https://developer.apple.com/account → Membership Details
- `MACOS_APP_PASSWORD`: the app-specific password from above

Next `v*` tag will produce signed + notarised macOS binaries.

### Verifying

On a Mac, after downloading the release:

```sh
codesign -dvvv ./vvibe        # signature info
spctl --assess --type install ./vvibe   # Gatekeeper verdict (accepted/rejected)
```

If `spctl` rejects, the binary is signed but not notarised — check the CI
log for `notary-submit failed` lines.

## Linux

No signing pipeline. The community standard for daemons is just SHA256
checksums (already published in `checksums.txt`).

## What's NOT covered yet

- **Hardware-token (EV) Windows signing** — needs a self-hosted Windows
  runner with the token plugged in. Documented if/when an org buys it.
- **macOS dmg stapling** — bare-binary stapling isn't supported by Apple;
  if we ever ship a .dmg installer we'd add it then. Today users see a
  brief online Gatekeeper check on first run, then it's cached.
- **Automatic certificate rotation** — Apple Developer renews each Sept;
  Windows OV cert renews per issuer. Both require manually re-exporting
  the cert + updating secrets. Calendar reminder beats a clever script.

## Smoke-testing without real certs

`goreleaser release --snapshot --clean` doesn't push tags and uses
`0.0.0-dev-<sha>` for the version. The sign hook will log
`[sign:skip] ... unset` for every binary — that's the desired no-op.

If you want to verify the sign path will work, set the env vars with a
self-signed cert before the snapshot run; you'll get red-flagged binaries
but the tooling chain itself runs end-to-end.
