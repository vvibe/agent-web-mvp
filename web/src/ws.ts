import type { ClientMessage, ServerMessage } from '../../shared/types';

type Listener = (msg: ServerMessage) => void;

export class WSClient {
  private ws: WebSocket | undefined;
  private listeners = new Set<Listener>();
  private queue: ClientMessage[] = [];
  private reconnectDelay = 500;

  constructor(private url: string) {
    this.connect();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  private connect() {
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener('open', () => {
      this.reconnectDelay = 500;
      while (this.queue.length > 0) {
        const m = this.queue.shift()!;
        this.ws!.send(JSON.stringify(m));
      }
    });

    this.ws.addEventListener('message', (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      for (const l of this.listeners) l(msg);
    });

    this.ws.addEventListener('close', () => {
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
    });

    this.ws.addEventListener('error', () => {
      this.ws?.close();
    });
  }
}

export function makeWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}
