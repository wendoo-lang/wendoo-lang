import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import type { AuthoringWorkspace, ToolCallError } from "@wendoo/assistant-bridge";
import { createAuthoringWorkspace, executeToolCall, ToolCallErrorCode } from "@wendoo/assistant-bridge";
import { createTargetAdapter, FAKE_TARGET_IDENTITY, ruleIdAt } from "@wendoo/assistant-bridge/testing";
import type {
  ConversationEntry,
  ConversationRecord,
  ConversationToolCall,
  ConversationTurnEnding,
  RelayConnect,
  RelayToolManifest,
  RelayToolOutcome,
  RelayUpstreamMessage,
} from "@wendoo/assistant-relay";
import {
  CONVERSATION_RECORD_VERSION,
  ConversationTurnFailureCode,
  RelayDeclineCode,
  RelayRefusalCode,
  RelayTakeoverCode,
  thinkingWritingName,
} from "@wendoo/assistant-relay";
import type { RelayLoopback } from "@wendoo/assistant-relay/testing";
import { createRelayLoopback } from "@wendoo/assistant-relay/testing";
import { __test__clientBuild } from "@wendoo/core/__test__";
import { createPersonActivity } from "../app/person-activity";
import { recordFor } from "../conversation/store";
import type { ScriptedCall, ScriptedService, ScriptedTurn } from "../testing/scripted-service";
import { runScriptedService } from "../testing/scripted-service";
import type { AssistantChannel } from "./channel";
import type { AssistantMachineOptions, AssistantMachineState, PendingAsk, TurnDoing } from "./machine";
import {
  AssistantMachine,
  AssistantStatus,
  doingFor,
  pendingFor,
  sessionOpenTimeoutMs,
  sessionReopenHeadDelaysMs,
  sessionReopenIntervalMs,
  sessionReopenJitterMs,
} from "./machine";
import type { SessionPresence } from "./presence";
import { sessionStatus } from "./sessions";

/** Tiles the fake target's brains are authored from. */
const tiles = {
  sensor: "tile.sensor->sensor.fake.signal",
  actuator: "tile.actuator->actuator.fake.emit",
} as const;

/** The document every workspace in this file opens on. */
const openingDocument = createAuthoringWorkspace(createTargetAdapter(), "fake brain").brainDef.toJson();

/** Id of the one rule {@link openingDocument} holds, which the authoring turn fills in. */
const openingRuleId = ruleIdAt(
  createAuthoringWorkspace(createTargetAdapter(), "fake brain", { brainJson: openingDocument }).brainDef,
  "0/0"
);

/** The calls a first turn makes: the session catalog read, then a batch that authors a rule. */
const firstTurnCalls = {
  catalog: { name: "read_catalog", input: {} },
  authoring: [
    { name: "read_catalog", input: { filter: "signal" } },
    { name: "propose_edit", input: { op: "placeTiles", ruleId: openingRuleId, side: "when", tileIds: [tiles.sensor] } },
    { name: "propose_edit", input: { op: "placeTiles", ruleId: openingRuleId, side: "do", tileIds: [tiles.actuator] } },
  ],
} as const satisfies Record<string, ScriptedCall | readonly ScriptedCall[]>;

/** What the client declares it serves. */
const manifest: RelayToolManifest = {
  target: FAKE_TARGET_IDENTITY,
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
  catalogDigest: "0f3a19c2",
};

/** A workspace over the fake target, opened on {@link openingDocument}. */
function freshWorkspace(): AuthoringWorkspace {
  return createAuthoringWorkspace(createTargetAdapter(), "fake brain", { brainJson: openingDocument });
}

/** A machine under test, with the pieces a test drives it through. */
interface Harness {
  readonly machine: AssistantMachine;
  /** How many sessions the machine has asked for. */
  connects(): number;
  /** How many of the channels it was given are closed. */
  closed(): number;
  /** The handshake of every session the machine opened, in the order it opened them. */
  handshakes(): readonly RelayConnect[];
  /** Every message the machine sent the service, across every session, in the order it sent them. */
  sent(): readonly RelayUpstreamMessage[];
  /** Close the session opened at `at` from the service's end, as the service dropping it. */
  drop(at: number): void;
  /** Resolves once every session's scripted service has played out its script. */
  readonly served: Promise<void>;
}

/** What a harness may vary about the machine it stands. */
interface HarnessOptions {
  readonly mediate?: AssistantMachineOptions["mediate"];
  /** Brains whose workspace the host cannot produce. */
  readonly workspaceless?: readonly string[];
  /** Closes every session the harness opened as the workspace throws, so the failure cannot be answered. */
  readonly dropsWhenServing?: boolean;
  /** Fails every attempt to open a session. */
  readonly unreachable?: boolean;
  /** Fails every attempt to open a session from this one on, counting from zero. */
  readonly unreachableFrom?: number;
  /** Ends the run {@link HarnessOptions.unreachableFrom} started, so this attempt and every later one is answered. */
  readonly unreachableUntil?: number;
  /** Never answers an attempt to open a session, leaving the open in flight forever. */
  readonly unanswered?: boolean;
  /** Where the person's own changes to a brain's document are recorded; none are recorded when absent. */
  readonly activity?: AssistantMachineOptions["activity"];
  /** Where the page stands for the machine's reopen loop; in view and never changing when absent. */
  readonly presence?: AssistantMachineOptions["presence"];
  /** The entropy the machine draws each steady reopen delay's spread from. */
  readonly random?: AssistantMachineOptions["random"];
}

/**
 * Stand a machine whose sessions are answered by scripted services: one per
 * session opened, taken from `script` by the order the sessions were opened in
 * when it varies by session.
 */
function harness(script: ScriptedService | ((at: number) => ScriptedService), options: HarnessOptions = {}): Harness {
  const workspaces = new Map<string, AuthoringWorkspace>();
  const opened: AssistantChannel[] = [];
  const closes: AssistantChannel[] = [];
  const services: Promise<void>[] = [];
  const loopbacks: RelayLoopback[] = [];
  const handshakes: RelayConnect[] = [];
  const sent: RelayUpstreamMessage[] = [];
  let connects = 0;

  const workspace = (brainId: string): AuthoringWorkspace => {
    if (options.workspaceless?.includes(brainId)) {
      if (options.dropsWhenServing) for (const channel of opened) channel.close();
      throw new Error(`no workspace for ${brainId}`);
    }
    const held = workspaces.get(brainId);
    if (held) return held;
    const made = freshWorkspace();
    workspaces.set(brainId, made);
    return made;
  };

  const connect = (): Promise<AssistantChannel> => {
    const at = connects++;
    const inFailingRun =
      at >= (options.unreachableFrom ?? Number.POSITIVE_INFINITY) &&
      at < (options.unreachableUntil ?? Number.POSITIVE_INFINITY);
    if (options.unreachable || inFailingRun) {
      return Promise.reject(new Error("no route to the service"));
    }
    if (options.unanswered) return new Promise<AssistantChannel>(() => {});
    const loopback: RelayLoopback = createRelayLoopback();
    loopbacks.push(loopback);
    services.push(runScriptedService(loopback, typeof script === "function" ? script(services.length) : script));
    const channel: AssistantChannel = {
      send: (message) => {
        sent.push(message);
        if (message.type === "session:connect") handshakes.push(message);
        loopback.toolServer.send(message);
      },
      next: () => loopback.toolServer.next(),
      close: () => {
        closes.push(channel);
        loopback.toolServer.close();
      },
      closed: loopback.toolServer.closed,
    };
    opened.push(channel);
    return Promise.resolve(channel);
  };

  return {
    machine: new AssistantMachine({
      connect,
      manifest,
      clientBuild: __test__clientBuild,
      workspace,
      ...(options.mediate ? { mediate: options.mediate } : {}),
      ...(options.activity ? { activity: options.activity } : {}),
      ...(options.presence ? { presence: options.presence } : {}),
      ...(options.random ? { random: options.random } : {}),
    }),
    connects: () => connects,
    closed: () => closes.length,
    handshakes: () => handshakes,
    sent: () => sent,
    drop: (at: number) => {
      const loopback = loopbacks[at];
      if (!loopback) throw new Error(`no session was opened at ${at}`);
      loopback.service.close();
    },
    get served(): Promise<void> {
      return Promise.all(services).then(() => undefined);
    },
  };
}

/** Resolve once `machine` reaches a state `predicate` accepts. */
function until(machine: AssistantMachine, predicate: (state: AssistantMachineState) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (predicate(machine.getState())) {
      resolve();
      return;
    }
    const unsubscribe = machine.subscribe(() => {
      if (!predicate(machine.getState())) return;
      unsubscribe();
      resolve();
    });
  });
}

/** Resolve once `machine` has no turn running on the active brain. */
function settled(machine: AssistantMachine): Promise<void> {
  return until(machine, (state) => state.status === AssistantStatus.Ready || state.status === AssistantStatus.Failed);
}

/** Resolve once `machine` has no turn running on `brainId`. */
function settledFor(machine: AssistantMachine, brainId: string): Promise<void> {
  return until(machine, (state) => {
    const status = sessionStatus(state.sessions, brainId);
    return status === AssistantStatus.Ready || status === AssistantStatus.Failed;
  });
}

/** Resolve once `brainId`'s conversation holds `count` entries. */
function holds(machine: AssistantMachine, brainId: string, count: number): Promise<void> {
  return until(machine, (state) => recordFor(state.store, brainId).entries.length === count);
}

/** Resolve once everything already scheduled has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The conversation `machine` holds for `brainId`. */
function conversation(machine: AssistantMachine, brainId: string): ConversationRecord {
  return recordFor(machine.getState().store, brainId);
}

/** What `entry` reads as: what the person said, or the turn's narration segments joined. */
function saidIn(entry: ConversationEntry): string {
  if (entry.kind === "user") return entry.text;
  return entry.steps.map((step) => (step.kind === "narration" ? step.text : "")).join("");
}

/** The calls `entry` made, for a turn; empty for something the person said. */
function callsIn(entry: ConversationEntry): ConversationToolCall[] {
  if (entry.kind === "user") return [];
  return entry.steps.flatMap((step) => (step.kind === "toolCall" ? [step.call] : []));
}

