import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, SessionMeta } from '../../../shared/types';

interface Props {
  session: SessionMeta;
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function ChatPane({ session, messages, onSend, onCancel }: Props) {
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const busy = session.status === 'running' || session.status === 'awaiting_permission';

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  }

  return (
    <section className="chat-pane">
      <header className="chat-header">
        <div>
          <h2>{session.title}</h2>
          <div className="header-meta">
            <span className={`badge agent-${session.agent}`}>{session.agent}</span>
            <span className="cwd">{session.cwd}</span>
            <span className={`status status-${session.status}`}>{session.status}</span>
          </div>
        </div>
        {busy && (
          <button className="cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
      </header>

      <div className="log" ref={logRef}>
        {messages.length === 0 && <p className="hint">Send a prompt to start.</p>}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              handleSubmit(e);
            }
          }}
          placeholder="Type a prompt — Ctrl/Cmd+Enter to send"
          rows={3}
        />
        <button type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={`bubble role-${message.role}`}>
      <div className="bubble-role">{message.role}</div>
      <div className="bubble-text">{message.text}</div>
    </div>
  );
}
