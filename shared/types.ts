import { z } from 'zod';

export type AgentKind = 'claude' | 'codex';

/** Claude model ids the UI offers and the server accepts. Anything outside
 *  this list is rejected back to "SDK default" (currently Opus 4.7 under the
 *  claude_code preset). Kept here so the dropdown, server validation, and
 *  daemon all share one source of truth. */
export const CLAUDE_MODELS = [
  { id: 'claude-opus-4-7', label: 'Opus 4.7 — most capable, slowest' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast, cheap' },
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]['id'];

export function isAllowedClaudeModel(m: unknown): m is ClaudeModelId {
  return typeof m === 'string' && CLAUDE_MODELS.some((cm) => cm.id === m);
}

export type SessionStatus = 'idle' | 'running' | 'awaiting_permission' | 'error' | 'ended';

export interface SessionMeta {
  id: string;
  agent: AgentKind;
  cwd: string;
  title: string;
  status: SessionStatus;
  createdAt: number;
  /** Stable device-token id this session is pinned to. Runner is strict:
   *  if the device is offline at send() time, the run errors out rather
   *  than re-routing to another daemon (machine-specific cwds make
   *  cross-device fallback unsafe). Undefined = no pin (first connected
   *  daemon wins, which is fine in the common single-daemon case). */
  preferredDeviceId?: string;
  /** Display name of the pinned device (hostname or user-chosen alias),
   *  resolved server-side so the UI can render it even while the daemon
   *  is offline. Undefined when there's no pin OR the pin references a
   *  token id we no longer have on file (legacy sessions). */
  preferredDeviceLabel?: string;
  /** Claude model id (e.g. 'claude-sonnet-4-6'). Undefined = SDK default. */
  model?: string;
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
      /** Claude model id; ignored for Codex. Undefined = SDK default. */
      model?: string;
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
      /** Claude model id (e.g. 'claude-sonnet-4-6'); daemon ignores for Codex. */
      model?: string;
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

// ─── Runtime validation (M10 N-6) ────────────────────────────────────────────
//
// zod schemas for everything coming OFF the daemon WS. A user's own daemon
// is partially trusted (it spawned from their machine) but its JSON shape
// is currently trust-on-faith — a buggy or malicious daemon can spoof
// `role: 'user'` to inject fake history rows, or send oversized payloads
// past the message-level limit. Bounds below are picked well above legit
// daemon traffic so a normal client never trips them.
//
// Hard-coded length caps rather than env-tunable: the new vvibe repo will
// own its own protocol versioning; this repo's job is to land the contract
// hardening before the daemon binary + WS shape ports over.

const RUN_ID_MAX = 200;
const REQUEST_ID_MAX = 200;
const TEXT_MAX = 1 << 19; // ~512 KB per message text payload
const TOOL_NAME_MAX = 200;
const PATH_MAX = 4096;
const TOKEN_MAX = 8192;
const ERROR_MAX = 4096;
const ENTRIES_MAX = 10_000;
const ENTRY_NAME_MAX = 512;
const HOSTNAME_MAX = 255;
const SHORT_STR_MAX = 200;

const ChatMessageRoleSchema = z.enum([
  'user',
  'assistant',
  'system',
  'tool_use',
  'tool_result',
]);

const DirEntrySchema = z.object({
  name: z.string().max(ENTRY_NAME_MAX),
  isDir: z.boolean(),
});

export const DaemonClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('daemon_message'),
    runId: z.string().min(1).max(RUN_ID_MAX),
    role: ChatMessageRoleSchema,
    text: z.string().max(TEXT_MAX),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('daemon_permission_request'),
    runId: z.string().min(1).max(RUN_ID_MAX),
    requestId: z.string().min(1).max(REQUEST_ID_MAX),
    toolName: z.string().min(1).max(TOOL_NAME_MAX),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('daemon_done'),
    runId: z.string().min(1).max(RUN_ID_MAX),
    resumeToken: z.string().max(TOKEN_MAX).optional(),
    error: z.string().max(ERROR_MAX).optional(),
  }),
  z.object({
    type: z.literal('daemon_dir_listing'),
    requestId: z.string().min(1).max(REQUEST_ID_MAX),
    path: z.string().max(PATH_MAX),
    parent: z.string().max(PATH_MAX).optional(),
    entries: z.array(DirEntrySchema).max(ENTRIES_MAX),
    error: z.string().max(ERROR_MAX).optional(),
  }),
]);

/** The daemon's first message on the /client WS. Not part of
 *  DaemonClientMessage because it's a one-shot handshake, not a streamed
 *  per-run event. Validated separately so the post-hello validator can
 *  use a tighter discriminated union. */
export const DeviceHelloMessageSchema = z.object({
  type: z.literal('hello'),
  hostname: z.string().min(1).max(HOSTNAME_MAX),
  displayName: z.string().max(SHORT_STR_MAX).optional(),
  os: z.string().min(1).max(SHORT_STR_MAX),
  arch: z.string().min(1).max(SHORT_STR_MAX),
  version: z.string().min(1).max(SHORT_STR_MAX),
  agents: z
    .array(
      z.object({
        name: z.string().min(1).max(SHORT_STR_MAX),
        path: z.string().max(PATH_MAX),
      }),
    )
    .max(50),
  pid: z.number().int().min(0),
});
