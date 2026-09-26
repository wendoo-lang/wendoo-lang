import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeSessionErrorCode } from "@wendoo/bridge-protocol";
import {
  assertCounterpartAway,
  assertJoinCode,
  assertSessionError,
  assertWelcome,
  startTestRelay,
  type TestRelay,
  within,
} from "./testing/index.js";

/** Runs `body` against a relay started with `options`, closing the relay afterwards. */
async function withRelay(
  options: Parameters<typeof startTestRelay>[0],
  body: (relay: TestRelay) => Promise<void>
): Promise<void> {
  const relay = await startTestRelay(options);
  try {
    await body(relay);
  } finally {
    await relay.close();
  }
}

describe("session engine", () => {
  it("forms a session: a hello is answered with a join code, and both members are welcomed once the code pairs", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const host = await relay.connect("demo/host");
      const joinCode = assertJoinCode(await host.hello());
      await host.ping();
      host.assertNothingReceived();

      const guest = await relay.connect("demo/guest");
      assert.equal(assertJoinCode(await guest.hello({ joinCode })), joinCode);
      const guestWelcome = assertWelcome(await guest.nextMessage());
      const hostWelcome = assertWelcome(await host.nextMessage());

      assert.equal(hostWelcome.sessionId, guestWelcome.sessionId);
      assert.equal(hostWelcome.joinCode, joinCode);
      host.send({ type: "demo:note", payload: { text: "to the guest" } });
      assert.deepEqual(await guest.nextMessage(), { type: "demo:note", payload: { text: "to the guest" } });
    });
  });

  it("reclaims a lingering session by token: same session id, the stable member welcomed again", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome, secondWelcome } = await relay.pair("demo/host", "demo/guest");
      await first.close();
      assertCounterpartAway(await second.nextMessage());

      const returned = await relay.connect("demo/host");
      assertJoinCode(await returned.hello({ bindingToken: firstWelcome.bindingToken }));

      assert.deepEqual(assertWelcome(await returned.nextMessage()), firstWelcome);
      assert.deepEqual(assertWelcome(await second.nextMessage()), secondWelcome);
    });
  });

  it("sweeps a session with no member after the linger time; a token then re-forms it under a new session id and join code", async () => {
    await withRelay({ bindingSecret: "spec-secret", lingerMs: 20 }, async (relay) => {
      const { first, second, firstWelcome, secondWelcome } = await relay.pair("demo/host", "demo/guest");
      await first.close();
      await second.close();
      await relay.expireLinger();

      const host = await relay.connect("demo/host");
      const reformedCode = assertJoinCode(await host.hello({ bindingToken: firstWelcome.bindingToken }));
      const guest = await relay.connect("demo/guest");
      assert.equal(assertJoinCode(await guest.hello({ bindingToken: secondWelcome.bindingToken })), reformedCode);
      const guestWelcome = assertWelcome(await guest.nextMessage());
      const hostWelcome = assertWelcome(await host.nextMessage());

      assert.notEqual(reformedCode, firstWelcome.joinCode);
      assert.notEqual(hostWelcome.sessionId, firstWelcome.sessionId);
      assert.equal(hostWelcome.sessionId, guestWelcome.sessionId);
      assert.equal(hostWelcome.bindingToken, firstWelcome.bindingToken);
      assert.equal(guestWelcome.bindingToken, secondWelcome.bindingToken);
    });
  });

  it("replaces on a new claimant: the displaced member alone is told and closed, and the other migrates on its open connection", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome } = await relay.pair("demo/host", "demo/guest");
      const claimant = await relay.connect("demo/guest");

      assertJoinCode(await claimant.hello({ joinCode: firstWelcome.joinCode }));

      assertSessionError(await second.nextMessage(), BridgeSessionErrorCode.SESSION_REPLACED);
      await within(second.closed, "the displaced connection to close");
      const migratedWelcome = assertWelcome(await first.nextMessage());
      const claimantWelcome = assertWelcome(await claimant.nextMessage());
      assert.equal(migratedWelcome.sessionId, claimantWelcome.sessionId);
      assert.notEqual(migratedWelcome.sessionId, firstWelcome.sessionId);
      assert.equal(migratedWelcome.joinCode, firstWelcome.joinCode);
      assert.notEqual(migratedWelcome.bindingToken, firstWelcome.bindingToken);
      first.send({ type: "demo:note", payload: { text: "to the claimant" } });
      assert.deepEqual(await claimant.nextMessage(), { type: "demo:note", payload: { text: "to the claimant" } });
    });
  });

  it("adopts a verified token after a restart under the same secret, re-forming the session under its binding", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome, secondWelcome } = await relay.pair("demo/host", "demo/guest");
      await relay.restart();
      await within(first.closed, "the host's connection to close");
      await within(second.closed, "the guest's connection to close");

      const host = await relay.connect("demo/host");
      const adoptedCode = assertJoinCode(await host.hello({ bindingToken: firstWelcome.bindingToken }));
      const guest = await relay.connect("demo/guest");
      assert.equal(assertJoinCode(await guest.hello({ bindingToken: secondWelcome.bindingToken })), adoptedCode);
      const guestWelcome = assertWelcome(await guest.nextMessage());
      const hostWelcome = assertWelcome(await host.nextMessage());

      assert.notEqual(hostWelcome.sessionId, firstWelcome.sessionId);
      assert.equal(hostWelcome.sessionId, guestWelcome.sessionId);
      assert.equal(hostWelcome.bindingToken, firstWelcome.bindingToken);
      assert.equal(guestWelcome.bindingToken, secondWelcome.bindingToken);
    });
  });
});
