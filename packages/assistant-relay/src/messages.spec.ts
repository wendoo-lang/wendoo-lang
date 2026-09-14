import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { __test__clientBuild } from "@wendoo/core/__test__";
import { CONVERSATION_RECORD_VERSION, conversationRecordSchema } from "./conversation.js";
import type { RelayDownstreamMessage, RelayUpstreamMessage } from "./messages.js";
import {
  NarrationJudgment,
  NarrationPart,
  NarrationRole,
  RelayTurnEndCode,
  relayDownstreamMessageSchema,
  relayUpstreamMessageSchema,
} from "./messages.js";
import { ASSISTANT_RELAY_PROTOCOL_VERSION, RelayRefusalCode } from "./session.js";
import { RelayDeclineCode, RelayTakeoverCode } from "./tool-calls.js";

/** One message of every downstream type. */
const downstream: readonly RelayDownstreamMessage[] = [
  { type: "session:accepted", sessionId: "01JQ8G0000000000000000" },
  {
    type: "session:refused",
    code: RelayRefusalCode.ProtocolVersionMismatch,
    protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
    message: "reload and reconnect",
  },
  { type: "turn:start" },
  { type: "turn:narration", text: "placing the sensor" },
  { type: "turn:narration", text: "Two ways of being.", role: NarrationRole.Plan },
  { type: "turn:narration", text: "the longer story", part: NarrationPart.Body, role: NarrationRole.Diagnosis },
  {
    type: "turn:narration",
    text: "It hid.",
    role: NarrationRole.Verdict,
    judgment: NarrationJudgment.Succeeded,
  },
  { type: "turn:writing", tool: "propose_edit", chars: 0 },
  { type: "turn:writing", tool: "propose_edit", chars: 4312 },
  {
    type: "turn:toolCalls",
    requests: [{ requestId: "r1", name: "read_project", input: {}, timeoutMs: 15000 }],
  },
  { type: "turn:end", code: RelayTurnEndCode.Complete },
  { type: "turn:end", code: RelayTurnEndCode.Stopped },
  { type: "turn:end", code: RelayTurnEndCode.Truncated },
  { type: "turn:end", code: RelayTurnEndCode.Failed, message: "the model call did not complete" },
];

/** One message of every upstream type. */
const upstream: readonly RelayUpstreamMessage[] = [
  {
    type: "session:connect",
    protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
    clientBuild: __test__clientBuild,
    manifest: {
      target: "example-org/trg-fake",
      tools: ["compile", "read_project"],
      morphology: false,
      catalogDigest: "0f3a19c2",
    },
  },
  {
    type: "session:connect",
    protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
    clientBuild: __test__clientBuild,
    manifest: {
      target: "example-org/trg-fake",
      tools: ["compile", "read_project"],
      morphology: false,
      catalogDigest: "0f3a19c2",
    },
    conversation: {
      version: CONVERSATION_RECORD_VERSION,
      brainId: "brain-a",
      entries: [
        { kind: "user", text: "make it hide in the dark" },
        {
          kind: "assistant",
          steps: [
            { kind: "narration", text: "placing the sensor" },
            { kind: "toolCall", call: { name: "propose_edit", input: {}, outcome: { kind: "ok", payload: {} } } },
          ],
          ending: { kind: "end", code: RelayTurnEndCode.Complete },
        },
      ],
    },
  },
  {
    type: "turn:toolResults",
    results: [
      { requestId: "r1", outcome: { kind: "ok", payload: { pages: [] } } },
      { requestId: "r2", outcome: { kind: "ok", payload: { error: "unknown_tool" }, isError: true } },
      { requestId: "r3", outcome: { kind: "declined", code: RelayDeclineCode.UserStopped } },
      { requestId: "r4", outcome: { kind: "takeover", code: RelayTakeoverCode.DocumentEdited } },
    ],
  },
  { type: "session:userMessage", text: "make it hide in the dark" },
  { type: "session:libraryAdded", coordinate: "example-org/lib-position" },
  { type: "turn:stop" },
];

/** `message` as it comes back off the wire. */
function overTheWire(message: unknown): unknown {
  return JSON.parse(JSON.stringify(message));
}

