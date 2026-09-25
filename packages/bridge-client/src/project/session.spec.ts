import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { BridgeSessionErrorCode, PROTOCOL_VERSION, type WsMessage } from "@wendoo/bridge-protocol";
import { ProjectSession } from "./session.js";

type WsCallback = ((...args: unknown[]) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: WsCallback = null;
  onclose: WsCallback = null;
  onmessage: WsCallback = null;
  onerror: WsCallback = null;

  readonly url: string;
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  simulateOpen(): void {
    this.onopen?.({});
  }

  simulateMessage(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.onclose?.({});
  }
}

function lastSocket(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1);
  assert.ok(ws, "expected a MockWebSocket instance");
  return ws;
}

function parseSent(ws: MockWebSocket): WsMessage[] {
  return ws.sent.map((raw) => JSON.parse(raw) as WsMessage);
}

function createSession(): ProjectSession<WsMessage, WsMessage> {
  return new ProjectSession<WsMessage, WsMessage>("app", "localhost:3000", {});
}

function startSession(session: ProjectSession<WsMessage, WsMessage>): MockWebSocket {
  session.start();
  const ws = lastSocket();
  ws.simulateOpen();
  return ws;
}

/** Records the session's error and status events, in order, as `error:<code>` and `status:<status>`. */
function recordEvents(session: ProjectSession<WsMessage, WsMessage>): string[] {
  const events: string[] = [];
  session.addEventListener("error", (code) => {
    events.push(`error:${code}`);
  });
  session.addEventListener("status", (status) => {
    events.push(`status:${status}`);
  });
  return events;
}

