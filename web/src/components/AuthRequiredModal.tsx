import { useState } from 'react';
import type { AuthRequiredInfo } from '../../../shared/types';

interface Props {
  info: AuthRequiredInfo;
  onDismiss: () => void;
  /** Re-run the last user prompt on this session. Modal dismisses itself
   *  after firing — if auth is still broken, the server will emit another
   *  auth_required and the modal pops back up. */
  onRetry: () => void;
}

export function AuthRequiredModal({ info, onDismiss, onRetry }: Props) {
  const [copied, setCopied] = useState(false);

  const where =
    info.context === 'this-machine'
      ? 'on this machine (where the dev server is running)'
      : 'on the machine where your vvibe daemon is running';

  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(info.fixCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be unavailable in non-https origins — silently ignore.
      // User can still select-and-copy from the visible block.
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>{info.agent} CLI is not signed in</h3>
        <p>
          The <code>{info.agent}</code> CLI reported that it isn't logged in.
          Open a terminal {where} and run:
        </p>
        <div className="auth-cmd-row">
          <pre className="auth-cmd">{info.fixCommand}</pre>
          <button type="button" onClick={copyCmd}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="auth-hint">
          Then click <em>I've logged in, retry</em> below and we'll re-run
          your last message automatically.
        </p>
        <details className="auth-raw">
          <summary>Raw error from {info.agent}</summary>
          <pre className="tool-input">{info.rawError}</pre>
        </details>
        <div className="modal-actions">
          <button type="button" onClick={onDismiss}>
            Dismiss
          </button>
          <button type="button" className="allow" onClick={onRetry}>
            I've logged in, retry
          </button>
        </div>
      </div>
    </div>
  );
}
