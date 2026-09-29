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

/**
 * Payload of a {@link PeerSessionHelloMessage}.
 *
 * @typeParam TDeclaration - What a party of the kind declares about itself;
 * `never` for a kind that defines no declaration.
 */
export interface PeerSessionHelloPayload<TDeclaration = never> {
  /** Protocol version the sender speaks. */
  protocolVersion: number;
  /**
   * What the sender declares about itself, in the shape its kind defines.
   * Absent when the sender declares nothing; a receiver accepts a hello
   * with or without it, at any version it accepts.
   */
  declaration?: TDeclaration;
}

/**
 * First message each party of a peer session sends. Both parties send
 * one; neither sends any other message of the session before it has
 * received the peer's hello.
 *
 * @typeParam TKind - The session kind's name; the message type is
 * `<kind>:hello`.
 * @typeParam TDeclaration - What a party of the kind declares about itself
 * in its hello; `never` for a kind that defines no declaration.
 */
export interface PeerSessionHelloMessage<TKind extends string, TDeclaration = never> {
  type: `${TKind}:hello`;
  payload: PeerSessionHelloPayload<TDeclaration>;
}
