import type { WebSocket } from 'ws';
import type { DaemonClientMessage, DaemonServerMessage } from '../shared/types.ts';

export interface DeviceHello {
  hostname: string;
  displayName?: string;
  os: string;
  arch: string;
  version: string;
  agents: Array<{ name: string; path: string }>;
  pid: number;
}

export interface Device extends DeviceHello {
  id: string;
  userId: string;
  connectedAt: number;
  remoteAddr: string;
  ws: WebSocket;
}

/**
 * In-memory registry of connected local daemons. Single-user MVP: we don't
 * persist or authenticate beyond the bearer token that the daemon sends in
 * the upgrade headers (the HTTP handler is expected to validate that before
 * inserting here).
 */
export class DeviceRegistry {
  private devices = new Map<string, Device>();
  private listeners = new Set<(devices: Device[]) => void>();
  private daemonListeners = new Set<(deviceId: string, msg: DaemonClientMessage) => void>();

  list(): Device[] {
    return [...this.devices.values()];
  }

  /**
   * List a single user's connected daemons. Use this anywhere a browser is
   * asking "what devices are mine?" — `list()` returns every daemon across
   * users and is only correct for global housekeeping.
   */
  listForUser(userId: string): Device[] {
    return this.list().filter((d) => d.userId === userId);
  }

  get(id: string): Device | undefined {
    return this.devices.get(id);
  }

  /**
   * Pick a daemon to run an agent on for a given user. Single-daemon MVP per
   * user: return the user's first connected daemon, or undefined if none.
   */
  pickRunner(userId: string): Device | undefined {
    return this.listForUser(userId)[0];
  }

  /**
   * Register a connected daemon. `id` must be a value stable across reconnects
   * (the device_tokens.id from the daemon's bearer token, or a synthetic
   * userId-scoped id for anon dev mode). Using a stable id is load-bearing:
   * agent_sessions.preferred_device_id stores this value, so a daemon reboot
   * cycling through random UUIDs would silently un-pin every session and let
   * the cross-device fallback kick in.
   *
   * If a connection with the same id is already registered, the previous WS
   * is closed and the new connection wins. This handles a daemon process
   * restarting before the previous WS has been declared dead by the ping
   * watchdog — without eviction, the stale entry would shadow the live one.
   */
  register(id: string, ws: WebSocket, userId: string, hello: DeviceHello, remoteAddr: string): Device {
    const prior = this.devices.get(id);
    if (prior && prior.ws !== ws) {
      try {
        prior.ws.close(4001, 'replaced by newer connection');
      } catch {
        /* ignore */
      }
    }
    const device: Device = {
      id,
      userId,
      connectedAt: Date.now(),
      remoteAddr,
      ws,
      ...hello,
    };
    this.devices.set(device.id, device);
    this.notify();
    return device;
  }

  /**
   * Remove a device from the registry. Pass `ws` when called from a close
   * handler so we don't unregister a *newer* connection that replaced us in
   * register(): the prior ws's close fires after the eviction and would
   * otherwise drop the live entry.
   */
  unregister(id: string, ws?: WebSocket): void {
    const cur = this.devices.get(id);
    if (!cur) return;
    if (ws && cur.ws !== ws) return;
    this.devices.delete(id);
    this.notify();
  }

  onChange(fn: (devices: Device[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Subscribe to daemon → server messages (daemon_message, daemon_done, etc.).
   * Server's daemon WS handler calls dispatchDaemonMessage() per incoming msg.
   */
  onDaemonMessage(fn: (deviceId: string, msg: DaemonClientMessage) => void): () => void {
    this.daemonListeners.add(fn);
    return () => {
      this.daemonListeners.delete(fn);
    };
  }

  dispatchDaemonMessage(deviceId: string, msg: DaemonClientMessage): void {
    for (const l of this.daemonListeners) l(deviceId, msg);
  }

  sendToDevice(id: string, msg: DaemonServerMessage): boolean {
    const d = this.devices.get(id);
    if (!d || d.ws.readyState !== d.ws.OPEN) return false;
    d.ws.send(JSON.stringify(msg));
    return true;
  }

  private notify() {
    const list = this.list();
    for (const l of this.listeners) l(list);
  }
}
