import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { BridgeSessionErrorCode, PROTOCOL_VERSION, type WsMessage } from "@wendoo/bridge-protocol";
import {
  assertCounterpartAway,
  assertJoinCode,
  assertSessionError,
  assertVersionRejected,
  assertWelcome,
  type ScriptedPeer,
  startTestRelay,
  type TestRelay,
  type TestRelayOptions,
  within,
} from "@wendoo/bridge-session/testing";
import { runReplCommand } from "./repl-commands.js";
import { type BridgeAdmin, type BridgeServer, startBridgeServer } from "./server.js";

/** Join-code rotation interval of the bridge servers the rotation specs start, in milliseconds. */
const ROTATION_MS = 500;

/**
 * Runs `body` against a bridge server started with `options`, handing it the
 * running server's session operations, and closes the server afterwards.
 */
async function withBridge(
  options: Pick<TestRelayOptions, "lingerMs" | "rotationMs" | "activityTimeoutMs">,
  body: (bridge: TestRelay, admin: BridgeAdmin) => Promise<void>
): Promise<void> {
  let server: BridgeServer | undefined;
  const bridge = await startTestRelay({
    bindingSecret: "spec-secret",
    server: async (serverOptions) => {
      server = await startBridgeServer(serverOptions);
      return server;
    },
    probePath: "app",
    ...options,
  });
  const admin: BridgeAdmin = {
    sessions: () => server?.admin.sessions() ?? [],
    endSession: (sessionId) => server?.admin.endSession(sessionId) ?? false,
    disconnectMember: (memberId) => server?.admin.disconnectMember(memberId) ?? false,
  };
  try {
    await body(bridge, admin);
  } finally {
    await bridge.close();
  }
}

/** The join code `message` carries, asserting it is a `session:joinCode`, whatever the code's shape. */
function joinCodeOf(message: WsMessage): string {
  assert.equal(message.type, "session:joinCode");
  return (message.payload as { joinCode: string }).joinCode;
}

/** Asserts that `message` is an `error` message, whatever its prose. */
function assertErrorMessage(message: WsMessage): void {
  assert.equal(message.type, "error");
}

/** Asserts that `message` is the `session:error` refusing a hello's join code. */
function assertJoinCodeUnknown(message: WsMessage): void {
  assertSessionError(message, BridgeSessionErrorCode.JOIN_CODE_UNKNOWN);
  assert.equal(message.id, "hello");
}

/** Asserts that `message` is a code-less `session:error` answering the message with `id`. */
function assertRefused(message: WsMessage, id: string): void {
  assertSessionError(message, undefined);
  assert.equal(message.id, id);
}

/** A `filesystem:change` payload writing `path`. */
function writeOf(path: string): Record<string, unknown> {
  return { action: "write", path, content: "export {};", newEtag: "etag-1" };
}