/** How `entry`'s turn finished; absent while it still runs, and for something the person said. */
function endingOf(entry: ConversationEntry): ConversationTurnEnding | undefined {
  return entry.kind === "assistant" ? entry.ending : undefined;
}

/** A script whose one turn narrates and then completes. */
const oneQuietTurn: ScriptedService = {
  turns: [{ steps: [{ kind: "narration", text: "looking at it" }] }],
};

/** Let everything already queued run, without advancing a mocked clock. */
async function drain(): Promise<void> {
  for (let step = 0; step < 20; step++) await Promise.resolve();
}

/** Let everything already queued run, then the mocked clock run `ms` forward, then what that queued run. */
async function advance(ms: number): Promise<void> {
  await drain();
  mock.timers.tick(ms);
  await drain();
}

/** Resolve once `brainId`'s session stands at `status`. */
function standsAt(machine: AssistantMachine, brainId: string, status: AssistantStatus): Promise<void> {
  return until(machine, (state) => sessionStatus(state.sessions, brainId) === status);
}

/** A presence the test drives, standing in for a page's visibility and the browser's connection. */
function pageIn(inView: boolean) {
  const listeners = new Set<() => void>();
  let visible = inView;
  return {
    presence: {
      inView: () => visible,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies SessionPresence,
    /** How many listeners are watching the page. */
    watchers: () => listeners.size,
    /** Put the page in or out of view, telling whoever watches. */
    show: (next: boolean) => {
      visible = next;
      for (const listener of [...listeners]) listener();
    },
    /** Tell whoever watches the browser came back online. */
    online: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

/** A stand holding one open session for `brain-a`, ready for the service to drop it. */
async function standingSession(
  options: Pick<HarnessOptions, "unreachableFrom" | "unreachableUntil" | "presence" | "random">
): Promise<Harness> {
  const stand = harness(oneQuietTurn, options);
  stand.machine.setActiveBrain("brain-a");
  stand.machine.openSession("brain-a");
  await settled(stand.machine);
  return stand;
}

describe("opening the session", () => {
  test("opens no session while the host has named no brain", async () => {
    const stand = harness(oneQuietTurn);

    await flush();

    assert.equal(stand.connects(), 0);
    assert.equal(stand.machine.getState().status, AssistantStatus.Idle);
  });

  test("opens one session for the send that finds the brain holding none", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);

    assert.equal(stand.connects(), 1);
    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
    await stand.served;
  });

  test("passes through connecting on the way to ready when the session is opened first", async () => {
    const stand = harness(oneQuietTurn);
    const seen: string[] = [stand.machine.getState().status];
    stand.machine.subscribe(() => {
      const status = stand.machine.getState().status;
      if (seen[seen.length - 1] !== status) seen.push(status);
    });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.openSession("brain-a");
    await settled(stand.machine);
    stand.machine.send("make it hide");
    await settled(stand.machine);

    assert.deepEqual(seen, [
      AssistantStatus.Idle,
      AssistantStatus.Connecting,
      AssistantStatus.Ready,
      AssistantStatus.TurnActive,
      AssistantStatus.Ready,
    ]);
    await stand.served;
  });

  test("stands turn-active from the send that opens the session for it", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");

    assert.equal(stand.machine.getState().status, AssistantStatus.TurnActive);
    await settled(stand.machine);
    await stand.served;
  });

  test("reuses the session it already holds for a second turn", async () => {
    const stand = harness({ turns: [oneQuietTurn.turns![0]!, oneQuietTurn.turns![0]!] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("first");
    await settled(stand.machine);
    stand.machine.send("second");
    await settled(stand.machine);

    assert.equal(stand.connects(), 1);
    assert.equal(conversation(stand.machine, "brain-a").entries.length, 4);
    await stand.served;
  });

  test("does nothing on a send before the host has named a brain", async () => {
    const stand = harness(oneQuietTurn);

    stand.machine.send("make it hide");

    assert.equal(stand.connects(), 0);
    assert.equal(stand.machine.getState().status, AssistantStatus.Idle);
  });

  test("fails the turn that could not reach a service, and opens one on the next send", async () => {
    const unreachable = harness(oneQuietTurn, { unreachable: true });
    unreachable.machine.setActiveBrain("brain-a");

    unreachable.machine.send("make it hide");
    await settled(unreachable.machine);

    assert.equal(unreachable.machine.getState().status, AssistantStatus.Failed);
    assert.deepEqual(conversation(unreachable.machine, "brain-a").entries, [
      { kind: "user", text: "make it hide" },
      {
        kind: "assistant",
        steps: [],
        ending: { kind: "failure", code: ConversationTurnFailureCode.NotConnected },
      },
    ]);
    unreachable.machine.close();

    const reachable = harness(oneQuietTurn);
    reachable.machine.setActiveBrain("brain-a");
    reachable.machine.send("try again");
    await settled(reachable.machine);

    assert.equal(reachable.machine.getState().status, AssistantStatus.Ready);
    await reachable.served;
  });

  test("fails the turn whose handshake the service refused", async () => {
    const stand = harness({ refusal: RelayRefusalCode.TargetUnavailable });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);

    assert.equal(stand.machine.getState().status, AssistantStatus.Failed);
    assert.equal(stand.closed(), 1);
    await stand.served;
  });
});

describe("a library the person added", () => {
  /** The coordinate every add in this block names. */
  const added = "example-org/lib-position";

  /** The coordinate a second add names, where a test makes two. */
  const alsoAdded = "example-org/lib-flock";

  /** A turn the service leaves running until the client asks it to stop. */
  const heldTurn: ScriptedTurn = { steps: [{ kind: "awaitStop" }] };

  /** A turn that narrates and completes, as an add's own turn plays out. */
  const quietTurn: ScriptedTurn = { steps: [{ kind: "narration", text: "looking at it" }] };

  /** Every add the machine told the service about, in the order it told it. */
  function addsIn(stand: Harness): readonly RelayUpstreamMessage[] {
    return stand.sent().filter((message) => message.type === "session:libraryAdded");
  }

  /** The add message for `coordinate`, as the machine sends it. */
  function addOf(coordinate: string): RelayUpstreamMessage {
    return { type: "session:libraryAdded", coordinate };
  }

  test("opens a turn on the session standing, carrying the coordinate and nothing of the person's own", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);

    stand.machine.libraryAdded("brain-a", added);
    await settled(stand.machine);

    assert.deepEqual(addsIn(stand), [addOf(added)]);
    const entries = conversation(stand.machine, "brain-a").entries;
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["assistant"],
      "the add opened a turn and left nothing standing as the person's"
    );
    assert.equal(saidIn(entries[0]!), "looking at it");
    await stand.served;
  });

  test("stands the brain turn-active from the add that opened the turn", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);

    stand.machine.libraryAdded("brain-a", added);

    assert.equal(stand.machine.getState().status, AssistantStatus.TurnActive);
    await settled(stand.machine);
    await stand.served;
  });

  test("holds nothing back from a session standing ready, whatever turns follow", async () => {
    const stand = harness({ turns: [quietTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);

    stand.machine.libraryAdded("brain-a", added);
    await settled(stand.machine);
    stand.machine.send("and now hide");
    await settled(stand.machine);

    assert.deepEqual(addsIn(stand), [addOf(added)], "the add was told once, not told again at a later turn's end");
    await stand.served;
  });

  test("tells nobody while the brain holds no session, holding the add for no session to come", async () => {
    // The page stands out of view, so nothing dials for the brain and it holds
    // no session to tell.
    const stand = harness(oneQuietTurn, { presence: pageIn(false).presence });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.libraryAdded("brain-a", added);
    await flush();

    assert.equal(stand.connects(), 0);
    assert.deepEqual(addsIn(stand), []);
    assert.notEqual(stand.machine.getState().status, AssistantStatus.TurnActive);
    assert.deepEqual(conversation(stand.machine, "brain-a").entries, []);

    stand.machine.openSession("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);

    assert.deepEqual(addsIn(stand), [], "the session that opened afterwards was told nothing of the add");
    assert.deepEqual(conversation(stand.machine, "brain-a").entries, []);
  });

  test("tells nobody for a brain the machine holds nothing of", async () => {
    const stand = harness(oneQuietTurn);

    stand.machine.libraryAdded("brain-a", added);
    await flush();

    assert.equal(stand.connects(), 0);
    assert.deepEqual(addsIn(stand), []);
  });

  test("waits for the turn running, and takes a turn of its own once it ends", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn] });
    const seen: string[] = [stand.machine.getState().status];
    stand.machine.subscribe(() => {
      const status = stand.machine.getState().status;
      if (seen[seen.length - 1] !== status) seen.push(status);
    });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.libraryAdded("brain-a", added);
    assert.deepEqual(addsIn(stand), [], "nothing is told while the turn the add arrived during still runs");

    stand.machine.stop();
    await holds(stand.machine, "brain-a", 3);
    await settledFor(stand.machine, "brain-a");

    assert.deepEqual(addsIn(stand), [addOf(added)]);
    assert.deepEqual(
      conversation(stand.machine, "brain-a").entries.map((entry) => entry.kind),
      ["user", "assistant", "assistant"],
      "the add took a turn of its own, after the one it waited for"
    );
    assert.deepEqual(seen, [
      AssistantStatus.Idle,
      AssistantStatus.TurnActive,
      AssistantStatus.Ready,
      AssistantStatus.TurnActive,
      AssistantStatus.Ready,
    ]);
    await stand.served;
  });

  test("takes a turn for each of two adds made during one turn, in the order they were made", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.libraryAdded("brain-a", added);
    stand.machine.libraryAdded("brain-a", alsoAdded);
    stand.machine.stop();
    await holds(stand.machine, "brain-a", 4);

    assert.deepEqual(addsIn(stand), [addOf(added), addOf(alsoAdded)]);
    assert.deepEqual(
      conversation(stand.machine, "brain-a").entries.map((entry) => entry.kind),
      ["user", "assistant", "assistant", "assistant"],
      "each add took a turn of its own, rather than sharing one"
    );
    await stand.served;
  });

  test("takes its turn on the session opened after the one it was made on was lost", async () => {
    const stand = harness((at) => (at === 0 ? { turns: [heldTurn] } : { turns: [quietTurn] }));
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.libraryAdded("brain-a", added);
    stand.drop(0);
    await holds(stand.machine, "brain-a", 3);

    assert.equal(stand.connects(), 2, "the session the add waited on was lost and another was opened");
    assert.deepEqual(addsIn(stand), [addOf(added)]);
    assert.equal(
      endingOf(conversation(stand.machine, "brain-a").entries[1]!)?.kind,
      "failure",
      "the turn the add waited for went with the session"
    );
    assert.equal(saidIn(conversation(stand.machine, "brain-a").entries[2]!), "looking at it");
    await stand.served;
  });

  test("takes its turn on the brain it was added to, whatever brain is being shown by then", async () => {
    // The page stands out of view, so nothing dials for the brain shown second.
    const stand = harness({ turns: [heldTurn, quietTurn] }, { presence: pageIn(false).presence });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.libraryAdded("brain-a", added);
    stand.machine.setActiveBrain("brain-b");
    stand.machine.stopAll();
    await holds(stand.machine, "brain-a", 3);

    assert.deepEqual(addsIn(stand), [addOf(added)]);
    assert.equal(stand.connects(), 1, "the brain shown by then was told nothing and opened no session");
    assert.deepEqual(conversation(stand.machine, "brain-b").entries, []);
    assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-b"), AssistantStatus.Idle);
    await stand.served;
  });
});

