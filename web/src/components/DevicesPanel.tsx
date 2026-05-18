import { useState } from 'react';
import type { DeviceInfo } from '../../../shared/types';

interface Props {
  devices: DeviceInfo[];
}

function detectInstallCmd(): string {
  const isWindows =
    typeof navigator !== 'undefined' &&
    /win/i.test(navigator.platform || navigator.userAgent);
  return isWindows
    ? 'iwr https://agent-web-mvp-renddi.fly.dev/install.ps1 | iex'
    : 'curl -fsSL https://agent-web-mvp-renddi.fly.dev/install.sh | sh';
}

function InstallInstructions() {
  return (
    <>
      <p className="muted">Run on the machine you want to connect:</p>
      <pre className="install-cmd">{detectInstallCmd()}</pre>
      <pre className="install-cmd">vvibe login{'\n'}vvibe install</pre>
    </>
  );
}

export function DevicesPanel({ devices }: Props) {
  const [showAdd, setShowAdd] = useState(false);

  if (devices.length === 0) {
    return (
      <div className="devices-panel devices-empty">
        <div className="devices-header">
          <span className="dot dot-off" /> No device connected
        </div>
        <InstallInstructions />
      </div>
    );
  }
  return (
    <div className="devices-panel">
      <div className="devices-header">
        <span className="dot dot-on" /> {devices.length} device{devices.length === 1 ? '' : 's'}
      </div>
      <ul className="devices-list">
        {devices.map((d) => {
          // `agents` may arrive as null when the daemon detected zero CLIs —
          // Go's encoding/json serialises a nil slice as `null`, not `[]`.
          // Treat both as the no-agents case rather than crashing the panel.
          const agents = d.agents ?? [];
          return (
            <li key={d.id} title={`${d.hostname} • ${d.os}/${d.arch} • v${d.version}`}>
              <span className="device-name">{d.displayName ?? d.hostname}</span>
              <span className="device-meta">
                {d.os}/{d.arch}
                {agents.length > 0 ? ` · ${agents.map((a) => a.name).join(',')}` : ' · no agents'}
              </span>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="add-device-toggle"
        aria-expanded={showAdd}
        onClick={() => setShowAdd((v) => !v)}
      >
        {showAdd ? '− Hide instructions' : '+ Connect new device'}
      </button>
      {showAdd && (
        <div className="add-device-body">
          <InstallInstructions />
        </div>
      )}
    </div>
  );
}