describe("vscode bridge sessions", () => {
  it("answers each route's hello with the join code and welcomes the app and the extension once the extension presents the app's code", async () => {
    await withBridge({}, async (bridge) => {
      const app = await bridge.connect("app");
      const joinCode = assertJoinCode(await app.hello());
      await app.ping();
      app.assertNothingReceived();

      const extension = await bridge.connect("extension");
      assert.equal(assertJoinCode(await extension.hello({ joinCode })), joinCode);
      const extensionWelcome = assertWelcome(await extension.nextMessage());
      const appWelcome = assertWelcome(await app.nextMessage());

      assert.equal(appWelcome.sessionId, extensionWelcome.sessionId);
      assert.equal(appWelcome.joinCode, joinCode);
    });
  });

  for (const route of ["app", "extension"]) {
    for (const [label, payload] of [
      ["a newer protocol version", { protocolVersion: PROTOCOL_VERSION + 1 }],
      ["no protocol version", undefined],
    ] as const) {
      it(`rejects a hello at /${route} declaring ${label} with PROTOCOL_VERSION_MISMATCH and closes the connection`, async () => {
        await withBridge({}, async (bridge) => {
          const peer = await bridge.connect(route);
          peer.send({ type: "session:hello", id: "hello", payload });

          assertVersionRejected(await peer.nextMessage());
          await within(peer.closed, "the rejected connection to close");
        });
      });
    }
  }

  it("tells the extension when the app drops, and welcomes both again in the same session when the app returns by its token", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension, firstWelcome, secondWelcome } = await bridge.pair("app", "extension");
      await app.close();
      assertCounterpartAway(await extension.nextMessage());
      const vacancyCode = assertJoinCode(await extension.nextMessage());

      const returned = await bridge.connect("app");
      assert.equal(assertJoinCode(await returned.hello({ bindingToken: firstWelcome.bindingToken })), vacancyCode);

      assert.deepEqual(assertWelcome(await returned.nextMessage()), { ...firstWelcome, joinCode: vacancyCode });
      assert.deepEqual(assertWelcome(await extension.nextMessage()), { ...secondWelcome, joinCode: vacancyCode });
    });
  });

  it("tells the app when the extension drops, and welcomes both again in the same session when the extension returns by its token", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension, firstWelcome, secondWelcome } = await bridge.pair("app", "extension");
      await extension.close();
      assertCounterpartAway(await app.nextMessage());
      const vacancyCode = assertJoinCode(await app.nextMessage());

      const returned = await bridge.connect("extension");
      assert.equal(assertJoinCode(await returned.hello({ bindingToken: secondWelcome.bindingToken })), vacancyCode);

      assert.deepEqual(assertWelcome(await returned.nextMessage()), { ...secondWelcome, joinCode: vacancyCode });
      assert.deepEqual(assertWelcome(await app.nextMessage()), { ...firstWelcome, joinCode: vacancyCode });
    });
  });

  it("re-forms a swept session from its members' tokens under the same binding, whichever returns first", async () => {
    await withBridge({ lingerMs: 20 }, async (bridge) => {
      const { first: app, second: extension, firstWelcome, secondWelcome } = await bridge.pair("app", "extension");
      await extension.close();
      await app.close();
      await bridge.expireLinger();

      const returnedExtension = await bridge.connect("extension");
      const reformedCode = assertJoinCode(await returnedExtension.hello({ bindingToken: secondWelcome.bindingToken }));
      const returnedApp = await bridge.connect("app");
      assert.equal(assertJoinCode(await returnedApp.hello({ bindingToken: firstWelcome.bindingToken })), reformedCode);
      const appWelcome = assertWelcome(await returnedApp.nextMessage());
      const extensionWelcome = assertWelcome(await returnedExtension.nextMessage());

      assert.notEqual(appWelcome.sessionId, firstWelcome.sessionId);
      assert.equal(appWelcome.sessionId, extensionWelcome.sessionId);
      assert.equal(appWelcome.bindingToken, firstWelcome.bindingToken);
      assert.equal(extensionWelcome.bindingToken, secondWelcome.bindingToken);
    });
  });

  it("refuses the code a session formed with once both members are away, and binds an extension entering the code the returning app is answered with", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension, firstWelcome } = await bridge.pair("app", "extension");
      await extension.close();
      await app.close();

      const stale = await bridge.connect("extension");
      assertJoinCodeUnknown(await stale.hello({ joinCode: firstWelcome.joinCode }));
      await within(stale.closed, "the refused connection to close");
      const returned = await bridge.connect("app");
      const vacancyCode = assertJoinCode(await returned.hello({ bindingToken: firstWelcome.bindingToken }));
      const newExtension = await bridge.connect("extension");
      assert.equal(assertJoinCode(await newExtension.hello({ joinCode: vacancyCode })), vacancyCode);

      const extensionWelcome = assertWelcome(await newExtension.nextMessage());
      assert.equal(extensionWelcome.sessionId, firstWelcome.sessionId);
      assert.deepEqual(assertWelcome(await returned.nextMessage()), { ...firstWelcome, joinCode: vacancyCode });
    });
  });

  it("refuses a hello presenting a join code that matches no session, whatever token it also presents", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension, secondWelcome } = await bridge.pair("app", "extension");
      await extension.close();
      assertCounterpartAway(await app.nextMessage());
      assertJoinCode(await app.nextMessage());

      const refused = await bridge.connect("extension");
      assertJoinCodeUnknown(
        await refused.hello({ joinCode: "no-such-code", bindingToken: secondWelcome.bindingToken })
      );
      await within(refused.closed, "the refused connection to close");
      await app.ping();
      app.assertNothingReceived();

      const returned = await bridge.connect("extension");
      assertJoinCode(await returned.hello({ bindingToken: secondWelcome.bindingToken }));
      assert.equal(assertWelcome(await returned.nextMessage()).sessionId, secondWelcome.sessionId);
    });
  });

  it("opens a separate session for a token that fails verification", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, firstWelcome } = await bridge.pair("app", "extension");
      const [bindingId] = firstWelcome.bindingToken.split(".");

      const stranger = await bridge.connect("extension");
      const strangerCode = assertJoinCode(await stranger.hello({ bindingToken: `${bindingId}.00000000` }));
      await stranger.ping();
      await app.ping();

      assert.notEqual(strangerCode, firstWelcome.joinCode);
      stranger.assertNothingReceived();
      app.assertNothingReceived();
    });
  });

  it("refuses another extension presenting the join code of a session whose app and extension are connected, leaving both connected", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension, firstWelcome } = await bridge.pair("app", "extension");
      const claimant = await bridge.connect("extension");

      assertJoinCodeUnknown(await claimant.hello({ joinCode: firstWelcome.joinCode }));
      await within(claimant.closed, "the refused connection to close");

      await app.ping();
      await extension.ping();
      app.assertNothingReceived();
      extension.assertNothingReceived();
    });
  });

  it("supersedes an extension's open connection when the extension binds back in by its token, keeping the app connected", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension, firstWelcome, secondWelcome } = await bridge.pair("app", "extension");
      const second = await bridge.connect("extension");
      assertJoinCode(await second.hello({ bindingToken: secondWelcome.bindingToken }));

      assertSessionError(await extension.nextMessage(), BridgeSessionErrorCode.SESSION_REPLACED);
      await within(extension.closed, "the superseded connection to close");
      assert.deepEqual(assertWelcome(await second.nextMessage()), secondWelcome);
      assert.deepEqual(assertWelcome(await app.nextMessage()), firstWelcome);
    });
  });

  it("rotates the join code of a session waiting for its extension, pushing the new code to the app", async () => {
    await withBridge({ rotationMs: ROTATION_MS }, async (bridge) => {
      const app = await bridge.connect("app");
      const joinCode = assertJoinCode(await app.hello());

      const rotated = assertJoinCode(await app.nextMessage());
      assert.notEqual(rotated, joinCode);
    });
  });

  it("ends the session when the extension says goodbye: the app is told SESSION_ENDED, and both connections close", async () => {
    await withBridge({}, async (bridge, admin) => {
      const { first: app, second: extension } = await bridge.pair("app", "extension");

      extension.send({ type: "session:goodbye" });

      assertSessionError(await app.nextMessage(), BridgeSessionErrorCode.SESSION_ENDED);
      await within(app.closed, "the app's connection to close");
      await within(extension.closed, "the extension's connection to close");
      extension.assertNothingReceived();
      assert.deepEqual(admin.sessions(), []);
    });
  });

  it("closes a connection that sends nothing for the activity timeout, telling its counterpart it is away", async () => {
    await withBridge({ activityTimeoutMs: 300 }, async (bridge) => {
      const { first: app, second: extension, firstWelcome } = await bridge.pair("app", "extension");
      const beat = setInterval(() => {
        extension.send({ type: "control:ping" });
      }, 50);
      try {
        await within(app.closed, "the silent app's connection to close");
        let message = await extension.nextMessage();
        while (message.type === "control:pong") message = await extension.nextMessage();
        assertCounterpartAway(message);
        const returned = await bridge.connect("app");
        assertJoinCode(await returned.hello({ bindingToken: firstWelcome.bindingToken }));
        assert.equal(assertWelcome(await returned.nextMessage()).sessionId, firstWelcome.sessionId);
      } finally {
        clearInterval(beat);
      }
    });
  });
});

