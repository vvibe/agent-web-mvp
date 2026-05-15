import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatMessage,
  PermissionRequest,
  ServerMessage,
  SessionMeta,
} from '../../shared/types';
import { WSClient, makeWsUrl } from './ws';
import { SessionList } from './components/SessionList';
import { ChatPane } from './components/ChatPane';
import { PermissionModal } from './components/PermissionModal';
import { NewSessionDialog } from './components/NewSessionDialog';
import { LoginGate } from './components/LoginGate';
import { PairPage } from './components/PairPage';

interface Me {
  authenticated: boolean;
  authEnabled: boolean;
  user?: {
    id: string;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  };
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ authenticated: false, authEnabled: true }));
  }, []);

  if (!me) {
    return <div className="boot">Loading…</div>;
  }

  // Tiny path-based router. Keeps the SPA stateful without pulling react-router.
  const path = window.location.pathname;
  const search = new URLSearchParams(window.location.search);

  // /pair?code=ABC — show pair page if logged in, else redirect through OAuth.
  if (path === '/pair') {
    const code = search.get('code') ?? '';
    if (!me.authenticated) {
      return <LoginGate authEnabled={me.authEnabled} returnTo={`/pair?code=${encodeURIComponent(code)}`} />;
    }
    return <PairPage code={code} user={me.user ?? null} />;
  }

  if (!me.authenticated) {
    return <LoginGate authEnabled={me.authEnabled} returnTo="/" />;
  }

  return <MainApp me={me} />;
}

function MainApp({ me }: { me: Me }) {
  const wsRef = useRef<WSClient | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string>('');
  const [sessions, setSessions] = useState<Record<string, SessionMeta>>({});
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    const ws = new WSClient(makeWsUrl());
    wsRef.current = ws;
    const off = ws.on(handleServerMessage);
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'hello':
        setDefaultCwd(msg.defaultCwd);
        break;
      case 'sessions':
        setSessions(Object.fromEntries(msg.sessions.map((s) => [s.id, s])));
        setActiveId((prev) => prev ?? msg.sessions[0]?.id ?? null);
        break;
      case 'session_created':
        setSessions((prev) => ({ ...prev, [msg.session.id]: msg.session }));
        setActiveId(msg.session.id);
        break;
      case 'session_updated':
        setSessions((prev) => ({ ...prev, [msg.session.id]: msg.session }));
        break;
      case 'session_deleted':
        setSessions((prev) => {
          const next = { ...prev };
          delete next[msg.sessionId];
          return next;
        });
        setMessages((prev) => {
          const next = { ...prev };
          delete next[msg.sessionId];
          return next;
        });
        setActiveId((prev) => (prev === msg.sessionId ? null : prev));
        break;
      case 'message':
        setMessages((prev) => ({
          ...prev,
          [msg.message.sessionId]: [...(prev[msg.message.sessionId] ?? []), msg.message],
        }));
        break;
      case 'permission_request':
        setPendingPermissions((prev) => [...prev, msg.request]);
        break;
      case 'permission_resolved':
        setPendingPermissions((prev) =>
          prev.filter((p) => p.requestId !== msg.requestId),
        );
        break;
      case 'error':
        console.error('[server error]', msg.error);
        break;
    }
  }

  const sessionList = useMemo(
    () => Object.values(sessions).sort((a, b) => a.createdAt - b.createdAt),
    [sessions],
  );

  const activeSession = activeId ? sessions[activeId] : undefined;
  const activeMessages = activeId ? (messages[activeId] ?? []) : [];

  const activePermission = pendingPermissions.find((p) => p.sessionId === activeId);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Agent Web</h1>
          <button className="new-btn" onClick={() => setShowNew(true)}>
            + New
          </button>
        </div>
        <SessionList
          sessions={sessionList}
          activeId={activeId}
          onSelect={setActiveId}
          onDelete={(id) => wsRef.current?.send({ type: 'delete_session', sessionId: id })}
        />
        <div className="sidebar-footer">
          {me.user && (
            <>
              <span className="muted user-login">{me.user.login}</span>
              <a className="logout" href="/auth/logout">Sign out</a>
            </>
          )}
        </div>
      </aside>

      <main className="main">
        {activeSession ? (
          <ChatPane
            session={activeSession}
            messages={activeMessages}
            onSend={(text) =>
              wsRef.current?.send({
                type: 'send_prompt',
                sessionId: activeSession.id,
                prompt: text,
              })
            }
            onCancel={() =>
              wsRef.current?.send({ type: 'cancel', sessionId: activeSession.id })
            }
          />
        ) : (
          <div className="empty">
            <p>No session selected.</p>
            <button onClick={() => setShowNew(true)}>Create one</button>
          </div>
        )}
      </main>

      {activePermission && (
        <PermissionModal
          request={activePermission}
          onResolve={(allow) =>
            wsRef.current?.send({
              type: 'permission_response',
              sessionId: activePermission.sessionId,
              requestId: activePermission.requestId,
              allow,
            })
          }
        />
      )}

      {showNew && (
        <NewSessionDialog
          defaultCwd={defaultCwd}
          onCancel={() => setShowNew(false)}
          onCreate={(agent, cwd, title) => {
            wsRef.current?.send({ type: 'create_session', agent, cwd, title });
            setShowNew(false);
          }}
        />
      )}
    </div>
  );
}
