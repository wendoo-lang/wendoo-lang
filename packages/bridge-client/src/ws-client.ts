import type { WsMessage } from "@wendoo/bridge-protocol";

type MessageHandler = (msg: WsMessage) => void;

type WsClientState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

interface WsClientOptions {
  maxReconnectDelay?: number;
  initialReconnectDelay?: number;
  requestTimeout?: number;
  heartbeatInterval?: number;
  heartbeatMessage?: WsMessage;
  maxMissedHeartbeats?: number;
  maxQueueSize?: number;
}

const DEFAULT_MAX_RECONNECT_DELAY = 30_000;
const DEFAULT_INITIAL_RECONNECT_DELAY = 500;
const DEFAULT_REQUEST_TIMEOUT = 30_000;
const DEFAULT_HEARTBEAT_INTERVAL = 15_000;
const DEFAULT_MAX_MISSED_HEARTBEATS = 2;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

/**
 * Reconnecting WebSocket client used by {@link ProjectSession}. Handles
 * heartbeats, request/response correlation by message `id`, and queueing of
 * outbound messages while disconnected.
 */
export class WsClient {
  private ws: WebSocket | undefined;
  private url = "";
  private state: WsClientState = "idle";
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly initialReconnectDelay: number;
  private readonly requestTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly heartbeatMessage: WsMessage;
  private readonly maxMissedHeartbeats: number;
  private readonly maxQueueSize: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private missedHeartbeats = 0;

  onOpen?: () => void;
  onDisconnect?: () => void;
  /**
   * Called with every inbound message that is not a reply to a pending
   * {@link request}, after the listeners registered for its type.
   */
  onMessage?: (msg: WsMessage) => void;

  private readonly pendingRequests = new Map<
    string,
    { resolve: (msg: WsMessage) => void; reject: (err: Error) => void }
  >();
  private readonly queuedMessages: WsMessage[] = [];
  private readonly listeners = new Map<string, Set<MessageHandler>>();

  constructor(options?: WsClientOptions) {
    this.maxReconnectDelay = options?.maxReconnectDelay ?? DEFAULT_MAX_RECONNECT_DELAY;
    this.initialReconnectDelay = options?.initialReconnectDelay ?? DEFAULT_INITIAL_RECONNECT_DELAY;
    this.requestTimeout = options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT;
    this.heartbeatInterval = options?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.heartbeatMessage = options?.heartbeatMessage ?? { type: "ping" };
    this.maxMissedHeartbeats = options?.maxMissedHeartbeats ?? DEFAULT_MAX_MISSED_HEARTBEATS;
    this.maxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    this.reconnectDelay = this.initialReconnectDelay;
  }

  get connectionState(): WsClientState {
    return this.state;
  }

  connect(url: string): void {
    if (this.state === "open" || this.state === "connecting") {
      return;
    }
    this.url = url;
    this.state = "connecting";
    this.openSocket();
  }

  close(): void {
    this.state = "closed";
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.rejectAllPending(new Error("client closed"));
    this.ws?.close();
    this.ws = undefined;
  }

  send(msg: WsMessage): void {
    if (this.state === "open" && this.ws) {
      if (this.queuedMessages.length > 0) {
        this.enqueue(msg);
        if (this.state === "open") {
          this.flushQueue();
        }
      } else {
        try {
          this.ws.send(JSON.stringify(msg));
        } catch {
          this.enqueue(msg);
        }
      }
    } else if (this.state === "connecting" || this.state === "reconnecting") {
      this.enqueue(msg);
    }
  }

  request(type: string, payload?: unknown, seq?: number): Promise<WsMessage> {
    const id = crypto.randomUUID();
    const msg: WsMessage = { type, id, payload, seq };

    return new Promise<WsMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`request timed out: ${type}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.send(msg);
    });
  }

  on(type: string, handler: MessageHandler): () => void {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.listeners.delete(type);
      }
    };
  }

  private openSocket(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.handleDisconnect();
      return;
    }

    ws.onopen = () => {
      this.ws = ws;
      this.state = "open";
      this.reconnectDelay = this.initialReconnectDelay;
      this.startHeartbeat();
      this.onOpen?.();
      this.flushQueue();
    };

    ws.onmessage = (event: MessageEvent) => {
      // Any received message counts as proof of life.
      this.missedHeartbeats = 0;
      let msg: WsMessage;
      try {
        msg = JSON.parse(String(event.data)) as WsMessage;
      } catch {
        return;
      }
      this.handleMessage(msg);
    };

    ws.onclose = () => {
      this.handleDisconnect();
    };

    ws.onerror = () => {
      // onclose fires after onerror, so reconnect logic is handled there
    };
  }

  private handleMessage(msg: WsMessage): void {
    if (msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg);
        return;
      }
    }

    const handlers = this.listeners.get(msg.type);
    if (handlers) {
      for (const handler of handlers) {
        handler(msg);
      }
    }
    this.onMessage?.(msg);
  }

  private handleDisconnect(): void {
    this.stopHeartbeat();
    this.ws = undefined;
    if (this.state === "closed") {
      return;
    }
    this.state = "reconnecting";
    this.onDisconnect?.();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      this.maxReconnectDelay,
      this.initialReconnectDelay + Math.random() * (this.reconnectDelay * 3 - this.initialReconnectDelay)
    );
    this.reconnectTimer = setTimeout(() => {
      if (this.state !== "reconnecting") {
        return;
      }
      this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatInterval <= 0) return;
    this.missedHeartbeats = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== "open" || !this.ws) return;
      this.missedHeartbeats++;
      if (this.missedHeartbeats > this.maxMissedHeartbeats) {
        this.ws.close();
        return;
      }
      this.send(this.heartbeatMessage);
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private enqueue(msg: WsMessage): void {
    // Kill-switch: if the queue grows beyond the limit, the connection is
    // unrecoverably behind. Drop all queued messages and force-close.
    if (this.queuedMessages.length >= this.maxQueueSize) {
      this.queuedMessages.length = 0;
      this.close();
      return;
    }
    this.queuedMessages.push(msg);
  }

  private flushQueue(): void {
    const queued = this.queuedMessages.splice(0);
    for (const msg of queued) {
      this.send(msg);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(err);
      this.pendingRequests.delete(id);
    }
  }
}
