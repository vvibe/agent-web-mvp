import { randomUUID } from 'node:crypto';
import type {
  AgentKind,
  ChatMessage,
  PermissionRequest,
  SessionMeta,
  SessionStatus,
} from '../shared/types.ts';
import type { AgentEvents, AgentRunner } from './agents/base.ts';
import type { AgentMessageRow, AgentSessionRow } from './db.ts';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';
import { RemoteRunner } from './agents/remote.ts';
import type { DeviceRegistry } from './devices.ts';
import { stmts } from './db.ts';

export type RunnerFactory = (
  userId: string,
  agent: AgentKind,
  cwd: string,
  events: AgentEvents,
  preferredDeviceId: string | undefined,
) => AgentRunner;

/**
 * Build a runner factory:
 *   - Authed users (anything except 'anon'): always RemoteRunner. The runner
 *     re-resolves the daemon on each send(), so it's safe to create the
 *     session before the daemon has connected. This also matters at boot:
 *     rehydrated sessions are constructed before any daemon WS reconnects.
 *   - Anonymous (dev mode without OAuth): fall back to local in-server
 *     runners so `npm run dev` keeps working single-user.
 */
export function makeRunnerFactory(devices: DeviceRegistry): RunnerFactory {
  return (userId, agent, cwd, events, preferredDeviceId) => {
    if (userId === 'anon') {
      return agent === 'claude' ? new ClaudeRunner(cwd, events) : new CodexRunner(cwd, events);
    }
    return new RemoteRunner(userId, agent, cwd, devices, events, preferredDeviceId);
  };
}

interface PendingPermission {
  resolve: (allow: boolean) => void;
}

export interface SessionEvents {
  onMeta: (session: Session) => void;
  onMessage: (msg: ChatMessage) => void;
  onPermissionRequest: (req: PermissionRequest) => void;
  onPermissionResolved: (sessionId: string, requestId: string) => void;
  onError: (sessionId: string, error: string) => void;
}

export class Session {
  readonly id: string;
  readonly userId: string;
  readonly agent: AgentKind;
  cwd: string;
  title: string;
  status: SessionStatus = 'idle';
  createdAt: number;
  history: ChatMessage[] = [];
  /** Latest resume token reported by the runner; persisted across restart. */
  resumeToken: string | undefined;
  /** Device the session is pinned to (RemoteRunner falls back to first
   *  connected if it's offline). Undefined = no pin. */
  preferredDeviceId: string | undefined;

  private runner: AgentRunner;
  private pending = new Map<string, PendingPermission>();
  private queue: string[] = [];
  private busy = false;
  // Set briefly while cancel() is in flight so onError can distinguish a
  // user-initiated abort (= idle) from a real runtime failure (= error).
  private cancelling = false;

  constructor(
    opts: {
      id?: string;
      userId: string;
      agent: AgentKind;
      cwd: string;
      title?: string;
      createdAt?: number;
      resumeToken?: string;
      preferredDeviceId?: string;
      history?: ChatMessage[];
    },
    private events: SessionEvents,
    makeRunner: RunnerFactory,
  ) {
    this.id = opts.id ?? randomUUID();
    this.userId = opts.userId;
    this.agent = opts.agent;
    this.cwd = opts.cwd;
    this.title = opts.title?.trim() || defaultTitle(opts.agent, opts.cwd);
    this.createdAt = opts.createdAt ?? Date.now();
    this.resumeToken = opts.resumeToken;
    this.preferredDeviceId = opts.preferredDeviceId;
    if (opts.history) this.history = opts.history;

    const agentEvents: AgentEvents = {
      onMessage: (m) => this.recordMessage(m),
      onPermissionRequest: (r) => this.askPermission(r),
      onError: (err) => {
        if (this.cancelling) {
          // Expected: SDK threw because we aborted. Don't paint the session red.
          this.recordMessage({ role: 'system', text: 'Cancelled.' });
          return;
        }
        this.setStatus('error');
        this.events.onError(this.id, err.message);
        this.recordMessage({ role: 'system', text: `Error: ${err.message}` });
      },
      onDone: () => {
        if (this.status !== 'error') this.setStatus('idle');
        this.busy = false;
        this.cancelling = false;
        this.drainQueue();
      },
      onResumeToken: (token) => {
        if (token === this.resumeToken) return;
        this.resumeToken = token;
        stmts.updateAgentSessionResumeToken.run(token, this.id);
      },
    };

    this.runner = makeRunner(opts.userId, opts.agent, this.cwd, agentEvents, this.preferredDeviceId);
  }

  meta(): SessionMeta {
    return {
      id: this.id,
      agent: this.agent,
      cwd: this.cwd,
      title: this.title,
      status: this.status,
      createdAt: this.createdAt,
      preferredDeviceId: this.preferredDeviceId,
    };
  }

