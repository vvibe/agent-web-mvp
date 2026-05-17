import { randomUUID } from 'node:crypto';
import type { AgentKind, DaemonClientMessage } from '../../shared/types.ts';
import type { DeviceRegistry } from '../devices.ts';
import type { AgentEvents, AgentRunner } from './base.ts';

/**
 * AgentRunner that delegates execution to a connected daemon (vvibe)
 * over the existing /client WebSocket. Server holds Claude's resume token
 * across runs; daemon is stateless between prompts.
 */
export class RemoteRunner implements AgentRunner {
  private activeRunId: string | undefined;
  // deviceId is resolved at send() time, not construction time, so that a
  // daemon reconnect (new device id) doesn't orphan existing sessions.
  private activeDeviceId: string | undefined;
  private donePromise: Promise<void> | undefined;
  private resolveDone: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly userId: string,
    private readonly agent: AgentKind,
    private readonly cwd: string,
    private readonly registry: DeviceRegistry,
    private readonly events: AgentEvents,
    /** When set, RemoteRunner prefers this device if connected. Falls back to
     *  the first connected daemon otherwise — pinning a session to a device
     *  shouldn't orphan it if the user happens to be on a different machine. */
    private readonly preferredDeviceId?: string,
    /** Claude model id (e.g. 'claude-sonnet-4-6'); undefined = SDK default.
     *  Daemon ignores for Codex. Passed through on every daemon_run_prompt. */
    private readonly model?: string,
  ) {}

  async send(prompt: string, resumeToken: string | undefined): Promise<void> {
    const device = this.pickDevice();
    if (!device) {
      this.events.onError(new Error('No daemon connected. Run `vvibe login` and `vvibe install` on your machine.'));
      this.events.onDone();
      return;
    }
    this.activeDeviceId = device.id;

    const runId = randomUUID();
    this.activeRunId = runId;

    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });

    this.unsubscribe = this.registry.onDaemonMessage((devId, msg) => {
      if (devId !== this.activeDeviceId) return;
      if ((msg as any).runId !== runId) return;
      this.handleDaemonMessage(msg);
    });

    const ok = this.registry.sendToDevice(device.id, {
      type: 'daemon_run_prompt',
      runId,
      sessionId: runId,
      agent: this.agent,
      cwd: this.cwd,
      prompt,
      resumeToken,
      model: this.model,
    });

    if (!ok) {
      this.cleanup();
      this.events.onError(new Error('Daemon disconnected before run could start.'));
      this.events.onDone();
      return;
    }

    await this.donePromise;
  }

  cancel(): void {
    if (!this.activeRunId || !this.activeDeviceId) return;
    this.registry.sendToDevice(this.activeDeviceId, {
      type: 'daemon_cancel',
      runId: this.activeRunId,
    });
  }

  private pickDevice() {
    if (this.preferredDeviceId) {
      const preferred = this.registry.get(this.preferredDeviceId);
      if (preferred && preferred.userId === this.userId) return preferred;
    }
    return this.registry.pickRunner(this.userId);
  }

  private handleDaemonMessage(msg: DaemonClientMessage): void {
    switch (msg.type) {
      case 'daemon_message':
        this.events.onMessage({ role: msg.role, text: msg.text, meta: msg.meta });
        break;

      case 'daemon_permission_request': {
        const requestId = msg.requestId;
        const devId = this.activeDeviceId;
        if (!devId) return;
        this.events
          .onPermissionRequest({ toolName: msg.toolName, input: msg.input })
          .then((allow) => {
            this.registry.sendToDevice(devId, {
              type: 'daemon_permission_response',
              runId: msg.runId,
              requestId,
              allow,
            });
          })
          .catch(() => {
            this.registry.sendToDevice(devId, {
              type: 'daemon_permission_response',
              runId: msg.runId,
              requestId,
              allow: false,
            });
          });
        break;
      }

      case 'daemon_done':
        if (msg.resumeToken) this.events.onResumeToken?.(msg.resumeToken);
        if (msg.error) this.events.onError(new Error(msg.error));
        this.cleanup();
        this.events.onDone();
        break;
    }
  }

  private cleanup(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.activeRunId = undefined;
    this.activeDeviceId = undefined;
    this.resolveDone?.();
    this.resolveDone = undefined;
    this.donePromise = undefined;
  }
}