describe("the relay wire", () => {
  test("carries every downstream message across unchanged", () => {
    for (const message of downstream) {
      assert.deepEqual(relayDownstreamMessageSchema.parse(overTheWire(message)), message, message.type);
    }
  });

  test("carries every upstream message across unchanged", () => {
    for (const message of upstream) {
      assert.deepEqual(relayUpstreamMessageSchema.parse(overTheWire(message)), message, message.type);
    }
  });

  test("names every message the wire defines", () => {
    const named = new Set([...downstream, ...upstream].map((message) => message.type));

    assert.deepEqual([...named].sort(), [
      "session:accepted",
      "session:connect",
      "session:libraryAdded",
      "session:refused",
      "session:userMessage",
      "turn:end",
      "turn:narration",
      "turn:start",
      "turn:stop",
      "turn:toolCalls",
      "turn:toolResults",
      "turn:writing",
    ]);
  });

  test("refuses a writing pulse whose count is not a whole number of characters", () => {
    assert.equal(
      relayDownstreamMessageSchema.safeParse({ type: "turn:writing", tool: "propose_edit", chars: -1 }).success,
      false
    );
    assert.equal(
      relayDownstreamMessageSchema.safeParse({ type: "turn:writing", tool: "propose_edit", chars: 1.5 }).success,
      false
    );
  });

  test("names every code a turn ends with, as the wire spells it", () => {
    assert.deepEqual(RelayTurnEndCode, {
      Complete: "complete",
      Stopped: "stopped",
      Truncated: "truncated",
      Failed: "failed",
    });
  });

  test("names every role a run of narration carries, as the wire spells it", () => {
    assert.deepEqual(NarrationRole, {
      Plan: "plan",
      Pivot: "pivot",
      Diagnosis: "diagnosis",
      Note: "note",
      Verdict: "verdict",
      Snag: "snag",
      Ask: "ask",
    });
  });

  test("refuses a narration role the wire does not define", () => {
    assert.equal(
      relayDownstreamMessageSchema.safeParse({ type: "turn:narration", text: "words", role: "aside" }).success,
      false
    );
  });

  test("refuses an upstream message carrying a field the wire does not define", () => {
    const forged = {
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
      clientBuild: __test__clientBuild,
      manifest: {
        target: "example-org/trg-fake",
        tools: [],
        morphology: false,
        catalogDigest: "0f3a19c2",
      },
      tier: "unlimited",
    };

    assert.equal(relayUpstreamMessageSchema.safeParse(forged).success, false);
  });

  test("admits a connect whose conversation the record schema would reject, so the service can drop it alone", () => {
    const carried = {
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
      clientBuild: __test__clientBuild,
      manifest: {
        target: "example-org/trg-fake",
        tools: [],
        morphology: false,
        catalogDigest: "0f3a19c2",
      },
      conversation: { version: CONVERSATION_RECORD_VERSION + 1, brainId: "brain-a", entries: [] },
    };

    const parsed = relayUpstreamMessageSchema.safeParse(carried);

    assert.equal(parsed.success, true);
    assert.equal(conversationRecordSchema.safeParse(carried.conversation).success, false);
  });

  test("refuses a tool manifest carrying a field the wire does not define", () => {
    const forged = {
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
      clientBuild: __test__clientBuild,
      manifest: {
        target: "example-org/trg-fake",
        tools: [],
        morphology: false,
        catalogDigest: "0f3a19c2",
        entitlements: ["example-org/trg-fake"],
      },
    };

    assert.equal(relayUpstreamMessageSchema.safeParse(forged).success, false);
  });

  test("refuses a connect that does not state the build the client runs", () => {
    const manifest = { target: "example-org/trg-fake", tools: [], morphology: false, catalogDigest: "0f3a19c2" };
    const refused: readonly unknown[] = [
      { type: "session:connect", protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION, manifest },
      {
        type: "session:connect",
        protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
        clientBuild: { targetPackageVersion: __test__clientBuild.targetPackageVersion },
        manifest,
      },
      {
        type: "session:connect",
        protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
        clientBuild: { ...__test__clientBuild, targetPackageVersion: "" },
        manifest,
      },
      {
        type: "session:connect",
        protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
        clientBuild: { ...__test__clientBuild, coreVersion: "0.2.20" },
        manifest,
      },
    ];

    for (const message of refused) {
      assert.equal(relayUpstreamMessageSchema.safeParse(message).success, false, JSON.stringify(message));
    }
  });

  test("refuses an added library the wire cannot act on", () => {
    const refused: readonly unknown[] = [
      { type: "session:libraryAdded" },
      { type: "session:libraryAdded", coordinate: "" },
      { type: "session:libraryAdded", coordinate: 7 },
      { type: "session:libraryAdded", coordinate: "example-org/lib-position", version: "1.3.0" },
    ];

    for (const message of refused) {
      assert.equal(relayUpstreamMessageSchema.safeParse(message).success, false, JSON.stringify(message));
    }
  });

  test("refuses a tool result carrying an outcome the envelope does not define", () => {
    const forged = {
      type: "turn:toolResults",
      results: [{ requestId: "r1", outcome: { kind: "delayed" } }],
    };

    assert.equal(relayUpstreamMessageSchema.safeParse(forged).success, false);
  });
});
