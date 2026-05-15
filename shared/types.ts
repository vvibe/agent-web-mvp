export type AgentKind = 'claude' | 'codex';

export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'error' | 'ended';

export interface SessionMeta {
  id: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
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

// ─── Client → Server ─────────────────────────────────────────────────────────
export type ClientMessage =
  | { type: 'list_sessions' }
  | { type: 'create_session'; agent: AgentKind; cwd: string; title?: string }
  | { type: 'send_prompt'; sessionId: string; prompt: string }
  | { type: 'permission_response'; sessionId: string; requestId: string; allow: boolean }
  | { type: 'cancel'; sessionId: string }
  | { type: 'delete_session'; sessionId: string };

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
  | { type: 'error'; sessionId?: string; error: string };

// ─── Daemon protocol (server ↔ local agent-client) ───────────────────────────
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
    };
