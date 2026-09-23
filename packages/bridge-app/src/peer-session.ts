import type { PeerSessionHelloMessage } from "@wendoo/bridge-protocol";
import { PeerSessionErrorCode } from "@wendoo/bridge-protocol";

/**
 * A session kind: its name, which prefixes its message types, and the newest
 * protocol version this build speaks for it.
 *
 * @typeParam TKind - The kind's name.
 */
export interface PeerSessionKind<TKind extends string> {
  /** The kind's name; its hello message type is `<kind>:hello`. */
  kind: TKind;
  /** Newest protocol version this side speaks for the kind. */
  protocolVersion: number;
}

/**
 * Transport carrying a peer session's messages between this party and
 * its peer. Message order is preserved in both directions.
 *
 * @typeParam TMessage - Every message the session's kind carries, hello
 * included.
 */
export interface PeerSessionPort<TMessage> {
  /** Send one message to the peer. */
  postMessage(message: TMessage): void;
  /** Subscribe to messages from the peer. Returns an unsubscribe function. */
  onMessage(listener: (message: TMessage) => void): () => void;
}

/** Error raised when a peer session cannot be established. */
export class PeerSessionError extends Error {
  /** Stable machine-readable error code. */
  readonly code: PeerSessionErrorCode;

  constructor(code: PeerSessionErrorCode, message: string) {
    super(message);
    this.name = "PeerSessionError";
    this.code = code;
  }
}

/** Options for {@link connectPeerSession}. */
export interface PeerSessionOptions<TKind extends string, TMessage extends { type: string }> {
  /** The session's kind. */
  kind: PeerSessionKind<TKind>;
  /** Transport to the peer. */
  port: PeerSessionPort<PeerSessionHelloMessage<TKind> | TMessage>;
}

/**
 * An established peer session.
 *
 * @typeParam TMessage - The kind's messages other than its hello.
 */
export interface PeerSession<TMessage> {
  /**
   * Protocol version the peer declared in its hello. Never newer than the
   * kind's `protocolVersion`.
   */
  readonly peerProtocolVersion: number;
  /** Send one message to the peer. */
  postMessage(message: TMessage): void;
  /**
   * Subscribe to the peer's messages other than its hello. Messages received
   * while no listener is attached are replayed to the next listener that
   * attaches. Returns an unsubscribe function.
   */
  onMessage(listener: (message: TMessage) => void): () => void;
  /** Detach from the port. */
  dispose(): void;
}

/**
 * Open a peer session of `kind` over `port`: sends this side's hello and
 * waits for the peer's. A peer declaring any version up to the kind's
 * `protocolVersion` is accepted and its version recorded on the session.
 * Rejects with {@link PeerSessionError} carrying
 * `PROTOCOL_VERSION_NEWER` when the peer declares a newer version. A
 * session covers one connection of the peer; open a new session when the
 * peer reconnects.
 *
 * @typeParam TKind - The kind's name.
 * @typeParam TMessage - The kind's messages other than its hello.
 */
export function connectPeerSession<TKind extends string, TMessage extends { type: string }>(
  options: PeerSessionOptions<TKind, TMessage>
): Promise<PeerSession<TMessage>> {
  const { kind, port } = options;
  const helloType: `${TKind}:hello` = `${kind.kind}:hello`;
  const listeners = new Set<(message: TMessage) => void>();
  const buffered: TMessage[] = [];

  return new Promise<PeerSession<TMessage>>((resolve, reject) => {
    const unsubscribe = port.onMessage((message) => {
      if (message.type !== helloType) {
        const sessionMessage = message as TMessage;
        if (listeners.size === 0) {
          buffered.push(sessionMessage);
          return;
        }
        for (const listener of listeners) {
          listener(sessionMessage);
        }
        return;
      }
      const peerProtocolVersion = (message as PeerSessionHelloMessage<TKind>).payload.protocolVersion;
      if (peerProtocolVersion > kind.protocolVersion) {
        unsubscribe();
        reject(
          new PeerSessionError(
            PeerSessionErrorCode.PROTOCOL_VERSION_NEWER,
            `The peer speaks ${kind.kind} session protocol version ${peerProtocolVersion}, newer than this side's ${kind.protocolVersion}; refresh or update this side to connect.`
          )
        );
        return;
      }
      resolve({
        peerProtocolVersion,
        postMessage(sessionMessage: TMessage): void {
          port.postMessage(sessionMessage);
        },
        onMessage(listener: (sessionMessage: TMessage) => void): () => void {
          listeners.add(listener);
          for (const sessionMessage of buffered.splice(0)) {
            listener(sessionMessage);
          }
          return () => {
            listeners.delete(listener);
          };
        },
        dispose(): void {
          unsubscribe();
        },
      });
    });
    port.postMessage({ type: helloType, payload: { protocolVersion: kind.protocolVersion } });
  });
}
