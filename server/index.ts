import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMessage, DaemonClientMessage, DeviceInfo, ServerMessage } from '../shared/types.ts';
import {
  isAllowedClaudeModel,
  DaemonClientMessageSchema,
  DeviceHelloMessageSchema,
} from '../shared/types.ts';
import { SessionStore, makeRunnerFactory, type Session } from './sessions.ts';
import { DeviceRegistry } from './devices.ts';
import { stmts } from './db.ts';
import {
  isAuthEnabled,
  loadUser,
  requireAuth,
  startOAuthLogin,
  handleOAuthCallback,
  logout,
  whoAmI,
  userIdFromCookie,
  type AuthedRequest,
} from './auth.ts';
import { pairInit, pairStatus, pairApprove, pairLookup, verifyDeviceToken } from './pairing.ts';
import rateLimit from 'express-rate-limit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://${HOST}:${PORT}`;

// Origin allowlist for browser-facing endpoints (/ws upgrade + state-changing
// REST). Defaults to PUBLIC_URL plus the Vite dev server origin; can be
// overridden with a comma-separated ALLOWED_ORIGINS.
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? `${PUBLIC_URL},http://localhost:5173,http://127.0.0.1:5173`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

// Fail-fast if we're on a public bind / https PUBLIC_URL without auth wired up.
// In that posture, the anonymous fallback would let any visitor share one
// global account and silently inherit every paired daemon.
if (!isAuthEnabled()) {
  const looksPublic = HOST === '0.0.0.0' || PUBLIC_URL.startsWith('https://');
  if (looksPublic && process.env.ALLOW_ANON !== '1') {
    console.error(
      `[boot] Refusing to start: auth is disabled (no GITHUB_CLIENT_ID/SECRET) but ` +
        `HOST=${HOST} and PUBLIC_URL=${PUBLIC_URL} look public. ` +
        `Configure GitHub OAuth, or set ALLOW_ANON=1 to override (NOT recommended).`,
    );
    process.exit(1);
  }
}

const app = express();
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'frame-ancestors': ["'none'"],
        // Vite dev server injects inline scripts/HMR ws; relax in dev only.
        'script-src': process.env.NODE_ENV === 'production'
          ? ["'self'"]
          : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'img-src': ["'self'", 'data:', 'https://avatars.githubusercontent.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(loadUser);

// Origin check for state-changing browser requests. GET requests are exempt
// (OAuth callback, logout-via-GET, etc.) — those don't need CSRF protection
// because they don't carry side effects beyond redirects. Daemon-facing API
// (the /client WS) is separately gated on Bearer token, not Origin.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin as string | undefined;
  // Allow requests with no Origin header only for non-browser clients (daemon
  // pair-init has no Origin because it's invoked from Go). Those endpoints are
  // gated separately or rate-limited at the next milestone; for browser-state
  // routes we still require a matching Origin.
  if (origin && !isAllowedOrigin(origin)) {
    res.status(403).json({ error: 'Origin not allowed' });
    return;
  }
  next();
});

// Install scripts (install.sh / install.ps1) live under server/public. They
// contain a `__VVIBE_SERVER_URL__` placeholder that we substitute at request
// time with the WS URL derived from the request itself, so the daemon config
// is seeded to point at this server (no `--server` flag needed at login).
// trust proxy is set further down so req.protocol/req.get('host') reflect
// X-Forwarded-* on Fly. Cache disabled because the substituted body depends
// on the request host.
const SERVER_URL_PLACEHOLDER = '__VVIBE_SERVER_URL__';
const publicDir = path.resolve(__dirname, 'public');

// Derive the daemon WS URL from PUBLIC_URL rather than the request's Host
// header. Host is attacker-controllable in principle (anyone past the edge
// proxy that sets a weird Host); even if Fly normally normalizes it, the
// substituted value lands inside a single-quoted shell/PS string, so a quote
// or newline in Host would break out of the literal. PUBLIC_URL is set from
// env at boot — it's the one value we already trust to identify us.
const installScriptWsURL = (() => {
  try {
    const u = new URL(PUBLIC_URL);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/client';
    return u.toString();
  } catch {
    return `${PUBLIC_URL.replace(/^http/, 'ws')}/client`;
  }
})();

