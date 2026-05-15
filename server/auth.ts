import { randomUUID, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { stmts, type UserRow } from './db.ts';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? '';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://127.0.0.1:8787';
const COOKIE_NAME = 'sid';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// In-memory short-lived OAuth state cache (state → returnTo). Cleared after
// callback or after a 10-minute TTL. Doesn't need to survive restarts —
// pending OAuth handshakes are abandoned anyway when the user gives up.
interface PendingOAuth {
  returnTo: string;
  expiresAt: number;
}
const pendingOAuth = new Map<string, PendingOAuth>();
function cleanupPendingOAuth() {
  const now = Date.now();
  for (const [k, v] of pendingOAuth) if (v.expiresAt < now) pendingOAuth.delete(k);
}

export function isAuthEnabled(): boolean {
  return !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
}

export interface AuthedRequest extends Request {
  user?: UserRow;
}

/**
 * Express middleware: looks for a sid cookie, resolves user, attaches to req.
 * When auth is not configured (dev mode without secrets), attaches a synthetic
 * "anonymous" user so the rest of the app keeps working single-user.
 */
export function loadUser(req: AuthedRequest, _res: Response, next: NextFunction) {
  if (!isAuthEnabled()) {
    req.user = ANON_USER;
    return next();
  }
  const sid = req.cookies?.[COOKIE_NAME];
  if (!sid) return next();
  const row = stmts.findUserIdBySessionId.get(sid);
  if (!row) return next();
  const user = stmts.findUserById.get(row.user_id);
  if (!user) return next();
  stmts.touchBrowserSession.run(Date.now(), sid);
  req.user = user;
  next();
}

export function userIdFromCookie(cookieHeader: string | undefined): string | undefined {
  if (!isAuthEnabled()) return ANON_USER.id;
  if (!cookieHeader) return undefined;
  const sid = parseCookieValue(cookieHeader, COOKIE_NAME);
  if (!sid) return undefined;
  const row = stmts.findUserIdBySessionId.get(sid);
  return row?.user_id;
}

function parseCookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq) === name) {
      return decodeURIComponent(part.slice(eq + 1));
    }
  }
  return undefined;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (req.user) return next();
  res.status(401).json({ error: 'auth required' });
}

// ─── Routes (mounted by server/index.ts) ──────────────────────────────────────

export function startOAuthLogin(req: Request, res: Response) {
  if (!isAuthEnabled()) {
    res.status(503).type('text/plain').send(
      'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.',
    );
    return;
  }
  cleanupPendingOAuth();
  const state = randomBytes(16).toString('hex');
  const returnTo = typeof req.query.return_to === 'string' ? req.query.return_to : '/';
  pendingOAuth.set(state, { returnTo, expiresAt: Date.now() + 10 * 60 * 1000 });

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', GITHUB_CLIENT_ID);
  url.searchParams.set('redirect_uri', `${PUBLIC_URL}/auth/github/callback`);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
}

export async function handleOAuthCallback(req: Request, res: Response) {
  cleanupPendingOAuth();
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }
  const pending = pendingOAuth.get(state);
  if (!pending) {
    res.status(400).send('Invalid or expired state');
    return;
  }
  pendingOAuth.delete(state);

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${PUBLIC_URL}/auth/github/callback`,
      }),
    });
    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) {
      res.status(400).send(`GitHub error: ${tokenBody.error ?? 'no access_token'}`);
      return;
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'agent-web-mvp',
      },
    });
    const gh = (await userRes.json()) as {
      id: number;
      login: string;
      email: string | null;
      name: string | null;
      avatar_url: string | null;
    };

    // GitHub may return null email if the user keeps it private; fetch /user/emails.
    let email = gh.email;
    if (!email) {
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${tokenBody.access_token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'agent-web-mvp',
          },
        });
        const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
        email = primary?.email ?? null;
      } catch {
        /* non-fatal */
      }
    }

    const userId = randomUUID();
    const now = Date.now();
    const user = stmts.upsertUser.get(userId, gh.id, gh.login, email, gh.name, gh.avatar_url, now) as UserRow;

    const sid = randomBytes(32).toString('hex');
    stmts.createBrowserSession.run(sid, user.id, now, now);
    res.cookie(COOKIE_NAME, sid, {
      httpOnly: true,
      secure: PUBLIC_URL.startsWith('https://'),
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    });
    res.redirect(pending.returnTo);
  } catch (err) {
    console.error('[auth] callback error', err);
    res.status(500).send('Authentication failed');
  }
}

export function logout(req: AuthedRequest, res: Response) {
  const sid = req.cookies?.[COOKIE_NAME];
  if (sid) stmts.deleteBrowserSession.run(sid);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.redirect('/');
}

export function whoAmI(req: AuthedRequest, res: Response) {
  if (!req.user) {
    res.json({ authenticated: false, authEnabled: isAuthEnabled() });
    return;
  }
  res.json({
    authenticated: true,
    authEnabled: isAuthEnabled(),
    user: {
      id: req.user.id,
      login: req.user.github_login,
      name: req.user.name,
      email: req.user.email,
      avatar_url: req.user.avatar_url,
    },
  });
}

// ─── Anonymous user fallback (dev mode) ──────────────────────────────────────
//
// When auth is unconfigured, every request maps to this single synthetic user.
// Keeps `npm run dev` working without forcing GitHub OAuth setup.

const ANON_USER: UserRow = {
  id: 'anon',
  github_id: 0,
  github_login: 'anonymous',
  email: null,
  name: 'Anonymous (dev)',
  avatar_url: null,
  created_at: 0,
};
