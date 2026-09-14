import { z } from "zod";
import type { RelayConnect, RelayConnectAccepted, RelayConnectRefused } from "./session.js";
import { clientBuildSchema, RelayRefusalCode, relayToolManifestSchema } from "./session.js";
import type { RelayToolCallRequest, RelayToolResult } from "./tool-calls.js";
import { relayToolCallRequestSchema, relayToolResultSchema } from "./tool-calls.js";

/**
 * A model turn has begun. Narration, tool-call batches, and finally one
 * {@link RelayTurnEnd} follow it; a session runs one turn at a time.
 */
export interface RelayTurnStart {
  readonly type: "turn:start";
}

/**
 * What a run of narration is doing, where the service could tell. A run the
 * service could not place carries none of these, and is the assistant simply
 * talking.
 */
export const NarrationRole = {
  /** How the assistant means to go about the request it was given. */
  Plan: "plan",
  /** A plan taking the place of one stated earlier in the same turn. */
  Pivot: "pivot",
  /** Working out why something the assistant built did not do what it meant. */
  Diagnosis: "diagnosis",
  /** What that working-out came to, stated as the thing worth keeping. */
  Note: "note",
  /** Whether a rehearsal did what the assistant wanted of it. */
  Verdict: "verdict",
  /** What happened when the editor refused one of the assistant's proposals. */
  Snag: "snag",
  /** A question the assistant is putting to the person, waiting on their answer. */
  Ask: "ask",
} as const;

/** What a run of narration is doing, where the service could tell. */
export type NarrationRole = (typeof NarrationRole)[keyof typeof NarrationRole];

/** How a rehearsal went, in the assistant's own judgement. */
export const NarrationJudgment = {
  Succeeded: "succeeded",
  Failed: "failed",
} as const;

/** How a rehearsal went, in the assistant's own judgement. */
export type NarrationJudgment = (typeof NarrationJudgment)[keyof typeof NarrationJudgment];

/**
 * Which part of its run a narration fragment belongs to. Fragments carrying no
 * part belong to the headline the run opens with.
 */
export const NarrationPart = {
  /** The longer form standing under the headline, which a surface may fold away. */
  Body: "body",
} as const;

/** Which part of its run a narration fragment belongs to. */
export type NarrationPart = (typeof NarrationPart)[keyof typeof NarrationPart];

/**
 * One fragment of the assistant's narration, in stream order. Fragments of one
 * run join in arrival order into that run's headline and body; a tool-call
 * batch ends the run, as does a fragment carrying a role parting from the one
 * the run carries, and the next fragment opens a new one.
 */
export interface RelayNarrationDelta {
  readonly type: "turn:narration";
  readonly text: string;
  /** The part of its run this fragment belongs to; absent for the headline. */
  readonly part?: NarrationPart;
  /** What the run this fragment belongs to is doing; absent where the service could not tell. */
  readonly role?: NarrationRole;
  /** How the rehearsal went; present only on a run whose role is `verdict`. */
  readonly judgment?: NarrationJudgment;
}

/**
 * The `tool` a {@link RelayTurnWriting} carries while the model is reasoning.
 * No bridge tool answers to this name.
 */
export const thinkingWritingName = "thinking";

/**
 * The model is producing something right now: one tool call, or the reasoning
 * it does before acting, named {@link thinkingWritingName}. The first of one
 * run's pulses carries a `chars` of `0` and names what the model has begun; the
 * ones after it are progress ticks the service throttles as the text grows.
 */
export interface RelayTurnWriting {
  readonly type: "turn:writing";
  /** Bridge name of the tool being written, or {@link thinkingWritingName} while the model reasons. */
  readonly tool: string;
  /** Characters written so far -- of the call's JSON, or of the reasoning; `0` at the start. */
  readonly chars: number;
}

/** The tool calls the turn's current model step asked for, to be served as one batch. */
export interface RelayToolCallBatch {
  readonly type: "turn:toolCalls";
  readonly requests: readonly RelayToolCallRequest[];
}

