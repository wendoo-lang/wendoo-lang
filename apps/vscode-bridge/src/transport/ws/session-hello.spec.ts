import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BridgeSessionErrorCode, PROTOCOL_VERSION, type WsMessage } from "@wendoo/bridge-protocol";
import type { WSContext } from "hono/ws";

process.env.BRIDGE_BINDING_SECRET = "session-hello-secret";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";

const bindingTokenModule = await import("#core/binding-token.js");
const sessionRegistry = await import("#core/session-registry.js");
const appSessionHandlers = await import("./app/handlers/session.handler.js");
const extensionSessionHandlers = await import("./extension/handlers/session.handler.js");

bindingTokenModule.initBindingSecret();

interface TestWs {
  readonly ws: WSContext;
  readonly messages: WsMessage[];
  readonly closeCount: () => number;
}

function createTestWs(): TestWs {
  const messages: WsMessage[] = [];
  let closes = 0;
  const ws = {
    send(data: string) {
      messages.push(JSON.parse(data) as WsMessage);
    },
    close() {
      closes++;
    },
  } as unknown as WSContext;
  return { ws, messages, closeCount: () => closes };
}

const ROLES = [
  { role: "app", handlers: appSessionHandlers.sessionHandlers },
  { role: "extension", handlers: extensionSessionHandlers.sessionHandlers },
] as const;

for (const { role, handlers } of ROLES) {
  describe(`${role} session:hello`, () => {
    const hello = handlers["session:hello"]!;

    afterEach(() => {
      sessionRegistry.clearAllSessions();
    });

    for (const [label, payload] of [
      ["a newer protocol version", { protocolVersion: PROTOCOL_VERSION + 1 }],
      ["no protocol version", undefined],
    ] as const) {
      it(`rejects a hello declaring ${label} with PROTOCOL_VERSION_MISMATCH and closes the socket`, () => {
        const testWs = createTestWs();

        hello(testWs.ws, payload, "hello-1");

        assert.deepEqual(
          testWs.messages.map((msg) => [msg.type, msg.id, (msg.payload as { code?: string } | undefined)?.code]),
          [["session:error", "hello-1", BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH]]
        );
        assert.equal(testWs.closeCount(), 1);
        assert.deepEqual(sessionRegistry.getSessionCount(), { apps: 0, extensions: 0 });
      });
    }

    it("welcomes a hello declaring this bridge's protocol version and keeps the socket open", () => {
      const testWs = createTestWs();

      hello(testWs.ws, { protocolVersion: PROTOCOL_VERSION }, "hello-1");

      assert.equal(testWs.messages[0]?.type, "session:welcome");
      assert.equal(testWs.closeCount(), 0);
    });
  });
}