describe("an ask the person typed while a turn was running", () => {
  /** A turn the service leaves running until the client asks it to stop. */
  const heldTurn: ScriptedTurn = { steps: [{ kind: "awaitStop" }] };

  /** A turn that narrates and completes, as a waiting ask's turn plays out. */
  const quietTurn: ScriptedTurn = { steps: [{ kind: "narration", text: "looking at it" }] };

  /** The coordinate every add in this block names. */
  const added = "example-org/lib-position";

  /** What `brainId` has waiting of the person's own asks, in the order they were typed. */
  function waitingFor(machine: AssistantMachine, brainId: string): readonly PendingAsk[] {
    return pendingFor(machine.getState().pending, brainId);
  }

  /** What `brainId` has waiting, read by the words each ask carries. */
  function waitingWords(machine: AssistantMachine, brainId: string): string[] {
    return waitingFor(machine, brainId).map((ask) => ask.text);
  }

  /** What the machine opened each turn with, in the order it opened them. */
  function openings(stand: Harness): string[] {
    const opened: string[] = [];
    for (const message of stand.sent()) {
      if (message.type === "session:userMessage") opened.push(message.text);
      if (message.type === "session:libraryAdded") opened.push(`added ${message.coordinate}`);
    }
    return opened;
  }

  test("holds the ask back while the turn runs, and takes a turn of its own once it ends", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await drain();
    assert.equal(stand.machine.getState().status, AssistantStatus.TurnActive, "the first turn is under way");

    stand.machine.send("and jump");

    assert.deepEqual(openings(stand), ["make it hide"], "nothing of the ask crossed while the turn ran");
    assert.deepEqual(waitingWords(stand.machine, "brain-a"), ["and jump"]);
    assert.equal(conversation(stand.machine, "brain-a").entries.length, 1, "the waiting ask stands in no record yet");

    stand.machine.stop();
    await holds(stand.machine, "brain-a", 4);
    await settledFor(stand.machine, "brain-a");

    assert.deepEqual(openings(stand), ["make it hide", "and jump"]);
    assert.deepEqual(conversation(stand.machine, "brain-a").entries.map(saidIn), [
      "make it hide",
      "",
      "and jump",
      "looking at it",
    ]);
    assert.deepEqual(waitingWords(stand.machine, "brain-a"), [], "nothing waits once it has taken its turn");
    await stand.served;
  });

  test("takes one turn for the asks typed one after another, their words joined in order", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.send("and jump");
    stand.machine.send("then hide again");
    stand.machine.send("then stop");
    stand.machine.stop();
    await holds(stand.machine, "brain-a", 4);
    await settledFor(stand.machine, "brain-a");

    assert.deepEqual(openings(stand), ["make it hide", "and jump\nthen hide again\nthen stop"]);
    assert.deepEqual(
      conversation(stand.machine, "brain-a").entries.map((entry) => entry.kind),
      ["user", "assistant", "user", "assistant"],
      "the three asks took one turn between them"
    );
    await stand.served;
  });

  test("takes what waits in the order it arrived, an add taking its own turn between the asks around it", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn, quietTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.send("and jump");
    stand.machine.libraryAdded("brain-a", added);
    stand.machine.send("then hide again");
    stand.machine.stop();
    await holds(stand.machine, "brain-a", 7);
    await settledFor(stand.machine, "brain-a");

    assert.deepEqual(openings(stand), ["make it hide", "and jump", `added ${added}`, "then hide again"]);
    assert.deepEqual(
      conversation(stand.machine, "brain-a").entries.map((entry) => entry.kind),
      ["user", "assistant", "user", "assistant", "assistant", "user", "assistant"],
      "the add parted the asks around it rather than joining them"
    );
    await stand.served;
  });

  test("takes a waiting ask back, opening nothing for it and leaving the rest in the order they were typed", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.send("and jump");
    stand.machine.send("then hide again");
    stand.machine.send("then stop");

    const middle = waitingFor(stand.machine, "brain-a")[1]!;
    assert.equal(stand.machine.cancelAsk(middle.id), "then hide again", "the ask came back with its words");
    assert.deepEqual(waitingWords(stand.machine, "brain-a"), ["and jump", "then stop"]);
    assert.equal(stand.machine.cancelAsk(middle.id), undefined, "an ask already taken back is not there to take again");

    stand.machine.stop();
    await holds(stand.machine, "brain-a", 4);
    await settledFor(stand.machine, "brain-a");

    assert.deepEqual(openings(stand), ["make it hide", "and jump\nthen stop"]);
    await stand.served;
  });

  test("holds one turn for a library added twice while the turn ran", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.libraryAdded("brain-a", added);
    stand.machine.libraryAdded("brain-a", added);
    stand.machine.stop();
    await holds(stand.machine, "brain-a", 3);
    await settledFor(stand.machine, "brain-a");

    assert.deepEqual(openings(stand), ["make it hide", `added ${added}`]);
    assert.deepEqual(
      conversation(stand.machine, "brain-a").entries.map((entry) => entry.kind),
      ["user", "assistant", "assistant"],
      "the second add of the same library took no turn of its own"
    );
    await stand.served;
  });

  test("takes its turn on the session opened after the one it waited on was lost", async () => {
    const stand = harness((at) => (at === 0 ? { turns: [heldTurn] } : { turns: [quietTurn] }));
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await drain();
    stand.machine.send("and jump");
    stand.drop(0);
    await holds(stand.machine, "brain-a", 4);

    assert.equal(stand.connects(), 2, "the session the ask waited on was lost and another was opened");
    assert.deepEqual(openings(stand), ["make it hide", "and jump"]);
    assert.equal(
      endingOf(conversation(stand.machine, "brain-a").entries[1]!)?.kind,
      "failure",
      "the turn the ask waited for went with the session"
    );
    assert.equal(saidIn(conversation(stand.machine, "brain-a").entries[3]!), "looking at it");
    await stand.served;
  });

  test("keeps each brain's waiting asks its own, and takes back only the shown brain's", async () => {
    // The page stands out of view, so nothing dials for either brain beyond the
    // sessions the test asks for.
    const stand = harness({ turns: [heldTurn, quietTurn] }, { presence: pageIn(false).presence });

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    await drain();
    stand.machine.send("and jump");
    stand.machine.setActiveBrain("brain-b");
    stand.machine.send("make it seek");
    await drain();
    stand.machine.send("and flock");

    assert.deepEqual(waitingWords(stand.machine, "brain-a"), ["and jump"]);
    assert.deepEqual(waitingWords(stand.machine, "brain-b"), ["and flock"]);

    const held = waitingFor(stand.machine, "brain-a")[0]!;
    assert.equal(stand.machine.cancelAsk(held.id), undefined, "the brain behind the one shown keeps what it holds");
    assert.deepEqual(waitingWords(stand.machine, "brain-a"), ["and jump"]);

    stand.machine.stopAll();
    await holds(stand.machine, "brain-a", 4);
    await holds(stand.machine, "brain-b", 4);
    await settledFor(stand.machine, "brain-a");
    await settledFor(stand.machine, "brain-b");

    assert.deepEqual(conversation(stand.machine, "brain-a").entries.map(saidIn), [
      "make it hide",
      "",
      "and jump",
      "looking at it",
    ]);
    assert.deepEqual(conversation(stand.machine, "brain-b").entries.map(saidIn), [
      "make it seek",
      "",
      "and flock",
      "looking at it",
    ]);
    await stand.served;
  });

  test("stands the ask either waiting or in the record, and never in both at once", async () => {
    const stand = harness({ turns: [heldTurn, quietTurn] });
    stand.machine.setActiveBrain("brain-a");
    const asked = "and jump";
    /** Whether the ask stood waiting and recorded at the same time, and how often. */
    let doubled = 0;
    /** How many of the states seen stood the ask waiting. */
    let waited = 0;
    stand.machine.subscribe(() => {
      const state = stand.machine.getState();
      const waiting = pendingFor(state.pending, "brain-a").some((ask) => ask.text === asked);
      const recorded = recordFor(state.store, "brain-a").entries.some(
        (entry) => entry.kind === "user" && entry.text === asked
      );
      if (waiting) waited++;
      if (waiting && recorded) doubled++;
    });

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.send(asked);
    stand.machine.stop();
    await holds(stand.machine, "brain-a", 4);
    await settledFor(stand.machine, "brain-a");

    assert.equal(doubled, 0, "no state ever stood the ask twice");
    assert.ok(waited > 0, "the ask did stand waiting on the way");
    assert.deepEqual(waitingWords(stand.machine, "brain-a"), []);
    assert.deepEqual(
      conversation(stand.machine, "brain-a").entries.map(saidIn),
      ["make it hide", "", asked, "looking at it"],
      "the ask stands in the record it drained into"
    );
    await stand.served;
  });

  describe("an ask the person hurries to the front", () => {
    /** How many times the machine asked a running turn to stop. */
    function stops(stand: Harness): number {
      return stand.sent().filter((message) => message.type === "turn:stop").length;
    }

    test("stops the running turn and takes its own words alone, the rest joining behind it", async () => {
      const stand = harness({ turns: [heldTurn, quietTurn, quietTurn] });
      stand.machine.setActiveBrain("brain-a");

      stand.machine.send("make it hide");
      await drain();
      stand.machine.send("and jump");
      stand.machine.send("then hide again");
      stand.machine.send("then stop");

      const hurried = waitingFor(stand.machine, "brain-a")[2]!;
      stand.machine.sendNow(hurried.id);

      assert.deepEqual(waitingWords(stand.machine, "brain-a"), ["then stop", "and jump", "then hide again"]);
      assert.equal(stops(stand), 1, "the running turn was asked to stop the once");

      await holds(stand.machine, "brain-a", 6);
      await settledFor(stand.machine, "brain-a");

      assert.deepEqual(endingOf(conversation(stand.machine, "brain-a").entries[1]!), {
        kind: "end",
        code: "stopped",
      });
      assert.deepEqual(openings(stand), ["make it hide", "then stop", "and jump\nthen hide again"]);
      assert.equal(stops(stand), 1, "nothing asked the turn it opened to stop as well");
      assert.deepEqual(waitingWords(stand.machine, "brain-a"), []);
      await stand.served;
    });

    test("takes its turn alone on the session opened after the one its brain had lost", async () => {
      // The page stands out of view, so nothing dials for the brain beyond the
      // sessions the test asks for.
      const stand = harness((at) => (at === 0 ? { turns: [heldTurn] } : { turns: [quietTurn, quietTurn] }), {
        presence: pageIn(false).presence,
      });
      stand.machine.setActiveBrain("brain-a");

      stand.machine.send("make it hide");
      await drain();
      stand.machine.send("and jump");
      stand.machine.send("then hide again");
      const hurried = waitingFor(stand.machine, "brain-a")[1]!;

      stand.drop(0);
      await settledFor(stand.machine, "brain-a");
      assert.equal(stand.machine.getState().status, AssistantStatus.Failed, "the turn went with the session it ran on");

      stand.machine.sendNow(hurried.id);

      assert.deepEqual(
        waitingWords(stand.machine, "brain-a"),
        ["then hide again", "and jump"],
        "the hurried ask stands at the front, with nothing opened for it while the brain holds no session"
      );

      stand.machine.openSession("brain-a");
      await holds(stand.machine, "brain-a", 6);
      await settledFor(stand.machine, "brain-a");

      assert.equal(stand.connects(), 2);
      assert.deepEqual(openings(stand), ["make it hide", "then hide again", "and jump"]);
      await stand.served;
    });

    test("hurries nothing along for a name waiting on nothing, or for a brain behind the one shown", async () => {
      // The page stands out of view, so nothing dials for either brain beyond
      // the one session the test asks for.
      const stand = harness({ turns: [heldTurn, quietTurn] }, { presence: pageIn(false).presence });
      stand.machine.setActiveBrain("brain-a");

      stand.machine.send("make it hide");
      await drain();
      stand.machine.send("and jump");
      stand.machine.send("then hide again");
      const held = waitingFor(stand.machine, "brain-a")[1]!;

      stand.machine.sendNow("ask-none");
      assert.deepEqual(waitingWords(stand.machine, "brain-a"), ["and jump", "then hide again"]);

      stand.machine.setActiveBrain("brain-b");
      stand.machine.sendNow(held.id);
      assert.deepEqual(
        waitingWords(stand.machine, "brain-a"),
        ["and jump", "then hide again"],
        "the brain behind the one shown keeps what it holds in the order it holds it"
      );

      stand.machine.setActiveBrain("brain-a");
      stand.machine.stop();
      await holds(stand.machine, "brain-a", 4);
      await settledFor(stand.machine, "brain-a");

      assert.equal(stand.connects(), 1);
      assert.deepEqual(openings(stand), ["make it hide", "and jump\nthen hide again"]);
      await stand.served;
    });
  });
});

