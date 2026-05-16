import { useEffect, useMemo, useState } from 'react';
import type { AgentKind, DeviceInfo } from '../../../shared/types';
import type { WSClient } from '../ws';
import { DirectoryPicker } from './DirectoryPicker';

interface Props {
  defaultCwd: string;
  devices: DeviceInfo[];
  ws: WSClient;
  onCancel: () => void;
  onCreate: (agent: AgentKind, cwd: string, title?: string, deviceId?: string) => void;
}

export function NewSessionDialog({ defaultCwd, devices, ws, onCancel, onCreate }: Props) {
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [cwd, setCwd] = useState(defaultCwd);
  const [title, setTitle] = useState('');
  // Empty string means "no preference" — server runs on first connected daemon.
  const [deviceId, setDeviceId] = useState<string>('');
  const [showBrowser, setShowBrowser] = useState(false);

  // Agents available across the relevant devices. When the user picks a
  // specific device, only that one counts; with "Any" we union across all
  // connected daemons since RemoteRunner is free to pick at send() time.
  const agentsAvailable = useMemo(() => {
    const relevant = deviceId ? devices.filter((d) => d.id === deviceId) : devices;
    return new Set(relevant.flatMap((d) => d.agents.map((a) => a.name)));
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

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cwd.trim()) return;
    onCreate(agent, cwd.trim(), title.trim() || undefined, deviceId || undefined);
  }

  const selectedDevice = deviceId ? devices.find((d) => d.id === deviceId) : undefined;
  const noAgentsOnDevice = devices.length > 0 && agentsAvailable.size === 0;
  const scopeLabel = selectedDevice
    ? (selectedDevice.displayName ?? selectedDevice.hostname)
    : 'any connected device';

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
            or <code>codex</code> on that machine, then restart vvibe.
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
          {devices.length > 1 && (
            <label>
              Device
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                <option value="">Any (first connected)</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {(d.displayName ?? d.hostname)} — {d.os}/{d.arch}
                    {d.agents.length > 0
                      ? ` · ${d.agents.map((a) => a.name).join(',')}`
                      : ' · no agents'}
                  </option>
                ))}
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
          <div className="modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="allow" disabled={isDisabled(agent)}>
              Create
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
