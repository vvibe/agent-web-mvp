import { randomUUID } from 'node:crypto';
import type {
  AgentKind,
  AuthRequiredInfo,
  ChatMessage,
  PermissionRequest,
  SessionMeta,
  SessionStatus,
} from '../shared/types.ts';
import { detectAuthRequired } from '../shared/types.ts';
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
  model: string | undefined,
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
  return (userId, agent, cwd, events, preferredDeviceId, model) => {
    if (userId === 'anon') {
      return agent === 'claude' ? new ClaudeRunner(cwd, events, model) : new CodexRunner(cwd, events);
    }
    return new RemoteRunner(userId, agent, cwd, devices, events, preferredDeviceId, model);
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
  onAuthRequired: (sessionId: string, info: AuthRequiredInfo) => void;
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
  /** Claude model id (e.g. 'claude-sonnet-4-6'); undefined = SDK default
   *  (currently Opus 4.7 under the claude_code preset). Ignored for Codex. */
  model: string | undefined;

  private runner: AgentRunner;
  private pending = new Map<string, PendingPermission>();
  private queue: string[] = [];
  private busy = false;
  // Set briefly while cancel() is in flight so onError can distinguish a
  // user-initiated abort (= idle) from a real runtime failure (= error).
  private cancelling = false;
  // The prompt currently in flight with the runner. Kept so the stale-
  // resume auto-recovery path can re-run it as a fresh conversation
  // without asking the user to retype. Cleared on done.
  private inFlightPrompt: string | null = null;
  // True once we've already auto-recovered from a stale Claude resume
  // token for *this* turn. Prevents an infinite loop if the retry also
  // fails (which would mean it's not a stale-token problem after all).
  // Reset when the runner reports a fresh resume token, so a session
  // that recovered once and ran successfully can still recover again
  // weeks later if the daemon machine is wiped a second time.
  private staleResumeRetried = false;
  // Per-turn latch: a single "not logged in" failure typically surfaces
  // BOTH as stderr (system message) AND as the final error. We want one
  // modal, not two. Reset on every fresh prompt.
  private authAlertedThisTurn = false;

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
      model?: string;
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
    this.model = opts.model;
    if (opts.history) this.history = opts.history;

    const agentEvents: AgentEvents = {
      onMessage: (m) => {
        // Codex pipes stderr through as a system message rather than as an
        // Error, so the auth check has to run here too — not just in onError.
        if (m.role === 'system' && !this.authAlertedThisTurn) {
          const hit = detectAuthRequired(m.text, this.agent);
          if (hit) {
            this.authAlertedThisTurn = true;
            this.emitAuthRequired(hit);
          }
        }
        this.recordMessage(m);
      },
      onPermissionRequest: (r) => this.askPermission(r),
      onError: (err) => {
        if (this.cancelling) {
          // Expected: SDK threw because we aborted. Don't paint the session red.
          this.recordMessage({ role: 'system', text: 'Cancelled.' });
          return;
        }
        // Auth-required interception. We replace the raw "Not logged in ·
        // Please run /login" error with a friendlier system message and an
        // auth_required event for the UI modal. Run BEFORE the stale-resume
        // recovery so a misconfigured auth state can't masquerade as a stale
        // session and trigger a retry loop.
        if (!this.authAlertedThisTurn) {
          const hit = detectAuthRequired(err.message, this.agent);
          if (hit) {
            this.authAlertedThisTurn = true;
            this.setStatus('error');
            this.emitAuthRequired(hit);
            // "This machine" is unambiguous for anon (server + agent are co-
            // located) but misleading for the daemon path — the user might
            // be viewing from a phone while the daemon runs on a desktop.
            const where = this.userId === 'anon' ? 'on this machine' : 'on the daemon machine';
            this.recordMessage({
              role: 'system',
              text: `${this.agent} CLI is not signed in ${where}. Run \`${hit.fixCommand}\` there and retry.`,
            });
            return;
          }
        }
        // Stale resume token recovery. Claude Code stores conversation
        // history locally on the daemon machine (~/.claude/projects/…)
        // and refuses to resume an ID that isn't there anymore. We see
        // this whenever the daemon machine got wiped, the user paired a
        // different machine, or Claude Code's local store was cleared.
        // Re-running the same prompt without a resume token starts a
        // fresh conversation — the user keeps working, just without the
        // earlier turns in context. Cheaper than making them re-create
        // the session, and the friendly system message tells them
        // exactly why their context just reset.
        if (
          !this.staleResumeRetried &&
          this.inFlightPrompt !== null &&
          isStaleResumeError(err.message)
        ) {
          this.staleResumeRetried = true;
          this.resumeToken = undefined;
          stmts.updateAgentSessionResumeToken.run(null, this.id);
          this.recordMessage({
            role: 'system',
            text: "Claude couldn't find this conversation on this device anymore. Re-running your last prompt from scratch — earlier messages above are kept for your reference but won't be in Claude's context.",
          });
          const replay = this.inFlightPrompt;
          this.inFlightPrompt = null;
          this.busy = false;
          // Front of queue so it runs before any other queued prompt.
          // enqueuePrompt would re-record the user message in history,
          // which we don't want — the original user bubble is still there.
          this.queue.unshift(replay);
          this.drainQueue();
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
        this.inFlightPrompt = null;
        this.drainQueue();
      },
      onResumeToken: (token) => {
        // A fresh token means the runner is happy again; future stale
        // errors (e.g. machine wiped a second time months from now)
        // should still be eligible for one round of auto-recovery.
        this.staleResumeRetried = false;
        if (token === this.resumeToken) return;
        this.resumeToken = token;
        stmts.updateAgentSessionResumeToken.run(token, this.id);
      },
    };

    this.runner = makeRunner(opts.userId, opts.agent, this.cwd, agentEvents, this.preferredDeviceId, this.model);
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
      model: this.model,
    };
  }

  enqueuePrompt(prompt: string) {
    // New user prompt = fresh chance. If they ran `claude /login` between
    // turns, we want to detect a *new* auth failure on this turn rather
    // than staying silent because we already alerted earlier.
    this.authAlertedThisTurn = false;
    this.recordMessage({ role: 'user', text: prompt });
    this.queue.push(prompt);
    this.drainQueue();
  }

  /** Re-run the last user prompt without recording a duplicate user bubble.
   *  Used by the auth-required modal's "I've logged in, retry" button.
   *  Returns true if a prompt was queued, false if there's no user message
   *  to retry (defensive — auth_required only ever fires after a failed
   *  user prompt, so this should always succeed in practice). */
  retryLastUserPrompt(): boolean {
    // Scan from the end — most chats are short and we don't expect this to
    // be hot, but linear-from-tail is the right shape regardless.
    let last: ChatMessage | undefined;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === 'user') { last = this.history[i]; break; }
    }
    if (!last) return false;
    this.authAlertedThisTurn = false;
    // Push to the FRONT so a queued retry runs before any unrelated prompts
    // the user may have typed before clicking retry. Same shape as the
    // stale-resume auto-recovery path above.
    this.queue.unshift(last.text);
    this.drainQueue();
    return true;
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
    // Keep the prompt around so onError can replay it without making
    // the user retype if Claude rejects a stale resume token.
    this.inFlightPrompt = next;
    await this.runner.send(next, this.resumeToken);
  }

  private emitAuthRequired(hit: { agent: AgentKind; fixCommand: string; rawError: string }): void {
    // Drop any resume token we captured during the failed turn. The SDK
    // emits an `init` system message (with a fresh session_id) before it
    // hits the auth check, so a failed-auth turn can still leave us with
    // a token pointing at a session that doesn't exist anywhere — once
    // the user fixes auth and clicks retry, that stale token would trip
    // the "no conversation found" auto-recovery path and surface a
    // confusing "Claude couldn't find this conversation" message even
    // though the retry would have worked fine without the token.
    if (this.resumeToken !== undefined) {
      this.resumeToken = undefined;
      stmts.updateAgentSessionResumeToken.run(null, this.id);
    }
    const info: AuthRequiredInfo = {
      agent: hit.agent,
      fixCommand: hit.fixCommand,
      rawError: hit.rawError,
      context: this.userId === 'anon' ? 'this-machine' : 'daemon-machine',
    };
    this.events.onAuthRequired(this.id, info);
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

// isStaleResumeError matches the SDK error that Claude Code emits when
// the daemon asks it to resume a session ID that no longer exists in
// the local ~/.claude/projects/ store. Surfaced verbatim through the
// claude-bridge as e.g. "Claude Code returned an error result: No
// conversation found with session ID: 9bda7a69-...".
//
// Matching on the human-readable substring is fragile vs. SDK upgrades
// but there is no error code on the wire today, and the SDK message
// is fairly stable. If this breaks, the failure mode is graceful: we
// fall through to the regular error path and the user sees the literal
// error — no worse than before this fix.
function isStaleResumeError(message: string): boolean {
  return /no conversation found with session id/i.test(message);
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
    model?: string;
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
      s.model ?? null,
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
          model: row.model ?? undefined,
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
