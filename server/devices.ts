import { randomUUID } from 'node:crypto';
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

  get(id: string): Device | undefined {
    return this.devices.get(id);
  }

  /**
   * Pick a daemon to run an agent on. Single-daemon MVP: return the first
   * connected daemon, or undefined if none. Device picker (M3) replaces this.
   */
  pickRunner(): Device | undefined {
    return this.list()[0];
  }

  register(ws: WebSocket, hello: DeviceHello, remoteAddr: string): Device {
    const device: Device = {
      id: randomUUID(),
      connectedAt: Date.now(),
      remoteAddr,
      ws,
      ...hello,
    };
    this.devices.set(device.id, device);
    this.notify();
    return device;
  }

  unregister(id: string): void {
    if (this.devices.delete(id)) this.notify();
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
