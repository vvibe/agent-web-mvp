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

// Strip ANSI escape sequences from tool output. CLIs like `npx skills` print
// color / cursor / spinner codes meant for a real terminal; here they leak
// as visible `[34m...[39m` garbage because the leading ESC char is dropped
// by HTML rendering. Cheap fix: drop the whole sequence on display. Doesn't
// modify the stored text, so a future ansi-to-html renderer can replace
// this transform without losing data.
//
// \x1b? handles two cases: the proper ESC-prefixed sequence as emitted by
// CLIs, AND the ESC-stripped form that sometimes reaches us via transport
// layers (just `[34m...` etc.).
const ANSI_PATTERN = /\x1b?\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

function MessageBubble({ message }: { message: ChatMessage }) {
  // Only strip on tool output; user/assistant prose shouldn't contain ANSI,
  // and stripping there would be a waste of regex work on every render.
  const text =
    message.role === 'tool_result' || message.role === 'tool_use'
      ? stripAnsi(message.text)
      : message.text;
  return (
    <div className={`bubble role-${message.role}`}>
      <div className="bubble-role">{message.role}</div>
      <div className="bubble-text">{text}</div>
    </div>
  );
}