describe("a session per brain", () => {
  test("opens a brain's session with no send", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.openSession("brain-a");
    assert.equal(stand.machine.getState().status, AssistantStatus.Connecting);
    await settled(stand.machine);

    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
    assert.equal(stand.connects(), 1);
    assert.deepEqual(conversation(stand.machine, "brain-a").entries, []);
  });

  test("opens one session however often it is asked for the same brain", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.openSession("brain-a");
    stand.machine.openSession("brain-a");
    await settled(stand.machine);
    stand.machine.openSession("brain-a");

    assert.equal(stand.connects(), 1);
  });

  test("reuses the session it holds when the brain's container closes and opens again", async () => {
    const stand = harness({ turns: [oneQuietTurn.turns![0]!, oneQuietTurn.turns![0]!] });
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    stand.machine.send("first");
    await settled(stand.machine);

    // The container is gone and comes back on the same brain; nothing tears the
    // session down in between.
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    stand.machine.send("second");
    await settled(stand.machine);

    assert.equal(stand.connects(), 1);
    assert.equal(stand.closed(), 0);
    assert.equal(conversation(stand.machine, "brain-a").entries.length, 4);
    await stand.served;
  });

  test("stands two brains' sessions at once, each filling only its own record", async () => {
    const stand = harness(oneQuietTurn);

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    await settledFor(stand.machine, "brain-a");
    stand.machine.setActiveBrain("brain-b");
    stand.machine.send("make it seek");
    await settledFor(stand.machine, "brain-b");

    const { sessions } = stand.machine.getState();
    assert.equal(stand.connects(), 2);
    assert.equal(sessionStatus(sessions, "brain-a"), AssistantStatus.Ready);
    assert.equal(sessionStatus(sessions, "brain-b"), AssistantStatus.Ready);
    assert.deepEqual(conversation(stand.machine, "brain-a").entries[0], { kind: "user", text: "make it hide" });
    assert.deepEqual(conversation(stand.machine, "brain-b").entries[0], { kind: "user", text: "make it seek" });
    assert.equal(conversation(stand.machine, "brain-a").entries.length, 2);
    assert.equal(conversation(stand.machine, "brain-b").entries.length, 2);
    await stand.served;
  });

  test("closes every session it opened when it is stood down", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    stand.machine.openSession("brain-b");
    await settledFor(stand.machine, "brain-a");
    await settledFor(stand.machine, "brain-b");

    stand.machine.close();

    assert.equal(stand.closed(), 2);
    assert.equal(stand.machine.getState().status, AssistantStatus.Idle);
  });

  test("closes a session that arrives after it was stood down, and holds none", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.openSession("brain-a");
    stand.machine.close();
    await flush();

    assert.equal(stand.closed(), 1);
    assert.equal(stand.machine.getState().status, AssistantStatus.Idle);
  });
});

describe("serving a turn's tool calls", () => {
  test("serves the session catalog read and an authoring batch, recording both verbatim in arrival order", async () => {
    const stand = harness({
      turns: [
        {
          steps: [
            { kind: "toolCalls", calls: [firstTurnCalls.catalog] },
            { kind: "narration", text: "writing the rule" },
            { kind: "toolCalls", calls: firstTurnCalls.authoring },
          ],
        },
      ],
    });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    await stand.served;

    const inProcess = freshWorkspace();
    const served = [];
    for (const call of [firstTurnCalls.catalog, ...firstTurnCalls.authoring]) {
      const answer = await executeToolCall(inProcess, call.name, call.input);
      served.push({
        kind: "toolCall" as const,
        call: {
          name: call.name,
          input: call.input,
          outcome: { kind: "ok", payload: JSON.parse(JSON.stringify(answer.payload)) },
        },
      });
    }

    assert.deepEqual(conversation(stand.machine, "brain-a").entries, [
      { kind: "user", text: "make it hide" },
      {
        kind: "assistant",
        steps: [served[0], { kind: "narration", text: "writing the rule" }, ...served.slice(1)],
        ending: { kind: "end", code: "complete" },
      },
    ]);
  });

  test("ends the turn stopped when the mediator declines a call, keeping the declined outcome", async () => {
    const stand = harness(
      { turns: [{ steps: [{ kind: "toolCalls", calls: [firstTurnCalls.catalog] }] }] },
      { mediate: () => ({ kind: "declined", code: RelayDeclineCode.UserStopped }) }
    );
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    await stand.served;

    assert.deepEqual(conversation(stand.machine, "brain-a").entries[1], {
      kind: "assistant",
      steps: [
        {
          kind: "toolCall",
          call: {
            name: firstTurnCalls.catalog.name,
            input: firstTurnCalls.catalog.input,
            outcome: { kind: "declined", code: RelayDeclineCode.UserStopped },
          },
        },
      ],
      ending: { kind: "end", code: "stopped" },
    });
    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
  });

  test("answers every call of a batch it could not serve with an error, and leaves the turn to the service", async () => {
    const stand = harness(
      {
        turns: [
          {
            steps: [
              { kind: "toolCalls", calls: firstTurnCalls.authoring },
              { kind: "narration", text: "after the batch" },
            ],
          },
        ],
      },
      { workspaceless: ["brain-a"] }
    );
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    await stand.served;

    const turn = conversation(stand.machine, "brain-a").entries[1]!;
    const outcomes = callsIn(turn).map((call) => call.outcome);
    assert.equal(outcomes.length, firstTurnCalls.authoring.length, "every call of the batch was recorded");
    for (const outcome of outcomes) {
      assert.ok(outcome.kind === "ok", "an unserved call is answered on the wire, not mediated away");
      assert.equal(outcome.isError, true);
      assert.equal((outcome.payload as ToolCallError).error, ToolCallErrorCode.ServingFailed);
    }
    // The service played the rest of its turn and ended it, so the batch it was
    // waiting on was answered.
    assert.equal(saidIn(turn), "after the batch");
    assert.deepEqual(endingOf(turn), { kind: "end", code: "complete" });
    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
    assert.equal(stand.connects(), 1);
    assert.equal(stand.closed(), 0);
  });

  test("fails the turn whose unserved batch it could not even answer", async () => {
    const stand = harness(
      { turns: [{ steps: [{ kind: "toolCalls", calls: [firstTurnCalls.catalog] }] }] },
      { workspaceless: ["brain-a"], dropsWhenServing: true }
    );
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);

    const turn = conversation(stand.machine, "brain-a").entries[1]!;
    assert.deepEqual(endingOf(turn), {
      kind: "failure",
      code: ConversationTurnFailureCode.ToolServingFailed,
    });
    assert.equal(
      stand.machine.getState().status,
      AssistantStatus.Failed,
      "the machine gave up the session it could not answer on"
    );
    stand.machine.close();
    await stand.served;
  });
});