function serveInstallScript(filename: string) {
  const filePath = path.join(publicDir, filename);
  return (_req: express.Request, res: express.Response) => {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    // Replace only the FIRST occurrence. The placeholder is meant to appear
    // exactly once (the variable assignment near the top of the script);
    // any other occurrence — even in a comment — should remain literal.
    // Replacing all caused install.sh to silently skip its config-seed step
    // because the placeholder also lived inside a `case "$SERVER_URL"`
    // pattern, which then got rewritten to match the substituted value.
    content = content.replace(SERVER_URL_PLACEHOLDER, installScriptWsURL);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(content);
  };
}

if (existsSync(publicDir)) {
  app.get('/install.sh', serveInstallScript('install.sh'));
  app.get('/install.ps1', serveInstallScript('install.ps1'));
}

const distWeb = path.resolve(__dirname, '..', 'dist', 'web');
if (existsSync(distWeb)) {
  app.use(express.static(distWeb));
}

// ─── REST routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultCwd: DEFAULT_CWD, devices: devices.list().length });
});
app.get('/api/me', whoAmI);

// Rate limiters. Trust Fly's proxy hop so the limiter keys on the real
// client IP, not the edge. Limits chosen well above the legitimate daemon /
// browser cadence so a normal user never trips them.
app.set('trust proxy', 1);
const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many auth attempts; slow down.' },
});
const pairInitLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many pair-init requests; slow down.' },
});
const pairStatusLimiter = rateLimit({
  // Daemon polls every 2s during a ≤10-min window → ~300 polls/code worst
  // case. We allow 90/min per IP, plenty for one or two daemons, and well
  // below what brute-forcing a 12-char code would need.
  windowMs: 60_000,
  limit: 90,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many pair-status polls; slow down.' },
});

