import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  BridgeSessionErrorCode,
  PROTOCOL_VERSION,
  type SessionHelloPayload,
  type WsMessage,
} from "@wendoo/bridge-protocol";
import { pino } from "pino";
import { Relay, type RelayConnection, type RelayFrame, type RelayOptions } from "./relay.js";
import {
  assertCounterpartAway,
  assertJoinCode,
  assertSessionError,
  assertWelcome,
  startTestRelay,
  type TestRelay,
  type Welcome,
  within,
} from "./testing/index.js";
import { type RelayServerOptions, startRelayServer } from "./testing/server.js";

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

/** Asserts that `message` is the `session:error` refusing a hello's join code, answering the hello. */
function assertJoinCodeUnknown(message: WsMessage): void {
  assertSessionError(message, BridgeSessionErrorCode.JOIN_CODE_UNKNOWN);
  assert.equal(message.id, "hello");
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

  it("reclaims a lingering session by token: same session id and token, the stable member welcomed again", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome, secondWelcome } = await relay.pair("demo/host", "demo/guest");
      await first.close();
      assertCounterpartAway(await second.nextMessage());
      const vacancyCode = assertJoinCode(await second.nextMessage());

      const returned = await relay.connect("demo/host");
      assert.equal(assertJoinCode(await returned.hello({ bindingToken: firstWelcome.bindingToken })), vacancyCode);

      assert.deepEqual(assertWelcome(await returned.nextMessage()), { ...firstWelcome, joinCode: vacancyCode });
      assert.deepEqual(assertWelcome(await second.nextMessage()), { ...secondWelcome, joinCode: vacancyCode });
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

  it("refuses a hello presenting the code of a session whose roles are both bound, leaving the pair connected", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome } = await relay.pair("demo/host", "demo/guest");
      const claimant = await relay.connect("demo/guest");

      assertJoinCodeUnknown(await claimant.hello({ joinCode: firstWelcome.joinCode }));
      await within(claimant.closed, "the refused connection to close");

      first.send({ type: "demo:note", payload: { text: "still paired" } });
      assert.deepEqual(await second.nextMessage(), { type: "demo:note", payload: { text: "still paired" } });
      await first.ping();
      first.assertNothingReceived();
    });
  });

  it("refuses a hello presenting a join code no session holds and closes its connection", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const host = await relay.connect("demo/host");
      const joinCode = assertJoinCode(await host.hello());
      const stranger = await relay.connect("demo/guest");

      assertJoinCodeUnknown(await stranger.hello({ joinCode: "no-such-code" }));
      await within(stranger.closed, "the refused connection to close");

      const guest = await relay.connect("demo/guest");
      assertJoinCode(await guest.hello({ joinCode }));
      assertWelcome(await guest.nextMessage());
    });
  });

  it("mints a fresh code when a member drops, pushing it after counterpartAway; the code the pair formed with is refused", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome } = await relay.pair("demo/host", "demo/guest");
      await second.close();
      assertCounterpartAway(await first.nextMessage());
      const vacancyCode = assertJoinCode(await first.nextMessage());
      assert.notEqual(vacancyCode, firstWelcome.joinCode);

      const stale = await relay.connect("demo/guest");
      assertJoinCodeUnknown(await stale.hello({ joinCode: firstWelcome.joinCode }));
      const entered = await relay.connect("demo/guest");
      assert.equal(assertJoinCode(await entered.hello({ joinCode: vacancyCode })), vacancyCode);

      const enteredWelcome = assertWelcome(await entered.nextMessage());
      assert.equal(enteredWelcome.sessionId, firstWelcome.sessionId);
      assert.deepEqual(assertWelcome(await first.nextMessage()), { ...firstWelcome, joinCode: vacancyCode });
    });
  });

  it("supersedes a member's open connection when the member binds back in by its token, keeping the session", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome, secondWelcome } = await relay.pair("demo/host", "demo/guest");
      const newer = await relay.connect("demo/guest");

      assertJoinCode(await newer.hello({ bindingToken: secondWelcome.bindingToken }));

      assertSessionError(await second.nextMessage(), BridgeSessionErrorCode.SESSION_REPLACED);
      await within(second.closed, "the superseded connection to close");
      assert.deepEqual(assertWelcome(await newer.nextMessage()), secondWelcome);
      assert.deepEqual(assertWelcome(await first.nextMessage()), firstWelcome);
    });
  });

  it("ends the session on a member's goodbye: the other member is told SESSION_ENDED, both close, and its token later re-forms it", async () => {
    await withRelay({ bindingSecret: "spec-secret" }, async (relay) => {
      const { first, second, firstWelcome, secondWelcome } = await relay.pair("demo/host", "demo/guest");

      first.send({ type: "session:goodbye" });

      assertSessionError(await second.nextMessage(), BridgeSessionErrorCode.SESSION_ENDED);
      await within(second.closed, "the other member's connection to close");
      await within(first.closed, "the leaving member's connection to close");
      first.assertNothingReceived();
      const late = await relay.connect("demo/guest");
      assertJoinCodeUnknown(await late.hello({ joinCode: firstWelcome.joinCode }));

      const host = await relay.connect("demo/host");
      const reformedCode = assertJoinCode(await host.hello({ bindingToken: firstWelcome.bindingToken }));
      const guest = await relay.connect("demo/guest");
      assertJoinCode(await guest.hello({ bindingToken: secondWelcome.bindingToken }));
      const guestWelcome = assertWelcome(await guest.nextMessage());
      assert.notEqual(guestWelcome.sessionId, secondWelcome.sessionId);
      assert.equal(guestWelcome.joinCode, reformedCode);
      assert.equal(guestWelcome.bindingToken, secondWelcome.bindingToken);
    });
  });

  it("closes a connection that sends nothing for the activity timeout, telling its counterpart as on any drop", async () => {
    await withRelay({ bindingSecret: "spec-secret", activityTimeoutMs: 300 }, async (relay) => {
      const { first, second, firstWelcome } = await relay.pair("demo/host", "demo/guest");
      const beat = setInterval(() => {
        first.send({ type: "control:ping" });
      }, 50);
      try {
        await within(second.closed, "the silent connection to close");
        const frames: WsMessage[] = [];
        for (let message = await first.nextMessage(); message.type !== "session:joinCode"; ) {
          frames.push(message);
          message = await first.nextMessage();
        }
        assert.deepEqual(
          frames.filter((message) => message.type !== "control:pong"),
          [{ type: "session:counterpartAway" }]
        );

        const returned = await relay.connect("demo/guest");
        assertJoinCode(await returned.hello({ bindingToken: firstWelcome.bindingToken }));
        assert.equal(assertWelcome(await returned.nextMessage()).sessionId, firstWelcome.sessionId);
      } finally {
        clearInterval(beat);
      }
    });
  });
});