describe("what a running turn is having served", () => {
  test("stands the turn at planning the moment it is sent", () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");

    assert.deepEqual(doingFor(stand.machine.getState().doing, "brain-a"), { kind: "planning" });
  });

  /** A batch of two calls, so what stands for it is the whole batch and not one call of it. */
  const batch = [
    firstTurnCalls.catalog,
    { name: "read_project", input: {} },
  ] as const satisfies readonly ScriptedCall[];

  /** The names {@link batch} is served under. */
  const batchNames = batch.map((call) => call.name);

  /** A mediation holding every call of `name` until the gate is opened, letting every other call run. */
  function heldAt(name: string): { readonly mediate: AssistantMachineOptions["mediate"]; readonly open: () => void } {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      mediate: async (request) => {
        if (request.name === name) await gate;
        return undefined;
      },
      open: () => release(),
    };
  }

  /** Resolve once `brainId` is having something served. */
  function serves(machine: AssistantMachine, brainId: string): Promise<void> {
    return until(machine, (state) => doingFor(state.doing, brainId)?.kind === "serving");
  }

  test("names every tool of the batch while the turn runs, and names none once the turn has ended", async () => {
    const gate = heldAt(firstTurnCalls.catalog.name);
    const stand = harness({ turns: [{ steps: [{ kind: "toolCalls", calls: batch }] }] }, { mediate: gate.mediate });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await serves(stand.machine, "brain-a");

    assert.deepEqual(doingFor(stand.machine.getState().doing, "brain-a"), { kind: "serving", tools: batchNames });

    gate.open();
    await settled(stand.machine);
    await stand.served;

    assert.equal(doingFor(stand.machine.getState().doing, "brain-a"), undefined, "the ended turn is at nothing");
    assert.equal(callsIn(conversation(stand.machine, "brain-a").entries[1]!).length, batch.length);
  });

  test("keeps each brain's own batch, clearing only the one whose turn ended", async () => {
    const gate = heldAt(firstTurnCalls.catalog.name);
    // One script per session, in the order the two brains open theirs.
    const scripts: ScriptedService[] = [
      { turns: [{ steps: [{ kind: "toolCalls", calls: [firstTurnCalls.catalog] }] }] },
      { turns: [{ steps: [{ kind: "toolCalls", calls: [batch[1]] }] }] },
    ];
    const stand = harness((at) => scripts[at]!, { mediate: gate.mediate });

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    await serves(stand.machine, "brain-a");
    stand.machine.setActiveBrain("brain-b");
    stand.machine.send("make it seek");
    await settledFor(stand.machine, "brain-b");

    const { doing } = stand.machine.getState();
    assert.deepEqual(
      doingFor(doing, "brain-a"),
      { kind: "serving", tools: [firstTurnCalls.catalog.name] },
      "the held brain is still serving"
    );
    assert.equal(doingFor(doing, "brain-b"), undefined, "the brain that finished is at nothing");

    gate.open();
    await settledFor(stand.machine, "brain-a");
    await stand.served;

    assert.equal(doingFor(stand.machine.getState().doing, "brain-a"), undefined);
  });
});

describe("what a running turn stands at, in the order it stood there", () => {
  /** Everything `brainId`'s turn stood at, in order, each entry the state as it changed. */
  function trackDoing(machine: AssistantMachine, brainId: string): readonly (TurnDoing | undefined)[] {
    const seen: (TurnDoing | undefined)[] = [doingFor(machine.getState().doing, brainId)];
    machine.subscribe(() => {
      const at = doingFor(machine.getState().doing, brainId);
      if (at !== seen[seen.length - 1]) seen.push(at);
    });
    return seen;
  }

  /** Run one scripted turn on `brain-a` to its end and answer with what it stood at along the way. */
  async function stoodAt(script: ScriptedService): Promise<readonly (TurnDoing | undefined)[]> {
    const stand = harness(script);
    stand.machine.setActiveBrain("brain-a");
    const seen = trackDoing(stand.machine, "brain-a");
    stand.machine.send("make it hide");
    await settled(stand.machine);
    await stand.served;
    return seen;
  }

  test("takes up the tool each pulse names, and each tick's count after it", async () => {
    const seen = await stoodAt({
      turns: [
        {
          steps: [
            { kind: "writing", tool: "propose_edit", chars: 0 },
            { kind: "writing", tool: "propose_edit", chars: 4312 },
          ],
        },
      ],
    });

    assert.deepEqual(seen, [
      undefined,
      { kind: "planning" },
      { kind: "writing", tool: "propose_edit", chars: 0 },
      { kind: "writing", tool: "propose_edit", chars: 4312 },
      undefined,
    ]);
  });

  test("stands at planning while the model reasons", async () => {
    const seen = await stoodAt({
      turns: [
        {
          steps: [
            { kind: "writing", tool: thinkingWritingName, chars: 0 },
            { kind: "writing", tool: thinkingWritingName, chars: 9312 },
          ],
        },
      ],
    });

    assert.deepEqual(
      seen.map((at) => at?.kind),
      [undefined, "planning", "planning", "planning", undefined]
    );
  });

  test("keeps the reasoning's name and its count out of what the turn stands at", async () => {
    const seen = await stoodAt({
      turns: [
        {
          steps: [
            { kind: "writing", tool: thinkingWritingName, chars: 9312 },
            { kind: "writing", tool: "propose_edit", chars: 40 },
          ],
        },
      ],
    });

    const named = seen.filter((at) => at?.kind === "writing").map((at) => (at?.kind === "writing" ? at.tool : ""));
    assert.deepEqual(named, ["propose_edit"], "only a real tool call is ever stood at by name");
  });

  test("stands at nothing while narration arrives, which says for itself what the turn is at", async () => {
    const seen = await stoodAt({
      turns: [
        {
          steps: [
            { kind: "writing", tool: "propose_edit", chars: 0 },
            { kind: "narration", text: "Placing the sensor." },
            { kind: "writing", tool: "compile", chars: 1200 },
          ],
        },
      ],
    });

    assert.deepEqual(seen, [
      undefined,
      { kind: "planning" },
      { kind: "writing", tool: "propose_edit", chars: 0 },
      undefined,
      { kind: "writing", tool: "compile", chars: 1200 },
      undefined,
    ]);
  });

  test("stands at the batch once it is asked for, leaving the call it was writing behind", async () => {
    const seen = await stoodAt({
      turns: [
        {
          steps: [
            { kind: "writing", tool: firstTurnCalls.catalog.name, chars: 2400 },
            { kind: "toolCalls", calls: [firstTurnCalls.catalog] },
          ],
        },
      ],
    });

    assert.deepEqual(seen, [
      undefined,
      { kind: "planning" },
      { kind: "writing", tool: firstTurnCalls.catalog.name, chars: 2400 },
      { kind: "serving", tools: [firstTurnCalls.catalog.name] },
      { kind: "planning" },
      undefined,
    ]);
  });
});

