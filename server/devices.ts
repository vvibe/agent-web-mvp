import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';

export interface DeviceHello {
  hostname: string;
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

  list(): Device[] {
    return [...this.devices.values()];
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

  private notify() {
    const list = this.list();
    for (const l of this.listeners) l(list);
  }
}
