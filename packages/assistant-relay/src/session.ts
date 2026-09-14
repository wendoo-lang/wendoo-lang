import type { ClientBuild } from "@wendoo/core";
import { z } from "zod";
import type { ConversationRecord } from "./conversation.js";

/**
 * Version of the relay wire this package defines. A session speaks one version
 * end to end: the client declares the version it holds when it connects, and
 * the service admits only its own.
 */
export const ASSISTANT_RELAY_PROTOCOL_VERSION = 3;

/**
 * Identifier of one relay session. The service mints it from a globally unique
 * source when it accepts a connection; a client never mints or supplies one.
 */
export type RelaySessionId = string;

/**
 * What the client serves and what it asks the session to be. Every field is a
 * request or a description of the client.
 */
export interface RelayToolManifest {
  /** Target the client asks to author for, by the Wendoo identity its target declares. */
  readonly target: string;
  /** Names of the bridge tools the client serves, in ascending order. */
  readonly tools: readonly string[];
  /** `true` when the client also serves the bridge's morphology extension. */
  readonly morphology: boolean;
  /** Hash of the catalog digest the client's editor holds, as `catalogDigest` reports it. */
  readonly catalogDigest: string;
}

/** Schema of {@link RelayToolManifest}. */
export const relayToolManifestSchema = z.strictObject({
  target: z.string().min(1),
  tools: z.array(z.string().min(1)),
  morphology: z.boolean(),
  catalogDigest: z.string().min(1),
});

/** Schema of the {@link ClientBuild} a connecting client states. */
export const clientBuildSchema = z.strictObject({
  targetPackageVersion: z.string().min(1),
  coreDistHash: z.string().min(1),
}) satisfies z.ZodType<ClientBuild>;

/**
 * The part of a connect every wire version spells the same way: which message
 * this is, and which version the client speaks. Read it off a frame before the
 * full upstream union, which admits only the current version's payload.
 */
export interface RelayConnectEnvelope {
  readonly type: "session:connect";
  /** Wire version the client holds, as {@link ASSISTANT_RELAY_PROTOCOL_VERSION} spells it. */
  readonly protocolVersion: number;
}

/**
 * Schema of {@link RelayConnectEnvelope}. It admits whatever else the frame
 * carries, so a connect written by any wire version reads through it.
 */
export const relayConnectEnvelopeSchema = z.looseObject({
  type: z.literal("session:connect"),
  protocolVersion: z.number().int().positive(),
});

/** First message of a session: the wire version the client speaks and what it serves. */
export interface RelayConnect {
  readonly type: "session:connect";
  /** Wire version the client holds, as {@link ASSISTANT_RELAY_PROTOCOL_VERSION} spells it. */
  readonly protocolVersion: number;
  /**
   * The build the client runs. The service holds it for the life of the session
   * and reads nothing into either value: both are opaque strings it compares
   * for equality.
   */
  readonly clientBuild: ClientBuild;
  readonly manifest: RelayToolManifest;
  /**
   * The conversation the client holds for the brain the session is for, which
   * the service rebuilds its model context from. Absent when the client holds
   * none. The wire admits any value here and the service reads it against
   * `conversationRecordSchema`: a record it cannot read is dropped and the
   * session opens anyway.
   */
  readonly conversation?: ConversationRecord;
}

/** The session is open, and this is what to call it. */
export interface RelayConnectAccepted {
  readonly type: "session:accepted";
  readonly sessionId: RelaySessionId;
}

/** Why the service would not open a session. */
export const RelayRefusalCode = {
  /**
   * The client declared a wire version other than the one the service speaks.
   * The client reloads to pick up the current build and connects again; no
   * session spans two versions.
   */
  ProtocolVersionMismatch: "protocol_version_mismatch",
  /**
   * The service does not serve the target the manifest asked for. Does not
   * distinguish a target the service does not know from one this session may
   * not claim.
   */
  TargetUnavailable: "target_unavailable",
} as const;

/** Why the service would not open a session. */
export type RelayRefusalCode = (typeof RelayRefusalCode)[keyof typeof RelayRefusalCode];

/** The session is not open, and why. */
export interface RelayConnectRefused {
  readonly type: "session:refused";
  readonly code: RelayRefusalCode;
  /** Wire version the service speaks. */
  readonly protocolVersion: number;
  /** Human-readable context; the code is the contract. */
  readonly message?: string;
}