describe("ending a turn", () => {
  test("ends the turn stopped when the person stops it", async () => {
    const stand = harness({ turns: [{ steps: [{ kind: "awaitStop" }] }] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.stop();
    await settled(stand.machine);
    await stand.served;

    assert.deepEqual(conversation(stand.machine, "brain-a").entries[1], {
      kind: "assistant",
      steps: [],
      ending: { kind: "end", code: "stopped" },
    });
  });

  test("stops a turn that was asked before its session had opened", async () => {
    const stand = harness({ turns: [{ steps: [{ kind: "awaitStop" }] }] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    stand.machine.stop();
    await settled(stand.machine);
    await stand.served;

    assert.deepEqual(conversation(stand.machine, "brain-a").entries[1], {
      kind: "assistant",
      steps: [],
      ending: { kind: "end", code: "stopped" },
    });
  });

  test("records a failure and keeps what it had when the session closes mid-turn", async () => {
    const stand = harness({
      turns: [{ steps: [{ kind: "narration", text: "looking at it" }, { kind: "close" }] }],
    });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);

    assert.equal(stand.machine.getState().status, AssistantStatus.Failed);
    assert.equal(stand.connects(), 1, "the drop is the turn's to report before anything is opened for it");
    assert.deepEqual(conversation(stand.machine, "brain-a").entries, [
      { kind: "user", text: "make it hide" },
      {
        kind: "assistant",
        steps: [{ kind: "narration", text: "looking at it" }],
        ending: { kind: "failure", code: ConversationTurnFailureCode.Disconnected },
      },
    ]);
    stand.machine.close();
    await stand.served;
  });

  test("closes the session it opened when it is stood down", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    stand.machine.close();

    assert.equal(stand.closed(), 1);
    assert.equal(stand.machine.getState().status, AssistantStatus.Idle);
    await stand.served;
  });
});

describe("stopping every running turn", () => {
  test("stops every running turn, whichever brain is active", async () => {
    const stand = harness({ turns: [{ steps: [{ kind: "awaitStop" }] }] });

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.setActiveBrain("brain-b");
    stand.machine.send("make it jump");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);

    stand.machine.stopAll();
    await settledFor(stand.machine, "brain-a");
    await settledFor(stand.machine, "brain-b");
    await stand.served;

    for (const brainId of ["brain-a", "brain-b"]) {
      assert.deepEqual(
        endingOf(conversation(stand.machine, brainId).entries[1]!),
        { kind: "end", code: "stopped" },
        `${brainId}'s turn was stopped`
      );
    }
  });

  test("stops a turn still waiting for its session", async () => {
    const stand = harness({ turns: [{ steps: [{ kind: "awaitStop" }] }] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    stand.machine.stopAll();
    await settled(stand.machine);
    await stand.served;

    assert.deepEqual(endingOf(conversation(stand.machine, "brain-a").entries[1]!), {
      kind: "end",
      code: "stopped",
    });
  });

  test("changes nothing when no turn is running", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    const before = stand.machine.getState();

    stand.machine.stopAll();

    assert.equal(stand.machine.getState(), before, "the machine stands exactly where it did");
    assert.equal(stand.closed(), 0, "no session was closed");
    await stand.served;
  });

  test("a move to another brain leaves the running turn alone", async () => {
    const stand = harness({ turns: [{ steps: [{ kind: "awaitStop" }] }] });

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.setActiveBrain("brain-b");
    await flush();

    assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.TurnActive);
    assert.equal(conversation(stand.machine, "brain-a").entries.length, 1, "the turn has closed nothing off");

    stand.machine.stopAll();
    await settledFor(stand.machine, "brain-a");
    stand.machine.close();
    await stand.served;
  });
});

describe("losing a session and opening another", () => {
  test("opens another session itself when the service closes an idle one, and takes the next turn on it", async () => {
    const scripts: ScriptedService[] = [{ closesWhenIdle: true }, oneQuietTurn];
    const stand = harness((at) => scripts[at]!);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.openSession("brain-a");
    await until(stand.machine, (state) => state.status === AssistantStatus.Ready && stand.connects() === 2);
    stand.machine.send("make it hide");
    await settled(stand.machine);

    assert.equal(stand.connects(), 2, "the send found the session the machine had already opened");
    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
    assert.deepEqual(conversation(stand.machine, "brain-a").entries, [
      { kind: "user", text: "make it hide" },
      {
        kind: "assistant",
        steps: [{ kind: "narration", text: "looking at it" }],
        ending: { kind: "end", code: "complete" },
      },
    ]);
    await stand.served;
  });

  test("gives up on a handshake the service never answers, and opens a session for the next send", async () => {
    const scripts: ScriptedService[] = [{ silent: true }, oneQuietTurn];
    const stand = harness((at) => scripts[at]!);
    stand.machine.setActiveBrain("brain-a");
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.send("make it hide");
      assert.equal(stand.machine.getState().status, AssistantStatus.TurnActive);

      mock.timers.tick(sessionOpenTimeoutMs);
      await until(stand.machine, (state) => recordFor(state.store, "brain-a").entries.length === 2);

      assert.equal(stand.machine.getState().status, AssistantStatus.Failed);
      assert.deepEqual(conversation(stand.machine, "brain-a").entries[1], {
        kind: "assistant",
        steps: [],
        ending: { kind: "failure", code: ConversationTurnFailureCode.NotConnected },
      });
      assert.equal(stand.closed(), 1);

      stand.machine.send("try again");
      await settled(stand.machine);

      assert.equal(stand.connects(), 2);
      assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
    await stand.served;
  });

  test("gives up on a session whose socket never opens, and starts another on the next send", async () => {
    const stand = harness(oneQuietTurn, { unanswered: true });
    stand.machine.setActiveBrain("brain-a");
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.send("make it hide");
      mock.timers.tick(sessionOpenTimeoutMs);
      await until(stand.machine, (state) => recordFor(state.store, "brain-a").entries.length === 2);

      assert.equal(stand.machine.getState().status, AssistantStatus.Failed);
      assert.deepEqual(conversation(stand.machine, "brain-a").entries[1], {
        kind: "assistant",
        steps: [],
        ending: { kind: "failure", code: ConversationTurnFailureCode.NotConnected },
      });

      stand.machine.send("try again");

      assert.equal(stand.connects(), 2);
      assert.equal(stand.machine.getState().status, AssistantStatus.TurnActive);
    } finally {
      mock.timers.reset();
    }
  });

  test("opens a fresh session for the send after a turn lost the one it ran on", async () => {
    const scripts: ScriptedService[] = [
      { turns: [{ steps: [{ kind: "narration", text: "looking at it" }, { kind: "close" }] }] },
      oneQuietTurn,
    ];
    const stand = harness((at) => scripts[at]!);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    assert.equal(stand.machine.getState().status, AssistantStatus.Failed);

    stand.machine.send("try again");
    await settled(stand.machine);

    assert.equal(stand.connects(), 2);
    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
    await stand.served;
  });
});

