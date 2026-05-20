import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthRequiredInfo,
  ChatMessage,
  DeviceInfo,
  PermissionRequest,
  ServerMessage,
  SessionMeta,
} from '../../shared/types';
import { WSClient, makeWsUrl } from './ws';
import { SessionList } from './components/SessionList';
import { ChatPane } from './components/ChatPane';
import { PermissionModal } from './components/PermissionModal';
import { AuthRequiredModal } from './components/AuthRequiredModal';
import { NewSessionDialog } from './components/NewSessionDialog';
import { LoginGate } from './components/LoginGate';
import { PairPage } from './components/PairPage';
import { DevicesPanel } from './components/DevicesPanel';

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
  // Keyed by sessionId so a re-send doesn't queue a second modal on top of
  // the dismissed one — the latest auth_required for a given session wins.
  const [authRequired, setAuthRequired] = useState<Record<string, AuthRequiredInfo>>({});
  const [showNew, setShowNew] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // Server-side rejections (e.g. codex gated behind CODEX_TRUST_DEFAULTS,
  // unknown device, cwd doesn't exist) used to go to console-only and the
  // user just saw "nothing happened". Stack them as dismissible toasts so
  // every server `{type:'error'}` becomes visible.
  const [serverErrors, setServerErrors] = useState<{ id: number; text: string }[]>([]);
  const errorIdRef = useRef(0);

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
      case 'auth_required':
        setAuthRequired((prev) => ({ ...prev, [msg.sessionId]: msg.info }));
        break;
      case 'devices':
        setDevices(msg.devices);
        break;
      case 'error': {
        console.error('[server error]', msg.error);
        const id = ++errorIdRef.current;
        setServerErrors((prev) => [...prev, { id, text: msg.error }]);
        break;
      }
    }
  }

  const sessionList = useMemo(
    () => Object.values(sessions).sort((a, b) => a.createdAt - b.createdAt),
    [sessions],
  );

  // Count anything that could be burning tokens right now — drives the
  // "Stop all" emergency-brake button visibility.
  const runningCount = useMemo(
    () =>
      sessionList.filter(
        (s) => s.status === 'running' || s.status === 'awaiting_permission',
      ).length,
    [sessionList],
  );

  const activeSession = activeId ? sessions[activeId] : undefined;
  const activeMessages = activeId ? (messages[activeId] ?? []) : [];

  const activePermission = pendingPermissions.find((p) => p.sessionId === activeId);
  const activeAuthRequired = activeId ? authRequired[activeId] : undefined;

  return (
    <div className="app">
      {serverErrors.length > 0 && (
        <div className="toast-stack" role="alert" aria-live="polite">
          {serverErrors.map((e) => (
            <div key={e.id} className="toast toast-error">
              <span className="toast-text">{e.text}</span>
              <button
                type="button"
                className="toast-dismiss"
                aria-label="Dismiss"
                onClick={() =>
                  setServerErrors((prev) => prev.filter((p) => p.id !== e.id))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>Agent Web</h1>
          <button className="new-btn" onClick={() => setShowNew(true)}>
            + New
          </button>
        </div>
        <SessionList
          sessions={sessionList}
          devices={devices}
          activeId={activeId}
          onSelect={setActiveId}
          onDelete={(id) => wsRef.current?.send({ type: 'delete_session', sessionId: id })}
        />
        <DevicesPanel devices={devices} />
        {runningCount > 0 && (
          <div className="sidebar-stop-all">
            <button
              type="button"
              className="stop-all-btn"
              onClick={() => {
                if (
                  confirm(
                    `Cancel ${runningCount} running session${runningCount === 1 ? '' : 's'}? This stops the agent immediately.`,
                  )
                ) {
                  wsRef.current?.send({ type: 'cancel_all' });
                }
              }}
              title="Cancel every running session in one click — emergency brake."
            >
              Stop all ({runningCount})
            </button>
          </div>
        )}
        <div className="sidebar-footer">
          {me.user && (
            <>
              <span className="muted user-login">{me.user.login}</span>
              <button
                className="logout link-button"
                onClick={async () => {
                  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
                  window.location.href = '/';
                }}
              >
                Sign out
              </button>
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

      {activeAuthRequired && activeId && (
        <AuthRequiredModal
          info={activeAuthRequired}
          onDismiss={() =>
            setAuthRequired((prev) => {
              const next = { ...prev };
              delete next[activeId];
              return next;
            })
          }
          onRetry={() => {
            // Optimistically close the modal. If auth is still broken, the
            // server will emit another auth_required and the modal will
            // reopen automatically.
            wsRef.current?.send({ type: 'retry_last', sessionId: activeId });
            setAuthRequired((prev) => {
              const next = { ...prev };
              delete next[activeId];
              return next;
            });
          }}
        />
      )}

      {showNew && wsRef.current && (
        <NewSessionDialog
          defaultCwd={defaultCwd}
          devices={devices}
          ws={wsRef.current}
          onCancel={() => setShowNew(false)}
          onCreate={(agent, cwd, title, deviceId, model) => {
            wsRef.current?.send({ type: 'create_session', agent, cwd, title, deviceId, model });
            setShowNew(false);
          }}
        />
      )}
    </div>
  );
}
