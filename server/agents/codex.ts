import { execSync, spawn, type ChildProcess } from 'node:child_process';
import type { AgentEvents, AgentRunner } from './base.ts';

// Pick a TextDecoder for stderr based on the active Windows OEM codepage. On
// Windows the shell error ("'codex' is not recognized…") is emitted in the OEM
// codepage (CP950 on zh-TW boxes), so forcing UTF-8 produces mojibake. On all
// non-Windows platforms we just use UTF-8.
//
// You can override the detection with AGENT_WEB_STDERR_ENC=<label> in .env.
const stderrDecoder: TextDecoder = (() => {
  if (process.platform !== 'win32') return new TextDecoder('utf-8', { fatal: false });
  const override = process.env.AGENT_WEB_STDERR_ENC;
  if (override) {
    try { return new TextDecoder(override, { fatal: false }); } catch { /* fall through */ }
  }
  let cp = 0;
  try {
    const out = execSync('chcp', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('ascii');
    const m = out.match(/(\d{3,5})/);
    if (m) cp = parseInt(m[1], 10);
  } catch { /* leave cp = 0 → falls through to utf-8 */ }
  const label =
    cp === 950 ? 'big5'
    : cp === 932 ? 'shift_jis'
    : cp === 936 ? 'gbk'
    : cp === 949 ? 'euc-kr'
    : cp === 1252 ? 'windows-1252'
    : 'utf-8';
  try {
    return new TextDecoder(label, { fatal: false });
  } catch {
    return new TextDecoder('utf-8', { fatal: false });
  }
})();

function decodeStderr(buf: Buffer): string {
  return stderrDecoder.decode(buf);
}

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

  async send(prompt: string, _resumeToken: string | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      const args = ['exec', ...CODEX_EXTRA_ARGS, prompt];

      let proc: ChildProcess;
      try {
        proc = spawn(CODEX_BIN, args, {
          cwd: this.cwd,
          shell: process.platform === 'win32', // resolve .cmd shims on Windows
          env: process.env,
          // Close stdin: when given a prompt arg, codex still tries to read
          // additional input from stdin and hangs on EOF if the pipe is open.
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        this.events.onError(err as Error);
        this.events.onDone();
        resolve();
        return;
      }

      this.current = proc;

      // Codex output is UTF-8, but on Windows when the binary is missing the
      // OEM-locale shell error (e.g. "'codex' is not recognized…" in CP950)
      // comes through stderr and gets mojibake'd if forced to UTF-8.
      // Decode bytes with `decodeChunk` which falls back to the system locale
      // for stderr on Windows. stdout from a real Codex run stays UTF-8.
      proc.stdout?.on('data', (chunk: Buffer) => {
        this.events.onMessage({ role: 'assistant', text: chunk.toString('utf8') });
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        this.events.onMessage({ role: 'system', text: decodeStderr(chunk) });
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