describe("reopening a session the service dropped", () => {
  test("opens another session itself, showing the person nothing on the way", async () => {
    const stand = harness(oneQuietTurn);
    const seen: string[] = [];
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    await settled(stand.machine);
    stand.machine.subscribe(() => {
      const status = stand.machine.getState().status;
      if (seen[seen.length - 1] !== status) seen.push(status);
    });

    stand.drop(0);
    await until(stand.machine, () => stand.connects() === 2);
    await drain();

    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
    assert.deepEqual(
      seen.filter((status) => status === AssistantStatus.Connecting || status === AssistantStatus.Failed),
      [],
      "a reopen that lands never puts the session where the person would read a wait or a fault"
    );
  });

  test("opens another session only for the brain being shown when two drop at once", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    stand.machine.openSession("brain-b");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);
    await standsAt(stand.machine, "brain-b", AssistantStatus.Ready);

    stand.drop(0);
    stand.drop(1);
    await until(stand.machine, () => stand.connects() === 3);
    await flush();

    assert.equal(stand.connects(), 3, "the shown brain reopened, and the one behind it did not");
    assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-b"), AssistantStatus.Idle);
    stand.machine.close();
    await stand.served;
  });

  test("dials at once, then a second later, then on the steady interval", async () => {
    const stand = await standingSession({ unreachableFrom: 1, random: () => 0 });

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.drop(0);
      await advance(0);
      assert.equal(stand.connects(), 2, "the first attempt is made as soon as the session is lost");

      await advance(sessionReopenHeadDelaysMs[1]! - 1);
      assert.equal(stand.connects(), 2);
      await advance(1);
      assert.equal(stand.connects(), 3, "the second attempt is made a second later");

      await advance(sessionReopenIntervalMs - 1);
      assert.equal(stand.connects(), 3);
      await advance(1);
      assert.equal(stand.connects(), 4, "and the ones after it on the steady interval");
    } finally {
      mock.timers.reset();
    }
  });

  test("spreads a steady attempt across the jitter window", async () => {
    /** Assert the first steady attempt is dialed at `dueAt` and not a millisecond earlier, spread drawn at `random`. */
    async function steadyDueAt(random: () => number, dueAt: number): Promise<void> {
      const stand = await standingSession({ unreachableFrom: 1, random });
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        stand.drop(0);
        await advance(0);
        await advance(sessionReopenHeadDelaysMs[1]!);
        assert.equal(stand.connects(), 3, "the head of the schedule is spent");

        await advance(dueAt - 1);
        assert.equal(stand.connects(), 3, `nothing was dialed before ${dueAt}ms`);
        await advance(1);
        assert.equal(stand.connects(), 4, `the attempt was dialed at ${dueAt}ms`);
      } finally {
        mock.timers.reset();
      }
    }

    await steadyDueAt(() => 0, sessionReopenIntervalMs);
    await steadyDueAt(() => 1 - Number.EPSILON, sessionReopenIntervalMs + sessionReopenJitterMs - 1);
  });

  test("keeps dialing however long the service stays away, settling nothing", async () => {
    // The service is unreachable for every attempt but the last.
    const attempts = 25;
    const stand = await standingSession({ unreachableFrom: 1, unreachableUntil: 1 + attempts, random: () => 0 });

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.drop(0);
      await advance(0);
      await advance(sessionReopenHeadDelaysMs[1]!);
      for (let made = sessionReopenHeadDelaysMs.length; made <= attempts; made++) {
        assert.equal(
          sessionStatus(stand.machine.getState().sessions, "brain-a"),
          AssistantStatus.Idle,
          "a brain still being dialed for is settled nowhere"
        );
        await advance(sessionReopenIntervalMs);
      }

      assert.equal(stand.connects(), 1 + attempts + 1, "every attempt was made, and the last one landed");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
  });

  test("dials nothing while the page is out of view, and once as soon as it comes back", async () => {
    const page = pageIn(false);
    const stand = await standingSession({ unreachableFrom: 1, random: () => 0, presence: page.presence });

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.drop(0);
      await advance(sessionReopenIntervalMs * 4);
      assert.equal(stand.connects(), 1, "a page nobody is looking at dials nothing");

      page.show(true);
      await advance(0);
      assert.equal(stand.connects(), 2, "the page coming back dials at once");

      await advance(sessionReopenHeadDelaysMs[1]!);
      assert.equal(stand.connects(), 3, "and the loop carries on from there");

      page.show(false);
      await advance(sessionReopenIntervalMs * 4);
      assert.equal(stand.connects(), 3, "the page going away again stops it");
    } finally {
      mock.timers.reset();
    }
  });

  test("dials as soon as the browser comes back online", async () => {
    const page = pageIn(true);
    const stand = await standingSession({ unreachableFrom: 1, random: () => 0, presence: page.presence });

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.drop(0);
      await advance(0);
      await advance(sessionReopenHeadDelaysMs[1]!);
      assert.equal(stand.connects(), 3, "the head of the schedule is spent");

      await advance(sessionReopenIntervalMs - 1);
      assert.equal(stand.connects(), 3, "the steady interval has not run out");
      page.online();
      await advance(0);
      assert.equal(stand.connects(), 4, "the browser coming back dialed without waiting the interval out");
    } finally {
      mock.timers.reset();
    }
  });

  test("leaves nothing watching the page when it is stood down out of view", async () => {
    const page = pageIn(false);
    const stand = await standingSession({ unreachableFrom: 1, presence: page.presence });

    stand.drop(0);
    await standsAt(stand.machine, "brain-a", AssistantStatus.Idle);
    await drain();
    assert.equal(page.watchers(), 1, "the waiting loop is watching for the page to come back");

    stand.machine.close();
    await drain();

    assert.equal(page.watchers(), 0);
    assert.equal(stand.connects(), 1);
  });

  test("stands one loop per brain however often its session drops", async () => {
    const stand = await standingSession({});

    stand.drop(0);
    await until(stand.machine, () => stand.connects() === 2);
    await drain();
    stand.drop(1);
    await until(stand.machine, () => stand.connects() === 3);
    await drain();

    assert.equal(stand.connects(), 3, "each drop cost exactly one attempt");
    assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    stand.machine.close();
  });

  test("dials for the session a running turn lost, once that turn has settled", async () => {
    const stand = harness((at) =>
      at === 0
        ? { turns: [{ steps: [{ kind: "narration", text: "looking at it" }, { kind: "close" }] }] }
        : oneQuietTurn
    );

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.setActiveBrain("brain-a");
      stand.machine.send("make it hide");
      await settledFor(stand.machine, "brain-a");

      assert.equal(stand.connects(), 1, "nothing was dialed while the turn still ran");
      assert.deepEqual(endingOf(conversation(stand.machine, "brain-a").entries[1]!), {
        kind: "failure",
        code: ConversationTurnFailureCode.Disconnected,
      });
      assert.equal(stand.machine.getState().status, AssistantStatus.Failed);

      await advance(0);

      assert.equal(stand.connects(), 2, "the dialing was armed once the turn was out of the way");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
  });

  test("closes nothing to reopen when every running turn is stopped", async () => {
    const stand = harness({ turns: [{ steps: [{ kind: "awaitStop" }] }] });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await until(stand.machine, (state) => state.status === AssistantStatus.TurnActive);
    stand.machine.stopAll();
    await settled(stand.machine);
    await drain();
    await stand.served;

    assert.equal(stand.connects(), 1);
    assert.equal(stand.closed(), 0);
    assert.equal(stand.machine.getState().status, AssistantStatus.Ready);
  });

  test("reopens no session the machine closed itself", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    await settled(stand.machine);

    stand.machine.close();
    await flush();

    assert.equal(stand.connects(), 1);
    assert.equal(stand.machine.getState().status, AssistantStatus.Idle);
  });

  test("gives a reopen up for a send that comes while it is still trying", async () => {
    const stand = await standingSession({ unreachableFrom: 1, unreachableUntil: 2, random: () => 0 });

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.drop(0);
      await advance(0);
      assert.equal(stand.connects(), 2, "the immediate attempt was made and failed");

      stand.machine.send("make it hide");
      await drain();

      assert.equal(stand.connects(), 3, "the send opened its own session");
      await advance(sessionReopenIntervalMs * 4);

      assert.equal(stand.connects(), 3, "the reopen stood down rather than keep trying under the send");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("dialing on after an open that failed", () => {
  test("settles the send that reached no service failed, and stands ready once a session lands", async () => {
    const stand = harness(oneQuietTurn, { unreachableFrom: 0, unreachableUntil: 1 });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);

    assert.equal(stand.machine.getState().status, AssistantStatus.Failed, "the person watched their send fail");
    assert.deepEqual(endingOf(conversation(stand.machine, "brain-a").entries[1]!), {
      kind: "failure",
      code: ConversationTurnFailureCode.NotConnected,
    });

    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);

    assert.equal(stand.connects(), 2, "the machine dialed again on its own");
    stand.machine.close();
    await stand.served;
  });

  test("dials on after an eager open that reached no service, saying nothing about it", async () => {
    const stand = harness(oneQuietTurn, { unreachableFrom: 0, unreachableUntil: 1 });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.openSession("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Failed);
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);

    assert.equal(stand.connects(), 2);
    assert.deepEqual(conversation(stand.machine, "brain-a").entries, []);
    stand.machine.close();
    await stand.served;
  });

  test("dials on after a handshake the service never answered", async () => {
    const scripts: ScriptedService[] = [{ silent: true }, oneQuietTurn];
    const stand = harness((at) => scripts[at] ?? oneQuietTurn);

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.setActiveBrain("brain-a");
      stand.machine.openSession("brain-a");
      await advance(sessionOpenTimeoutMs);

      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Failed);
      assert.equal(stand.connects(), 1);

      await advance(0);

      assert.equal(stand.connects(), 2);
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
  });

  test("dials for the turn that never got a session, once that turn has settled", async () => {
    const stand = harness(oneQuietTurn, { unreachableFrom: 0, unreachableUntil: 1 });

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.setActiveBrain("brain-a");
      stand.machine.send("make it hide");
      await settledFor(stand.machine, "brain-a");

      assert.equal(stand.connects(), 1, "nothing was dialed while the turn still ran");
      assert.equal(stand.machine.getState().status, AssistantStatus.Failed);

      await advance(0);

      assert.equal(stand.connects(), 2, "the dialing was armed once the turn was out of the way");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
  });

  test("dials for the turn whose results could not be sent, once that turn has settled", async () => {
    const stand = harness(
      { turns: [{ steps: [{ kind: "toolCalls", calls: [firstTurnCalls.catalog] }] }] },
      { workspaceless: ["brain-a"], dropsWhenServing: true }
    );

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.setActiveBrain("brain-a");
      stand.machine.send("make it hide");
      await settledFor(stand.machine, "brain-a");

      assert.deepEqual(endingOf(conversation(stand.machine, "brain-a").entries[1]!), {
        kind: "failure",
        code: ConversationTurnFailureCode.ToolServingFailed,
      });
      assert.equal(stand.connects(), 1, "nothing was dialed while the turn still ran");

      await advance(0);

      assert.equal(stand.connects(), 2, "the dialing was armed once the turn was out of the way");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("a session the service refuses", () => {
  /** A script refusing every handshake, as a service standing no session for this client at all. */
  const refusing: ScriptedService = { refusal: RelayRefusalCode.TargetUnavailable };

  test("stands the brain failed and dials nothing after it", async () => {
    const stand = harness(refusing);

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.setActiveBrain("brain-a");
      stand.machine.openSession("brain-a");
      await standsAt(stand.machine, "brain-a", AssistantStatus.Failed);

      await advance(sessionReopenIntervalMs * 4);

      assert.equal(stand.connects(), 1, "a refusal is answered the same however often it is asked");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Failed);
    } finally {
      mock.timers.reset();
    }
    await stand.served;
  });

  test("asks again for the send that follows one, and still dials nothing when it is refused again", async () => {
    const stand = harness(refusing);

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.machine.setActiveBrain("brain-a");
      stand.machine.openSession("brain-a");
      await standsAt(stand.machine, "brain-a", AssistantStatus.Failed);

      stand.machine.send("make it hide");
      await settledFor(stand.machine, "brain-a");

      assert.equal(stand.connects(), 2, "the person asking again is asked of the service again");
      assert.deepEqual(endingOf(conversation(stand.machine, "brain-a").entries[1]!), {
        kind: "failure",
        code: ConversationTurnFailureCode.NotConnected,
      });

      await advance(sessionReopenIntervalMs * 4);

      assert.equal(stand.connects(), 2, "the refusal it met again stands no loop either");
    } finally {
      mock.timers.reset();
    }
    await stand.served;
  });

  test("ends the quiet dialing that meets one", async () => {
    const stand = harness((at) => (at === 0 ? oneQuietTurn : refusing));
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    await settled(stand.machine);

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.drop(0);
      await advance(0);

      assert.equal(stand.connects(), 2, "the dialing that followed the drop met the refusal");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Failed);

      await advance(sessionReopenIntervalMs * 4);

      assert.equal(stand.connects(), 2, "and stopped there");
    } finally {
      mock.timers.reset();
    }
  });
});

describe("dialing for the brain being shown", () => {
  test("dials for the brain it is given, before anything is sent on it", async () => {
    const stand = harness(oneQuietTurn);

    stand.machine.setActiveBrain("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);

    assert.equal(stand.connects(), 1);
    assert.deepEqual(conversation(stand.machine, "brain-a").entries, [], "nothing was said about it");
    stand.machine.close();
    await stand.served;
  });

  test("stops dialing for the brain it moves away from", async () => {
    const stand = harness(oneQuietTurn, { unreachableFrom: 2, unreachableUntil: 3 });
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    stand.machine.openSession("brain-b");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);
    await standsAt(stand.machine, "brain-b", AssistantStatus.Ready);

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      stand.drop(0);
      await advance(0);
      assert.equal(stand.connects(), 3, "the shown brain was dialed for as soon as its session went");

      stand.machine.setActiveBrain("brain-b");
      await advance(sessionReopenIntervalMs * 4);

      assert.equal(stand.connects(), 3, "the brain behind the one shown is dialed for no more");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Idle);

      stand.machine.setActiveBrain("brain-a");
      await advance(0);

      assert.equal(stand.connects(), 4, "and is dialed for again when it is shown again");
      assert.equal(sessionStatus(stand.machine.getState().sessions, "brain-a"), AssistantStatus.Ready);
    } finally {
      mock.timers.reset();
    }
  });

  test("stands no dialing for a brain behind the one shown when its session drops", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");
    stand.machine.openSession("brain-a");
    stand.machine.openSession("brain-b");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);
    await standsAt(stand.machine, "brain-b", AssistantStatus.Ready);

    stand.drop(1);
    await standsAt(stand.machine, "brain-b", AssistantStatus.Idle);
    await flush();

    assert.equal(stand.connects(), 2, "the brain behind the one shown is left as it is");
    stand.machine.close();
    await stand.served;
  });

  test("dials for one brain at a time through sends, switches, and drops", async () => {
    const stand = harness(oneQuietTurn);

    stand.machine.setActiveBrain("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);
    stand.machine.setActiveBrain("brain-b");
    await standsAt(stand.machine, "brain-b", AssistantStatus.Ready);
    stand.machine.send("make it hide");
    await settled(stand.machine);

    assert.equal(stand.connects(), 2, "the send found the session standing for the brain shown");

    stand.drop(0);
    await standsAt(stand.machine, "brain-a", AssistantStatus.Idle);
    await flush();

    assert.equal(stand.connects(), 2, "nothing was dialed for the brain behind the one shown");

    stand.machine.setActiveBrain("brain-a");
    await standsAt(stand.machine, "brain-a", AssistantStatus.Ready);
    await flush();

    assert.equal(stand.connects(), 3, "showing it again dialed once, and once only");
    stand.machine.close();
    await stand.served;
  });
});

