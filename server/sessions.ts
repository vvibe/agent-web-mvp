import { randomUUID } from 'node:crypto';
import type {
  AgentKind,
  ChatMessage,
  PermissionRequest,
  SessionMeta,
  SessionStatus,
} from '../shared/types.ts';
import type { AgentRunner } from './agents/base.ts';
import { ClaudeRunner } from './agents/claude.ts';
import { CodexRunner } from './agents/codex.ts';

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

  constructor(opts: { agent: AgentKind; cwd: string; title?: string }, private events: SessionEvents) {
    this.id = randomUUID();
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

    this.runner =
      opts.agent === 'claude'
        ? new ClaudeRunner(this.cwd, agentEvents)
        : new CodexRunner(this.cwd, agentEvents);
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

  constructor(private events: SessionEvents) {}

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  create(opts: { agent: AgentKind; cwd: string; title?: string }): Session {
    const s = new Session(opts, this.events);
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