  enqueuePrompt(prompt: string) {
    this.recordMessage({ role: 'user', text: prompt });
    this.queue.push(prompt);
    this.drainQueue();
  }

  resolvePermission(requestId: string, allow: boolean) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    p.resolve(allow);
    this.events.onPermissionResolved(this.id, requestId);
    if (this.pending.size === 0 && this.status === 'awaiting_permission') {
      this.setStatus('running');
    }
  }

  cancel() {
    this.cancelling = true;
    this.runner.cancel();
    for (const [id, p] of this.pending) {
      p.resolve(false);
      this.events.onPermissionResolved(this.id, id);
    }
    this.pending.clear();
    this.queue.length = 0;
  }

  // ─── internal ─────────────────────────────────────────────────────────────

  private async drainQueue() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    this.setStatus('running');
    await this.runner.send(next, this.resumeToken);
  }

  private askPermission(req: { toolName: string; input: unknown }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve });
      this.setStatus('awaiting_permission');
      this.events.onPermissionRequest({
        requestId,
        sessionId: this.id,
        toolName: req.toolName,
        input: req.input,
      });
    });
  }

  private recordMessage(m: Omit<ChatMessage, 'id' | 'sessionId' | 'ts'>) {
    const full: ChatMessage = {
      id: randomUUID(),
      sessionId: this.id,
      ts: Date.now(),
      ...m,
    };
    this.history.push(full);
    stmts.insertAgentMessage.run(
      full.id,
      full.sessionId,
      full.role,
      full.text,
      full.meta ? JSON.stringify(full.meta) : null,
      full.ts,
    );
    this.events.onMessage(full);
  }

  private setStatus(s: SessionStatus) {
    if (this.status === s) return;
    this.status = s;
    this.events.onMeta(this);
  }
}

function defaultTitle(agent: AgentKind, cwd: string): string {
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
  return `${agent} · ${folder}`;
}

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private events: SessionEvents, private makeRunner: RunnerFactory) {}

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Sessions belonging to a specific user. */
  listForUser(userId: string): Session[] {
    return this.list().filter((s) => s.userId === userId);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Resolve a session that belongs to `userId`. Returns undefined if the
   * session doesn't exist OR belongs to someone else. The two cases are
   * deliberately conflated so a caller can't probe for session ids that
   * aren't theirs.
   */
  getForUser(id: string, userId: string): Session | undefined {
    const s = this.sessions.get(id);
    return s && s.userId === userId ? s : undefined;
  }

  create(opts: {
    userId: string;
    agent: AgentKind;
    cwd: string;
    title?: string;
    preferredDeviceId?: string;
  }): Session {
    const s = new Session(opts, this.events, this.makeRunner);
    // Persist BEFORE the in-memory commit so a FK violation or any other DB
    // error doesn't leave a phantom session in memory that fails on reload.
    stmts.insertAgentSession.run(
      s.id,
      s.userId,
      s.agent,
      s.cwd,
      s.title,
      s.preferredDeviceId ?? null,
      s.createdAt,
    );
    this.sessions.set(s.id, s);
    this.events.onMeta(s);
    return s;
  }

  delete(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.cancel();
    this.sessions.delete(id);
    stmts.deleteAgentSession.run(id);
    return true;
  }

  /**
   * Load all persisted sessions from the database and reconstruct in-memory
   * Session objects with their full history. Run once at server start, BEFORE
   * accepting browser connections. All sessions come back in 'idle' status —
   * any in-flight runs that were interrupted by the restart are lost; the
   * user just re-sends the prompt and Claude's resumeToken continues context.
   */
  rehydrate(): void {
    const rows: AgentSessionRow[] = stmts.listAgentSessions.all();
    for (const row of rows) {
      const msgRows: AgentMessageRow[] = stmts.listAgentMessagesBySession.all(row.id);
      const history: ChatMessage[] = msgRows.map((m) => ({
        id: m.id,
        sessionId: m.session_id,
        ts: m.ts,
        role: m.role as ChatMessage['role'],
        text: m.text,
        meta: m.meta ? safeParseJSON(m.meta) : undefined,
      }));
      const s = new Session(
        {
          id: row.id,
          userId: row.user_id,
          agent: row.agent as AgentKind,
          cwd: row.cwd,
          title: row.title,
          createdAt: row.created_at,
          resumeToken: row.resume_token ?? undefined,
          preferredDeviceId: row.preferred_device_id ?? undefined,
          history,
        },
        this.events,
        this.makeRunner,
      );
      this.sessions.set(s.id, s);
    }
    if (rows.length > 0) {
      console.log(`[sessions] rehydrated ${rows.length} session${rows.length === 1 ? '' : 's'}`);
    }
  }
}

function safeParseJSON(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
