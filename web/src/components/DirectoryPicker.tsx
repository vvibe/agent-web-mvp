import { useEffect, useMemo, useRef, useState } from 'react';
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

// looksLikeAbsolutePath returns true when the query string looks like a
// full path the daemon could resolve, rather than a filter for the
// current directory. Covers Unix absolute (`/foo`), Windows drive
// (`C:\…`, `c:/…`), UNC (`\\server\…`), and the home shorthand `~`.
//
// We deliberately match conservatively — false positives would send the
// daemon a path it'll reject (no harm), but false negatives would mean
// pasting an obvious path quietly does nothing.
function looksLikeAbsolutePath(s: string): boolean {
  const t = s.trim();
  if (t === '') return false;
  if (t === '~') return true;
  if (t.startsWith('/')) return true;
  if (t.startsWith('\\\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  return false;
}

export function DirectoryPicker({ ws, initialPath, deviceId, devices, onPick, onCancel }: Props) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  // Query box value. Doubles as (1) a filter over the current dir's
  // entries — substring, case-insensitive — and (2) an absolute-path
  // entry: Enter on a path-shaped query jumps the daemon to that path.
  const [query, setQuery] = useState('');
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
    // Clear the filter whenever we move directories — leaving a stale
    // filter in place would silently hide the new dir's contents and
    // looks like a bug ("why is this folder empty?").
    setQuery('');
  }

  // Filter the current dir's entries by query (substring, case-insensitive)
  // *unless* the query looks like an absolute path. Path-shaped queries
  // are handled by the Enter key handler — filtering by them would just
  // empty the list (no entry name contains a `\` or `/`).
  const filteredEntries = useMemo(() => {
    if (!listing) return [];
    const q = query.trim().toLowerCase();
    if (q === '' || looksLikeAbsolutePath(q)) return listing.entries;
    return listing.entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [listing, query]);

  function onQueryKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      // Stop the modal-backdrop click handler from firing on Esc paths
      // through other shortcuts and dismissing the picker entirely.
      e.preventDefault();
      setQuery('');
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const trimmed = query.trim();
    if (trimmed === '') return;
    if (looksLikeAbsolutePath(trimmed)) {
      // Daemon resolves "" as the user's home; `~` is a UI shorthand
      // for the same intent. Anything else, pass through verbatim.
      fetchDir(trimmed === '~' ? '' : trimmed);
      return;
    }
    // Not a path — interpret as filter+enter. If exactly one filtered
    // entry remains, navigate into it; otherwise no-op (no need to be
    // clever about ambiguous matches).
    if (filteredEntries.length === 1 && listing) {
      fetchDir(joinPath(listing.path, filteredEntries[0].name));
    }
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
        <input
          type="text"
          className="dir-picker-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKeyDown}
          placeholder="filter… or paste a full path + Enter (e.g. C:\Users\you\repo)"
          autoFocus
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        {listing?.error && <p className="warning">{listing.error}</p>}
        <ul className="dir-list">
          {listing?.parent && (
            <li className="dir-up" onClick={() => fetchDir(listing.parent!)}>
              ..
            </li>
          )}
          {filteredEntries.map((e) => (
            <li
              key={e.name}
              onClick={() =>
                listing && fetchDir(joinPath(listing.path, e.name))
              }
            >
              {e.name}
            </li>
          ))}
          {!loading && listing && filteredEntries.length === 0 && !listing.error && (
            <li className="muted dir-empty">
              {query.trim() && !looksLikeAbsolutePath(query)
                ? `(no subfolders match "${query.trim()}")`
                : '(no subfolders)'}
            </li>
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
