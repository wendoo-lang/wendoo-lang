import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ProjectSession } from "@wendoo/bridge-client";
import {
  BridgeSessionErrorCode,
  type ExtensionClientMessage,
  type ExtensionServerMessage,
  PROTOCOL_VERSION,
  type WsMessage,
} from "@wendoo/bridge-protocol";
import { BridgePairing } from "./bridge-pairing";

type Callback = ((event: unknown) => void) | null;

/** A WebSocket stand-in the spec opens, feeds, and closes by hand. */
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: Callback = null;
  onclose: Callback = null;
  onmessage: Callback = null;
  onerror: Callback = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  /** The hello this socket carried, parsed. */
  hello(): WsMessage | undefined {
    return this.sent.map((data) => JSON.parse(data) as WsMessage).find((msg) => msg.type === "session:hello");
  }
}

/** The socket the session opened last, opened. */
function openLatest(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1);
  assert.ok(ws, "expected the session to open a socket");
  ws.onopen?.({});
  return ws;
}

/** Hands `ws` the message `message`, as the bridge sends it. */
function receive(ws: MockWebSocket, message: object): void {
  ws.onmessage?.({ data: JSON.stringify(message) });
}

/** A `session:welcome` carrying `bindingToken`. */
function welcome(bindingToken: string): object {
  return {
    type: "session:welcome",
    payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-1", joinCode: "fuzzy-diamond-moor", bindingToken },
  };
}

describe("BridgePairing", () => {
  const originalWebSocket = globalThis.WebSocket;
  let session: ProjectSession<ExtensionClientMessage, ExtensionServerMessage>;
  let saved: string[];
  let pairing: BridgePairing;
  let changes: boolean[];

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    session = new ProjectSession("extension", "localhost:6464", {}, "fuzzy-diamond-moor");
    saved = [];
    pairing = new BridgePairing(session, (token) => {
      saved.push(token);
    });
    changes = [];
    pairing.onDidChange(() => {
      changes.push(pairing.paired);
    });
  });

  afterEach(() => {
    pairing.dispose();
    session.stop();
    mock.timers.reset();
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  it("is paired from a welcome, saving its token, until the bridge reports the app away", () => {
    session.start();
    const ws = openLatest();
    receive(ws, { type: "session:joinCode", payload: { joinCode: "fuzzy-diamond-moor" } });
    assert.equal(pairing.paired, false);

    receive(ws, welcome("token-1"));
    assert.equal(pairing.paired, true);
    assert.deepEqual(saved, ["token-1"]);

    receive(ws, { type: "session:counterpartAway" });
    assert.equal(pairing.paired, false);

    receive(ws, welcome("token-1"));
    assert.deepEqual(changes, [true, false, true]);
    assert.deepEqual(saved, ["token-1", "token-1"]);
  });

  it("saves the token of a welcome that replaces the session's token", () => {
    session.start();
    const ws = openLatest();
    receive(ws, welcome("token-1"));
    receive(ws, welcome("token-2"));

    assert.deepEqual(saved, ["token-1", "token-2"]);
    assert.equal(pairing.paired, true);
  });

  it("is unpaired when the connection drops, and the reconnect presents the welcomed token alone", () => {
    session.start();
    const ws = openLatest();
    receive(ws, welcome("token-1"));

    ws.onclose?.({});
    assert.equal(pairing.paired, false);
    mock.timers.tick(60_000);
    const reconnected = openLatest();

    assert.notEqual(reconnected, ws);
    assert.deepEqual(reconnected.hello()?.payload, {
      protocolVersion: PROTOCOL_VERSION,
      bindingToken: "token-1",
    });
    assert.equal(pairing.paired, false);
    receive(reconnected, welcome("token-1"));
    assert.equal(pairing.paired, true);
  });

  it("is unpaired when the session ends on SESSION_REPLACED, which holds it without reconnecting", () => {
    const errors: BridgeSessionErrorCode[] = [];
    session.addEventListener("error", (code) => {
      errors.push(code);
    });
    session.start();
    const ws = openLatest();
    receive(ws, welcome("token-1"));

    receive(ws, {
      type: "session:error",
      payload: { message: "replaced", code: BridgeSessionErrorCode.SESSION_REPLACED },
    });

    assert.deepEqual(errors, [BridgeSessionErrorCode.SESSION_REPLACED]);
    assert.equal(session.status, "disconnected");
    assert.equal(pairing.paired, false);
    mock.timers.tick(60_000);
    assert.equal(MockWebSocket.instances.length, 1);
    assert.deepEqual(saved, ["token-1"]);
  });
});