describe("what a session's handshake declares of the client", () => {
  test("states the build the host gave, on every session it opens", async () => {
    const stand = harness(oneQuietTurn);

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    await settledFor(stand.machine, "brain-a");
    stand.machine.setActiveBrain("brain-b");
    stand.machine.send("make it seek");
    await settledFor(stand.machine, "brain-b");

    assert.deepEqual(
      stand.handshakes().map((handshake) => handshake.clientBuild),
      [__test__clientBuild, __test__clientBuild]
    );
    stand.machine.close();
    await stand.served;
  });
});

describe("carrying the conversation into a session", () => {
  test("opens the first session of a brain with no conversation on it", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.openSession("brain-a");
    await settled(stand.machine);

    assert.equal(stand.handshakes().length, 1);
    assert.equal(stand.handshakes()[0]?.conversation, undefined);
  });

  test("carries what it holds on the session the person asks for after a turn was cut off", async () => {
    const scripts: ScriptedService[] = [
      { turns: [{ steps: [{ kind: "narration", text: "looking at it" }, { kind: "close" }] }] },
      oneQuietTurn,
    ];
    const stand = harness((at) => scripts[at]!);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    stand.machine.send("try again");
    await settled(stand.machine);
    await stand.served;

    const carried = stand.handshakes()[1]?.conversation;
    assert.equal(stand.connects(), 2);
    assert.equal(carried?.version, CONVERSATION_RECORD_VERSION);
    assert.equal(carried?.brainId, "brain-a");
    assert.deepEqual(
      carried?.entries.map((entry) => entry.kind),
      ["user", "assistant", "user"],
      "the cut-off turn and the ask that follows it both cross"
    );
    assert.deepEqual(endingOf(carried?.entries[1] as ConversationEntry), {
      kind: "failure",
      code: ConversationTurnFailureCode.Disconnected,
    });
  });

  test("carries what it holds on the session it reopens itself", async () => {
    const stand = harness(oneQuietTurn);
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    stand.drop(0);
    await until(stand.machine, () => stand.connects() === 2);

    const carried = stand.handshakes()[1]?.conversation;
    assert.equal(carried?.brainId, "brain-a");
    assert.deepEqual(
      carried?.entries.map((entry) => entry.kind),
      ["user", "assistant"]
    );
    stand.machine.close();
    await stand.served;
  });

  test("carries each brain's own conversation, and no other brain's", async () => {
    const stand = harness(oneQuietTurn);

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    await settledFor(stand.machine, "brain-a");
    stand.machine.setActiveBrain("brain-b");
    stand.machine.send("make it seek");
    await settledFor(stand.machine, "brain-b");

    // Each brain is shown when its session is dropped, so each is dialed for.
    stand.drop(1);
    await until(stand.machine, () => stand.connects() === 3);
    stand.machine.setActiveBrain("brain-a");
    stand.drop(0);
    await until(stand.machine, () => stand.connects() === 4);

    assert.deepEqual(
      stand
        .handshakes()
        .slice(2)
        .map((connect) => connect.conversation?.brainId),
      ["brain-b", "brain-a"]
    );
    stand.machine.close();
    await stand.served;
  });
});

describe("conversations of more than one brain", () => {
  test("keeps each brain's interleaved turns in its own record", async () => {
    const turn = (text: string) => ({ steps: [{ kind: "narration" as const, text }] });
    // One script per session, in the order the two brains open theirs.
    const scripts: ScriptedService[] = [{ turns: [turn("for a"), turn("for a again")] }, { turns: [turn("for b")] }];
    const stand = harness((at) => scripts[at]!);

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("first for a");
    await settled(stand.machine);
    stand.machine.setActiveBrain("brain-b");
    stand.machine.send("first for b");
    await settled(stand.machine);
    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("second for a");
    await settled(stand.machine);
    await stand.served;

    assert.deepEqual(conversation(stand.machine, "brain-a").entries.map(saidIn), [
      "first for a",
      "for a",
      "second for a",
      "for a again",
    ]);
    assert.deepEqual(conversation(stand.machine, "brain-b").entries.map(saidIn), ["first for b", "for b"]);
  });

  test("keeps filling the brain a running turn was sent for after the active brain moves", async () => {
    let moved: () => void = () => {};
    const switched = new Promise<void>((resolve) => {
      moved = resolve;
    });
    const stand = harness(
      {
        turns: [
          {
            steps: [
              { kind: "toolCalls", calls: [firstTurnCalls.catalog] },
              { kind: "narration", text: "after the switch" },
            ],
          },
        ],
      },
      {
        mediate: async () => {
          await switched;
          return undefined;
        },
      }
    );

    stand.machine.setActiveBrain("brain-a");
    stand.machine.send("make it hide");
    stand.machine.setActiveBrain("brain-b");
    moved();
    await settledFor(stand.machine, "brain-a");
    stand.machine.close();
    await stand.served;

    assert.equal(stand.machine.getState().store.activeBrainId, "brain-b");
    assert.deepEqual(conversation(stand.machine, "brain-b").entries, []);
    const turn = conversation(stand.machine, "brain-a").entries[1];
    assert.ok(turn, "the turn stands in the record of the brain it was sent for");
    assert.equal(saidIn(turn), "after the switch");
    assert.equal(callsIn(turn).length, 1);
  });
});

describe("a turn the person takes over", () => {
  /** The one call a taken-over turn's batch asks for. */
  const batch = { turns: [{ steps: [{ kind: "toolCalls", calls: [firstTurnCalls.catalog] }] }] } as const;

  /** The outcome `turn` answered its one call with. */
  function onlyOutcome(turn: ConversationEntry): RelayToolOutcome {
    const calls = callsIn(turn);
    assert.equal(calls.length, 1, "the turn answered exactly one call");
    return calls[0]!.outcome;
  }

  test("answers every call of a batch with a takeover once the person changed the document mid-turn", async () => {
    const activity = createPersonActivity();
    const stand = harness(batch, { activity });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    activity.noteMutation("brain-a");
    await settled(stand.machine);
    await stand.served;

    const turn = conversation(stand.machine, "brain-a").entries[1]!;
    assert.deepEqual(onlyOutcome(turn), { kind: "takeover", code: RelayTakeoverCode.DocumentEdited });
    assert.deepEqual(endingOf(turn), { kind: "end", code: "stopped" });
    assert.equal(stand.machine.getState().status, AssistantStatus.Ready, "the session stays standing");
  });

  test("serves the batch when the person's change came before the turn started", async () => {
    const activity = createPersonActivity();
    const stand = harness(batch, { activity });
    stand.machine.setActiveBrain("brain-a");

    activity.noteMutation("brain-a");
    stand.machine.send("make it hide");
    await settled(stand.machine);
    await stand.served;

    const turn = conversation(stand.machine, "brain-a").entries[1]!;
    assert.equal(onlyOutcome(turn).kind, "ok");
    assert.deepEqual(endingOf(turn), { kind: "end", code: "complete" });
  });

  test("takes the turn over in place of asking the host's own mediation", async () => {
    const activity = createPersonActivity();
    const consulted = mock.fn(() => ({ kind: "declined", code: RelayDeclineCode.UserStopped }) as const);
    const stand = harness(batch, { activity, mediate: consulted });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    activity.noteMutation("brain-a");
    await settled(stand.machine);
    await stand.served;

    const turn = conversation(stand.machine, "brain-a").entries[1]!;
    assert.deepEqual(onlyOutcome(turn), { kind: "takeover", code: RelayTakeoverCode.DocumentEdited });
    assert.equal(consulted.mock.callCount(), 0);
  });

  test("leaves the host's own mediation to answer while the person has changed nothing", async () => {
    const activity = createPersonActivity();
    const stand = harness(batch, {
      activity,
      mediate: () => ({ kind: "declined", code: RelayDeclineCode.UserStopped }),
    });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    await settled(stand.machine);
    await stand.served;

    const turn = conversation(stand.machine, "brain-a").entries[1]!;
    assert.deepEqual(onlyOutcome(turn), { kind: "declined", code: RelayDeclineCode.UserStopped });
  });

  test("leaves a turn of another brain alone", async () => {
    const activity = createPersonActivity();
    const stand = harness(batch, { activity });
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    activity.noteMutation("brain-b");
    await settled(stand.machine);
    await stand.served;

    const turn = conversation(stand.machine, "brain-a").entries[1]!;
    assert.equal(onlyOutcome(turn).kind, "ok");
  });

  test("takes the next turn on its own terms, with the taken-over turn still in the record", async () => {
    const activity = createPersonActivity();
    const stand = harness(
      {
        turns: [
          { steps: [{ kind: "toolCalls", calls: [firstTurnCalls.catalog] }] },
          {
            steps: [
              { kind: "toolCalls", calls: [firstTurnCalls.catalog] },
              { kind: "narration", text: "and again" },
            ],
          },
        ],
      },
      { activity }
    );
    stand.machine.setActiveBrain("brain-a");

    stand.machine.send("make it hide");
    activity.noteMutation("brain-a");
    await settled(stand.machine);

    stand.machine.send("carry on");
    await settled(stand.machine);
    await stand.served;

    const entries = conversation(stand.machine, "brain-a").entries;
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["user", "assistant", "user", "assistant"]
    );
    assert.equal(onlyOutcome(entries[3]!).kind, "ok");
    assert.deepEqual(endingOf(entries[3]!), { kind: "end", code: "complete" });
  });
});
