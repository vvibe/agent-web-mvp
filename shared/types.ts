export type AgentKind = 'claude' | 'codex';

export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'error' | 'ended';

export interface SessionMeta {
  id: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  /** Device this session is pinned to; runner falls back to any connected
   *  daemon if it's offline. Undefined = no pin (first-connected wins). */
  preferredDeviceId?: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  ts: number;
  role: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result';
  text: string;
  meta?: Record<string, unknown>;
}

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
}

/** Connected daemon as visible to the browser. */
export interface DeviceInfo {
  id: string;
  hostname: string;
  displayName?: string;
  os: string;
  arch: string;
  version: string;
  agents: Array<{ name: string; path: string }>;
  connectedAt: number;
}

/** Directory entry returned by `list_dir`. Files are filtered server-side
 *  since cwd must be a directory; only `isDir: true` entries reach the UI. */
export interface DirEntry {
  name: string;
  isDir: boolean;
}

// ─── Client → Server ─────────────────────────────────────────────────────────
export type ClientMessage =
  | { type: 'list_sessions' }
  | {
      type: 'create_session';
      agent: AgentKind;
      cwd: string;
      title?: string;
      /** Pin this session to a specific daemon. Falls back to first connected
       *  if the chosen device is offline at send time. */
      deviceId?: string;
    }
  | { type: 'send_prompt'; sessionId: string; prompt: string }
  | { type: 'permission_response'; sessionId: string; requestId: string; allow: boolean }
  | { type: 'cancel'; sessionId: string }
  /** Emergency brake — cancel every running/awaiting session this user owns. */
  | { type: 'cancel_all' }
  | { type: 'delete_session'; sessionId: string }
  | {
      type: 'list_dir';
      requestId: string;
      /** Pick which daemon to list against. When omitted, server lists its
       *  own fs (anon dev mode). When the chosen device is offline, server
       *  responds with an error rather than silently rerouting — picking a
       *  different machine's tree mid-browse would be jarring. */
      deviceId?: string;
      /** Empty string = ask the daemon for its home dir. */
      path: string;
    };

// ─── Server → Client ─────────────────────────────────────────────────────────
export type ServerMessage =
  | { type: 'hello'; defaultCwd: string }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'session_created'; session: SessionMeta }
  | { type: 'session_updated'; session: SessionMeta }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; sessionId: string; requestId: string }
  | { type: 'devices'; devices: DeviceInfo[] }
  /** Acknowledgement for `cancel_all` — how many sessions were actually
   *  cancelled (zero is a normal "nothing was running" reply, not an error). */
  | { type: 'cancel_all_ack'; cancelled: number }
  | {
      type: 'dir_listing';
      requestId: string;
      path: string;
      /** Parent directory absolute path. Omitted when `path` is a root
       *  (filesystem root on POSIX, drive letter on Windows). */
      parent?: string;
      entries: DirEntry[];
      error?: string;
    }
  | { type: 'error'; sessionId?: string; error: string };

// ─── Daemon protocol (server ↔ local vvibe daemon) ───────────────────────────
//
// One `runId` per server-initiated prompt. Daemon correlates streamed output,
// permission requests, and cancel back to the right RemoteRunner via runId.
// Session continuation (Claude's resume token) is held on the server; daemon
// is stateless across runs aside from the in-flight child process.

export type DaemonServerMessage =
  | {
      type: 'daemon_run_prompt';
      runId: string;
      sessionId: string;
      agent: AgentKind;
      cwd: string;
      prompt: string;
      resumeToken?: string;
    }
  | { type: 'daemon_cancel'; runId: string }
  | {
      type: 'daemon_permission_response';
      runId: string;
      requestId: string;
      allow: boolean;
    }
  | {
      type: 'daemon_list_dir';
      requestId: string;
      /** Empty string = daemon picks its home dir. */
      path: string;
    };

export type DaemonClientMessage =
  | {
      type: 'daemon_message';
      runId: string;
      role: ChatMessage['role'];
      text: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: 'daemon_permission_request';
      runId: string;
      requestId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: 'daemon_done';
      runId: string;
      resumeToken?: string;
      error?: string;
    }
  | {
      type: 'daemon_dir_listing';
      requestId: string;
      path: string;
      parent?: string;
      entries: DirEntry[];
      error?: string;
    };
