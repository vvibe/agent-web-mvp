import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { stmts } from './db.ts';
import type { AuthedRequest } from './auth.ts';

const PAIR_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Short user-facing code: 8 chars, unambiguous alphabet (no I/O/0/1).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newPairingCode(): string {
  const buf = randomBytes(8);
  let s = '';
  for (let i = 0; i < buf.length; i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return s;
}

function newDeviceToken(): string {
  return randomBytes(32).toString('hex');
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
  const token = newDeviceToken();
  const result = stmts.approvePairingCode.run(req.user.id, token, code);
  if (result.changes === 0) {
    // Lost a race against another approval / expiry.
    res.status(409).json({ error: 'code no longer pending' });
    return;
  }
  stmts.insertDeviceToken.run(token, req.user.id, row.device_name, Date.now());
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
