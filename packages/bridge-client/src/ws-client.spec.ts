import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { WsMessage } from "@wendoo/bridge-protocol";
import { WsClient } from "./ws-client.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

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

  simulateMessage(data: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.onclose?.({});
  }

  simulateError(): void {
    this.onerror?.({});
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

/**
 * Records every call `client` makes to its callbacks and to a listener for
 * `greeting`, in order, as `onOpen`, `onDisconnect`, `onQueueOverflow`,
 * `onMessage:<type>`, and `listener:<type>`.
 */
function recordCallbacks(client: WsClient): string[] {
  const calls: string[] = [];
  client.onOpen = () => {
    calls.push("onOpen");
  };
  client.onDisconnect = () => {
    calls.push("onDisconnect");
  };
  client.onQueueOverflow = () => {
    calls.push("onQueueOverflow");
  };
  client.onMessage = (msg) => {
    calls.push(`onMessage:${msg.type}`);
  };
  client.on("greeting", (msg) => {
    calls.push(`listener:${msg.type}`);
  });
  return calls;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("WsClient", () => {
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

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  describe("connection lifecycle", () => {
    it("starts in idle state", () => {
      const client = new WsClient();
      assert.equal(client.connectionState, "idle");
    });

    it("transitions to connecting then open", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      assert.equal(client.connectionState, "connecting");

      lastSocket().simulateOpen();
      assert.equal(client.connectionState, "open");
    });

    it("fires onOpen when the socket opens", () => {
      const client = new WsClient();
      let opened = false;
      client.onOpen = () => {
        opened = true;
      };
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();
      assert.ok(opened);
    });

    it("ignores connect() when already open", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      client.connect("ws://localhost:9999");
      assert.equal(MockWebSocket.instances.length, 1);
    });

    it("ignores connect() when already connecting", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      client.connect("ws://localhost:9999");
      assert.equal(MockWebSocket.instances.length, 1);
    });

    it("ignores connect() after close()", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();
      client.close();

      client.connect("ws://localhost:9999");
      assert.equal(client.connectionState, "closed");
      assert.equal(MockWebSocket.instances.length, 1);
    });

    it("transitions to closed and closes socket on close()", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      const ws = lastSocket();
      ws.simulateOpen();

      client.close();
      assert.equal(client.connectionState, "closed");
      assert.ok(ws.closed);
    });
  });

  // -----------------------------------------------------------------------
  // close() on a socket that has not opened yet
  // -----------------------------------------------------------------------

  describe("close() before the socket opens", () => {
    /**
     * Drives `ws` through everything a socket can do after its client closed --
     * open, deliver a message, two heartbeat intervals, drop, and a reconnect
     * window -- and returns what `client` and the wire showed for it.
     */
    function afterSocketActivity(client: WsClient, ws: MockWebSocket, calls: string[]) {
      ws.simulateOpen();
      ws.simulateMessage({ type: "greeting" });
      mock.timers.tick(200);
      ws.simulateClose();
      mock.timers.tick(1000);
      return {
        closed: ws.closed,
        sent: parseSent(ws),
        calls,
        state: client.connectionState,
        sockets: MockWebSocket.instances.length,
      };
    }

    it("closes the socket still connecting, which then sends nothing and reaches no callback", () => {
      const client = new WsClient({ initialReconnectDelay: 10, heartbeatInterval: 100 });
      const calls = recordCallbacks(client);
      client.connect("ws://localhost:9999");
      client.send({ type: "queued" });
      const ws = lastSocket();

      client.close();

      assert.deepEqual(afterSocketActivity(client, ws, calls), {
        closed: true,
        sent: [],
        calls: [],
        state: "closed",
        sockets: 1,
      });
    });

    it("closes the retry socket in flight while reconnecting, which then sends nothing and reaches no callback", () => {
      const client = new WsClient({ initialReconnectDelay: 10, heartbeatInterval: 100 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();
      lastSocket().simulateClose();
      const calls = recordCallbacks(client);
      client.send({ type: "queued" });
      mock.timers.tick(10);
      const retry = lastSocket();
      assert.equal(MockWebSocket.instances.length, 2, "retry socket opened");

      client.close();

      assert.deepEqual(afterSocketActivity(client, retry, calls), {
        closed: true,
        sent: [],
        calls: [],
        state: "closed",
        sockets: 2,
      });
    });
  });

  // -----------------------------------------------------------------------
  // Sending messages
  // -----------------------------------------------------------------------

  describe("send", () => {
    it("sends a message when open", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      const msg: WsMessage = { type: "test", payload: { value: 1 } };
      client.send(msg);

      const sent = parseSent(lastSocket());
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], msg);
    });

    it("queues messages while connecting and flushes on open", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");

      const m1: WsMessage = { type: "a" };
      const m2: WsMessage = { type: "b" };
      client.send(m1);
      client.send(m2);

      const ws = lastSocket();
      assert.equal(ws.sent.length, 0, "nothing sent before open");

      ws.simulateOpen();

      const sent = parseSent(ws);
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[0], m1);
      assert.deepEqual(sent[1], m2);
    });

    it("drops messages sent while idle", () => {
      const client = new WsClient();
      client.send({ type: "dropped" });
      assert.equal(MockWebSocket.instances.length, 0);
    });
  });

  describe("sendImmediate", () => {
    it("sends from onOpen ahead of the queued messages, which follow in order", () => {
      const client = new WsClient();
      const first: WsMessage = { type: "first" };
      client.onOpen = () => {
        client.sendImmediate(first);
      };
      client.connect("ws://localhost:9999");
      const queued: WsMessage[] = [{ type: "a" }, { type: "b" }];
      for (const m of queued) {
        client.send(m);
      }

      lastSocket().simulateOpen();

      assert.deepEqual(parseSent(lastSocket()), [first, ...queued]);
    });

    it("drops the message while connecting instead of queueing it", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      client.sendImmediate({ type: "dropped" });

      lastSocket().simulateOpen();

      assert.deepEqual(lastSocket().sent, []);
    });
  });

  // -----------------------------------------------------------------------
  // Queued messages sent upon connect (user-requested test)
  // -----------------------------------------------------------------------

  describe("queued messages sent upon connect", () => {
    it("sends all queued messages in order when the socket opens", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");

      const messages: WsMessage[] = [
        { type: "hello", payload: { role: "app" } },
        { type: "subscribe", payload: { channel: "events" } },
        { type: "ping" },
      ];
      for (const m of messages) {
        client.send(m);
      }

      const ws = lastSocket();
      assert.equal(ws.sent.length, 0, "messages queued, not sent yet");

      ws.simulateOpen();

      const sent = parseSent(ws);
      assert.equal(sent.length, messages.length);
      for (let i = 0; i < messages.length; i++) {
        assert.deepEqual(sent[i], messages[i]);
      }
    });

    it("queues messages during reconnect and flushes when reconnected", () => {
      const client = new WsClient({ initialReconnectDelay: 10 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      lastSocket().simulateClose();
      assert.equal(client.connectionState, "reconnecting");

      const msg: WsMessage = { type: "queued-during-reconnect" };
      client.send(msg);

      mock.timers.tick(10);
      const ws2 = lastSocket();
      assert.equal(ws2.sent.length, 0, "queued until reconnect completes");

      ws2.simulateOpen();
      const sent = parseSent(ws2);
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0], msg);
    });

    it("does not re-send messages that were already flushed", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");

      client.send({ type: "first" });
      lastSocket().simulateOpen();

      client.send({ type: "second" });

      const sent = parseSent(lastSocket());
      assert.equal(sent.length, 2);
      assert.equal(sent[0]!.type, "first");
      assert.equal(sent[1]!.type, "second");
    });
  });

  describe("queue overflow", () => {
    it("closes, then calls onQueueOverflow once, when a send would grow the queue past maxQueueSize", () => {
      const client = new WsClient({ initialReconnectDelay: 10, maxQueueSize: 2 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();
      lastSocket().simulateClose();
      const calls = recordCallbacks(client);
      client.onQueueOverflow = () => {
        calls.push(`onQueueOverflow:${client.connectionState}`);
        client.send({ type: "sent-from-callback" });
      };
      client.send({ type: "first" });
      client.send({ type: "second" });
      assert.deepEqual(calls, [], "a full queue is not yet an overflow");

      client.send({ type: "third" });
      client.send({ type: "fourth" });
      mock.timers.tick(1000);

      assert.deepEqual(
        { calls, state: client.connectionState, sockets: MockWebSocket.instances.length },
        { calls: ["onQueueOverflow:closed"], state: "closed", sockets: 1 }
      );
    });
  });

  // -----------------------------------------------------------------------
  // Event listeners
  // -----------------------------------------------------------------------

  describe("on / listeners", () => {
    it("dispatches a message to registered listeners", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      const received: WsMessage[] = [];
      client.on("greeting", (msg) => received.push(msg));

      lastSocket().simulateMessage({ type: "greeting", payload: "hi" });

      assert.equal(received.length, 1);
      assert.equal(received[0]!.type, "greeting");
      assert.equal(received[0]!.payload, "hi");
    });

    it("supports multiple listeners for the same type", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      let count = 0;
      client.on("tick", () => count++);
      client.on("tick", () => count++);

      lastSocket().simulateMessage({ type: "tick" });
      assert.equal(count, 2);
    });

    it("unsubscribes via the returned function", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      let count = 0;
      const unsub = client.on("tick", () => count++);

      lastSocket().simulateMessage({ type: "tick" });
      assert.equal(count, 1);

      unsub();
      lastSocket().simulateMessage({ type: "tick" });
      assert.equal(count, 1, "handler not called after unsub");
    });

    it("ignores unparseable messages", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      let called = false;
      client.on("anything", () => {
        called = true;
      });

      lastSocket().onmessage?.({ data: "not valid json{{{" });
      assert.ok(!called);
    });
  });

  // -----------------------------------------------------------------------
  // Request / response correlation
  // -----------------------------------------------------------------------

  describe("request", () => {
    it("resolves when a response with matching id arrives", async () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      const promise = client.request("getData", { key: "x" });

      const ws = lastSocket();
      const sent = parseSent(ws);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.type, "getData");
      assert.ok(sent[0]!.id, "request should have an id");

      ws.simulateMessage({
        type: "getData:response",
        id: sent[0]!.id,
        payload: { result: 42 },
      });

      const response = await promise;
      assert.deepEqual(response.payload, { result: 42 });
    });

    it("times out if no response arrives", async () => {
      const client = new WsClient({ requestTimeout: 100 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      const promise = client.request("slow");

      mock.timers.tick(100);

      await assert.rejects(promise, { message: "request timed out: slow" });
    });

    it("rejects pending requests when client is closed", async () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      const promise = client.request("pending");
      client.close();

      await assert.rejects(promise, { message: "client closed" });
    });

    it("does not dispatch a response with id to listeners", () => {
      const client = new WsClient();
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      let listenerCalled = false;
      client.on("getData:response", () => {
        listenerCalled = true;
      });

      const promise = client.request("getData");

      const ws = lastSocket();
      const sent = parseSent(ws);
      ws.simulateMessage({ type: "getData:response", id: sent[0]!.id, payload: {} });

      promise.then(() => {});

      assert.ok(!listenerCalled, "response handled by pending request, not listener");
    });
  });

  // -----------------------------------------------------------------------
  // Reconnection
  // -----------------------------------------------------------------------

  describe("reconnection", () => {
    const originalRandom = Math.random;

    beforeEach(() => {
      Math.random = () => 1;
    });

    afterEach(() => {
      Math.random = originalRandom;
    });

    it("fires onDisconnect and enters reconnecting state on socket close", () => {
      const client = new WsClient();
      let disconnected = false;
      client.onDisconnect = () => {
        disconnected = true;
      };
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      lastSocket().simulateClose();
      assert.ok(disconnected);
      assert.equal(client.connectionState, "reconnecting");
    });

    it("attempts to reconnect after the initial delay", () => {
      const client = new WsClient({ initialReconnectDelay: 50 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      lastSocket().simulateClose();
      assert.equal(MockWebSocket.instances.length, 1);

      mock.timers.tick(50);
      assert.equal(MockWebSocket.instances.length, 2, "new socket created after delay");
    });

    it("applies decorrelated jitter backoff on repeated failures", () => {
      const client = new WsClient({ initialReconnectDelay: 100, maxReconnectDelay: 1000 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      lastSocket().simulateClose();
      mock.timers.tick(100);
      assert.equal(MockWebSocket.instances.length, 2);

      lastSocket().simulateClose();
      mock.timers.tick(299);
      assert.equal(MockWebSocket.instances.length, 2, "not yet -- delay grew to 300");
      mock.timers.tick(1);
      assert.equal(MockWebSocket.instances.length, 3);

      lastSocket().simulateClose();
      mock.timers.tick(899);
      assert.equal(MockWebSocket.instances.length, 3, "not yet -- delay grew to 900");
      mock.timers.tick(1);
      assert.equal(MockWebSocket.instances.length, 4);
    });

    it("caps reconnect delay at maxReconnectDelay", () => {
      const client = new WsClient({ initialReconnectDelay: 100, maxReconnectDelay: 200 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      lastSocket().simulateClose();
      mock.timers.tick(100);

      lastSocket().simulateClose();
      mock.timers.tick(200);
      assert.equal(MockWebSocket.instances.length, 3);

      lastSocket().simulateClose();
      mock.timers.tick(200);
      assert.equal(MockWebSocket.instances.length, 4, "stays capped at 200");
    });

    it("resets backoff delay after a successful reconnect", () => {
      const client = new WsClient({ initialReconnectDelay: 100 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      lastSocket().simulateClose();
      mock.timers.tick(100);
      lastSocket().simulateOpen();

      lastSocket().simulateClose();
      mock.timers.tick(100);
      assert.equal(MockWebSocket.instances.length, 3, "reconnect at initial delay, not doubled");
    });

    it("does not reconnect after close() is called", () => {
      const client = new WsClient({ initialReconnectDelay: 10 });
      client.connect("ws://localhost:9999");
      lastSocket().simulateOpen();

      client.close();
      lastSocket().simulateClose();

      mock.timers.tick(100);
      assert.equal(MockWebSocket.instances.length, 1, "no reconnect attempt");
    });
  });
});
