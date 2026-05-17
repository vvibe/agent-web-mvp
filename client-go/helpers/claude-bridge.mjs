// claude-bridge: Node child process spawned by vvibe (the Go daemon) to
// drive the @anthropic-ai/claude-agent-sdk. The Go side speaks JSON-lines
// over stdin/stdout. One bridge process handles one prompt turn, then exits.
//
// Inbound (stdin, one line each):
//   { "type": "prompt", "prompt": "...", "cwd": "/abs/path", "resume": "?" }
//   { "type": "permission_response", "requestId": "...", "allow": true }
//   { "type": "cancel" }
//
// Outbound (stdout, one line each):
//   { "type": "message", "role": "...", "text": "...", "meta": {} }
//   { "type": "permission_request", "requestId": "...", "toolName": "...", "input": {} }
//   { "type": "done", "resumeToken": "?", "error": "?" }
//
// SDK resolution is locked to daemon-controlled paths only — never the
// agent cwd. The cwd is user-supplied and could point at a repo carrying a
// malicious node_modules/@anthropic-ai/claude-agent-sdk; loading that would
// execute attacker code inside the bridge before any of Claude's permission
// gates ran. See ROADMAP.md M4.6 (H-4).

import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const stdin = createInterface({ input: process.stdin });

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function fail(message) {
  write({ type: 'done', error: message });
  process.exit(0);
}

async function loadSdk() {
  // Resolve from the bridge script's own directory (where the daemon may
  // ship a vendored SDK in node_modules) and then fall through to the Node
  // global resolution. The agent cwd is *never* consulted: it's
  // attacker-controllable and a hostile repo could otherwise drop a fake
  // @anthropic-ai/claude-agent-sdk into node_modules/ and execute arbitrary
  // code at import time, bypassing every permission gate downstream.
  const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
  try {
    const req = createRequire(path.join(bridgeDir, 'package.json'));
    const resolved = req.resolve('@anthropic-ai/claude-agent-sdk');
    // On Windows, dynamic import() requires a file:// URL for absolute
    // paths — `C:\...` fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
    return await import(pathToFileURL(resolved).href);
  } catch {
    /* fall through to bare-specifier resolution */
  }
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw new Error(
      '@anthropic-ai/claude-agent-sdk not found in daemon-controlled paths. ' +
        'Install it alongside the daemon binary or globally — the agent ' +
        'cwd is not consulted for SDK resolution.',
    );
  }
}

const pendingPermissions = new Map();
const aborter = new AbortController();
let initialPrompt = null;

stdin.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'prompt' && !initialPrompt) {
    initialPrompt = msg;
    runTurn(msg).catch((err) => fail(err?.message ?? String(err)));
    return;
  }
  if (msg.type === 'permission_response') {
    const p = pendingPermissions.get(msg.requestId);
    if (p) {
      pendingPermissions.delete(msg.requestId);
      p(!!msg.allow);
    }
    return;
  }
  if (msg.type === 'cancel') {
    aborter.abort();
    return;
  }
});

stdin.on('close', () => {
  if (!initialPrompt) process.exit(0);
});

async function runTurn(req) {
  const { query } = await loadSdk();

  let sdkSessionId = req.resume || undefined;

  try {
    const result = query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd,
        resume: sdkSessionId,
        abortController: aborter,
        // Hard cap on tool-use turns per prompt. Defense against prompt
        // injection (e.g. a README that tricks Claude into chained reads)
        // and against runaway agent loops chewing through tokens. 25 is
        // plenty for normal coding tasks — most prompts resolve in <10.
        maxTurns: 25,
        canUseTool: (toolName, input) => askPermission(toolName, input),
        // Use Claude Code's full default system prompt so the model is told
        // its working directory, git status, etc. Without this, Claude has
        // no context and invents paths like /home/user/.
        systemPrompt: { type: 'preset', preset: 'claude_code' },
      },
    });

    for await (const msg of result) {
      handleSdkMessage(msg, (id) => {
        sdkSessionId = id;
      });
    }
    write({ type: 'done', resumeToken: sdkSessionId });
  } catch (err) {
    if (aborter.signal.aborted) {
      write({ type: 'done', resumeToken: sdkSessionId, error: 'cancelled' });
    } else {
      write({ type: 'done', resumeToken: sdkSessionId, error: err?.message ?? String(err) });
    }
  } finally {
    process.exit(0);
  }
}

function askPermission(toolName, input) {
  return new Promise((resolve) => {
    const requestId = randomId();
    pendingPermissions.set(requestId, (allow) => {
      resolve(
        allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'User denied permission via web UI.' },
      );
    });
    write({ type: 'permission_request', requestId, toolName, input });
  });
}

function randomId() {
  // 16 hex chars — enough entropy for in-turn correlation.
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function handleSdkMessage(msg, setSessionId) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'system':
      if (msg.session_id) setSessionId(msg.session_id);
      if (msg.subtype === 'init') {
        write({
          type: 'message',
          role: 'system',
          text: `Session ready (model: ${msg.model ?? 'unknown'})`,
        });
      }
      break;
    case 'assistant': {
      const blocks = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          write({ type: 'message', role: 'assistant', text: block.text });
        } else if (block.type === 'tool_use') {
          write({
            type: 'message',
            role: 'tool_use',
            text: `→ ${block.name}`,
            meta: { name: block.name, input: block.input, id: block.id },
          });
        }
      }
      break;
    }
    case 'user': {
      const blocks = msg.message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
                : '';
          write({
            type: 'message',
            role: 'tool_result',
            text: text.slice(0, 4000),
            meta: { tool_use_id: block.tool_use_id, is_error: !!block.is_error },
          });
        }
      }
      break;
    }
    case 'result':
      if (msg.session_id) setSessionId(msg.session_id);
      if (msg.is_error) {
        write({ type: 'message', role: 'system', text: msg.result ?? 'Agent reported an error' });
      }
      break;
  }
}
