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
