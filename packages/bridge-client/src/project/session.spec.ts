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
  });
});
