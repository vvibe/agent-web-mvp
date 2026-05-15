import { randomUUID } from 'node:crypto';
import type {
  AgentKind,
  ChatMessage,
  PermissionRequest,
  SessionMeta,
  SessionStatus,
} from '../shared/types.ts';
import type { AgentEvents, AgentRunner } from './agents/base.ts';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';
import { RemoteRunner } from './agents/remote.ts';
import type { DeviceRegistry } from './devices.ts';

export type RunnerFactory = (
  userId: string,
  agent: AgentKind,
  cwd: string,
  events: AgentEvents,
) => AgentRunner;

/**
 * Build a runner factory that prefers a connected daemon for the given user,
 * falling back to a local in-server runner when none is available. Daemons
 * belonging to other users are ignored.
 */
export function makeRunnerFactory(devices: DeviceRegistry): RunnerFactory {
  return (userId, agent, cwd, events) => {
    // Prefer remote even if no daemon is currently connected for this user —
    // they may be about to start one. RemoteRunner re-resolves the device on
    // each send(), so an empty per-user registry just yields a graceful "no
    // daemon" error for the first prompt and recovers as soon as a daemon
    // shows up.
    if (devices.listForUser(userId).length > 0) {
      return new RemoteRunner(userId, agent, cwd, devices, events);
    }
    return agent === 'claude' ? new ClaudeRunner(cwd, events) : new CodexRunner(cwd, events);
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

  private runner: AgentRunner;
  private pending = new Map<string, PendingPermission>();
  private queue: string[] = [];
  private busy = false;
  // Set briefly while cancel() is in flight so onError can distinguish a
  // user-initiated abort (= idle) from a real runtime failure (= error).
  private cancelling = false;

  constructor(
    opts: { userId: string; agent: AgentKind; cwd: string; title?: string },
    private events: SessionEvents,
    makeRunner: RunnerFactory,
  ) {
    this.id = randomUUID();
    this.userId = opts.userId;
    this.agent = opts.agent;
    this.cwd = opts.cwd;
    this.title = opts.title?.trim() || defaultTitle(opts.agent, opts.cwd);
    this.createdAt = Date.now();

    const agentEvents = {
      onMessage: (m: Omit<ChatMessage, 'id' | 'sessionId' | 'ts'>) => this.recordMessage(m),
      onPermissionRequest: (r: { toolName: string; input: unknown }) => this.askPermission(r),
      onError: (err: Error) => {
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
    };

    this.runner = makeRunner(opts.userId, opts.agent, this.cwd, agentEvents);
  }

  meta(): SessionMeta {
    return {
      id: this.id,
      agent: this.agent,
      cwd: this.cwd,
      title: this.title,
      status: this.status,
      createdAt: this.createdAt,
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
    await this.runner.send(next);
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

  create(opts: { userId: string; agent: AgentKind; cwd: string; title?: string }): Session {
    const s = new Session(opts, this.events, this.makeRunner);
    this.sessions.set(s.id, s);
    this.events.onMeta(s);
    return s;
  }

  delete(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.cancel();
    this.sessions.delete(id);
    return true;
  }
}