/** One connection registered with a {@link Relay} directly, recording every frame the relay sends it. */
interface Endpoint {
  readonly connection: RelayConnection;
  /** Every frame the relay sent, as text. */
  readonly frames: string[];
  /** Every frame the relay sent, parsed. */
  messages(): WsMessage[];
  /** Hands the relay `message` serialized as JSON, as received from this endpoint. */
  send(message: object): void;
  /** Hands the relay a `session:hello` with id `hello` and `fields` merged over the current protocol version. */
  hello(fields?: Partial<SessionHelloPayload>): void;
  /** Whether the relay has closed this endpoint's connection. */
  readonly closeRequested: boolean;
}

/** Registers a connection of `role` in the `demo` kind with `relay`. */
function connectEndpoint(relay: Relay, role: string): Endpoint {
  const frames: string[] = [];
  let closeRequested = false;
  const connection = relay.connect("demo", role, {
    send: (data) => {
      frames.push(data);
    },
    close: () => {
      closeRequested = true;
    },
  });
  const send = (message: object) => {
    connection.receive(JSON.stringify(message));
  };
  return {
    connection,
    frames,
    messages: () => frames.map((frame) => JSON.parse(frame) as WsMessage),
    send,
    hello: (fields = {}) => {
      send({ type: "session:hello", id: "hello", payload: { protocolVersion: PROTOCOL_VERSION, ...fields } });
    },
    get closeRequested() {
      return closeRequested;
    },
  };
}

