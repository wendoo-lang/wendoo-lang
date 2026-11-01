import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { __test__clientBuild } from "@wendoo/core/__test__";
import type { RelayDownstreamMessage } from "./messages.js";
import { relayUpstreamMessageSchema } from "./messages.js";
import type { RelayToolManifest } from "./session.js";
import { ASSISTANT_RELAY_PROTOCOL_VERSION, RelayRefusalCode, relayConnectEnvelopeSchema } from "./session.js";
import type { RelayLoopback } from "./testing/index.js";
import { createRelayLoopback } from "./testing/index.js";

const manifest: RelayToolManifest = {
  target: "example-org/trg-fake",
  tools: [
    "compile",
    "offer_libraries",
    "propose_edit",
    "read_catalog",
    "read_libraries",
    "read_project",
    "simulate",
    "suggest_tiles",
  ],
  morphology: false,
  catalogDigest: "9f2c41ab",
};

/** Answer the connect `frame` the way the service does, reading its envelope first. */
function answerConnect(loopback: RelayLoopback, frame: unknown): void {
  const envelope = relayConnectEnvelopeSchema.safeParse(frame);
  if (!envelope.success || envelope.data.protocolVersion !== ASSISTANT_RELAY_PROTOCOL_VERSION) {
    loopback.service.send({
      type: "session:refused",
      code: RelayRefusalCode.ProtocolVersionMismatch,
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
    });
    return;
  }
  loopback.service.send({ type: "session:accepted", sessionId: "01JQ8G0000000000000000" });
}

/** Connect at `protocolVersion` and return what the service answered. */
async function connectAt(protocolVersion: number): Promise<RelayDownstreamMessage> {
  const loopback = createRelayLoopback();
  loopback.toolServer.send({
    type: "session:connect",
    protocolVersion,
    clientBuild: __test__clientBuild,
    manifest,
  });

  const connect = await loopback.service.next();
  assert.equal(connect.type, "session:connect");
  answerConnect(loopback, connect);

  return await loopback.toolServer.next();
}

describe("the relay handshake", () => {
  test("opens the session when the client speaks the version the service does", async () => {
    const answer = await connectAt(ASSISTANT_RELAY_PROTOCOL_VERSION);

    assert.equal(answer.type, "session:accepted");
    assert.equal(answer.sessionId, "01JQ8G0000000000000000");
  });

  test("carries the manifest and the build the client runs across as the client stated them", async () => {
    const loopback = createRelayLoopback();
    loopback.toolServer.send({
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
      clientBuild: __test__clientBuild,
      manifest,
    });

    const connect = await loopback.service.next();

    assert.equal(connect.type, "session:connect");
    assert.deepEqual(connect.manifest, manifest);
    assert.deepEqual(connect.clientBuild, __test__clientBuild);
  });

  test("carries the connection ticket across, and a connect without one", async () => {
    const loopback = createRelayLoopback();
    const connect = {
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
      clientBuild: __test__clientBuild,
      manifest,
    } as const;
    loopback.toolServer.send({ ...connect, ticket: "opaque.connection.ticket" });
    loopback.toolServer.send(connect);

    const ticketed = await loopback.service.next();
    const bare = await loopback.service.next();

    assert.equal(ticketed.type === "session:connect" ? ticketed.ticket : undefined, "opaque.connection.ticket");
    assert.equal(bare.type, "session:connect");
    assert.equal("ticket" in bare, false);
  });

  test("refuses a connect carrying a field the wire does not define, ticket or no ticket", () => {
    const base = {
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
      clientBuild: __test__clientBuild,
      manifest,
      lease: 5000,
    };

    assert.equal(relayUpstreamMessageSchema.safeParse(base).success, false);
    assert.equal(relayUpstreamMessageSchema.safeParse({ ...base, ticket: "t" }).success, false);
  });

  test("carries each refusal a connect's authentication can draw", async () => {
    for (const code of [RelayRefusalCode.Unauthenticated, RelayRefusalCode.WalletExhausted]) {
      const loopback = createRelayLoopback();
      loopback.service.send({ type: "session:refused", code, protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION });

      const answer = await loopback.toolServer.next();

      assert.equal(answer.type, "session:refused");
      assert.equal(answer.type === "session:refused" ? answer.code : undefined, code);
    }
  });

  test("carries the lease's wallet status after the session opens", async () => {
    const loopback = createRelayLoopback();
    loopback.service.send({ type: "session:accepted", sessionId: "01JQ8G0000000000000000" });
    loopback.service.send({ type: "session:wallet", leaseRemaining: 5000, leaseTotal: 5000 });

    assert.equal((await loopback.toolServer.next()).type, "session:accepted");
    assert.deepEqual(await loopback.toolServer.next(), {
      type: "session:wallet",
      leaseRemaining: 5000,
      leaseTotal: 5000,
    });
  });

  test("refuses a client holding another version and names the version it speaks", async () => {
    const answer = await connectAt(ASSISTANT_RELAY_PROTOCOL_VERSION + 1);

    assert.equal(answer.type, "session:refused");
    assert.equal(answer.code, RelayRefusalCode.ProtocolVersionMismatch);
    assert.equal(answer.protocolVersion, ASSISTANT_RELAY_PROTOCOL_VERSION);
  });

  test("carries a refusal of the target the manifest asked for", async () => {
    const loopback = createRelayLoopback();
    loopback.service.send({
      type: "session:refused",
      code: RelayRefusalCode.TargetUnavailable,
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
    });

    const answer = await loopback.toolServer.next();

    assert.equal(answer.type, "session:refused");
    assert.equal(answer.code, RelayRefusalCode.TargetUnavailable);
  });
});

