import {
  BRIDGE_PROTOCOL_NAMESPACES,
  BridgeSessionErrorCode,
  type ErrorPayload,
  PROTOCOL_VERSION,
  type WsMessage,
} from "@wendoo/bridge-protocol";
import { WsClient } from "../ws-client.js";

type InternalHandler = (msg: WsMessage) => void;

/** Lifecycle state of a {@link ProjectSession}. */
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting";

/** Map of event names to payload types for {@link ProjectSession.addEventListener}. */
export interface SessionEventMap {
  status: ConnectionStatus;
  /**
   * Stable code of the failure that ended the session: one this side detected,
   * or one the bridge reported in a `session:error`. Fires before `status`
   * becomes `"disconnected"`. The session is stopped afterwards; call `start()`
   * to open a new one.
   */
  error: BridgeSessionErrorCode;
  /**
   * The bridge reported that the session's counterpart disconnected. The
   * session, its connection, and its binding token are unaffected; the next
   * accepted `session:welcome` means the counterpart is connected again.
   */
  counterpartAway: undefined;
}

/** Mutable session-scoped metadata persisted across reconnects. */
export interface SessionMeta {
  /** Token used to rebind to a previously established session. */
  bindingToken?: string;
}

/**
 * Session layer over {@link WsClient}: sends a `session:hello` as the first
 * frame of every connection, ahead of any messages queued while connecting or
 * reconnecting, tracks the session id and binding token, and lets callers
 * subscribe to typed inbound messages.
 *
 * Each hello presents the binding token and session id this session holds.
 * Until this session accepts a `session:welcome`, each hello also presents
 * the join code passed to the constructor; the first accepted welcome
 * discards it, so every later hello, on a reconnect or after `start()`,
 * presents the token and session id alone.
 *
 * @typeParam TClient - Union of message types this side may send.
 * @typeParam TServer - Union of message types this side may receive.
 */
export class ProjectSession<TClient extends WsMessage, TServer extends WsMessage> {
  private _client: WsClient | undefined;
  private _status: ConnectionStatus = "disconnected";
  private _eventListeners = new Map<string, Set<(value: never) => void>>();
  private _messageHandlers = new Map<string, Set<InternalHandler>>();
  private _payloadListeners = new Set<InternalHandler>();
  private _clientUnsubs: (() => void)[] = [];
  private _wsPath: string;
  private _bridgeUrl: string;
  private _sessionId: string | undefined;
  /** The join code hellos present; `undefined` once a welcome has been accepted. */
  private _joinCode: string | undefined;
  private _meta: SessionMeta;