/** How a turn ended. */
export const RelayTurnEndCode = {
  /** The assistant finished its answer. */
  Complete: "complete",
  /** A stop from the person ended the turn. */
  Stopped: "stopped",
  /**
   * The assistant broke off mid-answer and there is no more of it coming. What
   * it narrated and applied before breaking off stands; the person may ask
   * again.
   */
  Truncated: "truncated",
  /**
   * The service could not carry the turn to an answer. The document rests at
   * the last edit a tool call applied, valid and undoable.
   */
  Failed: "failed",
} as const;

/** How a turn ended. */
export type RelayTurnEndCode = (typeof RelayTurnEndCode)[keyof typeof RelayTurnEndCode];

/** The turn is over; no further narration or tool call belongs to it. */
export interface RelayTurnEnd {
  readonly type: "turn:end";
  readonly code: RelayTurnEndCode;
  /** Human-readable context; the code is the contract. */
  readonly message?: string;
}

/** The client's answers to one {@link RelayToolCallBatch}, in any order. */
export interface RelayToolResultBatch {
  readonly type: "turn:toolResults";
  readonly results: readonly RelayToolResult[];
}

/** Something the person said, which starts a turn. */
export interface RelayUserMessage {
  readonly type: "session:userMessage";
  readonly text: string;
}

/**
 * The person added a library to the project from a card the assistant offered,
 * which starts a turn carrying that news. Sent only for an install that put the
 * library there: one that failed, one the person's app refused, and one of a
 * library the project already held all send nothing.
 */
export interface RelayLibraryAdded {
  readonly type: "session:libraryAdded";
  /** The `<owner>/<repo>` coordinate of the library the project now holds. */
  readonly coordinate: string;
}

/** The person asked the turn in flight to stop. */
export interface RelayStop {
  readonly type: "turn:stop";
}

/** Every message the service sends the client over a relay session. */
export type RelayDownstreamMessage =
  | RelayConnectAccepted
  | RelayConnectRefused
  | RelayTurnStart
  | RelayNarrationDelta
  | RelayTurnWriting
  | RelayToolCallBatch
  | RelayTurnEnd;

/**
 * Every message the client sends the service over a relay session: the connect,
 * tool results, a user message, a library the person added, and a stop.
 */
export type RelayUpstreamMessage =
  | RelayConnect
  | RelayToolResultBatch
  | RelayUserMessage
  | RelayLibraryAdded
  | RelayStop;

/** Schema of {@link RelayDownstreamMessage}. */
export const relayDownstreamMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("session:accepted"), sessionId: z.string().min(1) }),
  z.strictObject({
    type: z.literal("session:refused"),
    code: z.enum(RelayRefusalCode),
    protocolVersion: z.number().int().positive(),
    message: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("turn:start") }),
  z.strictObject({
    type: z.literal("turn:narration"),
    text: z.string(),
    part: z.enum(NarrationPart).optional(),
    role: z.enum(NarrationRole).optional(),
    judgment: z.enum(NarrationJudgment).optional(),
  }),
  z.strictObject({
    type: z.literal("turn:writing"),
    tool: z.string().min(1),
    chars: z.number().int().nonnegative(),
  }),
  z.strictObject({ type: z.literal("turn:toolCalls"), requests: z.array(relayToolCallRequestSchema) }),
  z.strictObject({
    type: z.literal("turn:end"),
    code: z.enum(RelayTurnEndCode),
    message: z.string().optional(),
  }),
]);

/** Schema of {@link RelayUpstreamMessage}. */
export const relayUpstreamMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("session:connect"),
    protocolVersion: z.number().int().positive(),
    clientBuild: clientBuildSchema,
    manifest: relayToolManifestSchema,
    conversation: z.unknown().optional(),
  }),
  z.strictObject({ type: z.literal("turn:toolResults"), results: z.array(relayToolResultSchema) }),
  z.strictObject({ type: z.literal("session:userMessage"), text: z.string() }),
  z.strictObject({ type: z.literal("session:libraryAdded"), coordinate: z.string().min(1) }),
  z.strictObject({ type: z.literal("turn:stop") }),
]);