/** The join code `message` carries, asserting it is a `session:joinCode`, whatever the code's shape. */
function joinCodeOf(message: WsMessage | undefined): string {
  assert.equal(message?.type, "session:joinCode");
  return (message.payload as { joinCode: string }).joinCode;
}

/**
 * Pairs a `host` and a `guest` endpoint in `relay`, clears the frames the
 * pairing sent them, and returns them with the pairing's join code and the
 * welcome each received.
 */
function pairEndpoints(relay: Relay): {
  host: Endpoint;
  guest: Endpoint;
  joinCode: string;
  hostWelcome: Welcome;
  guestWelcome: Welcome;
} {
  const host = connectEndpoint(relay, "host");
  host.hello();
  const joinCode = joinCodeOf(host.messages()[0]);
  const guest = connectEndpoint(relay, "guest");
  guest.hello({ joinCode });
  const guestWelcome = assertWelcome(guest.messages()[1]);
  const hostWelcome = assertWelcome(host.messages()[1]);
  host.frames.length = 0;
  guest.frames.length = 0;
  return { host, guest, joinCode, hostWelcome, guestWelcome };
}

/** Constructs a relay with no log output and the given optional settings. */
function createRelay(options: Omit<RelayOptions, "bindingSecret" | "logger"> = {}): Relay {
  return new Relay({ bindingSecret: "spec-secret", logger: pino({ level: "silent" }), ...options });
}

describe("session joining", () => {
  it("refuses a join code presented for the role already bound in the session holding it", () => {
    const relay = createRelay();
    const host = connectEndpoint(relay, "host");
    host.hello();
    const joinCode = joinCodeOf(host.messages()[0]);

    const second = connectEndpoint(relay, "host");
    second.hello({ joinCode });

    assertJoinCodeUnknown(second.messages()[0]);
    assert.equal(second.messages().length, 1);
    assert.equal(second.closeRequested, true);
    assert.equal(host.messages().length, 1);
    const guest = connectEndpoint(relay, "guest");
    guest.hello({ joinCode });
    assertWelcome(guest.messages()[1]);
  });

  it("refuses a third role presenting a token for a session whose roles are both bound, keeping its connection open", () => {
    const relay = createRelay();
    const { host, guest, hostWelcome } = pairEndpoints(relay);
    const third = connectEndpoint(relay, "witness");

    third.hello({ bindingToken: hostWelcome.bindingToken });

    assertSessionError(third.messages()[0], undefined);
    assert.equal(third.closeRequested, false);
    host.send({ type: "demo:note" });
    assert.deepEqual(guest.messages(), [{ type: "demo:note" }]);
  });
});

