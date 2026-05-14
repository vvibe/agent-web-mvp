import { useState } from 'react';
import type { AgentKind } from '../../../shared/types';

interface Props {
  defaultCwd: string;
  onCancel: () => void;
  onCreate: (agent: AgentKind, cwd: string, title?: string) => void;
}

export function NewSessionDialog({ defaultCwd, onCancel, onCreate }: Props) {
  const [agent, setAgent] = useState<AgentKind>('claude');
  const [cwd, setCwd] = useState(defaultCwd);
  const [title, setTitle] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!cwd.trim()) return;
    onCreate(agent, cwd.trim(), title.trim() || undefined);
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New session</h3>
        <form onSubmit={submit}>
          <label>
            Agent
            <select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind)}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex CLI</option>
            </select>
          </label>
          <label>
            Working directory
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="C:\path\to\repo"
              required
            />
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
            <button type="submit" className="allow">
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
