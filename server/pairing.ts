import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { stmts } from './db.ts';
import type { AuthedRequest } from './auth.ts';

const PAIR_TTL_MS = 10 * 60 * 1000; // 10 minutes

// User-facing code: 12 chars × 32-symbol alphabet (no I/O/0/1) ≈ 10^18 space.
// At 12-char length, even an attacker who can issue requests at network speed
// has ~no chance of guessing a live code within the 10-minute TTL; the
// rate-limit on /api/device/pair-status puts a hard ceiling on that anyway.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 12;
function newPairingCode(): string {
  const buf = randomBytes(CODE_LEN);
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return s;
}

// Device token is "<id>.<secret>". Only the secret is sensitive; id is a
// non-secret lookup key (PK in device_tokens). The DB stores secret_hash =
// sha256(secret); a leaked DB cannot reconstruct usable tokens.
function newDeviceToken(): { id: string; secret: string; token: string; secretHash: string } {
  const id = randomBytes(8).toString('hex'); // 16 hex chars
  const secret = randomBytes(24).toString('hex'); // 48 hex chars
  const secretHash = createHash('sha256').update(secret).digest('hex');
  return { id, secret, token: `${id}.${secret}`, secretHash };
}

/**
 * Resolve a bearer token presented by a daemon. Parses "<id>.<secret>",
 * looks up the row by id, and constant-time-compares the hashed secret.
 * Returns the row only on a successful match.
 */
export function verifyDeviceToken(presented: string): import('./db.ts').DeviceTokenRow | undefined {
  const dot = presented.indexOf('.');
  if (dot <= 0 || dot === presented.length - 1) return undefined;
  const id = presented.slice(0, dot);
  const secret = presented.slice(dot + 1);
  const row = stmts.findDeviceTokenById.get(id);
  if (!row) return undefined;
  const computed = createHash('sha256').update(secret).digest();
  const expected = Buffer.from(row.secret_hash, 'hex');
  if (computed.length !== expected.length) return undefined;
  if (!timingSafeEqual(computed, expected)) return undefined;
  return row;
}

// ─── Daemon endpoints (unauthenticated; daemon doesn't have a user yet) ──────

/**
 * Daemon kicks off a pairing flow:
 *   POST /api/device/pair-init  { display_name? }
 *   → { code, verification_uri, poll_interval, expires_in }
 */
export function pairInit(req: Request, res: Response) {
  const displayName = typeof req.body?.display_name === 'string' ? req.body.display_name : null;
  const now = Date.now();
  const code = newPairingCode();
  stmts.insertPairingCode.run(code, 'pending', displayName, now, now + PAIR_TTL_MS);

  const publicUrl = process.env.PUBLIC_URL ?? `http://${req.headers.host}`;
  res.json({
    code,
    verification_uri: `${publicUrl}/pair?code=${encodeURIComponent(code)}`,
    poll_interval: 2,
    expires_in: Math.floor(PAIR_TTL_MS / 1000),
  });
}

/**
 * Daemon polls until the user approves:
 *   GET /api/device/pair-status?code=ABC
 *   → { status: 'pending' | 'approved' | 'denied' | 'expired', token?, display_name? }
 */
export function pairStatus(req: Request, res: Response) {
  const code = String(req.query.code ?? '');
  if (!code) {
    res.status(400).json({ error: 'missing code' });
    return;
  }
  // Lazy-expire on read so old rows don't masquerade as pending forever.
  stmts.expireOldPairingCodes.run(Date.now());
  const row = stmts.findPairingCode.get(code);
  if (!row) {
    res.status(404).json({ error: 'unknown code' });
    return;
  }
  if (row.status === 'approved') {
    // One-shot: mark claimed *before* responding so a concurrent poll from
    // an attacker cannot also see the token. If we lose the race, the second
    // caller sees 'claimed' below and gets nothing.
    const claim = stmts.claimPairingCode.run(code);
    if (claim.changes === 0) {
      res.json({ status: 'claimed' });
      return;
    }
    res.json({ status: 'approved', token: row.device_token, display_name: row.device_name });
    return;
  }
  res.json({ status: row.status });
}

// ─── Browser endpoint (cookie-authenticated) ─────────────────────────────────

/**
 * User approves a pairing code from the web UI:
 *   POST /api/device/pair-approve  { code }
 *   → { ok: true }
 *
 * The pairing row is marked approved, a device_token is minted, and the
 * device_tokens row is inserted under the current user. Daemon's next
 * pair-status poll picks up the token.
 */
export function pairApprove(req: AuthedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: 'auth required' });
    return;
  }
  const code = String(req.body?.code ?? '');
  if (!code) {
    res.status(400).json({ error: 'missing code' });
    return;
  }
  stmts.expireOldPairingCodes.run(Date.now());
  const row = stmts.findPairingCode.get(code);
  if (!row) {
    res.status(404).json({ error: 'unknown code' });
    return;
  }
  if (row.status !== 'pending') {
    res.status(409).json({ error: `code is ${row.status}` });
    return;
  }
  const t = newDeviceToken();
  // Stash the *full* token on the pairing row briefly so pair-status can hand
  // it back exactly once; the daemon DB only ever stores the hashed secret.
  const result = stmts.approvePairingCode.run(req.user.id, t.token, code);
  if (result.changes === 0) {
    // Lost a race against another approval / expiry.
    res.status(409).json({ error: 'code no longer pending' });
    return;
  }
  stmts.insertDeviceToken.run(t.id, t.secretHash, req.user.id, row.device_name, Date.now());
  res.json({ ok: true });
}

/**
 * Browser asks "what code is this?" so the /pair page can show the daemon's
 * suggested device name before the user confirms.
 *   GET /api/device/pair-lookup?code=ABC
 *   → { code, status, device_name }   (no token leak, even if approved)
 */
export function pairLookup(req: AuthedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: 'auth required' });
    return;
  }
  const code = String(req.query.code ?? '');
  if (!code) {
    res.status(400).json({ error: 'missing code' });
    return;
  }
  stmts.expireOldPairingCodes.run(Date.now());
  const row = stmts.findPairingCode.get(code);
  if (!row) {
    res.status(404).json({ error: 'unknown code' });
    return;
  }
  res.json({ code: row.code, status: row.status, device_name: row.device_name });
}
