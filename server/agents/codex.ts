import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentEvents, AgentRunner } from './base.ts';

// Codex CLI MVP integration: we spawn `codex exec "<prompt>"` per turn and pipe
// stdout/stderr into the session log. This is intentionally simple — Codex has
// its own permission model (--full-auto / --ask-for-approval) which we surface
// via the CODEX_ARGS env var rather than reimplementing in the web UI.
//
// Multi-turn continuation is NOT yet wired up; each prompt is independent.
// TODO: switch to `codex exec --json` + session resume once we want chat memory.

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';
const CODEX_EXTRA_ARGS = (process.env.CODEX_ARGS ?? '').split(' ').filter(Boolean);

export class CodexRunner implements AgentRunner {
  private current: ChildProcess | undefined;

  constructor(
    private readonly cwd: string,
    private readonly events: AgentEvents,
  ) {}

  async send(prompt: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const args = ['exec', ...CODEX_EXTRA_ARGS, prompt];

      let proc: ChildProcess;
      try {
        proc = spawn(CODEX_BIN, args, {
          cwd: this.cwd,
          shell: process.platform === 'win32', // resolve .cmd shims on Windows
          env: process.env,
        });
      } catch (err) {
        this.events.onError(err as Error);
        this.events.onDone();
        resolve();
        return;
      }

      this.current = proc;

      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');

      proc.stdout?.on('data', (chunk: string) => {
        this.events.onMessage({ role: 'assistant', text: chunk });
      });

      proc.stderr?.on('data', (chunk: string) => {
        this.events.onMessage({ role: 'system', text: chunk });
      });

      proc.on('error', (err) => {
        const msg =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `Cannot find "${CODEX_BIN}" on PATH. Install the Codex CLI or set CODEX_BIN.`
            : err.message;
        this.events.onError(new Error(msg));
      });

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          this.events.onMessage({
            role: 'system',
            text: `[codex exited with code ${code}]`,
          });
        }
        this.current = undefined;
        this.events.onDone();
        resolve();
      });
    });
  }

  cancel(): void {
    if (this.current && !this.current.killed) {
      this.current.kill();
    }
  }
}