describe("vscode bridge console commands", () => {
  it("disconnect <id> closes that member's connection; the app is told, and the extension's token reclaims the session", async () => {
    await withBridge({}, async (bridge, admin) => {
      const { first: app, second: extension, firstWelcome, secondWelcome } = await bridge.pair("app", "extension");
      const memberId = admin.sessions()[0]?.roles.find((role) => role.role === "extension")?.memberId;
      assert.ok(memberId !== undefined);

      assert.ok(runReplCommand(`disconnect ${memberId}`, admin)?.includes(memberId));
      await within(extension.closed, "the disconnected extension's connection to close");
      assertCounterpartAway(await app.nextMessage());
      const vacancyCode = assertJoinCode(await app.nextMessage());
      assert.deepEqual(
        admin.sessions()[0]?.roles.map((role) => [role.role, role.state]),
        [
          ["app", "connected"],
          ["extension", "lingering"],
        ]
      );
      const returned = await bridge.connect("extension");
      assertJoinCode(await returned.hello({ bindingToken: secondWelcome.bindingToken }));

      assert.deepEqual(assertWelcome(await returned.nextMessage()), { ...secondWelcome, joinCode: vacancyCode });
      assert.deepEqual(assertWelcome(await app.nextMessage()), { ...firstWelcome, joinCode: vacancyCode });
    });
  });

  it("kill <id> ends the session at once: both members are told SESSION_ENDED and closed, its join code is not minted again, and a token re-forms a new session", async () => {
    mock.method(Math, "random", () => 0);
    try {
      await withBridge({}, async (bridge, admin) => {
        const { first: app, second: extension, firstWelcome, secondWelcome } = await bridge.pair("app", "extension");

        assert.ok(runReplCommand(`kill ${firstWelcome.sessionId}`, admin)?.includes(firstWelcome.sessionId));
        assert.deepEqual(admin.sessions(), []);
        assertSessionError(await app.nextMessage(), BridgeSessionErrorCode.SESSION_ENDED);
        assertSessionError(await extension.nextMessage(), BridgeSessionErrorCode.SESSION_ENDED);
        await within(app.closed, "the app's connection to close");
        await within(extension.closed, "the extension's connection to close");

        const fresh = await bridge.connect("app");
        const freshCode = joinCodeOf(await fresh.hello());
        const returnedApp = await bridge.connect("app");
        const reformedCode = joinCodeOf(await returnedApp.hello({ bindingToken: firstWelcome.bindingToken }));
        const returnedExtension = await bridge.connect("extension");
        await returnedExtension.hello({ bindingToken: secondWelcome.bindingToken });
        const welcome = (await returnedExtension.nextMessage()).payload as { sessionId: string; joinCode: string };

        assert.ok(freshCode.startsWith(`${firstWelcome.joinCode}-`));
        assert.equal(welcome.joinCode, reformedCode);
        assert.notEqual(welcome.sessionId, firstWelcome.sessionId);
        assert.notEqual(welcome.joinCode, firstWelcome.joinCode);
      });
    } finally {
      mock.restoreAll();
    }
  });
});

