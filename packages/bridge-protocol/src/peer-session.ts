/** Stable identifiers for peer-session errors. */
export const PeerSessionErrorCode = {
  /**
   * The peer's hello declared a protocol version newer than this side speaks.
   * The remedy is to refresh or update this side.
   */
  PROTOCOL_VERSION_NEWER: "PEER_SESSION_PROTOCOL_VERSION_NEWER",
} as const;

/** Union of all {@link PeerSessionErrorCode} values. */
export type PeerSessionErrorCode = (typeof PeerSessionErrorCode)[keyof typeof PeerSessionErrorCode];

/** Payload of a {@link PeerSessionHelloMessage}. */
export interface PeerSessionHelloPayload {
  /** Protocol version the sender speaks. */
  protocolVersion: number;
}

/**
 * First message each party of a peer session sends. Both parties send
 * one; neither sends any other message of the session before it has
 * received the peer's hello.
 *
 * @typeParam TKind - The session kind's name; the message type is
 * `<kind>:hello`.
 */
export interface PeerSessionHelloMessage<TKind extends string> {
  type: `${TKind}:hello`;
  payload: PeerSessionHelloPayload;
}
