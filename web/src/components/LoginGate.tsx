interface Props {
  authEnabled: boolean;
  returnTo?: string;
}

export function LoginGate({ authEnabled, returnTo }: Props) {
  const href = `/auth/github${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`;
  return (
    <div className="login-gate">
      <div className="login-gate-card">
        <h1>Agent Web</h1>
        <p className="muted">Drive Claude or Codex on your own machine from anywhere.</p>
        {authEnabled ? (
          <a className="github-btn" href={href}>
            Sign in with GitHub
          </a>
        ) : (
          <p className="muted">
            Auth is not configured. Set <code>GITHUB_CLIENT_ID</code> and{' '}
            <code>GITHUB_CLIENT_SECRET</code> on the server.
          </p>
        )}
      </div>
    </div>
  );
}
