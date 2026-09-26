import { z } from "zod";
import type { FileSystemNotification, FilesystemSyncPayload } from "../notifications.js";

/** Stable identifiers for bridge-session errors. */
export const BridgeSessionErrorCode = {
  /**
   * The two sides of the session do not speak a common protocol version. Raised
   * by a client whose bridge's `session:welcome` declared no protocol version,
   * or one other than the client's `PROTOCOL_VERSION`; reported by a bridge
   * that does not support the version a client's `session:hello` declared.
   */
  PROTOCOL_VERSION_MISMATCH: "BRIDGE_SESSION_PROTOCOL_VERSION_MISMATCH",
  /**
   * A newer connection of the same member has taken this connection's place:
   * this client's hold on the session is over, and it does not reconnect
   * automatically. Reported by a bridge, on the connection it then closes,
   * when a hello presenting the session's binding token binds the member's
   * role while this connection still holds it. The session continues under
   * the newer connection.
   */
  SESSION_REPLACED: "BRIDGE_SESSION_SESSION_REPLACED",
  /**
   * The join code this connection's hello presented opens no vacant role: no
   * session holds it, or the session holding it already has this connection's
   * role bound. The client does not reconnect automatically; a person enters
   * a current code to connect. Reported by a bridge, in answer to the hello,
   * on the connection it then closes.
   */
  JOIN_CODE_UNKNOWN: "BRIDGE_SESSION_JOIN_CODE_UNKNOWN",
  /**
   * The session was ended on purpose: its other member sent
   * `session:goodbye`, or an operator ended it. The client does not reconnect
   * automatically; connecting again is a deliberate act. Reported by a
   * bridge, on the connection it then closes.
   */
  SESSION_ENDED: "BRIDGE_SESSION_SESSION_ENDED",
  /**
   * This side queued more outbound messages than it holds while its
   * connection was not open, so it discarded them and ended the session.
   * Raised by a client; never sent in a `session:error`.
   */
  OUTBOUND_QUEUE_OVERFLOW: "BRIDGE_SESSION_OUTBOUND_QUEUE_OVERFLOW",
} as const;

/** Union of all {@link BridgeSessionErrorCode} values. */
export type BridgeSessionErrorCode = (typeof BridgeSessionErrorCode)[keyof typeof BridgeSessionErrorCode];

/** Payload carried by error messages. */
export interface ErrorPayload {
  message: string;
  /** Stable code of the failure, when the sender reports one. */
  code?: BridgeSessionErrorCode;
}

/** A single filesystem mutation pushed to the peer. */
export interface FilesystemChangeMessage {
  type: "filesystem:change";
  id?: string;
  payload?: FileSystemNotification;
  /** Monotonic per-sender sequence number used to detect drops/reorderings. */
  seq?: number;
}

/** A full filesystem snapshot pushed to seed or resync the peer. */
export interface FilesystemSyncMessage {
  type: "filesystem:sync";
  id?: string;
  payload?: FilesystemSyncPayload;
  /** Monotonic per-sender sequence number used to detect drops/reorderings. */
  seq?: number;
}

/** Liveness probe; the peer responds with {@link ControlPongMessage}. */
export interface ControlPingMessage {
  type: "control:ping";
  id?: string;
}

/** Reply to a {@link ControlPingMessage}. */
export interface ControlPongMessage {
  type: "control:pong";
  id?: string;
}

/**
 * Session-scoped error reported to the peer. One whose payload carries a
 * `code` ends the session: the receiver closes its connection and does not
 * reconnect.
 */
export interface SessionErrorMessage {
  type: "session:error";
  id?: string;
  payload: ErrorPayload;
}

/** Generic (non-session-scoped) error reported to the peer. */
export interface GeneralErrorMessage {
  type: "error";
  id?: string;
  payload: ErrorPayload;
}

/** Schema for the `session:hello` payload. */
export const sessionHelloPayloadSchema = z.object({
  protocolVersion: z.number(),
  joinCode: z.string().optional(),
  bindingToken: z.string().optional(),
});

/** Payload of a {@link SessionHelloMessage}. */
export type SessionHelloPayload = z.infer<typeof sessionHelloPayloadSchema>;

/** First message a client sends to initiate or resume a session. */
export interface SessionHelloMessage {
  type: "session:hello";
  id?: string;
  payload?: SessionHelloPayload;
}

/**
 * Sent by a bridge to tell a member that its session's counterpart has
 * disconnected. The session stays open and keeps its binding token; the next
 * `session:welcome` means the counterpart is connected again.
 */
export interface SessionCounterpartAwayMessage {
  type: "session:counterpartAway";
}

/**
 * Sent by a client to end its session on purpose. The bridge closes both
 * members' connections, first telling the other member with a
 * `session:error` carrying `SESSION_ENDED`.
 */
export interface SessionGoodbyeMessage {
  type: "session:goodbye";
  id?: string;
}