/** One message of every bridge protocol namespace. */
const PROTOCOL_MESSAGES: readonly WsMessage[] = [
  { type: "session:welcome", payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-1", joinCode: "J-1" } },
  { type: "session:joinCode", payload: { joinCode: "J-2" } },
  { type: "control:pong" },
  { type: "error", payload: { message: "invalid message envelope" } },
  { type: "filesystem:change", payload: { action: "mkdir", path: "src" } },
  { type: "compile:status", payload: { file: "a.ts", success: true, diagnosticCount: { error: 0, warning: 0 } } },
];

/** Payload messages of two kinds, one carrying a top-level field the envelope does not declare, and a bare type. */
const PAYLOAD_MESSAGES: readonly object[] = [
  { type: "sample:document", payload: { content: 'say "hi"\n\u00e9 \ud83d\ude00' }, extra: { kept: true } },
  { type: "other:note", payload: [1, 2, 3] },
  { type: "notice" },
];

describe("ProjectSession", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  });

  afterEach(() => {
    mock.timers.reset();
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  describe("payload messages", () => {
    it("delivers every message outside the protocol namespaces, verbatim, to each listener", () => {
      const session = createSession();
      const first: WsMessage[] = [];
      const second: WsMessage[] = [];
      session.onPayload((msg) => {
        first.push(msg);
      });
      session.onPayload((msg) => {
        second.push(msg);
      });
      const ws = startSession(session);

      for (const msg of [...PROTOCOL_MESSAGES, ...PAYLOAD_MESSAGES]) {
        ws.simulateMessage(msg);
      }

      assert.deepEqual(first, PAYLOAD_MESSAGES);
      assert.deepEqual(second, PAYLOAD_MESSAGES);
    });

    it("does not deliver a reply to a pending request", async () => {
      const session = createSession();
      const delivered: WsMessage[] = [];
      session.onPayload((msg) => {
        delivered.push(msg);
      });
      const ws = startSession(session);

      const reply = session.request("sample:query");
      const query = parseSent(ws).find((msg) => msg.type === "sample:query");
      assert.ok(query?.id);
      ws.simulateMessage({ type: "sample:answer", id: query.id });

      assert.equal((await reply).type, "sample:answer");
      assert.deepEqual(delivered, []);
    });

    it("keeps listeners across stop and start and stops delivering after unsubscribe", () => {
      const session = createSession();
      const delivered: WsMessage[] = [];
      const unsubscribe = session.onPayload((msg) => {
        delivered.push(msg);
      });

      startSession(session);
      session.stop();
      const ws = startSession(session);
      ws.simulateMessage(PAYLOAD_MESSAGES[0]);
      unsubscribe();
      ws.simulateMessage(PAYLOAD_MESSAGES[1]);

      assert.deepEqual(delivered, [PAYLOAD_MESSAGES[0]]);
    });

    it("sends payload messages verbatim", () => {
      const session = createSession();
      const ws = startSession(session);
      const before = ws.sent.length;

      for (const msg of PAYLOAD_MESSAGES) {
        session.sendPayload(msg as WsMessage);
      }

      assert.deepEqual(
        ws.sent.slice(before).map((raw) => JSON.parse(raw) as unknown),
        PAYLOAD_MESSAGES
      );
    });

    it("throws when a payload is sent before start", () => {
      const session = createSession();

      assert.throws(() => session.sendPayload({ type: "sample:document" }));
    });
  });

  describe("protocol version", () => {
    it("ends the session with PROTOCOL_VERSION_MISMATCH when the welcome declares another version", () => {
      const session = createSession();
      const ws = startSession(session);
      const events = recordEvents(session);

      ws.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION + 1, sessionId: "s-1", joinCode: "J-1" },
      });

      assert.deepEqual(events, [`error:${BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH}`, "status:disconnected"]);
      assert.equal(session.status, "disconnected");
      assert.equal(parseSent(ws).at(-1)?.type, "session:goodbye");
      assert.equal(ws.closed, true);
    });

    it("ends the session with PROTOCOL_VERSION_MISMATCH when the welcome declares no version", () => {
      const session = createSession();
      const ws = startSession(session);
      const events = recordEvents(session);

      ws.simulateMessage({ type: "session:welcome", payload: { sessionId: "s-1", joinCode: "J-1" } });

      assert.deepEqual(events, [`error:${BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH}`, "status:disconnected"]);
    });

    it("accepts a welcome declaring this side's version", () => {
      const session = createSession();
      const ws = startSession(session);
      const events = recordEvents(session);

      ws.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-1", joinCode: "J-1" },
      });

      assert.deepEqual(events, []);
      assert.equal(session.status, "connected");
      assert.equal(session.sessionId, "s-1");
    });

    it("delivers only an accepted welcome to welcome handlers", () => {
      const session = createSession();
      const welcomes: WsMessage[] = [];
      session.on("session:welcome", (msg) => {
        welcomes.push(msg);
      });
      const rejected = {
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION + 1, sessionId: "s-1" },
      };
      const accepted = { type: "session:welcome", payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-2" } };

      startSession(session).simulateMessage(rejected);

      assert.deepEqual(welcomes, []);
      assert.equal(session.sessionId, undefined);

      startSession(session).simulateMessage(accepted);

      assert.deepEqual(welcomes, [accepted]);
    });

    it("opens a new session on start after a rejection", () => {
      const session = createSession();
      const events = recordEvents(session);
      const rejectedSocket = startSession(session);
      rejectedSocket.simulateMessage({ type: "session:welcome", payload: { protocolVersion: PROTOCOL_VERSION + 1 } });

      const ws = startSession(session);
      ws.simulateMessage({ type: "session:welcome", payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-2" } });

      assert.notEqual(ws, rejectedSocket);
      assert.equal(parseSent(ws)[0]?.type, "session:hello");
      assert.equal(session.status, "connected");
      assert.equal(session.sessionId, "s-2");
      assert.deepEqual(events.slice(-3), ["status:disconnected", "status:connecting", "status:connected"]);
    });
  });

  describe("wire order", () => {
    const queued: readonly WsMessage[] = [
      { type: "sample:first", payload: { n: 1 } },
      { type: "sample:second", payload: { n: 2 } },
      { type: "sample:third", payload: { n: 3 } },
    ];

    it("sends session:hello before the payloads sent while the first connection opens, in their order", () => {
      const session = createSession();
      session.start();
      const ws = lastSocket();
      for (const msg of queued) {
        session.sendPayload(msg);
      }

      ws.simulateOpen();

      const sent = parseSent(ws);
      assert.equal(sent[0]?.type, "session:hello");
      assert.deepEqual(sent.slice(1), queued);
      session.stop();
    });

    it("sends session:hello before the payloads queued while reconnecting, in their order", () => {
      const session = createSession();
      const ws = startSession(session);
      ws.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-1", joinCode: "J-1", bindingToken: "T-1" },
      });
      ws.simulateClose();
      for (const msg of queued) {
        session.sendPayload(msg);
      }

      mock.timers.tick(60_000);
      const next = lastSocket();
      assert.notEqual(next, ws);
      next.simulateOpen();

      const sent = parseSent(next);
      assert.equal(sent[0]?.type, "session:hello");
      assert.deepEqual(sent.slice(1), queued);
      session.stop();
    });
  });

  describe("join code", () => {
    /** Drops `ws`, lets the client reconnect, and returns the hello the new connection sends. */
    function reconnectHello(ws: MockWebSocket): WsMessage | undefined {
      ws.simulateClose();
      mock.timers.tick(60_000);
      const next = lastSocket();
      assert.notEqual(next, ws);
      next.simulateOpen();
      return parseSent(next).find((msg) => msg.type === "session:hello");
    }

    it("presents on reconnect the join code a session:joinCode delivered", () => {
      const session = createSession();
      const ws = startSession(session);

      ws.simulateMessage({ type: "session:joinCode", payload: { joinCode: "J-2" } });

      assert.deepEqual(reconnectHello(ws)?.payload, { protocolVersion: PROTOCOL_VERSION, joinCode: "J-2" });
      session.stop();
    });

    it("presents on reconnect the latest join code alongside the binding token it holds", () => {
      const session = createSession();
      const ws = startSession(session);
      ws.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-1", joinCode: "J-1", bindingToken: "T-1" },
      });

      ws.simulateMessage({ type: "session:joinCode", payload: { joinCode: "J-3" } });

      assert.deepEqual(reconnectHello(ws)?.payload, {
        protocolVersion: PROTOCOL_VERSION,
        bindingToken: "T-1",
        sessionId: "s-1",
        joinCode: "J-3",
      });
      session.stop();
    });

    it("keeps the constructor's join code when a welcome carrying another is rejected", () => {
      const session = new ProjectSession<WsMessage, WsMessage>("app", "localhost:3000", {}, "J-0");
      const rejectedSocket = startSession(session);
      assert.equal((parseSent(rejectedSocket)[0]?.payload as { joinCode?: string } | undefined)?.joinCode, "J-0");

      rejectedSocket.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION + 1, joinCode: "J-9" },
      });
      const ws = startSession(session);

      assert.equal((parseSent(ws)[0]?.payload as { joinCode?: string } | undefined)?.joinCode, "J-0");
      session.stop();
    });
  });

  describe("bridge-reported errors", () => {
    it("ends the session with the code a session:error carries", () => {
      const session = createSession();
      const ws = startSession(session);
      const events = recordEvents(session);
      const errors: WsMessage[] = [];
      session.on("session:error", (msg) => {
        errors.push(msg);
      });

      ws.simulateMessage({
        type: "session:error",
        payload: { message: "unsupported protocol version", code: BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH },
      });

      assert.deepEqual(events, [`error:${BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH}`, "status:disconnected"]);
      assert.deepEqual(errors, []);
      assert.equal(parseSent(ws).at(-1)?.type, "session:goodbye");
      assert.equal(ws.closed, true);

      mock.timers.tick(60_000);
      assert.equal(MockWebSocket.instances.length, 1);
    });

    it("ends the session without reconnecting when the bridge reports SESSION_REPLACED and closes the socket", () => {
      const session = createSession();
      const ws = startSession(session);
      ws.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-1", joinCode: "J-1", bindingToken: "T-1" },
      });
      const events = recordEvents(session);
      const errors: WsMessage[] = [];
      session.on("session:error", (msg) => {
        errors.push(msg);
      });

      ws.simulateMessage({
        type: "session:error",
        payload: { message: "replaced", code: BridgeSessionErrorCode.SESSION_REPLACED },
      });
      ws.simulateClose();
      mock.timers.tick(60_000);

      assert.deepEqual(events, [`error:${BridgeSessionErrorCode.SESSION_REPLACED}`, "status:disconnected"]);
      assert.deepEqual(errors, []);
      assert.equal(parseSent(ws).at(-1)?.type, "session:goodbye");
      assert.equal(ws.closed, true);
      assert.equal(MockWebSocket.instances.length, 1);
    });

    it("keeps the session open on a session:error without a code", () => {
      const session = createSession();
      const ws = startSession(session);
      const events = recordEvents(session);
      const errors: WsMessage[] = [];
      session.on("session:error", (msg) => {
        errors.push(msg);
      });
      const uncoded = { type: "session:error", payload: { message: "session already established" } };

      ws.simulateMessage(uncoded);

      assert.deepEqual(events, []);
      assert.deepEqual(errors, [uncoded]);
      assert.equal(session.status, "connected");
      assert.equal(ws.closed, false);
    });
  });

  describe("counterpart away", () => {
    it("emits counterpartAway and leaves the connection, join code, and binding token in place", () => {
      const session = createSession();
      const ws = startSession(session);
      ws.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: PROTOCOL_VERSION, sessionId: "s-1", joinCode: "J-1", bindingToken: "T-1" },
      });
      const events = recordEvents(session);
      let awayCount = 0;
      session.addEventListener("counterpartAway", () => {
        awayCount++;
      });
      const payloads: WsMessage[] = [];
      session.onPayload((msg) => {
        payloads.push(msg);
      });

      ws.simulateMessage({ type: "session:counterpartAway" });

      assert.equal(awayCount, 1);
      assert.deepEqual(events, []);
      assert.deepEqual(payloads, []);
      assert.equal(session.status, "connected");
      assert.equal(session.sessionId, "s-1");
      assert.equal(ws.closed, false);

      ws.simulateClose();
      mock.timers.tick(60_000);
      const next = lastSocket();
      next.simulateOpen();
      assert.deepEqual(parseSent(next).find((msg) => msg.type === "session:hello")?.payload, {
        protocolVersion: PROTOCOL_VERSION,
        bindingToken: "T-1",
        sessionId: "s-1",
        joinCode: "J-1",
      });
      session.stop();
    });
  });
});
