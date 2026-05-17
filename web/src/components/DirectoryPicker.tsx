import { useEffect, useRef, useState } from 'react';
import type { DeviceInfo, DirEntry, ServerMessage } from '../../../shared/types';
import type { WSClient } from '../ws';

interface Props {
  ws: WSClient;
  initialPath: string;
  deviceId?: string;
  devices: DeviceInfo[];
  onPick: (absPath: string) => void;
  onCancel: () => void;
}

interface Listing {
  path: string;
  parent?: string;
  entries: DirEntry[];
  error?: string;
}

export function DirectoryPicker({ ws, initialPath, deviceId, devices, onPick, onCancel }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef<string>('');
  // Track requestId for the in-flight call so we ignore stale responses if the
  // user clicks through directories faster than the daemon round-trips.
  const triedHomeFallbackRef = useRef(false);

  useEffect(() => {
    requestIdRef.current = '';
    triedHomeFallbackRef.current = false;
    const off = ws.on((msg: ServerMessage) => {
      if (msg.type !== 'dir_listing') return;
      if (msg.requestId !== requestIdRef.current) return;
      // Initial-fetch fallback: if the requested path doesn't exist on the
      // daemon (e.g. cwd field was pre-filled with a path that's valid on
      // the server but not on the daemon's machine), silently retry with
      // empty path so the daemon resolves it to the user's home dir. Only
      // attempted once, otherwise a genuinely broken home would loop.
      if (msg.error && !triedHomeFallbackRef.current && msg.path !== '') {
        triedHomeFallbackRef.current = true;
        fetchDir('');
        return;
      }
      setLoading(false);
      setListing({
        path: msg.path,
        parent: msg.parent,
        entries: msg.entries,
        error: msg.error,
      });
    });
    fetchDir(initialPath);
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, deviceId]);

  function fetchDir(target: string) {
    const requestId = `dir-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    requestIdRef.current = requestId;
    setLoading(true);
    ws.send({ type: 'list_dir', requestId, deviceId, path: target });
  }

  const selectedDevice = deviceId ? devices.find((d) => d.id === deviceId) : undefined;
  const scopeLabel = selectedDevice
    ? (selectedDevice.displayName ?? selectedDevice.hostname)
    : devices.length > 0
      ? (devices[0].displayName ?? devices[0].hostname)
      : 'local server';

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal dir-picker" onClick={(e) => e.stopPropagation()}>
        <div className="dir-picker-header">
          <h3>Pick a folder</h3>
          <span className="muted">on {scopeLabel}</span>
        </div>
        <div className="dir-picker-path">
          <code>{listing?.path || (loading ? 'Loading…' : initialPath || '~')}</code>
        </div>
        {listing?.error && <p className="warning">{listing.error}</p>}
        <ul className="dir-list">
          {listing?.parent && (
            <li className="dir-up" onClick={() => fetchDir(listing.parent!)}>
              ..
            </li>
          )}
          {listing?.entries.map((e) => (
            <li
              key={e.name}
              onClick={() =>
                fetchDir(joinPath(listing.path, e.name))
              }
            >
              {e.name}
            </li>
          ))}
          {!loading && listing && listing.entries.length === 0 && !listing.error && (
            <li className="muted dir-empty">(no subfolders)</li>
          )}
        </ul>
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="allow"
            disabled={!listing?.path || !!listing?.error}
            onClick={() => listing?.path && onPick(listing.path)}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * OS-agnostic path join. The daemon returned `base` so we honour its
 * separator style: backslash on Windows results, forward slash elsewhere.
 * Avoids importing node:path in the browser and avoids guessing OS from
 * navigator (the daemon may run on a different machine than the browser).
 */
function joinPath(base: string, child: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  if (base.endsWith(sep)) return base + child;
  return base + sep + child;
}
