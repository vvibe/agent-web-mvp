import type { DeviceInfo } from '../../../shared/types';

interface Props {
  devices: DeviceInfo[];
}

export function DevicesPanel({ devices }: Props) {
  if (devices.length === 0) {
    const isWindows =
      typeof navigator !== 'undefined' &&
      /win/i.test(navigator.platform || navigator.userAgent);
    const installCmd = isWindows
      ? 'iwr https://agent-web-mvp-renddi.fly.dev/install.ps1 | iex'
      : 'curl -fsSL https://agent-web-mvp-renddi.fly.dev/install.sh | sh';
    return (
      <div className="devices-panel devices-empty">
        <div className="devices-header">
          <span className="dot dot-off" /> No device connected
        </div>
        <p className="muted">Install vvibe on your machine, then pair it:</p>
        <pre className="install-cmd">{installCmd}</pre>
        <pre className="install-cmd">vvibe login{'\n'}vvibe install</pre>
      </div>
    );
  }
  return (
    <div className="devices-panel">
      <div className="devices-header">
        <span className="dot dot-on" /> {devices.length} device{devices.length === 1 ? '' : 's'}
      </div>
      <ul className="devices-list">
        {devices.map((d) => (
          <li key={d.id} title={`${d.hostname} • ${d.os}/${d.arch} • v${d.version}`}>
            <span className="device-name">{d.displayName ?? d.hostname}</span>
            <span className="device-meta">
              {d.os}/{d.arch}
              {d.agents.length > 0 ? ` · ${d.agents.map((a) => a.name).join(',')}` : ' · no agents'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
