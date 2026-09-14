/**
 * Pins the framing a socket channel puts on the relay wire: what a handshake
 * looks like to a service reading it with the wire's own schema, that a tool-call
 * batch and its results cross intact, and that a session lost mid-turn stops the
 * reader.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, test } from "node:test";
import { FAKE_TARGET_IDENTITY } from "@wendoo/assistant-bridge/testing";
import type { RelayDownstreamMessage, RelayUpstreamMessage } from "@wendoo/assistant-relay";
import { ASSISTANT_RELAY_PROTOCOL_VERSION, relayUpstreamMessageSchema } from "@wendoo/assistant-relay";
import { __test__clientBuild } from "@wendoo/core/__test__";
import type { WebSocket as ServerSocket } from "ws";
import { WebSocketServer } from "ws";
import type { AssistantChannel } from "./channel";
import { createWebSocketConnect } from "./websocket-channel";

/** Path the stand-in service answers upgrades on, as the real endpoint spells it. */
const sessionPath = "/api/assistant/session";

/** What the client declares it serves. */
const manifest = {
  target: FAKE_TARGET_IDENTITY,
  tools: ["read_catalog"],
  morphology: false,
  catalogDigest: "0f3a19c2",
} as const;

/** One tool call the stand-in service asks for. */
const catalogRequest = {
  requestId: "call-0",
  name: "read_catalog",
  input: {},
  timeoutMs: 15000,
} as const;

/** A service the channel talks to, and the upstream frames it read off the wire. */
interface Stand {
  readonly url: string;
  /** Frames the service parsed with the wire's own upstream schema, in arrival order. */
  readonly received: RelayUpstreamMessage[];
  /** The socket the service holds, once a client has connected. */
  socket(): Promise<ServerSocket>;
  send(message: RelayDownstreamMessage): Promise<void>;
  /** Drop the connection without closing the listener, as a service faulting mid-turn does. */
  drop(): Promise<void>;
  stop(): Promise<void>;
}

/** Everything a test in this file stood up, torn down when the file is done. */
const standing: Stand[] = [];

after(async () => {
  for (const stand of standing) await stand.stop();
});

/** Stand a WebSocket service on an ephemeral port that parses every frame it is sent. */
async function serviceStand(): Promise<Stand> {
  const received: RelayUpstreamMessage[] = [];
  const server: Server = createServer();
  const sockets = new WebSocketServer({ server, path: sessionPath });
  let connected: ServerSocket | undefined;
  let announce: ((socket: ServerSocket) => void) | undefined;

  sockets.on("connection", (socket) => {
    connected = socket;
    socket.on("message", (data) => {
      received.push(relayUpstreamMessageSchema.parse(JSON.parse(String(data))) as RelayUpstreamMessage);
    });
    announce?.(socket);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const socket = (): Promise<ServerSocket> =>
    connected
      ? Promise.resolve(connected)
      : new Promise<ServerSocket>((resolve) => {
          announce = resolve;
        });

  const stand: Stand = {
    url: `ws://127.0.0.1:${port}${sessionPath}`,
    received,
    socket,
    send: async (message) => {
      (await socket()).send(JSON.stringify(message));
    },
    drop: async () => {
      (await socket()).terminate();
    },
    stop: () =>
      new Promise<void>((resolve) => {
        sockets.close(() => server.close(() => resolve()));
      }),
  };
  standing.push(stand);
  return stand;
}

/** Open a channel to `stand` and hand back what a client drives it through. */
async function connectTo(stand: Stand): Promise<AssistantChannel> {
  const channel = await createWebSocketConnect(stand.url)();
  channel.send({
    type: "session:connect",
    protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
    clientBuild: __test__clientBuild,
    manifest,
  });
  return channel;
}

/** Resolves once `stand` has read `count` frames, or rejects if it stalls. */
async function readFrames(stand: Stand, count: number): Promise<readonly RelayUpstreamMessage[]> {
  for (let waited = 0; waited < 200; waited++) {
    if (stand.received.length >= count) return stand.received;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the service read ${stand.received.length} frames, not ${count}`);
}

describe("a relay session over a WebSocket", () => {
  test("hands the service a handshake its own wire schema admits", async () => {
    const stand = await serviceStand();

    const channel = await connectTo(stand);
    const [connect] = await readFrames(stand, 1);
    await stand.send({ type: "session:accepted", sessionId: "session-0" });

    assert.deepEqual(connect, {
      type: "session:connect",
      protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
      clientBuild: { ...__test__clientBuild },
      manifest: { ...manifest },
    });
    assert.deepEqual(await channel.next(), { type: "session:accepted", sessionId: "session-0" });
    channel.close();
  });

  test("carries a tool-call batch down and its results back", async () => {
    const stand = await serviceStand();
    const channel = await connectTo(stand);
    await readFrames(stand, 1);
    await stand.send({ type: "session:accepted", sessionId: "session-0" });
    await channel.next();

    await stand.send({ type: "turn:toolCalls", requests: [catalogRequest] });
    const batch = await channel.next();
    channel.send({
      type: "turn:toolResults",
      results: [{ requestId: catalogRequest.requestId, outcome: { kind: "ok", payload: { tiles: [], total: 0 } } }],
    });
    const [, results] = await readFrames(stand, 2);

    assert.deepEqual(batch, { type: "turn:toolCalls", requests: [{ ...catalogRequest }] });
    assert.deepEqual(results, {
      type: "turn:toolResults",
      results: [{ requestId: catalogRequest.requestId, outcome: { kind: "ok", payload: { tiles: [], total: 0 } } }],
    });
    channel.close();
  });

  test("stops the reader when the session is lost mid-turn", async () => {
    const stand = await serviceStand();
    const channel = await connectTo(stand);
    await readFrames(stand, 1);
    await stand.send({ type: "session:accepted", sessionId: "session-0" });
    await channel.next();
    await stand.send({ type: "turn:start" });
    await channel.next();

    const reading = channel.next();
    await stand.drop();

    await assert.rejects(reading);
  });

  test("settles its closure when the session is lost", async () => {
    const stand = await serviceStand();
    const channel = await connectTo(stand);
    await readFrames(stand, 1);

    await stand.drop();

    await channel.closed;
  });

  test("opens no session when nothing answers the address", async () => {
    const stand = await serviceStand();
    await stand.stop();

    await assert.rejects(createWebSocketConnect(stand.url)());
  });
});