describe("vscode bridge routing", () => {
  /** Opens a paired app and extension on `bridge`. */
  async function openPair(bridge: TestRelay): Promise<{ app: ScriptedPeer; extension: ScriptedPeer }> {
    const { first, second } = await bridge.pair("app", "extension");
    return { app: first, extension: second };
  }

  it("forwards an extension's filesystem:change to the app as its validated fields, and returns the app's reply by id verbatim", async () => {
    await withBridge({}, async (bridge) => {
      const { app, extension } = await openPair(bridge);
      extension.send({
        type: "filesystem:change",
        id: "change-1",
        seq: 3,
        payload: { ...writeOf("tiles/a.ts"), unknownKey: true },
        unknownEnvelopeKey: 1,
      });

      assert.deepEqual(await app.nextMessage(), {
        type: "filesystem:change",
        id: "change-1",
        seq: 3,
        payload: writeOf("tiles/a.ts"),
      });
      const acknowledgement = '{ "type": "filesystem:change", "id": "change-1" }';
      app.sendText(acknowledgement);
      assert.equal(await extension.next(), acknowledgement);
    });
  });

  it("answers an extension's filesystem:change with a session:error by id when its payload is invalid or no app is connected", async () => {
    await withBridge({}, async (bridge) => {
      const extension = await bridge.connect("extension");
      extension.send({ type: "filesystem:change", id: "early", payload: writeOf("a.ts") });
      assertRefused(await extension.nextMessage(), "early");

      const { app, extension: paired } = await openPair(bridge);
      paired.send({ type: "filesystem:change", id: "invalid", payload: { action: "write" } });
      assertRefused(await paired.nextMessage(), "invalid");
      await app.ping();
      app.assertNothingReceived();

      await app.close();
      assertCounterpartAway(await paired.nextMessage());
      assertJoinCode(await paired.nextMessage());
      paired.send({ type: "filesystem:change", id: "away", payload: writeOf("a.ts") });
      assertRefused(await paired.nextMessage(), "away");
    });
  });

  it("forwards an extension's filesystem:sync request without its payload and returns the app's snapshot by id verbatim, or refuses it with no app connected", async () => {
    await withBridge({}, async (bridge) => {
      const { app, extension } = await openPair(bridge);
      extension.send({ type: "filesystem:sync", id: "sync-1", seq: 4, payload: { entries: "ignored" } });

      assert.deepEqual(await app.nextMessage(), { type: "filesystem:sync", id: "sync-1", seq: 4 });
      const snapshot = JSON.stringify({ type: "filesystem:sync", id: "sync-1", seq: 9, payload: { entries: [] } });
      app.sendText(snapshot);
      assert.equal(await extension.next(), snapshot);

      await app.close();
      assertCounterpartAway(await extension.nextMessage());
      assertJoinCode(await extension.nextMessage());
      extension.send({ type: "filesystem:sync", id: "sync-2" });
      assertRefused(await extension.nextMessage(), "sync-2");
    });
  });

  it("forwards the app's compile results, filesystem changes, and snapshots to the extension as their validated fields, dropping invalid ones", async () => {
    await withBridge({}, async (bridge) => {
      const { app, extension } = await openPair(bridge);
      const diagnostics = { file: "a.ts", version: 2, diagnostics: [] };
      const status = { file: "a.ts", success: true, diagnosticCount: { error: 0, warning: 0 } };

      app.send({ type: "compile:diagnostics", payload: { file: "a.ts" } });
      app.send({ type: "compile:diagnostics", seq: 1, payload: { ...diagnostics, extra: 1 } });
      app.send({ type: "compile:status", payload: status });
      app.send({ type: "filesystem:change", seq: 5, payload: writeOf("b.ts") });
      app.send({ type: "filesystem:sync", id: "unsolicited", payload: { entries: [] } });

      assert.deepEqual(await extension.nextMessage(), { type: "compile:diagnostics", payload: diagnostics });
      assert.deepEqual(await extension.nextMessage(), { type: "compile:status", payload: status });
      assert.deepEqual(await extension.nextMessage(), { type: "filesystem:change", seq: 5, payload: writeOf("b.ts") });
      assert.deepEqual(await extension.nextMessage(), {
        type: "filesystem:sync",
        id: "unsolicited",
        payload: { entries: [] },
      });
    });
  });

  it("answers a message type the sender's role does not route with an error message", async () => {
    await withBridge({}, async (bridge) => {
      const { app, extension } = await openPair(bridge);

      app.send({ type: "debug:attach" });
      assertErrorMessage(await app.nextMessage());
      extension.send({ type: "compile:status", payload: { file: "a.ts", success: true } });
      assertErrorMessage(await extension.nextMessage());
      extension.send({ type: "sample:note" });
      assertErrorMessage(await extension.nextMessage());
      extension.send({ type: "toString" });
      assertErrorMessage(await extension.nextMessage());

      await app.ping();
      app.assertNothingReceived();
    });
  });
});

