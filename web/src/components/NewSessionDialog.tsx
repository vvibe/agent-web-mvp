import { useEffect, useMemo, useState } from 'react';
import type { AgentKind, DeviceInfo, ServerMessage } from '../../../shared/types';
import { CLAUDE_MODELS } from '../../../shared/types';
import type { WSClient } from '../ws';
import { DirectoryPicker } from './DirectoryPicker';

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface Props {
  defaultCwd: string;
  devices: DeviceInfo[];
  ws: WSClient;
  onCancel: () => void;
  onCreate: (
    agent: AgentKind,
    cwd: string,
    title?: string,
    deviceId?: string,
    model?: string,
  ) => void;
}

export function NewSessionDialog({ defaultCwd, devices, ws, onCancel, onCreate }: Props) {
  const [agent, setAgent] = useState<AgentKind>('claude');
  // Empty string = "let the SDK pick" (currently Opus 4.7 under claude_code preset).
  const [model, setModel] = useState<string>('');
  // When daemons are paired, the cwd lives on the daemon's filesystem —
  // server's defaultCwd (e.g. '/app' in the Fly container) is meaningless
  // there and pre-filling it leads to a confusing "no such file or
  // directory" when the user opens the directory browser. Start empty in
  // that mode; in anon/local-only mode the server's cwd is the user's
  // working tree, so pre-filling it is useful.
  const [cwd, setCwd] = useState(() => (devices.length > 0 ? '' : defaultCwd));
  const [title, setTitle] = useState('');
  // Empty string means "no preference" — server runs on first connected daemon.
  const [deviceId, setDeviceId] = useState<string>('');
  const [showBrowser, setShowBrowser] = useState(false);

  // Codex enablement state — only relevant when agent === 'codex' and the
  // chosen device hasn't opted in yet. The dialog flips into a "first-time
  // setup" mode that combines enable + create into a single button.
  const [sandboxMode, setSandboxMode] = useState<SandboxMode>('workspace-write');
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  // The deviceId we just sent an enable request for — so we can ignore
  // stale acks if the user switches device between click and response.
  const [pendingEnableDeviceId, setPendingEnableDeviceId] = useState<string | null>(null);
  // Form values captured at the moment of "Enable & Create" click. We
  // replay them onCreate after the daemon acks success, so editing fields
  // mid-enable doesn't surprise the user with last-second values.
  const [enableThenCreate, setEnableThenCreate] = useState<null | {
    cwd: string;
    title: string;
    deviceId: string;
  }>(null);

  // Agents available across the relevant devices. When the user picks a
  // specific device, only that one counts; with "Any" we union across all
  // connected daemons since RemoteRunner is free to pick at send() time.
  const agentsAvailable = useMemo(() => {
    const relevant = deviceId ? devices.filter((d) => d.id === deviceId) : devices;
    return new Set(relevant.flatMap((d) => (d.agents ?? []).map((a) => a.name)));
  }, [deviceId, devices]);

  // When the selected agent becomes unavailable (e.g. user switched device in
  // the picker), auto-flip to one that is. Skipped when there are no devices
  // to gate on: anon mode runs locally and we can't introspect that.
  useEffect(() => {
    if (devices.length === 0) return;
    if (agentsAvailable.has(agent)) return;
    if (agentsAvailable.has('claude')) setAgent('claude');
    else if (agentsAvailable.has('codex')) setAgent('codex');
  }, [devices.length, agentsAvailable, agent]);

  function isDisabled(a: AgentKind) {
    return devices.length > 0 && !agentsAvailable.has(a);
  }

  // Which concrete device would the codex enable request target? With a
  // pinned device, that's the answer. With "Any", pick the first
  // codex-capable device — predictable and avoids server having to guess.
  const codexCandidateDevice = useMemo(() => {
    if (deviceId) return devices.find((d) => d.id === deviceId);
    return devices.find((d) => (d.agents ?? []).some((a) => a.name === 'codex'));
  }, [deviceId, devices]);

  // Whether the chosen agent needs the inline enablement panel right now.
  // Only kicks in for codex, only when the candidate device exists and
  // hasn't opted in yet. (When devices.length === 0 we're in anon/local
  // mode and there's no codex policy to flip — the server's own gate
  // handles that case separately.)
  const codexNeedsEnable =
    agent === 'codex' &&
    devices.length > 0 &&
    !!codexCandidateDevice &&
    codexCandidateDevice.codexEnabled === false;

  // Subscribe to codex_enable_result so we can flip the spinner off and
  // proceed with create on success. Tied to the dialog's lifetime — once
  // closed, no stray acks can touch state.
  useEffect(() => {
    const off = ws.on((msg: ServerMessage) => {
      if (msg.type !== 'codex_enable_result') return;
      if (msg.deviceId !== pendingEnableDeviceId) return;
      setEnabling(false);
      setPendingEnableDeviceId(null);
      if (!msg.success) {
        setEnableError(msg.error ?? 'Daemon refused to enable codex.');
        setEnableThenCreate(null);
        return;
      }
      // Daemon flipped its flag and server has broadcast the updated
      // devices list; replay the captured form values to fire the
      // create_session that the user originally clicked for.
      const replay = enableThenCreate;
      setEnableThenCreate(null);
      if (replay) {
        onCreate(
          'codex',
          replay.cwd,
          replay.title || undefined,
          replay.deviceId || undefined,
          undefined,
        );
      }
    });
    return off;
  }, [ws, pendingEnableDeviceId, enableThenCreate, onCreate]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cwd.trim()) return;

    if (codexNeedsEnable) {
      if (!codexCandidateDevice) return;
      setEnableError(null);
      setEnabling(true);
      setPendingEnableDeviceId(codexCandidateDevice.id);
      setEnableThenCreate({
        cwd: cwd.trim(),
        title: title.trim(),
        deviceId: deviceId,
      });
      ws.send({
        type: 'enable_codex_on_device',
        deviceId: codexCandidateDevice.id,
        sandboxMode,
      });
      return;
    }

    // Model only meaningful for Claude; Codex CLI doesn't take one yet.
    const sendModel = agent === 'claude' && model ? model : undefined;
    onCreate(agent, cwd.trim(), title.trim() || undefined, deviceId || undefined, sendModel);
  }

  const selectedDevice = deviceId ? devices.find((d) => d.id === deviceId) : undefined;
  const noAgentsOnDevice = devices.length > 0 && agentsAvailable.size === 0;
  const scopeLabel = selectedDevice
    ? (selectedDevice.displayName ?? selectedDevice.hostname)
    : 'any connected device';
  const targetDeviceLabel = codexCandidateDevice
    ? (codexCandidateDevice.displayName ?? codexCandidateDevice.hostname)
    : '';

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New session</h3>
        {devices.length === 0 && (
          <p className="warning">
            No daemon connected. The session will be created, but prompts will
            error until you pair a device.
          </p>
        )}
        {noAgentsOnDevice && (
          <p className="warning">
            {scopeLabel} has no agent CLI on PATH. Install <code>claude</code>{' '}
            or <code>codex</code> on that machine, then restart vvibe. If you{' '}
            <em>did</em> install one, run <code>vvibe doctor</code> on that
            machine — it'll show what the daemon actually sees.
          </p>
        )}
        <form onSubmit={submit}>
          <label>
            Agent
            <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
              <option value="claude" disabled={isDisabled('claude')}>
                Claude Code{isDisabled('claude') ? ' — not installed' : ''}
              </option>
              <option value="codex" disabled={isDisabled('codex')}>
                Codex CLI{isDisabled('codex') ? ' — not installed' : ''}
              </option>
            </select>
          </label>
          {agent === 'claude' && (
            <label>
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Default (SDK picks — currently Opus 4.7)</option>
                {CLAUDE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
          )}
          {devices.length > 1 && (
            <label>
              Device
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">Any (first connected)</option>
                {devices.map((d) => {
                  const agents = d.agents ?? [];
                  return (
                    <option key={d.id} value={d.id}>
                      {(d.displayName ?? d.hostname)} — {d.os}/{d.arch}
                      {agents.length > 0
                        ? ` · ${agents.map((a) => a.name).join(',')}`
                        : ' · no agents'}
                    </option>
                  );
                })}
              </select>
            </label>
          )}
          <label>
            Working directory
            <div className="cwd-row">
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="C:\path\to\repo"
                required
              />
              <button type="button" className="browse-btn" onClick={() => setShowBrowser(true)}>
                Browse…
              </button>
            </div>
          </label>
          <label>
            Title (optional)
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="auto-generated if blank"
            />
          </label>

          {codexNeedsEnable && (
            <div className="codex-enable-panel">
              <h4>First-time setup for Codex</h4>
              <p className="codex-enable-blurb">
                Codex doesn't have a per-tool permission popup like Claude does.
                Pick what it's allowed to do on{' '}
                <strong>{targetDeviceLabel || 'this device'}</strong>:
              </p>
              <fieldset className="sandbox-choice" disabled={enabling}>
                <label className="sandbox-option">
                  <input
                    type="radio"
                    name="sandbox-mode"
                    value="workspace-write"
                    checked={sandboxMode === 'workspace-write'}
                    onChange={() => setSandboxMode('workspace-write')}
                  />
                  <span>
                    <strong>Workspace write</strong>{' '}
                    <span className="sandbox-recommended">(recommended)</span>
                    <span className="sandbox-detail">
                      Read &amp; write inside the session's working directory only.
                    </span>
                  </span>
                </label>
                <label className="sandbox-option">
                  <input
                    type="radio"
                    name="sandbox-mode"
                    value="read-only"
                    checked={sandboxMode === 'read-only'}
                    onChange={() => setSandboxMode('read-only')}
                  />
                  <span>
                    <strong>Read-only</strong>
                    <span className="sandbox-detail">
                      Can read files but can't modify anything.
                    </span>
                  </span>
                </label>
                <label className="sandbox-option">
                  <input
                    type="radio"
                    name="sandbox-mode"
                    value="danger-full-access"
                    checked={sandboxMode === 'danger-full-access'}
                    onChange={() => setSandboxMode('danger-full-access')}
                  />
                  <span>
                    <strong>Full access</strong>{' '}
                    <span className="sandbox-danger">(dangerous)</span>
                    <span className="sandbox-detail">
                      Can read &amp; write anywhere on the device. No sandbox.
                    </span>
                  </span>
                </label>
              </fieldset>
              {enableError && (
                <p className="codex-enable-error">{enableError}</p>
              )}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" onClick={onCancel} disabled={enabling}>
              Cancel
            </button>
            <button
              type="submit"
              className="allow"
              disabled={isDisabled(agent) || enabling}
            >
              {enabling
                ? 'Enabling Codex…'
                : codexNeedsEnable
                  ? 'Enable Codex & Create'
                  : 'Create'}
            </button>
          </div>
        </form>
      </div>
      {showBrowser && (
        <DirectoryPicker
          ws={ws}
          initialPath={cwd}
          deviceId={deviceId || undefined}
          devices={devices}
          onCancel={() => setShowBrowser(false)}
          onPick={(p) => {
            setCwd(p);
            setShowBrowser(false);
          }}
        />
      )}
    </div>
  );
}