describe("frame handler", () => {
  it("settles each message outside the control namespaces: forwards a rewrite, replies, or drops it", () => {
    const handled: string[] = [];
    const relay = createRelay({
      frameHandler: (frame) => {
        handled.push(frame.type);
        if (frame.type === "demo:forward") {
          assert.equal(frame.forward(JSON.stringify({ type: "demo:rewritten", seq: frame.seq })), true);
        } else if (frame.type === "demo:ask") {
          frame.reply(JSON.stringify({ type: "demo:answer", id: frame.id }));
        }
      },
    });
    const { host, guest } = pairEndpoints(relay);

    host.send({ type: "demo:forward", seq: 7 });
    host.send({ type: "demo:ask", id: "q-1" });
    host.send({ type: "demo:ignored" });
    host.send({ type: "control:ping", id: "p-1" });

    assert.deepEqual(handled, ["demo:forward", "demo:ask", "demo:ignored"]);
    assert.deepEqual(guest.messages(), [{ type: "demo:rewritten", seq: 7 }]);
    assert.deepEqual(host.messages(), [
      { type: "demo:answer", id: "q-1" },
      { type: "control:pong", id: "p-1" },
    ]);
  });

  it("tells the handler the sender has no peer before its session forms", () => {
    const outcomes: boolean[] = [];
    const relay = createRelay({
      frameHandler: (frame) => {
        outcomes.push(frame.forward(frame.data));
      },
    });
    const host = connectEndpoint(relay, "host");
    host.send({ type: "demo:early" });
    host.send({ type: "session:hello", payload: { protocolVersion: PROTOCOL_VERSION } });
    host.send({ type: "demo:unpaired" });

    assert.deepEqual(outcomes, [false, false]);
  });

  it("returns the peer's reply to a message the handler forwarded verbatim, without handing the reply to the handler", () => {
    const frames: RelayFrame[] = [];
    const relay = createRelay({
      frameHandler: (frame) => {
        frames.push(frame);
        frame.forward(JSON.stringify({ type: frame.type, id: frame.id }));
      },
    });
    const { host, guest } = pairEndpoints(relay);

    host.send({ type: "demo:request", id: "r-1", payload: { dropped: true } });
    host.send({ type: "demo:request", id: "r-2" });
    const refusal = '{ "type": "session:error", "id": "r-1", "payload": { "message": "refused" } }';
    guest.connection.receive(refusal);
    const acknowledgement = '{"type":"demo:ack","id":"r-2"}';
    guest.connection.receive(acknowledgement);

    assert.deepEqual(
      frames.map((frame) => [frame.role, frame.type, frame.id]),
      [
        ["host", "demo:request", "r-1"],
        ["host", "demo:request", "r-2"],
      ]
    );
    assert.deepEqual(guest.messages(), [
      { type: "demo:request", id: "r-1" },
      { type: "demo:request", id: "r-2" },
    ]);
    assert.deepEqual(host.frames, [refusal, acknowledgement]);
  });

  it("treats a message carrying a forwarded message's id as an ordinary one once the reply deadline has passed", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    try {
      const handled: string[] = [];
      const relay = createRelay({
        replyDeadlineMs: 1000,
        frameHandler: (frame) => {
          handled.push(`${frame.role} ${frame.type} ${frame.id}`);
          frame.forward(frame.data);
        },
      });
      const { host, guest } = pairEndpoints(relay);
      host.send({ type: "demo:request", id: "on-time" });
      host.send({ type: "demo:request", id: "late" });
      host.send({ type: "demo:request", id: "late-control" });

      mock.timers.tick(999);
      guest.send({ type: "demo:answer", id: "on-time" });
      mock.timers.tick(1);
      guest.send({ type: "demo:answer", id: "late" });
      guest.send({ type: "session:error", id: "late-control", payload: { message: "refused" } });

      assert.deepEqual(handled, [
        "host demo:request on-time",
        "host demo:request late",
        "host demo:request late-control",
        "guest demo:answer late",
      ]);
      assert.deepEqual(host.messages(), [
        { type: "demo:answer", id: "on-time" },
        { type: "demo:answer", id: "late" },
      ]);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("rate protection", () => {
  it("answers each message beyond a connection's burst with an error and drops it, leaving its peer's allowance intact", () => {
    mock.timers.enable({ apis: ["Date"], now: 0 });
    try {
      const relay = createRelay();
      const { host, guest } = pairEndpoints(relay);

      // The host's hello spent one message of its burst.
      for (let index = 0; index < 105; index++) {
        host.send({ type: "demo:note", payload: { index } });
      }
      guest.send({ type: "demo:note", payload: { index: 0 } });

      assert.equal(guest.frames.length, 99);
      assert.deepEqual(guest.messages().at(-1), { type: "demo:note", payload: { index: 98 } });
      const hostMessages = host.messages();
      assert.equal(hostMessages.filter((message) => message.type === "error").length, 6);
      assert.deepEqual(hostMessages.at(-1), { type: "demo:note", payload: { index: 0 } });

      mock.timers.tick(1000);
      host.send({ type: "demo:note", payload: { index: 105 } });
      assert.deepEqual(guest.messages().at(-1), { type: "demo:note", payload: { index: 105 } });
    } finally {
      mock.timers.reset();
    }
  });
});

describe("liveness", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("resets a connection's activity timeout on every frame it sends, and closes it once a full timeout passes in silence", () => {
    const relay = createRelay({ activityTimeoutMs: 1000 });
    const { host, guest } = pairEndpoints(relay);

    for (let beat = 0; beat < 5; beat++) {
      mock.timers.tick(900);
      host.send({ type: "control:ping" });
      guest.send({ type: "demo:note" });
    }
    assert.equal(host.closeRequested, false);
    assert.equal(guest.closeRequested, false);

    mock.timers.tick(999);
    host.send({ type: "control:ping" });
    host.frames.length = 0;
    mock.timers.tick(1);
    assert.equal(guest.closeRequested, true);
    assert.equal(host.closeRequested, false);
    guest.send({ type: "demo:note", payload: { after: "closing" } });
    assertCounterpartAway(host.messages()[0]);
    joinCodeOf(host.messages()[1]);
    assert.equal(host.messages().length, 2);
    relay.dispose();
  });

  it("closes a connection that never sends a hello once the activity timeout passes", () => {
    const relay = createRelay({ activityTimeoutMs: 1000 });
    const idle = connectEndpoint(relay, "host");

    mock.timers.tick(999);
    assert.equal(idle.closeRequested, false);
    mock.timers.tick(1);
    assert.equal(idle.closeRequested, true);
    relay.dispose();
  });
});

describe("test relay", () => {
  it("runs over an injected server starter at every start and restart", async () => {
    const started: RelayServerOptions[] = [];
    const relay = await startTestRelay({
      bindingSecret: "spec-secret",
      server: (options) => {
        started.push(options);
        return startRelayServer(options);
      },
    });
    try {
      await relay.restart();
      await relay.pair("demo/host", "demo/guest");

      assert.deepEqual(
        started.map((options) => [options.port, options.bindingSecret]),
        [
          [0, "spec-secret"],
          [relay.port, "spec-secret"],
        ]
      );
    } finally {
      await relay.close();
    }
  });
});

/** Rotation interval of the relays the rotation specs construct, in milliseconds. */
const ROTATION_MS = 1000;
/** Entry grace of the relays the rotation specs construct, in milliseconds. */
const GRACE_MS = 200;
/** Retired-code quarantine of the relays the rotation specs construct, in milliseconds. */
const QUARANTINE_MS = 500;

describe("join code lifecycle", () => {
  let relays: Relay[];

  beforeEach(() => {
    mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
    relays = [];
  });

  afterEach(() => {
    for (const relay of relays) relay.dispose();
    mock.timers.reset();
    mock.restoreAll();
  });

  /** Constructs a relay rotating on the spec intervals, with `options` applied over them. */
  function rotatingRelay(options: Omit<RelayOptions, "bindingSecret" | "logger"> = {}): Relay {
    const relay = createRelay({ rotationMs: ROTATION_MS, graceMs: GRACE_MS, quarantineMs: QUARANTINE_MS, ...options });
    relays.push(relay);
    return relay;
  }

  /** Connects a `host` endpoint with no credentials and returns it with the join code it was answered with. */
  function openSession(relay: Relay): { host: Endpoint; joinCode: string } {
    const host = connectEndpoint(relay, "host");
    host.hello();
    return { host, joinCode: joinCodeOf(host.messages()[0]) };
  }

  /** Makes every join code the relay generates the same triplet, which the first session is answered with. */
  function generateOneTriplet(): void {
    mock.method(Math, "random", () => 0);
  }

  it("re-mints the code of a session with a vacant role each interval, pushing it to the connected member", () => {
    const relay = rotatingRelay();
    const { host, joinCode } = openSession(relay);

    mock.timers.tick(ROTATION_MS);
    const rotated = joinCodeOf(host.messages()[1]);
    assert.notEqual(rotated, joinCode);

    mock.timers.tick(ROTATION_MS);
    const rotatedAgain = joinCodeOf(host.messages()[2]);
    assert.notEqual(rotatedAgain, rotated);
  });

  it("holds no code while both roles are bound: nothing rotates, and the next drop mints a fresh one", () => {
    const relay = rotatingRelay();
    const { host, guest, joinCode } = pairEndpoints(relay);

    mock.timers.tick(ROTATION_MS * 2);
    assert.deepEqual(host.messages(), []);
    assert.deepEqual(guest.messages(), []);
    assert.equal(relay.sessions()[0].joinCode, undefined);

    guest.connection.closed();
    assertCounterpartAway(host.messages()[0]);
    const vacancyCode = joinCodeOf(host.messages()[1]);
    assert.notEqual(vacancyCode, joinCode);
    assert.equal(relay.sessions()[0].joinCode, vacancyCode);
  });

  it("rotates a lingering session too: its members returning by token are answered and welcomed with the rotated code", () => {
    const relay = rotatingRelay();
    const { host, guest, joinCode, hostWelcome, guestWelcome } = pairEndpoints(relay);
    host.connection.closed();
    guest.connection.closed();

    mock.timers.tick(ROTATION_MS);
    const returnedHost = connectEndpoint(relay, "host");
    returnedHost.hello({ bindingToken: hostWelcome.bindingToken });
    const rotated = joinCodeOf(returnedHost.messages()[0]);
    const returnedGuest = connectEndpoint(relay, "guest");
    returnedGuest.hello({ bindingToken: guestWelcome.bindingToken });
    const welcome = assertWelcome(returnedGuest.messages()[1]);

    assert.notEqual(rotated, joinCode);
    assert.equal(welcome.sessionId, hostWelcome.sessionId);
    assert.equal(welcome.joinCode, rotated);
  });

  it("joins a hello presenting the previous code within the entry grace, answering and welcoming with the current code", () => {
    const relay = rotatingRelay();
    const { host, joinCode } = openSession(relay);
    mock.timers.tick(ROTATION_MS);
    const rotated = joinCodeOf(host.messages()[1]);

    mock.timers.tick(GRACE_MS - 1);
    const guest = connectEndpoint(relay, "guest");
    guest.hello({ joinCode });

    assert.equal(joinCodeOf(guest.messages()[0]), rotated);
    const guestWelcome = assertWelcome(guest.messages()[1]);
    const hostWelcome = assertWelcome(host.messages()[2]);
    assert.equal(guestWelcome.joinCode, rotated);
    assert.equal(hostWelcome.sessionId, guestWelcome.sessionId);
  });

  it("refuses a hello presenting the previous code once the entry grace has passed", () => {
    const relay = rotatingRelay();
    const { host, joinCode } = openSession(relay);
    mock.timers.tick(ROTATION_MS);
    mock.timers.tick(GRACE_MS);
    host.frames.length = 0;

    const late = connectEndpoint(relay, "guest");
    late.hello({ joinCode });

    assertJoinCodeUnknown(late.messages()[0]);
    assert.equal(late.messages().length, 1);
    assert.equal(late.closeRequested, true);
    assert.deepEqual(host.messages(), []);
    assert.equal(relay.sessions().length, 1);
  });

  it("refuses a hello presenting the previous code at the next rotation when that comes before the grace ends", () => {
    const relay = rotatingRelay({ graceMs: ROTATION_MS * 3 });
    const { host, joinCode } = openSession(relay);
    mock.timers.tick(ROTATION_MS);
    const rotated = joinCodeOf(host.messages()[1]);
    mock.timers.tick(ROTATION_MS);
    const current = joinCodeOf(host.messages()[2]);
    host.frames.length = 0;

    const late = connectEndpoint(relay, "guest");
    late.hello({ joinCode });
    assertJoinCodeUnknown(late.messages()[0]);
    assert.deepEqual(host.messages(), []);

    const onTime = connectEndpoint(relay, "guest");
    onTime.hello({ joinCode: rotated });
    const welcome = assertWelcome(onTime.messages()[1]);
    assert.equal(welcome.sessionId, assertWelcome(host.messages()[0]).sessionId);
    assert.equal(welcome.joinCode, current);
  });

  it("takes both the current code and the previous code in its grace out of service when the last vacant role binds", () => {
    const relay = rotatingRelay();
    const { host, joinCode } = openSession(relay);
    mock.timers.tick(ROTATION_MS);
    const rotated = joinCodeOf(host.messages()[1]);
    const guest = connectEndpoint(relay, "guest");
    guest.hello({ joinCode: rotated });
    assertWelcome(guest.messages()[1]);

    for (const presented of [joinCode, rotated]) {
      const late = connectEndpoint(relay, "guest");
      late.hello({ joinCode: presented });
      assertJoinCodeUnknown(late.messages()[0]);
    }
    assert.equal(relay.sessions()[0].joinCode, undefined);
  });

  it("never mints a code the last vacant role's binding took out of service inside the quarantine window", () => {
    generateOneTriplet();
    const relay = rotatingRelay();
    const { joinCode } = pairEndpoints(relay);

    assert.notEqual(openSession(relay).joinCode, joinCode);
    mock.timers.tick(QUARANTINE_MS);
    assert.equal(openSession(relay).joinCode, joinCode);
  });

  it("never mints the code of a swept session inside the quarantine window, and mints it once the window has passed", () => {
    generateOneTriplet();
    const relay = rotatingRelay({ lingerMs: 100 });
    const { host, joinCode } = openSession(relay);
    host.connection.closed();
    mock.timers.tick(100);

    assert.notEqual(openSession(relay).joinCode, joinCode);
    mock.timers.tick(QUARANTINE_MS);
    assert.equal(openSession(relay).joinCode, joinCode);
  });

  it("quarantines a rotated-away code once its entry grace ends", () => {
    generateOneTriplet();
    const relay = rotatingRelay();
    const { joinCode } = openSession(relay);
    mock.timers.tick(ROTATION_MS);
    mock.timers.tick(GRACE_MS);

    assert.notEqual(openSession(relay).joinCode, joinCode);
    mock.timers.tick(QUARANTINE_MS);
    assert.equal(openSession(relay).joinCode, joinCode);
  });

  it("quarantines a rotated-away code at the next rotation when that comes before its entry grace ends", () => {
    generateOneTriplet();
    const relay = rotatingRelay({ graceMs: ROTATION_MS * 3 });
    const { joinCode } = openSession(relay);
    mock.timers.tick(ROTATION_MS);
    mock.timers.tick(ROTATION_MS);

    assert.notEqual(openSession(relay).joinCode, joinCode);
    mock.timers.tick(QUARANTINE_MS);
    assert.equal(openSession(relay).joinCode, joinCode);
  });

  it("falls back to a triplet with a random suffix once every attempt collides with a code in use", () => {
    generateOneTriplet();
    const relay = rotatingRelay();
    const { joinCode } = openSession(relay);

    assert.match(openSession(relay).joinCode, new RegExp(`^${joinCode}-[0-9a-f]{8}$`));
  });
});

describe("session inspection and administration", () => {
  afterEach(() => {
    mock.restoreAll();
    mock.timers.reset();
  });

  it("reports each session with its kind, session id, code while a role is vacant, and every role with its state and since when", () => {
    mock.timers.enable({ apis: ["Date"], now: 1000 });
    const relay = createRelay();
    assert.deepEqual(relay.sessions(), []);
    const { host, guest, hostWelcome } = pairEndpoints(relay);
    mock.timers.tick(500);
    const waiting = connectEndpoint(relay, "host");
    waiting.hello();
    const waitingCode = joinCodeOf(waiting.messages()[0]);

    const [paired, alone] = relay.sessions();
    assert.deepEqual([paired.kind, paired.sessionId, paired.joinCode], ["demo", hostWelcome.sessionId, undefined]);
    assert.deepEqual(
      paired.roles.map((role) => [role.role, role.state, role.since]),
      [
        ["guest", "connected", 1000],
        ["host", "connected", 1000],
      ]
    );
    const [guestId, hostId] = paired.roles.map((role) => role.memberId);
    assert.equal(typeof guestId, "string");
    assert.equal(typeof hostId, "string");
    assert.notEqual(guestId, hostId);
    assert.equal(alone.joinCode, waitingCode);
    assert.deepEqual(
      alone.roles.map((role) => [role.role, role.state, role.since]),
      [["host", "connected", 1500]]
    );

    mock.timers.tick(500);
    guest.connection.closed();
    const vacancyCode = joinCodeOf(host.messages()[1]);
    assert.equal(relay.sessions()[0].joinCode, vacancyCode);
    assert.deepEqual(relay.sessions()[0].roles, [
      { role: "guest", state: "lingering", memberId: undefined, since: 2000 },
      { role: "host", state: "connected", memberId: hostId, since: 1000 },
    ]);
    mock.timers.tick(500);
    host.connection.closed();
    assert.deepEqual(
      relay.sessions()[0].roles.map((role) => [role.role, role.state, role.since]),
      [
        ["guest", "lingering", 2000],
        ["host", "lingering", 2500],
      ]
    );
  });

  it("ends a session by id at once: each member is told SESSION_ENDED and closed, its code is retired, and a token re-forms a new session", () => {
    mock.method(Math, "random", () => 0);
    const relay = createRelay();
    const waiting = connectEndpoint(relay, "host");
    waiting.hello();
    const joinCode = joinCodeOf(waiting.messages()[0]);
    const guest = connectEndpoint(relay, "guest");
    guest.hello({ joinCode });
    const hostWelcome = assertWelcome(waiting.messages()[1]);
    waiting.frames.length = 0;
    guest.frames.length = 0;

    assert.equal(relay.endSession(hostWelcome.sessionId), true);
    assert.deepEqual(relay.sessions(), []);
    for (const member of [waiting, guest]) {
      assert.equal(member.closeRequested, true);
      assert.equal(member.messages().length, 1);
      assertSessionError(member.messages()[0], BridgeSessionErrorCode.SESSION_ENDED);
      member.connection.closed();
      assert.equal(member.messages().length, 1);
    }
    assert.equal(relay.endSession(hostWelcome.sessionId), false);

    const returned = connectEndpoint(relay, "host");
    returned.hello({ bindingToken: hostWelcome.bindingToken });
    const [reformed] = relay.sessions();
    assert.notEqual(reformed.sessionId, hostWelcome.sessionId);
    assert.notEqual(reformed.joinCode, joinCode);
    assert.equal(joinCodeOf(returned.messages()[0]), reformed.joinCode);
  });

  it("disconnects a member by id: its connection closes, its counterpart is told, and its token reclaims the session", () => {
    const relay = createRelay();
    const { host, guest, hostWelcome, guestWelcome } = pairEndpoints(relay);
    const guestId = relay.sessions()[0].roles.find((role) => role.role === "guest")?.memberId;
    assert.ok(guestId !== undefined);

    assert.equal(relay.disconnectMember(guestId), true);
    assert.equal(guest.closeRequested, true);
    assert.equal(host.closeRequested, false);
    guest.connection.closed();
    assertCounterpartAway(host.messages()[0]);
    const vacancyCode = joinCodeOf(host.messages()[1]);
    assert.equal(relay.disconnectMember(guestId), false);
    assert.equal(relay.disconnectMember("no-such-member"), false);

    const returned = connectEndpoint(relay, "guest");
    returned.hello({ bindingToken: guestWelcome.bindingToken });
    assert.deepEqual(assertWelcome(returned.messages()[1]), { ...guestWelcome, joinCode: vacancyCode });
    assert.deepEqual(assertWelcome(host.messages()[2]), { ...hostWelcome, joinCode: vacancyCode });
  });
});
