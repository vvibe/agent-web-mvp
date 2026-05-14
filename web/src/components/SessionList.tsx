import type { SessionMeta } from '../../../shared/types';

interface Props {
  sessions: SessionMeta[];
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

export function SessionList({ sessions, activeId, onSelect, onDelete }: Props) {
  if (sessions.length === 0) {
    return <p className="hint">No sessions yet.</p>;
  }
  return (
    <ul className="session-list">
      {sessions.map((s) => (
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
      ))}
    </ul>
  );
}
