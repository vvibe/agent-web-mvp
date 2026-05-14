import type { AgentEvents, AgentRunner } from './base.ts';

// The Claude Agent SDK exports a `query` function that returns an async iterable
// of messages and accepts a `canUseTool` callback for permission prompts.
// Docs: https://docs.anthropic.com/en/docs/agent-sdk
//
// We import dynamically so the server can start even if the dependency is
// missing — the user will get a clear runtime error when they try to start a
// Claude session instead of a crash at boot.

export class ClaudeRunner implements AgentRunner {
  private sdkSessionId: string | undefined;
  private aborter: AbortController | undefined;

  constructor(
    private readonly cwd: string,
    private readonly events: AgentEvents,
  ) {}

  async send(prompt: string): Promise<void> {
    let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query;
    try {
      ({ query: queryFn } = await import('@anthropic-ai/claude-agent-sdk'));
    } catch (err) {
      this.events.onError(
        new Error(
          '@anthropic-ai/claude-agent-sdk is not installed. Run `npm install` first.',
        ),
      );
      this.events.onDone();
      return;
    }

    this.aborter = new AbortController();

    try {
      const result = queryFn({
        prompt,
        options: {
          cwd: this.cwd,
          resume: this.sdkSessionId,
          abortController: this.aborter,
          canUseTool: async (toolName: string, input: unknown) => {
            const allowed = await this.events.onPermissionRequest({ toolName, input });
            return allowed
              ? { behavior: 'allow' as const, updatedInput: input as Record<string, unknown> }
              : { behavior: 'deny' as const, message: 'User denied permission via web UI.' };
          },
        },
      });

      for await (const msg of result) {
        this.handleSdkMessage(msg);
      }
    } catch (err) {
      this.events.onError(err as Error);
    } finally {
      this.events.onDone();
      this.aborter = undefined;
    }
  }

  cancel(): void {
    this.aborter?.abort();
  }

  private handleSdkMessage(msg: any): void {
    // The SDK emits messages with shape { type: 'assistant' | 'user' | 'system' | 'result', ... }.
    // We translate them into our ChatMessage protocol. Be defensive about shape
    // because the SDK is young and may change.
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'system':
        if (msg.session_id) this.sdkSessionId = msg.session_id;
        if (msg.subtype === 'init') {
          this.events.onMessage({
            role: 'system',
            text: `Session ready (model: ${msg.model ?? 'unknown'})`,
          });
        }
        break;

      case 'assistant': {
        const blocks = msg.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            this.events.onMessage({ role: 'assistant', text: block.text });
          } else if (block.type === 'tool_use') {
            this.events.onMessage({
              role: 'tool_use',
              text: `→ ${block.name}`,
              meta: { name: block.name, input: block.input, id: block.id },
            });
          }
        }
        break;
      }

      case 'user': {
        // Tool results come back as user messages with content blocks.
        const blocks = msg.message?.content ?? [];
        for (const block of blocks) {
          if (block.type === 'tool_result') {
            const text =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .map((c: any) => (c.type === 'text' ? c.text : ''))
                      .join('')
                  : '';
            this.events.onMessage({
              role: 'tool_result',
              text: text.slice(0, 4000), // cap to keep UI snappy
              meta: { tool_use_id: block.tool_use_id, is_error: !!block.is_error },
            });
          }
        }
        break;
      }

      case 'result': {
        if (msg.session_id) this.sdkSessionId = msg.session_id;
        if (msg.is_error) {
          this.events.onError(new Error(msg.result ?? 'Agent reported an error'));
        }
        break;
      }
    }
  }
}