describe("the version a connect states", () => {
  test("is the fourth version of the wire", () => {
    assert.equal(ASSISTANT_RELAY_PROTOCOL_VERSION, 4);
  });

  test("brings a client of the previous version, ticket in hand, a refusal rather than a parse failure", async () => {
    const loopback = createRelayLoopback();
    const previous = {
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION - 1,
      clientBuild: __test__clientBuild,
      manifest,
      ticket: "opaque.connection.ticket",
    };

    answerConnect(loopback, previous);
    const answer = await loopback.toolServer.next();

    assert.equal(answer.type, "session:refused");
    assert.equal(answer.type === "session:refused" ? answer.code : undefined, RelayRefusalCode.ProtocolVersionMismatch);
  });

  /** A connect an older wire wrote: no build the client runs, which this wire requires. */
  const older = {
    type: "session:connect",
    protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION - 1,
    manifest,
  };

  test("reads off a connect this wire's own union refuses", () => {
    const envelope = relayConnectEnvelopeSchema.safeParse(older);

    assert.equal(relayUpstreamMessageSchema.safeParse(older).success, false);
    assert.equal(envelope.success, true);
    assert.equal(envelope.data?.protocolVersion, ASSISTANT_RELAY_PROTOCOL_VERSION - 1);
  });

  test("brings that client a refusal naming the version the service speaks", async () => {
    const loopback = createRelayLoopback();

    answerConnect(loopback, older);
    const answer = await loopback.toolServer.next();

    assert.equal(answer.type, "session:refused");
    assert.equal(answer.code, RelayRefusalCode.ProtocolVersionMismatch);
    assert.equal(answer.protocolVersion, ASSISTANT_RELAY_PROTOCOL_VERSION);
  });

  test("reads off no message but a connect", () => {
    for (const frame of [
      { type: "session:userMessage", text: "hello", protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION },
      { type: "session:connect", manifest },
      { type: "session:connect", protocolVersion: "3", manifest },
    ]) {
      assert.equal(relayConnectEnvelopeSchema.safeParse(frame).success, false, JSON.stringify(frame));
    }
  });
});
