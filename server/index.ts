import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMessage, ServerMessage } from '../shared/types.ts';
import { SessionStore, makeRunnerFactory, type Session } from './sessions.ts';
import { DeviceRegistry, type DeviceHello } from './devices.ts';
import type { DaemonClientMessage } from '../shared/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? ''; // empty = accept any (single-user MVP)

const app = express();
app.use(express.json());

const distWeb = path.resolve(__dirname, '..', 'dist', 'web');
if (existsSync(distWeb)) {
  app.use(express.static(distWeb));
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultCwd: DEFAULT_CWD, devices: devices.list().length });
});

const httpServer = createServer(app);

// Two WebSocket endpoints:
//   /ws     — browser UI
//   /client — local daemon (agent-client)
const browserWss = new WebSocketServer({ noServer: true });
const clientWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (url === '/ws' || url.startsWith('/ws?')) {
    browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit('connection', ws, req));
  } else if (url === '/client' || url.startsWith('/client?')) {
    // Validate bearer token (if configured) before upgrading.
    if (CLIENT_TOKEN) {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== `Bearer ${CLIENT_TOKEN}`) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    clientWss.handleUpgrade(req, socket, head, (ws) => clientWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ─── Devices (local daemons) ──────────────────────────────────────────────────

const devices = new DeviceRegistry();

clientWss.on('connection', (ws, req) => {
  const remoteAddr = req.socket.remoteAddress ?? 'unknown';
  let deviceId: string | undefined;
  let helloReceived = false;

  console.log(`[client] connection from ${remoteAddr}`);

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
      const device = devices.register(ws, hello, remoteAddr);
      deviceId = device.id;
      console.log(
        `[client] device registered: ${hello.displayName ?? hello.hostname} (${hello.os}/${hello.arch}) — agents=${
          hello.agents?.map((a) => a.name).join(',') || 'none'
        }`,
      );
      return;
    }
    if (msg.type === 'echo_reply') {
      console.log('[client] echo_reply:', msg.data, '→', msg.ts);
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
    } else {
      console.log(`[client] disconnected before hello (${remoteAddr})`);
    }
  });

  // Keep the WS healthy with WS-level pings.
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25_000);
  ws.on('close', () => clearInterval(pingTimer));
});

// ─── Browser UI ───────────────────────────────────────────────────────────────

const browsers = new Set<WebSocket>();

function broadcast(msg: ServerMessage) {
  const json = JSON.stringify(msg);
  for (const ws of browsers) {
    if (ws.readyState === ws.OPEN) ws.send(json);
  }
}

const store = new SessionStore(
  {
    onMeta: (s) => broadcast({ type: 'session_updated', session: s.meta() }),
    onMessage: (m) => broadcast({ type: 'message', message: m }),
    onPermissionRequest: (r) => broadcast({ type: 'permission_request', request: r }),
    onPermissionResolved: (sid, rid) =>
      broadcast({ type: 'permission_resolved', sessionId: sid, requestId: rid }),
    onError: (sid, err) => broadcast({ type: 'error', sessionId: sid, error: err }),
  },
  makeRunnerFactory(devices),
);

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
  browsers.add(ws);

  send(ws, { type: 'hello', defaultCwd: DEFAULT_CWD });
  send(ws, { type: 'sessions', sessions: store.list().map((s) => s.meta()) });
  for (const s of store.list()) {
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
    handleClientMessage(ws, msg).catch((err) => {
      send(ws, { type: 'error', error: (err as Error).message });
    });
  });

  ws.on('close', () => browsers.delete(ws));
});

async function handleClientMessage(ws: WebSocket, msg: ClientMessage) {
  switch (msg.type) {
    case 'list_sessions':
      send(ws, { type: 'sessions', sessions: store.list().map((s) => s.meta()) });
      return;
    case 'create_session': {
      // Only validate cwd against the server filesystem when there's no
      // daemon connected — remote daemon paths live on the user's machine,
      // not the server.
      const hasDaemon = devices.list().length > 0;
      if (!hasDaemon && !isValidCwd(msg.cwd)) {
        send(ws, { type: 'error', error: `Directory does not exist: ${msg.cwd}` });
        return;
      }
      const s = store.create({ agent: msg.agent, cwd: msg.cwd, title: msg.title });
      send(ws, { type: 'session_created', session: s.meta() });
      return;
    }
    case 'send_prompt': {
      const s = mustSession(ws, msg.sessionId);
      if (!s) return;
      s.enqueuePrompt(msg.prompt);
      return;
    }
    case 'permission_response': {
      const s = mustSession(ws, msg.sessionId);
      if (!s) return;
      s.resolvePermission(msg.requestId, msg.allow);
      return;
    }
    case 'cancel': {
      const s = mustSession(ws, msg.sessionId);
      if (!s) return;
      s.cancel();
      return;
    }
    case 'delete_session': {
      if (store.delete(msg.sessionId)) {
        broadcast({ type: 'session_deleted', sessionId: msg.sessionId });
      }
      return;
    }
  }
}

function mustSession(ws: WebSocket, id: string): Session | undefined {
  const s = store.get(id);
  if (!s) send(ws, { type: 'error', sessionId: id, error: `Unknown session: ${id}` });
  return s;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, HOST, () => {
  console.log(`agent-web-mvp listening on http://${HOST}:${PORT}`);
  console.log(`  browser ws: ws://${HOST}:${PORT}/ws`);
  console.log(`  client ws:  ws://${HOST}:${PORT}/client${CLIENT_TOKEN ? ' (auth: Bearer)' : ' (no auth)'}`);
  console.log(`  default cwd: ${DEFAULT_CWD}`);
  if (!existsSync(distWeb)) {
    console.log('  (no built frontend found — run `npm run dev:web` for Vite dev server)');
  }
});
