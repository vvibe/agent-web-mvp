import type { DeviceInfo, SessionMeta } from '../../../shared/types';

interface Props {
  sessions: SessionMeta[];
  devices: DeviceInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

const statusLabel: Record<SessionMeta['status'], string> = {
  idle: 'idle',
  running: 'running…',
  awaiting_permission: 'awaiting',
  error: 'error',
  ended: 'ended',
};

export function SessionList({ sessions, devices, activeId, onSelect, onDelete }: Props) {
  if (sessions.length === 0) {
    return <p className="hint">No sessions yet.</p>;
  }
  const onlineIds = new Set(devices.map((d) => d.id));
  return (
    <ul className="session-list">
      {sessions.map((s) => {
        // Pinned device pill: server hands us a preferredDeviceLabel even for
        // offline devices (from device_tokens.display_name), so we can show
        // "Mac (offline)" without the daemon being connected. Sessions with no
        // pin show nothing — those use first-connected-daemon at send time.
        const pinned = s.preferredDeviceId;
        const pinnedOnline = pinned ? onlineIds.has(pinned) : false;
        const pinnedLabel = s.preferredDeviceLabel ?? (pinned ? 'unknown device' : null);
        return (
          <li
            key={s.id}
            className={s.id === activeId ? 'active' : ''}
            onClick={() => onSelect(s.id)}
          >
            <div className="row">
              <span className={`badge agent-${s.agent}`}>{s.agent}</span>
              <span className="title">{s.title}</span>
            </div>
            <div className="row meta">
              <span className={`status status-${s.status}`}>{statusLabel[s.status]}</span>
              {pinnedLabel && (
                <span
                  className={`device-pill ${pinnedOnline ? 'device-on' : 'device-off'}`}
                  title={
                    pinnedOnline
                      ? `Pinned to ${pinnedLabel} (online)`
                      : `Pinned to ${pinnedLabel} — daemon is offline, prompts will error until it reconnects.`
                  }
                >
                  <span className={`dot ${pinnedOnline ? 'dot-on' : 'dot-off'}`} />
                  {pinnedLabel}
                </span>
              )}
              <button
                className="delete"
                title="Delete session"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm('Delete this session?')) onDelete(s.id);
                }}
              >
                ×
              </button>
            </div>
            <div className="cwd" title={s.cwd}>
              {s.cwd}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