describe("vscode bridge service", () => {
  it("answers binary and oversized frames with an error message and routes neither", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension } = await bridge.pair("app", "extension");

      extension.sendBinary(new Uint8Array([1, 2, 3]));
      assertErrorMessage(await extension.nextMessage());
      extension.send({ type: "filesystem:change", payload: { ...writeOf("big.ts"), content: "x".repeat(1_048_576) } });
      assertErrorMessage(await extension.nextMessage());

      await app.ping();
      app.assertNothingReceived();
    });
  });

  it("refuses a connection beyond a client address's burst of 10", async () => {
    await withBridge({}, async (bridge) => {
      for (let index = 0; index < 10; index++) {
        await bridge.connect(index % 2 === 0 ? "app" : "extension");
      }

      await assert.rejects(bridge.connect("app"));
    });
  });

  it("reports its status at /health and refuses requests beyond a client address's burst of 30", async () => {
    await withBridge({}, async (bridge) => {
      const statuses: number[] = [];
      let report: unknown;
      for (let index = 0; index < 31; index++) {
        const response = await fetch(`http://${bridge.address}/health`);
        statuses.push(response.status);
        const body = await response.json();
        if (index === 0) report = body;
      }

      assert.equal((report as { status: string }).status, "ok");
      assert.equal((report as { packageName: string }).packageName, "@wendoo/vscode-bridge");
      assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
      assert.equal(statuses[30], 429);
    });
  });

  it("closes every connection when it stops", async () => {
    await withBridge({}, async (bridge) => {
      const { first: app, second: extension } = await bridge.pair("app", "extension");

      await bridge.restart();

      await within(app.closed, "the app's connection to close");
      await within(extension.closed, "the extension's connection to close");
    });
  });
});
