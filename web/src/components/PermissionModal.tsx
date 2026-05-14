import type { PermissionRequest } from '../../../shared/types';

interface Props {
  request: PermissionRequest;
  onResolve: (allow: boolean) => void;
}

export function PermissionModal({ request, onResolve }: Props) {
  const pretty = (() => {
    try {
      return JSON.stringify(request.input, null, 2);
    } catch {
      return String(request.input);
    }
  })();

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Permission requested</h3>
        <p>
          Claude wants to use tool <code>{request.toolName}</code>.
        </p>
        <pre className="tool-input">{pretty}</pre>
        <div className="modal-actions">
          <button className="deny" onClick={() => onResolve(false)}>
            Deny
          </button>
          <button className="allow" onClick={() => onResolve(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
