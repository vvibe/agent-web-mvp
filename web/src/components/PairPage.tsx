import { useEffect, useState } from 'react';

type LookupState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: string; deviceName: string | null }
  | { kind: 'not_found' }
  | { kind: 'error'; message: string };

type ApproveState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

interface Props {
  code: string;
  user: { login: string; name: string | null } | null;
}

export function PairPage({ code, user }: Props) {
  const [lookup, setLookup] = useState<LookupState>({ kind: 'loading' });
  const [approve, setApprove] = useState<ApproveState>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    fetch(`/api/device/pair-lookup?code=${encodeURIComponent(code)}`)
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 404) {
          setLookup({ kind: 'not_found' });
          return;
        }
        if (!r.ok) {
          setLookup({ kind: 'error', message: `HTTP ${r.status}` });
          return;
        }
        const data = (await r.json()) as { status: string; device_name: string | null };
        setLookup({ kind: 'ready', status: data.status, deviceName: data.device_name });
      })
      .catch((err) => {
        if (!alive) return;
        setLookup({ kind: 'error', message: err.message ?? String(err) });
      });
    return () => {
      alive = false;
    };
  }, [code]);

  async function onApprove() {
    setApprove({ kind: 'submitting' });
    try {
      const r = await fetch('/api/device/pair-approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setApprove({ kind: 'error', message: data.error ?? `HTTP ${r.status}` });
        return;
      }
      setApprove({ kind: 'done' });
    } catch (err) {
      setApprove({ kind: 'error', message: (err as Error).message });
    }
  }

  return (
    <div className="pair-page">
      <div className="pair-card">
        <h1>Pair a device</h1>
        {lookup.kind === 'loading' && <p className="muted">Looking up code…</p>}
        {lookup.kind === 'not_found' && (
          <p className="error">
            No pairing code matches <code>{code}</code>. It may have expired — run{' '}
            <code>vvibe login</code> again on your machine.
          </p>
        )}
        {lookup.kind === 'error' && <p className="error">Error: {lookup.message}</p>}
        {lookup.kind === 'ready' && (
          <>
            <p>
              A daemon on{' '}
              <strong>{lookup.deviceName ?? '(unnamed device)'}</strong> is asking to bind to your
              account{user ? ` (${user.login})` : ''}.
            </p>
            <p className="muted">Code: <code>{code}</code> · Status: <strong>{lookup.status}</strong></p>

            {lookup.status === 'pending' && approve.kind !== 'done' && (
              <div className="pair-actions">
                <button
                  className="approve"
                  onClick={onApprove}
                  disabled={approve.kind === 'submitting'}
                >
                  {approve.kind === 'submitting' ? 'Approving…' : 'Approve'}
                </button>
                <a className="cancel" href="/">
                  Cancel
                </a>
              </div>
            )}
            {approve.kind === 'error' && <p className="error">{approve.message}</p>}
            {(lookup.status === 'approved' || approve.kind === 'done') && (
              <p className="success">
                Approved. Your daemon should pick up the token within a few seconds — return to{' '}
                <a href="/">the home page</a>.
              </p>
            )}
            {lookup.status === 'expired' && (
              <p className="error">This code has expired. Re-run <code>vvibe login</code>.</p>
            )}
            {lookup.status === 'denied' && (
              <p className="error">This code was denied.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
