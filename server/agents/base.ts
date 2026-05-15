import type { ChatMessage, PermissionRequest } from '../../shared/types.ts';

export interface AgentEvents {
  onMessage: (msg: Omit<ChatMessage, 'id' | 'sessionId' | 'ts'>) => void;
  onPermissionRequest: (req: Omit<PermissionRequest, 'sessionId' | 'requestId'>) => Promise<boolean>;
  onError: (err: Error) => void;
  onDone: () => void;
  /**
   * Called when an agent reports a fresh resume token (Claude session_id).
   * Session persists this so multi-turn context survives server restart.
   * Optional because some runners (Codex) don't have a resume concept yet.
   */
  onResumeToken?: (token: string) => void;
}

export interface AgentRunner {
  /**
   * Execute one turn. `resumeToken` is the most recent resume token the
   * session has on record; the runner uses it to continue the conversation
   * and reports any new value back via events.onResumeToken.
   */
  send(prompt: string, resumeToken: string | undefined): Promise<void>;
  cancel(): void;
}