  /**
   * @param wsPath - Path of the bridge endpoint to connect to.
   * @param bridgeUrl - Bridge address as a host with an optional port.
   * @param meta - Metadata that persists across reconnects.
   * @param joinCode - Join code the hellos present until a welcome is accepted.
   */
  constructor(wsPath: string, bridgeUrl: string, meta: SessionMeta, joinCode?: string) {
    this._wsPath = wsPath;
    this._bridgeUrl = bridgeUrl;
    this._meta = meta;
    this._joinCode = joinCode;
    this.addEventListener("status", (status) => {
      if (status === "connected") {
        const payload: Record<string, string | number> = {
          protocolVersion: PROTOCOL_VERSION,
        };
        if (this._meta.bindingToken) payload.bindingToken = this._meta.bindingToken;
        if (this._sessionId) payload.sessionId = this._sessionId;
        if (this._joinCode) payload.joinCode = this._joinCode;
        this._client!.sendImmediate({ type: "session:hello", payload });
      }
    });
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  start(): void {
    if (this._client) return;

    const url = buildWsUrl(this._bridgeUrl, this._wsPath);

    this._client = new WsClient({ heartbeatMessage: { type: "control:ping" } });
    this._client.onOpen = () => {
      this.setStatus("connected");
    };
    this._client.onDisconnect = () => {
      this.setStatus("reconnecting");
    };
    this._client.onMessage = (msg) => {
      this.deliverPayload(msg);
    };
    this._client.onQueueOverflow = () => {
      this.fail(BridgeSessionErrorCode.OUTBOUND_QUEUE_OVERFLOW);
    };
    this.setStatus("connecting");
    // Registered ahead of the caller's handlers: ending the session removes
    // every handler, so a rejected welcome or a coded error reaches no other.
    this._clientUnsubs.push(
      this._client.on("session:welcome", (msg: WsMessage) => {
        const payload = msg.payload as
          | { protocolVersion?: number; sessionId?: string; bindingToken?: string }
          | undefined;
        if (payload?.protocolVersion !== PROTOCOL_VERSION) {
          this.fail(BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH);
          return;
        }
        if (payload?.sessionId) {
          this._sessionId = payload.sessionId;
        }
        if (payload?.bindingToken) {
          this._meta.bindingToken = payload.bindingToken;
        }
        this._joinCode = undefined;
      }),
      this._client.on("session:error", (msg: WsMessage) => {
        const code = (msg.payload as ErrorPayload | undefined)?.code;
        if (code !== undefined) {
          this.fail(code);
        }
      }),
      this._client.on("session:counterpartAway", () => {
        this.emit("counterpartAway", undefined);
      })
    );
    this.reregisterHandlers();
    this._client.connect(url);
  }

  stop(): void {
    if (!this._client) return;
    this.closeClient();
    this.setStatus("disconnected");
  }

  /**
   * Subscribe to inbound messages of `type`. The handler stays subscribed
   * across `start()`/`stop()` cycles. A `session:welcome` reaches the handler
   * only when this side accepts it, and a `session:error` only when it carries
   * no `code`. Returns an unsubscribe function.
   */
  on<T extends TServer["type"]>(type: T, handler: (msg: Extract<TServer, { type: T }>) => void): () => void {
    const wrapper: InternalHandler = (msg) => {
      handler(msg as Extract<TServer, { type: T }>);
    };

    let set = this._messageHandlers.get(type);
    if (!set) {
      set = new Set();
      this._messageHandlers.set(type, set);
    }
    set.add(wrapper);

    if (this._client) {
      this._clientUnsubs.push(this._client.on(type, wrapper));
    }

    return () => {
      set.delete(wrapper);
      if (set.size === 0) this._messageHandlers.delete(type);
    };
  }

  send(msg: TClient): void {
    if (!this._client) {
      throw new Error("Session not started");
    }
    this._client.send(msg);
  }

  /**
   * Send a payload message to the peer verbatim. The message's type must lie
   * outside `BRIDGE_PROTOCOL_NAMESPACES`. Throws if the session is not started.
   */
  sendPayload(msg: WsMessage): void {
    if (!this._client) {
      throw new Error("Session not started");
    }
    this._client.send(msg);
  }

  /**
   * Subscribe to payload messages: every inbound message whose type lies
   * outside `BRIDGE_PROTOCOL_NAMESPACES`, except replies to a pending
   * `request()`, delivered as received. The listener stays subscribed across
   * `start()`/`stop()` cycles. Returns an unsubscribe function.
   */
  onPayload(listener: (msg: WsMessage) => void): () => void {
    this._payloadListeners.add(listener);
    return () => {
      this._payloadListeners.delete(listener);
    };
  }

  request(type: string, payload?: unknown, seq?: number): Promise<WsMessage> {
    if (!this._client) {
      throw new Error("Session not started");
    }
    return this._client.request(type, payload, seq);
  }

  addEventListener<K extends keyof SessionEventMap>(
    event: K,
    listener: (value: SessionEventMap[K]) => void
  ): () => void {
    let set = this._eventListeners.get(event);
    if (!set) {
      set = new Set();
      this._eventListeners.set(event, set);
    }
    set.add(listener as (value: never) => void);
    return () => {
      set.delete(listener as (value: never) => void);
      if (set.size === 0) this._eventListeners.delete(event);
    };
  }

  private emit<K extends keyof SessionEventMap>(event: K, value: SessionEventMap[K]): void {
    const set = this._eventListeners.get(event);
    if (set) {
      for (const listener of set) {
        (listener as (value: SessionEventMap[K]) => void)(value);
      }
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this._status === next) return;
    this._status = next;
    this.emit("status", next);
  }

  private closeClient(): void {
    for (const unsub of this._clientUnsubs) unsub();
    this._clientUnsubs = [];
    this._client!.send({ type: "session:goodbye" });
    this._client!.close();
    this._client = undefined;
  }

  private fail(code: BridgeSessionErrorCode): void {
    this.closeClient();
    this.emit("error", code);
    this.setStatus("disconnected");
  }

  private deliverPayload(msg: WsMessage): void {
    const namespace = msg.type.split(":", 1)[0];
    if (BRIDGE_PROTOCOL_NAMESPACES.includes(namespace)) return;
    for (const listener of this._payloadListeners) {
      listener(msg);
    }
  }

  private reregisterHandlers(): void {
    for (const [type, handlers] of this._messageHandlers) {
      for (const handler of handlers) {
        this._clientUnsubs.push(this._client!.on(type, handler));
      }
    }
  }
}

function buildWsUrl(bridgeUrl: string, wsPath: string): string {
  const withoutScheme = bridgeUrl.replace(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//, "");
  const parsed = new URL(`http://${withoutScheme}`);
  const { hostname, port } = parsed;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  const scheme = isLocalhost ? "ws://" : "wss://";
  const portPart = port !== "" ? `:${port}` : "";
  return `${scheme}${hostname}${portPart}/${wsPath}`;
}
