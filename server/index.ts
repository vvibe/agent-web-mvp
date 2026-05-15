import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMessage, DaemonClientMessage, ServerMessage } from '../shared/types.ts';
import { SessionStore, makeRunnerFactory, type Session } from './sessions.ts';
import { DeviceRegistry, type DeviceHello } from './devices.ts';
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
import { pairInit, pairStatus, pairApprove, pairLookup } from './pairing.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(loadUser);

const distWeb = path.resolve(__dirname, '..', 'dist', 'web');
if (existsSync(distWeb)) {
  app.use(express.static(distWeb));
}

// ─── REST routes ─────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultCwd: DEFAULT_CWD, devices: devices.list().length });
});
app.get('/api/me', whoAmI);

// GitHub OAuth
app.get('/auth/github', startOAuthLogin);
app.get('/auth/github/callback', handleOAuthCallback);
app.post('/auth/logout', logout);
app.get('/auth/logout', logout); // browser convenience

// Device pairing
app.post('/api/device/pair-init', pairInit);
app.get('/api/device/pair-status', pairStatus);
app.get('/api/device/pair-lookup', requireAuth as any, pairLookup as any);
app.post('/api/device/pair-approve', requireAuth as any, pairApprove as any);

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

const browserWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (url === '/ws' || url.startsWith('/ws?')) {
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
    if (!isAuthEnabled()) {
      userId = 'anon';
    } else if (token) {
      const row = stmts.findDeviceToken.get(token);
      if (row) {
        stmts.touchDeviceToken.run(Date.now(), token);
        userId = row.user_id;
      }
    }
    if (!userId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    clientWss.handleUpgrade(req, socket, head, (ws) => {
      (ws as any)._userId = userId;
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
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!helloReceived && msg.type === 'hello') {
      helloReceived = true;
      clearTimeout(helloTimer);
      const hello = msg as DeviceHello & { type: string };
      const device = devices.register(ws, userId, hello, remoteAddr);
      deviceId = device.id;
      console.log(
        `[client] device registered: ${hello.displayName ?? hello.hostname} (${hello.os}/${hello.arch}) — agents=${
          hello.agents?.map((a) => a.name).join(',') || 'none'
        } [user=${userId}]`,
      );
      broadcastDevices(userId);
      return;
    }
    if (
      deviceId &&
      (msg.type === 'daemon_message' ||
        msg.type === 'daemon_permission_request' ||
        msg.type === 'daemon_done')
    ) {
      devices.dispatchDaemonMessage(deviceId, msg as DaemonClientMessage);
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (deviceId) {
      devices.unregister(deviceId);
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

function broadcastDevices(userId: string) {
  // Just retrigger a sessions update so the UI can re-fetch device list via
  // /api/me + WS. Simpler than a dedicated message until we add a devices
  // panel.
}

const store = new SessionStore(
  {
    onMeta: (s) => broadcastToUser(s.userId, { type: 'session_updated', session: s.meta() }),
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
  const userSessions = store.listForUser(userId);
  send(ws, { type: 'sessions', sessions: userSessions.map((s) => s.meta()) });
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
      send(ws, { type: 'sessions', sessions: store.listForUser(userId).map((s) => s.meta()) });
      return;
    case 'create_session': {
      // Only validate cwd against the server filesystem when there's no
      // daemon connected for this user — remote daemon paths live on the
      // user's machine, not the server.
      const hasDaemon = devices.listForUser(userId).length > 0;
      if (!hasDaemon && !isValidCwd(msg.cwd)) {
        send(ws, { type: 'error', error: `Directory does not exist: ${msg.cwd}` });
        return;
      }
      const s = store.create({ userId, agent: msg.agent, cwd: msg.cwd, title: msg.title });
      send(ws, { type: 'session_created', session: s.meta() });
      return;
    }
    case 'send_prompt': {
      const s = mustSession(ws, userId, msg.sessionId);
      if (!s) return;
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
    case 'delete_session': {
      const s = store.getForUser(msg.sessionId, userId);
      if (!s) return;
      if (store.delete(msg.sessionId)) {
        broadcastToUser(userId, { type: 'session_deleted', sessionId: msg.sessionId });
      }
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
  console.log(`  default cwd: ${DEFAULT_CWD}`);
  if (!existsSync(distWeb)) {
    console.log('  (no built frontend found — run `npm run dev:web` for Vite dev server)');
  }
});
