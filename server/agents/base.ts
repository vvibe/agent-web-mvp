import type { ChatMessage, PermissionRequest } from '../../shared/types.ts';

export interface AgentEvents {
  onMessage: (msg: Omit<ChatMessage, 'id' | 'sessionId' | 'ts'>) => void;
  onPermissionRequest: (req: Omit<PermissionRequest, 'sessionId' | 'requestId'>) => Promise<boolean>;
  onError: (err: Error) => void;
  onDone: () => void;
}

export interface AgentRunner {
  send(prompt: string): Promise<void>;
  cancel(): void;
}