// ─── WS rate limiting (M10 B-5) ──────────────────────────────────────────────
//
// HTTP endpoints get express-rate-limit; the browser /ws send_prompt path
// had no equivalent. Per-(userId, sessionId) token bucket: 10 prompts of
// burst capacity, refilling at 10/min. Picks legit user pace (a few
// prompts a minute) without tripping; well below what a runaway script
// would generate. Server-side gate independent of any frontend throttling.
const PROMPT_BUCKET_CAPACITY = 10;
const PROMPT_BUCKET_REFILL_PER_SEC = 10 / 60; // 10 prompts/min sustained

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  /** Returns true and decrements if a token is available; false if rate-limited. */
  consume(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

const promptBuckets = new Map<string, TokenBucket>();
function checkPromptRate(userId: string, sessionId: string): boolean {
  const key = `${userId}:${sessionId}`;
  let b = promptBuckets.get(key);
  if (!b) {
    b = new TokenBucket(PROMPT_BUCKET_CAPACITY, PROMPT_BUCKET_REFILL_PER_SEC);
    promptBuckets.set(key, b);
  }
  return b.consume();
}
function dropPromptBucket(userId: string, sessionId: string): void {
  promptBuckets.delete(`${userId}:${sessionId}`);
}

// GitHub OAuth
app.get('/auth/github', authLimiter, startOAuthLogin);
app.get('/auth/github/callback', authLimiter, handleOAuthCallback);
// POST-only: a GET endpoint is trivially CSRF-able via `<img src="…/logout">`
// from any third-party page (cookie auth, SameSite=Lax). The frontend now
// posts via fetch with credentials.
app.post('/auth/logout', logout);

// Device pairing
app.post('/api/device/pair-init', pairInitLimiter, pairInit);
app.get('/api/device/pair-status', pairStatusLimiter, pairStatus);
app.get('/api/device/pair-lookup', requireAuth as any, pairLookup as any);
app.post('/api/device/pair-approve', requireAuth as any, pairApprove as any);
app.delete('/api/device/:id', requireAuth as any, ((req: any, res: any) => {
  const id = String(req.params.id ?? '');
  const userId = req.user.id as string;
  if (!id) {
    res.status(400).json({ error: 'missing id' });
    return;
  }
  const r = stmts.deleteDeviceTokenForUser.run(id, userId);
  if (r.changes === 0) {
    // Either id is bogus or it belongs to another user. Don't distinguish:
    // disclosing "exists but not yours" lets a logged-in user probe for
    // valid device ids across the whole table.
    res.status(404).json({ error: 'device not found' });
    return;
  }
  devices.terminate(id);
  broadcastDevices(userId);
  res.status(204).end();
}) as any);

// SPA fallback: any non-API GET serves index.html so client-side routing
// (e.g. /pair?code=...) works on hard refresh.
if (existsSync(distWeb)) {
  app.get(/^\/(?!api|auth|assets|ws|client).*/, (_req, res) => {
    res.sendFile(path.join(distWeb, 'index.html'));
  });
}

const httpServer = createServer(app);

// ─── WebSocket endpoints ─────────────────────────────────────────────────────
//
//   /ws     — browser UI (cookie-gated)
//   /client — local daemon (Bearer-device-token-gated)

// 1 MB cap is comfortably above any real prompt or daemon message we send;
// without it ws defaults to 100 MB which lets a single frame OOM the Fly VM.
const WS_MAX_PAYLOAD = 1 << 20;
const browserWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });
const clientWss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (url === '/ws' || url.startsWith('/ws?')) {
    // CSWSH defence: browsers always send Origin on a WebSocket handshake.
    // The /client endpoint below is reached by the Go daemon (no Origin header)
    // so this check is intentionally scoped to /ws only.
    const origin = req.headers.origin as string | undefined;
    if (!isAllowedOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const userId = userIdFromCookie(req.headers.cookie);
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any)._userId = userId;
      browserWss.emit('connection', ws, req);
    });
  } else if (url === '/client' || url.startsWith('/client?')) {
    const auth = (req.headers['authorization'] ?? '') as string;
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const token = m?.[1];
    // Dev-mode fallback: if auth isn't configured, accept any (or no) token
    // and bind to the anonymous user.
    let userId: string | undefined;
    let deviceTokenId: string | undefined;
    if (!isAuthEnabled()) {
      userId = 'anon';
      // Anon dev mode has no token; use a fixed synthetic id so the registry
      // entry is still stable across reconnects.
      deviceTokenId = 'anon-default';
    } else if (token) {
      const row = verifyDeviceToken(token);
      if (row) {
        stmts.touchDeviceToken.run(Date.now(), row.id);
        userId = row.user_id;
        deviceTokenId = row.id;
      }
    }
    if (!userId || !deviceTokenId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    clientWss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any)._userId = userId;
      (ws as any)._deviceTokenId = deviceTokenId;
      clientWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ─── Devices (local daemons) ─────────────────────────────────────────────────

const devices = new DeviceRegistry();

clientWss.on('connection', (ws, req) => {
  const remoteAddr = req.socket.remoteAddress ?? 'unknown';
  const userId = (ws as any)._userId as string;
  const deviceTokenId = (ws as any)._deviceTokenId as string;
  let deviceId: string | undefined;
  let helloReceived = false;

  console.log(`[client] connection from ${remoteAddr} (user=${userId})`);

  const helloTimer = setTimeout(() => {
    if (!helloReceived) {
      console.warn('[client] no hello within 10s — closing');
      ws.close(4000, 'hello timeout');
    }
  }, 10_000);

  ws.on('message', (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Pre-hello: only accept a valid `hello` frame. Anything else
    // (including malformed hello) is silently dropped; the hello timeout
    // closes the socket if a valid hello doesn't arrive in 10s.
    if (!helloReceived) {
      const helloResult = DeviceHelloMessageSchema.safeParse(parsed);
      if (!helloResult.success) {
        console.warn(
          `[client] rejected pre-hello frame from ${remoteAddr}: ${helloResult.error.message}`,
        );
        return;
      }
      helloReceived = true;
      clearTimeout(helloTimer);
      // Strip the wire-level `type` discriminator before handing to the
      // registry; DeviceHello is the in-memory shape and doesn't carry it.
      const { type: _t, ...hello } = helloResult.data;
      const device = devices.register(deviceTokenId, ws, userId, hello, remoteAddr);
      deviceId = device.id;
      console.log(
        `[client] device registered: ${hello.displayName ?? hello.hostname} (${hello.os}/${hello.arch}) — agents=${
          hello.agents.map((a) => a.name).join(',') || 'none'
        } [user=${userId}]`,
      );
      broadcastDevices(userId);
      return;
    }

    // Post-hello: validate against the daemon→server union. Anything that
    // doesn't match is dropped with a log line — a buggy or hostile
    // daemon can't spoof `role: 'user'` to inject fake history, oversize
    // a single text payload past the cap, or exfiltrate by stuffing
    // dir-listing entries.
    const msgResult = DaemonClientMessageSchema.safeParse(parsed);
    if (!msgResult.success) {
      console.warn(
        `[client] rejected daemon message from device=${deviceId}: ${msgResult.error.message}`,
      );
      return;
    }
    const msg = msgResult.data;

    if (!deviceId) return; // post-hello guarantees this, but TS doesn't know

    if (
      msg.type === 'daemon_message' ||
      msg.type === 'daemon_permission_request' ||
      msg.type === 'daemon_done'
    ) {
      devices.dispatchDaemonMessage(deviceId, msg as DaemonClientMessage);
      return;
    }

    // Dir listings ride a separate per-request map rather than the
    // RemoteRunner dispatch; they're not tied to a session/runId.
    if (msg.type === 'daemon_dir_listing') {
      const pending = pendingDirListings.get(msg.requestId);
      if (!pending) return;
      // Cross-tenant guard: a daemon may only resolve listings that were
      // initiated by a browser of the same user. Without this, any daemon
      // could brute-force the 6-char requestId space and inject fake
      // directory entries into another user's picker.
      if (pending.userId !== userId) return;
      pendingDirListings.delete(msg.requestId);
      send(pending.ws, {
        type: 'dir_listing',
        requestId: msg.requestId,
        path: msg.path,
        parent: msg.parent,
        entries: msg.entries,
        error: msg.error,
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (deviceId) {
      // Pass ws so we don't accidentally drop a newer connection that
      // replaced us in register() (see DeviceRegistry.unregister).
      devices.unregister(deviceId, ws);
      console.log(`[client] device disconnected: ${deviceId}`);
      broadcastDevices(userId);
    } else {
      console.log(`[client] disconnected before hello (${remoteAddr})`);
    }
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25_000);
  ws.on('close', () => clearInterval(pingTimer));
});

// ─── Browser UI ──────────────────────────────────────────────────────────────

const browsers = new Map<string, Set<WebSocket>>(); // userId → connected browser sockets

function addBrowser(userId: string, ws: WebSocket) {
  let set = browsers.get(userId);
  if (!set) {
    set = new Set();
    browsers.set(userId, set);
  }
  set.add(ws);
}
function removeBrowser(userId: string, ws: WebSocket) {
  const set = browsers.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) browsers.delete(userId);
}
function broadcastToUser(userId: string, msg: ServerMessage) {
  const set = browsers.get(userId);
  if (!set) return;
  const json = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(json);
}

// ─── Directory browsing ──────────────────────────────────────────────────────
// Map browser-issued requestId → browser ws so daemon_dir_listing can route
// back to the right tab. TTL'd so a misbehaving daemon (or one running an
// older binary that doesn't know daemon_list_dir) can't hang the picker
// forever — we emit a timeout error back to the browser when sweeping.
const DIR_LISTING_TTL_MS = 5_000;
interface PendingDirListing {
  ws: WebSocket;
  // userId of the browser that initiated the listing. We check this
  // against the daemon's userId when a daemon_dir_listing comes back, so
  // a malicious user's daemon can't brute-force requestIds and inject
  // cross-tenant directory entries into someone else's picker.
  userId: string;
  path: string;
  expiresAt: number;
}
const pendingDirListings = new Map<string, PendingDirListing>();
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pendingDirListings) {
    if (p.expiresAt >= now) continue;
    pendingDirListings.delete(id);
    send(p.ws, {
      type: 'dir_listing',
      requestId: id,
      path: p.path,
      entries: [],
      error: 'Daemon did not respond. Upgrade vvibe (`vvibe upgrade`) and retry.',
    });
  }
}, 1_000).unref();

async function listLocalDir(rawPath: string): Promise<{
  path: string;
  parent?: string;
  entries: { name: string; isDir: boolean }[];
  error?: string;
}> {
  let p = rawPath;
  if (!p) p = os.homedir();
  else if (!path.isAbsolute(p)) return { path: p, entries: [], error: 'path must be absolute' };
  p = path.resolve(p);
  try {
    const items = await readdir(p, { withFileTypes: true });
    const entries = items
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, isDir: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parentDir = path.dirname(p);
    return { path: p, parent: parentDir === p ? undefined : parentDir, entries };
  } catch (err) {
    return { path: p, entries: [], error: (err as Error).message };
  }
}

/**
 * Resolve a pinned-device label for the UI. Prefer the live displayName from
 * the registry (most up-to-date — user may have renamed) and fall back to the
 * device_tokens.display_name for offline devices. Returns undefined for
 * unknown ids so the UI can render "pinned (unknown)" or similar.
 */
function pinnedDeviceLabel(deviceId: string | undefined): string | undefined {
  if (!deviceId) return undefined;
  const live = devices.get(deviceId);
  if (live) return live.displayName ?? live.hostname;
  const row = stmts.findDeviceLabelById.get(deviceId);
  return row?.display_name ?? undefined;
}

function metaWithDevice(s: { meta(): import('../shared/types.ts').SessionMeta }) {
  const m = s.meta();
  m.preferredDeviceLabel = pinnedDeviceLabel(m.preferredDeviceId);
  return m;
}

function deviceInfo(userId: string): DeviceInfo[] {
  return devices.listForUser(userId).map((d) => ({
    id: d.id,
    hostname: d.hostname,
    displayName: d.displayName,
    os: d.os,
    arch: d.arch,
    version: d.version,
    agents: d.agents,
    connectedAt: d.connectedAt,
  }));
}

function broadcastDevices(userId: string) {
  broadcastToUser(userId, { type: 'devices', devices: deviceInfo(userId) });
}

const store = new SessionStore(
  {
    onMeta: (s) => broadcastToUser(s.userId, { type: 'session_updated', session: metaWithDevice(s) }),
    onMessage: (m) => {
      // Locate session to find the user it belongs to.
      const s = store.get(m.sessionId);
      if (s) broadcastToUser(s.userId, { type: 'message', message: m });
    },
    onPermissionRequest: (r) => {
      const s = store.get(r.sessionId);
      if (s) broadcastToUser(s.userId, { type: 'permission_request', request: r });
    },
    onPermissionResolved: (sid, rid) => {
      const s = store.get(sid);
      if (s)
        broadcastToUser(s.userId, { type: 'permission_resolved', sessionId: sid, requestId: rid });
    },
    onError: (sid, err) => {
      const s = store.get(sid);
      if (s) broadcastToUser(s.userId, { type: 'error', sessionId: sid, error: err });
    },
  },
  makeRunnerFactory(devices),
);
store.rehydrate();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function isValidCwd(cwd: string): boolean {
  try {
    return existsSync(cwd) && statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

browserWss.on('connection', (ws) => {
  const userId = (ws as any)._userId as string;
  addBrowser(userId, ws);

  send(ws, { type: 'hello', defaultCwd: DEFAULT_CWD });
  send(ws, { type: 'devices', devices: deviceInfo(userId) });
  const userSessions = store.listForUser(userId);
  send(ws, { type: 'sessions', sessions: userSessions.map((s) => metaWithDevice(s)) });
  for (const s of userSessions) {
    for (const m of s.history) send(ws, { type: 'message', message: m });
  }

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', error: 'Invalid JSON' });
      return;
    }
    handleClientMessage(ws, userId, msg).catch((err) => {
      send(ws, { type: 'error', error: (err as Error).message });
    });
  });

  ws.on('close', () => removeBrowser(userId, ws));
});

