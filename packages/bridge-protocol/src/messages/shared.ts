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
   * Another connection of this side's role has taken this connection's place:
   * this client's hold on the session is over, and it does not reconnect
   * automatically. Reported by a bridge, on the connection it then closes, to
   * the connection displaced by a new claimant for its role (which ends the
   * session) or by the same member returning with the session's binding token
   * (the session continues under the returning connection).
   */
  SESSION_REPLACED: "BRIDGE_SESSION_SESSION_REPLACED",
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
  sessionId: z.string().optional(),
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
 * disconnected. The session stays open and keeps its join code and binding
 * token; the next `session:welcome` means the counterpart is connected again.
 */
export interface SessionCounterpartAwayMessage {
  type: "session:counterpartAway";
}

/** Sent by a client to gracefully end the session. */
export interface SessionGoodbyeMessage {
  type: "session:goodbye";
  id?: string;
}