async function handleClientMessage(ws: WebSocket, userId: string, msg: ClientMessage) {
  switch (msg.type) {
    case 'list_sessions':
      send(ws, { type: 'sessions', sessions: store.listForUser(userId).map((s) => metaWithDevice(s)) });
      return;
    case 'create_session': {
      // Codex has no in-UI permission flow yet (M5 P1 will add it). Until then
      // the operator must consciously vouch for their daemon's CODEX_ARGS
      // (e.g. `--sandbox read-only --ask-for-approval on-request`) by setting
      // CODEX_TRUST_DEFAULTS=1 on the server. The daemon enforces the same
      // gate independently before spawning.
      if (msg.agent === 'codex' && process.env.CODEX_TRUST_DEFAULTS !== '1') {
        send(ws, {
          type: 'error',
          error:
            'Codex agent is disabled by default. The operator must configure ' +
            'CODEX_ARGS on the daemon and set CODEX_TRUST_DEFAULTS=1 on the ' +
            'server to opt in. See README.',
        });
        return;
      }
      // Only validate cwd against the server filesystem when there's no
      // daemon connected for this user — remote daemon paths live on the
      // user's machine, not the server.
      const hasDaemon = devices.listForUser(userId).length > 0;
      if (!hasDaemon && !isValidCwd(msg.cwd)) {
        send(ws, { type: 'error', error: `Directory does not exist: ${msg.cwd}` });
        return;
      }
      // If the browser pinned a device, verify it belongs to this user before
      // persisting. We keep the value even if the device is currently offline:
      // RemoteRunner will fall back to first-connected at send() time.
      let preferredDeviceId: string | undefined;
      if (msg.deviceId) {
        const d = devices.get(msg.deviceId);
        if (!d || d.userId !== userId) {
          send(ws, { type: 'error', error: 'Unknown device.' });
          return;
        }
        preferredDeviceId = msg.deviceId;
      }
      const s = store.create({
        userId,
        agent: msg.agent,
        cwd: msg.cwd,
        title: msg.title,
        preferredDeviceId,
        // Whitelisted to current Claude family — anything outside this set is
        // dropped to undefined (= SDK default). Stops a malicious client from
        // passing arbitrary strings into the SDK's model option.
        model: msg.agent === 'claude' && isAllowedClaudeModel(msg.model) ? msg.model : undefined,
      });
      send(ws, { type: 'session_created', session: metaWithDevice(s) });
      return;
    }
    case 'send_prompt': {
      const s = mustSession(ws, userId, msg.sessionId);
      if (!s) return;
      if (!checkPromptRate(userId, msg.sessionId)) {
        send(ws, {
          type: 'error',
          sessionId: msg.sessionId,
          error: 'Too many prompts on this session; slow down (10/min).',
        });
        return;
      }
      s.enqueuePrompt(msg.prompt);
      return;
    }
    case 'permission_response': {
      const s = mustSession(ws, userId, msg.sessionId);
      if (!s) return;
      s.resolvePermission(msg.requestId, msg.allow);
      return;
    }
    case 'cancel': {
      const s = mustSession(ws, userId, msg.sessionId);
      if (!s) return;
      s.cancel();
      return;
    }
    case 'cancel_all': {
      // Emergency brake: cancel every session of this user that's actively
      // burning tokens. Cheap to call when nothing is running. Server-side
      // gate against "I went to lunch and an agent looped" / "I think my
      // tab was hijacked" scenarios.
      let cancelled = 0;
      for (const s of store.listForUser(userId)) {
        const st = s.meta().status;
        if (st === 'running' || st === 'awaiting_permission') {
          s.cancel();
          cancelled++;
        }
      }
      send(ws, { type: 'cancel_all_ack', cancelled });
      return;
    }
    case 'delete_session': {
      const s = store.getForUser(msg.sessionId, userId);
      if (!s) return;
      if (store.delete(msg.sessionId)) {
        dropPromptBucket(userId, msg.sessionId);
        broadcastToUser(userId, { type: 'session_deleted', sessionId: msg.sessionId });
      }
      return;
    }
    case 'list_dir': {
      // Route order:
      //   1. Explicit deviceId → forward to that daemon (after ownership check)
      //   2. Any of the user's daemons connected → forward to the first
      //   3. Anon dev mode without daemons → server-side fs (we want this for
      //      `npm run dev` single-user workflows)
      //   4. Authed user without daemons → error. Falling through to local fs
      //      would let users browse the prod server's container fs, which
      //      isn't useful and is a small leak surface.
      const target = msg.deviceId ? devices.get(msg.deviceId) : devices.pickRunner(userId);
      if (msg.deviceId && (!target || target.userId !== userId)) {
        send(ws, {
          type: 'dir_listing',
          requestId: msg.requestId,
          path: msg.path,
          entries: [],
          error: 'Unknown device.',
        });
        return;
      }
      if (target) {
        pendingDirListings.set(msg.requestId, {
          ws,
          userId,
          path: msg.path,
          expiresAt: Date.now() + DIR_LISTING_TTL_MS,
        });
        const ok = devices.sendToDevice(target.id, {
          type: 'daemon_list_dir',
          requestId: msg.requestId,
          path: msg.path,
        });
        if (!ok) {
          pendingDirListings.delete(msg.requestId);
          send(ws, {
            type: 'dir_listing',
            requestId: msg.requestId,
            path: msg.path,
            entries: [],
            error: 'Daemon disconnected.',
          });
        }
        return;
      }
      if (userId !== 'anon') {
        send(ws, {
          type: 'dir_listing',
          requestId: msg.requestId,
          path: msg.path,
          entries: [],
          error: 'No daemon connected. Pair a device first.',
        });
        return;
      }
      const local = await listLocalDir(msg.path);
      send(ws, { type: 'dir_listing', requestId: msg.requestId, ...local });
      return;
    }
  }
}

function mustSession(ws: WebSocket, userId: string, id: string): Session | undefined {
  const s = store.getForUser(id, userId);
  if (!s) send(ws, { type: 'error', sessionId: id, error: `Unknown session: ${id}` });
  return s;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, HOST, () => {
  console.log(`agent-web-mvp listening on http://${HOST}:${PORT}`);
  console.log(`  browser ws: ws://${HOST}:${PORT}/ws`);
  console.log(`  client ws:  ws://${HOST}:${PORT}/client (Bearer device-token)`);
  console.log(`  auth: ${isAuthEnabled() ? 'GitHub OAuth' : 'DISABLED (dev mode, single anon user)'}`);
  console.log(`  allowed origins: ${[...ALLOWED_ORIGINS].join(', ')}`);
  console.log(`  default cwd: ${DEFAULT_CWD}`);
  if (!existsSync(distWeb)) {
    console.log('  (no built frontend found — run `npm run dev:web` for Vite dev server)');
  }
});
