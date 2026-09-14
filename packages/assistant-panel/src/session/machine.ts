import type { AuthoringWorkspace } from "@wendoo/assistant-bridge";
import type { ToolCallMediator } from "@wendoo/assistant-bridge/relay";
import { serveToolCalls, unservedToolResults } from "@wendoo/assistant-bridge/relay";
import type {
  ConversationTurnEnding,
  RelayLibraryAdded,
  RelayToolCallBatch,
  RelayToolManifest,
  RelayToolResultBatch,
  RelayUserMessage,
} from "@wendoo/assistant-relay";
import {
  ASSISTANT_RELAY_PROTOCOL_VERSION,
  ConversationTurnFailureCode,
  RelayTakeoverCode,
  thinkingWritingName,
} from "@wendoo/assistant-relay";
import type { ClientBuild } from "@wendoo/core";
import { assertUnreachable } from "@wendoo/core";
import type { PersonActivity } from "../app/person-activity";
import type { ConversationStore, ConversationUpdate } from "../conversation/store";
import { emptyConversationStore, recordFor, withActiveBrain, withUpdate } from "../conversation/store";
import type { AssistantChannel, AssistantConnect } from "./channel";
import type { SessionPresence } from "./presence";
import { documentPresence } from "./presence";
import type { SessionStatuses } from "./sessions";
import { AssistantStatus, emptySessions, sessionStatus, withSessionStatus } from "./sessions";

export { AssistantStatus } from "./sessions";

/**
 * Milliseconds one attempt to open a session waits for the service to accept
 * it. An attempt that runs out closes whatever socket it opened and leaves the
 * brain holding no session.
 */
export const sessionOpenTimeoutMs = 8000;

/**
 * Milliseconds the leading quiet reopen attempts wait before they are made, in
 * order. Every attempt after these waits {@link sessionReopenIntervalMs}.
 */
export const sessionReopenHeadDelaysMs: readonly number[] = [0, 1000];

/** Milliseconds between quiet reopen attempts once {@link sessionReopenHeadDelaysMs} is spent, before their spread. */
export const sessionReopenIntervalMs = 5000;

/** Milliseconds wide the spread each steady reopen delay is lengthened by, drawn fresh from [0, this). */
export const sessionReopenJitterMs = 3000;

/** What a bounded wait answers with once it has run out. */
const runOut = Symbol("session open timeout");

/** What a brain's running turn is at right now. */
export type TurnDoing =
  /** Having the tools of a batch served, by the bridge name each was called by. */
  | { readonly kind: "serving"; readonly tools: readonly string[] }
  /** Writing one tool call, with the characters of its JSON written so far. */
  | { readonly kind: "writing"; readonly tool: string; readonly chars: number }
  /** Working out what to do next, between anything nameable: the turn has begun, or a batch's results have gone back. */
  | { readonly kind: "planning" };

/**
 * What each brain's running turn is at right now, keyed by brain id. A brain
 * whose turn is at nothing nameable is absent, and nothing here is ever
 * recorded.
 */
export type TurnActivities = ReadonlyMap<string, TurnDoing>;

/** What `brainId`'s turn is at, `undefined` for a brain at nothing and for no brain at all. */
export function doingFor(doing: TurnActivities, brainId: string | undefined): TurnDoing | undefined {
  return brainId === undefined ? undefined : doing.get(brainId);
}

/** One ask the person typed while a turn was running, waiting its turn. */
export interface PendingAsk {
  /** Names the ask for as long as it waits, so it can be taken back. */
  readonly id: string;
  /** What the person typed. */
  readonly text: string;
}

/**
 * What each brain has waiting of the person's own asks, keyed by brain id, in
 * the order they were typed. A brain waiting on none is absent.
 */
export type PendingAsks = ReadonlyMap<string, readonly PendingAsk[]>;

/** What a brain waiting on nothing has waiting. */
const nothingWaiting: readonly PendingAsk[] = [];

/** What `brainId` has waiting, empty for a brain waiting on nothing and for no brain at all. */
export function pendingFor(pending: PendingAsks, brainId: string | undefined): readonly PendingAsk[] {
  return (brainId === undefined ? undefined : pending.get(brainId)) ?? nothingWaiting;
}

/** One thing waiting for a brain's running turn to end. */
type PendingEntry =
  | { readonly kind: "added"; readonly coordinate: string }
  | ({
      readonly kind: "typed";
      /** Takes its turn carrying its own words alone, joining with nothing waiting behind it. */
      readonly solo?: boolean;
    } & PendingAsk);

/** What the machine exposes to whatever renders it. */
export interface AssistantMachineState {
  /** Where the active brain's session stands; idle while the host has named no brain. */
  readonly status: AssistantStatus;
  /** Where every brain's session stands. */
  readonly sessions: SessionStatuses;
  /**
   * What each brain's running turn is at, as the newest signal of the turn left
   * it: the tool call the model is writing, the batch most recently served, and
   * nothing while the turn is narrating or over. Read one brain's with
   * {@link doingFor}.
   */
  readonly doing: TurnActivities;
  /**
   * What each brain has waiting of the person's own asks, in the order they
   * were typed, until the running turn ends and they take a turn. Read one
   * brain's with {@link pendingFor}.
   */
  readonly pending: PendingAsks;
  readonly store: ConversationStore;
}

/** What one machine is built over. */
export interface AssistantMachineOptions {
  /** Opens one relay session. Called once per brain that opens one, never at construction. */
  readonly connect: AssistantConnect;
  /** What the handshake declares this client serves. */
  readonly manifest: RelayToolManifest;
  /** The build the handshake declares this client runs. */
  readonly clientBuild: ClientBuild;
  /**
   * The live workspace a brain's tool calls run against. Called once per served
   * batch with the brain the running turn belongs to, which is not necessarily
   * the active one. Throwing answers every call of that batch with an error and
   * leaves the turn running.
   */
  readonly workspace: (brainId: string) => AuthoringWorkspace;
  /** Consulted before each call in a batch once the person has not taken the turn over; every call runs when absent. */
  readonly mediate?: ToolCallMediator;
  /**
   * Where the person's own changes to a brain's document are recorded. A change
   * made since a turn started answers that turn's next batch with a takeover.
   * Absent leaves every batch to {@link mediate}.
   */
  readonly activity?: PersonActivity;
  /** Where the page stands for the quiet reopen loop; read from the document and the window when absent. */
  readonly presence?: SessionPresence;
  /** Entropy in [0, 1), drawn once per steady reopen delay for its spread; `Math.random` when absent. */
  readonly random?: () => number;
}

/** A quiet reopen loop the machine still expects for one brain. */
interface ReopenLoop {
  /** Ends the wait the loop stands in, so it can see it is no longer expected. */
  standDown: () => void;
}

/** Why one handshake stood no session up. */
type HandshakeFailure =
  /** The service answered the handshake with a refusal. */
  | "refused"
  /** The service could not be reached, answered nothing in time, or answered something other than an acceptance. */
  | "unavailable";

/** What one handshake came to. */
type HandshakeOutcome =
  | { readonly kind: "opened"; readonly channel: AssistantChannel }
  | { readonly kind: HandshakeFailure };

/**
 * One assistant session per brain, and the conversations they fill.
 *
 * A brain's session is opened by {@link AssistantMachine.openSession} or by its
 * first {@link AssistantMachine.send}, and is held until the machine is stood
 * down or the service drops it; several brains' sessions stand at once. The
 * brain being shown is dialed for quietly whenever it holds no session, until
 * one stands or the service refuses it. Each session runs one turn at a time,
 * and a turn keeps filling the record of the brain it was sent for whatever the
 * host makes active afterwards.
 */
export class AssistantMachine {
  private current: AssistantMachineState = {
    status: AssistantStatus.Idle,
    sessions: emptySessions(),
    doing: new Map(),
    pending: new Map(),
    store: emptyConversationStore(),
  };
  private readonly channels = new Map<string, AssistantChannel>();
  private readonly opening = new Map<string, Promise<AssistantChannel | undefined>>();
  /** The quiet reopen the machine still expects for a brain. */
  private readonly reopening = new Map<string, ReopenLoop>();
  /** Brains the service refused a session to, until the person asks for one again. */
  private readonly refused = new Set<string>();
  /** Brains whose running turn was asked to stop while it was still waiting for a session. */
  private readonly stopRequested = new Set<string>();
  /** What the person had changed of a brain's document when its running turn started. */
  private readonly changesAtTurnStart = new Map<string, number>();
  /**
   * What each brain has waiting for its running turn to end -- libraries the
   * person added and asks they typed -- in the order they arrived.
   */
  private readonly queued = new Map<string, PendingEntry[]>();
  /** How many asks the machine has held back so far, which names each of them. */
  private asksHeld = 0;
  private readonly listeners = new Set<() => void>();
  private readonly presence: SessionPresence;
  private readonly random: () => number;

  constructor(private readonly options: AssistantMachineOptions) {
    this.presence = options.presence ?? documentPresence();
    this.random = options.random ?? Math.random;
  }

  /** The machine's state; a new object exactly when something observable changed. */
  readonly getState = (): AssistantMachineState => this.current;

  /** Call `listener` whenever {@link getState} would answer with something new. Returns the unsubscribe. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Show `brainId`'s conversation. A turn already running keeps filling the
   * brain it was sent for. The brain named takes the quiet dialing over: the one
   * it replaces stops being dialed for, and this one is dialed for while it
   * holds no session. Naming the brain already shown changes nothing and
   * notifies nobody.
   */
  setActiveBrain(brainId: string): void {
    const shown = this.current.store.activeBrainId;
    if (shown === brainId) return;
    this.commit({ store: withActiveBrain(this.current.store, brainId) });
    if (shown !== undefined) this.standDownReopen(shown);
    void this.reopen(brainId);
  }

  /**
   * Open `brainId`'s session now, so its first send finds one standing. Does
   * nothing when the brain already holds a session or is opening one.
   */
  openSession(brainId: string): void {
    void this.openChannel(brainId);
  }

  /**
   * Start a turn on the active brain from what the person said. An ask typed
   * while that brain's turn is running waits for it, and the asks waiting one
   * after another take one turn together once it ends. Does nothing before the
   * host has named an active brain. A brain holding no session opens one for
   * the turn.
   */
  send(text: string): void {
    const brainId = this.current.store.activeBrainId;
    if (brainId === undefined) return;
    if (sessionStatus(this.current.sessions, brainId) === AssistantStatus.TurnActive) {
      this.queue(brainId, { kind: "typed", id: this.nextAskId(), text });
      return;
    }
    this.startAsk(brainId, text);
  }

  /**
   * Take back the ask `id` names from what the active brain has waiting,
   * answering with the text it held. Answers `undefined` when no ask of that
   * name waits, and leaves everything else waiting in the order it arrived.
   */
  cancelAsk(id: string): string | undefined {
    const brainId = this.current.store.activeBrainId;
    const waiting = brainId === undefined ? undefined : this.queued.get(brainId);
    if (waiting === undefined) return undefined;
    for (const [at, entry] of waiting.entries()) {
      if (entry.kind !== "typed" || entry.id !== id) continue;
      waiting.splice(at, 1);
      this.commit({ pending: this.waitingAsks() });
      return entry.text;
    }
    return undefined;
  }

  /**
   * Take the ask `id` names to the front of what the active brain has waiting,
   * and open its turn as soon as the floor is free: a turn of that brain's still
   * running is asked to stop first. The ask then takes a turn carrying its own
   * words alone, and everything else waits on behind it in the order it arrived.
   * Does nothing when no ask of that name waits.
   */
  sendNow(id: string): void {
    const brainId = this.current.store.activeBrainId;
    const waiting = brainId === undefined ? undefined : this.queued.get(brainId);
    if (brainId === undefined || waiting === undefined) return;
    for (const [at, entry] of waiting.entries()) {
      if (entry.kind !== "typed" || entry.id !== id) continue;
      waiting.splice(at, 1);
      waiting.unshift({ ...entry, solo: true });
      this.commit({ pending: this.waitingAsks() });
      if (sessionStatus(this.current.sessions, brainId) === AssistantStatus.TurnActive) this.askToStop(brainId);
      else this.drainPending(brainId);
      return;
    }
  }

  /**
   * Tell `brainId`'s session that the person added the library at `coordinate`,
   * which opens a turn carrying that news and nothing of the person's own. An
   * add made while a turn of that brain's is running waits for it, and takes a
   * turn of its own once it ends; adds waiting together are told in the order
   * they were made, and an add of a coordinate already waiting tells nobody
   * twice. An add to a brain holding no session tells nobody and waits for
   * nothing.
   */
  libraryAdded(brainId: string, coordinate: string): void {
    if (sessionStatus(this.current.sessions, brainId) === AssistantStatus.TurnActive) {
      const held = this.queued.get(brainId);
      if (held?.some((entry) => entry.kind === "added" && entry.coordinate === coordinate)) return;
      this.queue(brainId, { kind: "added", coordinate });
      return;
    }
    const channel = this.channels.get(brainId);
    if (channel === undefined) return;
    this.startAdded(brainId, channel, coordinate);
  }

  /** A name for the next ask held back, which no other ask this machine holds carries. */
  private nextAskId(): string {
    this.asksHeld++;
    return `ask-${this.asksHeld}`;
  }

  /** Hold `entry` for `brainId` behind everything already waiting for its running turn to end. */
  private queue(brainId: string, entry: PendingEntry): void {
    const waiting = this.queued.get(brainId);
    if (waiting === undefined) this.queued.set(brainId, [entry]);
    else waiting.push(entry);
    this.commit({ pending: this.waitingAsks() });
  }

  /** What each brain has waiting of the person's own asks, as the machine's state carries it. */
  private waitingAsks(): PendingAsks {
    const asks = new Map<string, readonly PendingAsk[]>();
    for (const [brainId, waiting] of this.queued) {
      const typed = waiting.flatMap((entry) => (entry.kind === "typed" ? [{ id: entry.id, text: entry.text }] : []));
      if (typed.length > 0) asks.set(brainId, typed);
    }
    return asks;
  }

  /**
   * Open a turn on `brainId` carrying `text` as the person's own ask, opening a
   * session for it when the brain holds none. No ask ever stands both waiting
   * and asked.
   */
  private startAsk(brainId: string, text: string): void {
    this.changesAtTurnStart.set(brainId, this.options.activity?.mutations(brainId) ?? 0);
    this.commit({
      sessions: withSessionStatus(this.current.sessions, brainId, AssistantStatus.TurnActive),
      store: withUpdate(this.current.store, brainId, { kind: "user", text }),
      pending: this.waitingAsks(),
    });
    this.beginDoing(brainId, { kind: "planning" });
    void this.runTurn(brainId, text);
  }

  /**
   * Open a turn on `channel` carrying the news that the person added the library
   * at `coordinate` to `brainId`.
   */
  private startAdded(brainId: string, channel: AssistantChannel, coordinate: string): void {
    this.changesAtTurnStart.set(brainId, this.options.activity?.mutations(brainId) ?? 0);
    this.commit({ sessions: withSessionStatus(this.current.sessions, brainId, AssistantStatus.TurnActive) });
    this.beginDoing(brainId, { kind: "planning" });
    void this.carryTurn(brainId, channel, { type: "session:libraryAdded", coordinate });
  }

  /**
   * Open the turn of whatever `brainId` has been waiting longest, once it holds
   * a session and no turn of its is running: a library takes a turn of its own,
   * and the asks the person typed one after another take one turn together,
   * their texts joined in the order they were typed. An ask hurried to the front
   * takes its turn on its own words alone, leaving the rest waiting. Does nothing
   * when the brain has nothing waiting.
   */
  private drainPending(brainId: string): void {
    const waiting = this.queued.get(brainId);
    if (waiting === undefined || waiting.length === 0) return;
    if (sessionStatus(this.current.sessions, brainId) === AssistantStatus.TurnActive) return;
    const channel = this.channels.get(brainId);
    if (channel === undefined) return;
    const head = waiting[0]!;
    if (head.kind === "added") {
      waiting.shift();
      this.startAdded(brainId, channel, head.coordinate);
      return;
    }
    const asked: string[] = [];
    for (const entry of waiting) {
      if (entry.kind !== "typed") break;
      asked.push(entry.text);
      if (entry.solo) break;
    }
    waiting.splice(0, asked.length);
    this.startAsk(brainId, asked.join("\n"));
  }

  /**
   * Ask the active brain's running turn to stop. Does nothing when no turn of
   * its is running. A turn still waiting for its session is asked as soon as
   * the session opens.
   */
  stop(): void {
    const brainId = this.current.store.activeBrainId;
    if (brainId === undefined) return;
    this.askToStop(brainId);
  }

  /**
   * Ask every running turn to stop, whatever brain it was sent for and whether
   * or not that brain is the active one. A turn still waiting for its session is
   * asked as soon as the session opens. Changes nothing when no turn is running.
   */
  stopAll(): void {
    for (const [brainId, status] of this.current.sessions) {
      if (status === AssistantStatus.TurnActive) this.askToStop(brainId);
    }
  }

  /** Ask `brainId`'s turn to stop, doing nothing when no turn of its is running. */
  private askToStop(brainId: string): void {
    if (sessionStatus(this.current.sessions, brainId) !== AssistantStatus.TurnActive) return;
    const channel = this.channels.get(brainId);
    if (channel) channel.send({ type: "turn:stop" });
    else this.stopRequested.add(brainId);
  }

  /** Close every session and stand the machine down. Conversations already recorded are kept. */
  close(): void {
    for (const brainId of [...this.channels.keys()]) this.dropChannel(brainId);
    this.opening.clear();
    for (const brainId of [...this.reopening.keys()]) this.standDownReopen(brainId);
    this.refused.clear();
    this.stopRequested.clear();
    this.changesAtTurnStart.clear();
    this.queued.clear();
    this.commit({ sessions: emptySessions(), doing: new Map(), pending: new Map() });
  }

  /**
   * What answers `brainId`'s running turn's calls without running them: a
   * takeover for every call once the person has changed the document since the
   * turn started, and whatever the host's own mediation says otherwise.
   */
  private mediatorFor(brainId: string): ToolCallMediator | undefined {
    const { activity, mediate } = this.options;
    if (activity === undefined) return mediate;
    const changed = this.changesAtTurnStart.get(brainId) ?? 0;
    return (request) => {
      if (activity.mutations(brainId) > changed) {
        return { kind: "takeover", code: RelayTakeoverCode.DocumentEdited };
      }
      return mediate?.(request);
    };
  }

  private commit(change: Partial<Omit<AssistantMachineState, "status">>): void {
    const next = { ...this.current, ...change };
    this.current = { ...next, status: sessionStatus(next.sessions, next.store.activeBrainId) };
    for (const listener of this.listeners) listener();
  }

  private record(brainId: string, update: ConversationUpdate): void {
    this.commit({ store: withUpdate(this.current.store, brainId, update) });
  }

  /** Stand `brainId`'s turn at `doing`, leaving every other brain's untouched. */
  private beginDoing(brainId: string, doing: TurnDoing): void {
    const next = new Map(this.current.doing);
    next.set(brainId, doing);
    this.commit({ doing: next });
  }

  /** Stand `brainId`'s turn at nothing, doing nothing when it already is. */
  private endDoing(brainId: string): void {
    if (!this.current.doing.has(brainId)) return;
    const next = new Map(this.current.doing);
    next.delete(brainId);
    this.commit({ doing: next });
  }

  /**
   * Record every call of `asked` on `brainId`'s turn with the outcome `answered`
   * gave it. The brain keeps standing at these tools until the turn's next
   * signal or its end.
   */
  private recordBatch(brainId: string, asked: RelayToolCallBatch, answered: RelayToolResultBatch): void {
    for (const [index, request] of asked.requests.entries()) {
      const outcome = answered.results[index]!.outcome;
      this.record(brainId, { kind: "toolCall", call: { name: request.name, input: request.input, outcome } });
    }
  }

  private dropChannel(brainId: string): void {
    this.channels.get(brainId)?.close();
    this.channels.delete(brainId);
  }

  /**
   * Hold `channel` as `brainId`'s session: it is given up the moment the channel
   * closes, the brain stands ready on it, and whatever the brain has been
   * waiting with takes its turn on it.
   */
  private hold(brainId: string, channel: AssistantChannel): void {
    this.channels.set(brainId, channel);
    this.dropWhenClosed(brainId, channel);
    this.settle(brainId, AssistantStatus.Ready);
    this.drainPending(brainId);
  }

  /** Stand `brainId`'s session at `status`, leaving a turn of its own running untouched. */
  private settle(brainId: string, status: AssistantStatus): void {
    if (sessionStatus(this.current.sessions, brainId) === AssistantStatus.TurnActive) return;
    this.commit({ sessions: withSessionStatus(this.current.sessions, brainId, status) });
  }

  /**
   * Close `brainId`'s running turn with `ending` and stand its session back up.
   * A turn that ends holding no session leaves the brain failed and dialed for
   * quietly.
   */
  private finish(brainId: string, ending: ConversationTurnEnding): void {
    this.stopRequested.delete(brainId);
    this.changesAtTurnStart.delete(brainId);
    this.endDoing(brainId);
    this.record(brainId, { kind: "ending", ending });
    const held = this.channels.has(brainId);
    this.commit({
      sessions: withSessionStatus(
        this.current.sessions,
        brainId,
        held ? AssistantStatus.Ready : AssistantStatus.Failed
      ),
    });
    if (!held) void this.reopen(brainId);
    this.drainPending(brainId);
  }

  /**
   * `brainId`'s session, opening one when it holds none. Answers `undefined`
   * when no session could be opened. Callers arriving while an open is in
   * flight share that one open. A brain the service refused a session to before
   * is asked for again.
   */
  private openChannel(brainId: string): Promise<AssistantChannel | undefined> {
    // Standing the brain's quiet reopen down, so this open is the only one live.
    this.standDownReopen(brainId);
    this.refused.delete(brainId);
    const held = this.channels.get(brainId);
    if (held) return Promise.resolve(held);
    const inFlight = this.opening.get(brainId);
    if (inFlight) return inFlight;

    const attempt: Promise<AssistantChannel | undefined> = this.handshake(brainId).then((outcome) => {
      // An open the machine no longer expects belongs to a session it has been
      // stood down from.
      if (this.opening.get(brainId) !== attempt) {
        if (outcome.kind === "opened") outcome.channel.close();
        return undefined;
      }
      this.opening.delete(brainId);
      if (outcome.kind !== "opened") {
        this.giveUp(brainId, outcome.kind);
        return undefined;
      }
      this.hold(brainId, outcome.channel);
      return outcome.channel;
    });
    this.opening.set(brainId, attempt);
    this.settle(brainId, AssistantStatus.Connecting);
    return attempt;
  }

  /**
   * Stand `brainId` at failed for a handshake that came to `failure`, and dial
   * on quietly for it. A refusal is marked instead of dialed on: nothing dials
   * for the brain again until the person asks for a session.
   */
  private giveUp(brainId: string, failure: HandshakeFailure): void {
    if (failure === "refused") this.refused.add(brainId);
    this.settle(brainId, AssistantStatus.Failed);
    void this.reopen(brainId);
  }

  /**
   * Give `brainId` up as holding no session the moment `channel` closes, and
   * open another quietly while it is the brain being shown, leaving a turn of
   * its own running to finish on its own terms. A channel the brain has already
   * given up for another leaves the machine untouched.
   */
  private dropWhenClosed(brainId: string, channel: AssistantChannel): void {
    void channel.closed.then(() => {
      if (this.channels.get(brainId) !== channel) return;
      this.channels.delete(brainId);
      this.settle(brainId, AssistantStatus.Idle);
      void this.reopen(brainId);
    });
  }

  /**
   * Whether a quiet reopen belongs to `brainId` as things stand: it is the brain
   * being shown, it holds no session and none is being opened for it, no turn of
   * its is running, the service has not refused it, and no loop of its own
   * already stands.
   */
  private wantsReopen(brainId: string): boolean {
    return (
      this.current.store.activeBrainId === brainId &&
      !this.reopening.has(brainId) &&
      !this.refused.has(brainId) &&
      !this.channels.has(brainId) &&
      !this.opening.has(brainId) &&
      sessionStatus(this.current.sessions, brainId) !== AssistantStatus.TurnActive
    );
  }

  /**
   * Open `brainId`'s session for as long as it takes and with nothing shown for
   * an attempt that lands: the attempts of {@link sessionReopenHeadDelaysMs},
   * then one every {@link sessionReopenIntervalMs} plus its spread. Does nothing
   * unless {@link wantsReopen} says the brain wants one, so one loop stands at a
   * time and it is the shown brain's. A refusal ends the loop and stands the
   * brain at failed.
   */
  private async reopen(brainId: string): Promise<void> {
    if (!this.wantsReopen(brainId)) return;
    const loop: ReopenLoop = { standDown: () => {} };
    this.reopening.set(brainId, loop);
    try {
      for (let attempt = 0; ; attempt++) {
        await this.whenDue(loop, this.reopenDelayMs(attempt));
        if (this.reopening.get(brainId) !== loop) return;
        const outcome = await this.handshake(brainId);
        if (this.reopening.get(brainId) !== loop) {
          if (outcome.kind === "opened") outcome.channel.close();
          return;
        }
        if (outcome.kind === "opened") {
          this.hold(brainId, outcome.channel);
          return;
        }
        if (outcome.kind === "refused") {
          this.giveUp(brainId, outcome.kind);
          return;
        }
      }
    } finally {
      if (this.reopening.get(brainId) === loop) this.reopening.delete(brainId);
    }
  }

  /** End `brainId`'s quiet reopen, leaving nothing of it waiting. */
  private standDownReopen(brainId: string): void {
    this.reopening.get(brainId)?.standDown();
    this.reopening.delete(brainId);
  }

  /** How long the reopen attempt at `attempt`, counting from zero, waits before it is made. */
  private reopenDelayMs(attempt: number): number {
    return sessionReopenHeadDelaysMs[attempt] ?? sessionReopenIntervalMs + this.spreadMs();
  }

  /** A fresh draw from the spread a steady reopen delay is lengthened by. */
  private spreadMs(): number {
    return Math.floor(this.random() * sessionReopenJitterMs);
  }

  /**
   * Resolve once `loop`'s next attempt is due: `delayMs` after it was asked for
   * with the page in view, or a spread after the page comes back into view or
   * the browser comes back online. A loop stood down resolves at once, and one
   * waiting out of view waits until something above happens.
   */
  private whenDue(loop: ReopenLoop, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const disarm = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      const due = (): void => {
        disarm();
        unsubscribe();
        loop.standDown = () => {};
        resolve();
      };
      const unsubscribe = this.presence.subscribe(() => {
        disarm();
        if (this.presence.inView()) timer = setTimeout(due, this.spreadMs());
      });
      loop.standDown = due;
      if (this.presence.inView()) timer = setTimeout(due, delayMs);
    });
  }

  /**
   * What one attempt to open `brainId`'s session came to: the session the
   * service accepted, the refusal it answered with, or unavailable when it could
   * not be reached or said nothing within {@link sessionOpenTimeoutMs}. The
   * handshake carries the conversation the brain already holds, so the service
   * can rebuild the context of a session it did not run. An attempt that runs
   * out closes the socket it opened, however late that socket arrives.
   */
  private async handshake(brainId: string): Promise<HandshakeOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runsOut = new Promise<typeof runOut>((resolve) => {
      timer = setTimeout(() => resolve(runOut), sessionOpenTimeoutMs);
    });
    try {
      const connecting = this.options.connect();
      const connected = await Promise.race([connecting, runsOut]);
      if (connected === runOut) {
        void connecting.then(
          (late) => late.close(),
          () => {}
        );
        return { kind: "unavailable" };
      }
      const held = recordFor(this.current.store, brainId);
      connected.send({
        type: "session:connect",
        protocolVersion: ASSISTANT_RELAY_PROTOCOL_VERSION,
        clientBuild: this.options.clientBuild,
        manifest: this.options.manifest,
        ...(held.entries.length > 0 ? { conversation: held } : {}),
      });
      const opening = await Promise.race([connected.next(), runsOut]);
      if (opening === runOut || opening.type !== "session:accepted") {
        connected.close();
        return { kind: opening !== runOut && opening.type === "session:refused" ? "refused" : "unavailable" };
      }
      return { kind: "opened", channel: connected };
    } catch {
      return { kind: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run one turn end to end on `brainId`'s record, opening its session when it holds none. */
  private async runTurn(brainId: string, text: string): Promise<void> {
    const channel = await this.openChannel(brainId);
    if (channel === undefined) {
      this.finish(brainId, { kind: "failure", code: ConversationTurnFailureCode.NotConnected });
      return;
    }
    await this.carryTurn(brainId, channel, { type: "session:userMessage", text });
  }

  /**
   * Send `opening` on `channel` and fill `brainId`'s record from the turn it
   * starts, until that turn ends. A session that goes while the turn runs
   * finishes it as disconnected.
   */
  private async carryTurn(
    brainId: string,
    channel: AssistantChannel,
    opening: RelayUserMessage | RelayLibraryAdded
  ): Promise<void> {
    try {
      channel.send(opening);
      if (this.stopRequested.delete(brainId)) channel.send({ type: "turn:stop" });
      await this.follow(brainId, channel);
    } catch {
      this.dropChannel(brainId);
      this.finish(brainId, { kind: "failure", code: ConversationTurnFailureCode.Disconnected });
    }
  }

  /**
   * Read the turn's messages and record them until it finishes. Throws whatever
   * the channel throws once the session is gone.
   */
  private async follow(brainId: string, channel: AssistantChannel): Promise<void> {
    for (;;) {
      const message = await channel.next();
      switch (message.type) {
        case "turn:narration":
          this.endDoing(brainId);
          this.record(brainId, {
            kind: "narration",
            text: message.text,
            ...(message.part === undefined ? {} : { part: message.part }),
            ...(message.role === undefined ? {} : { role: message.role }),
            ...(message.judgment === undefined ? {} : { judgment: message.judgment }),
          });
          break;
        case "turn:writing":
          this.beginDoing(
            brainId,
            message.tool === thinkingWritingName
              ? { kind: "planning" }
              : { kind: "writing", tool: message.tool, chars: message.chars }
          );
          break;
        case "turn:toolCalls": {
          this.beginDoing(brainId, {
            kind: "serving",
            tools: message.requests.map((request) => request.name),
          });
          let served: RelayToolResultBatch;
          try {
            served = await serveToolCalls(this.options.workspace(brainId), message, this.mediatorFor(brainId));
          } catch {
            const unserved = unservedToolResults(message);
            this.recordBatch(brainId, message, unserved);
            try {
              channel.send(unserved);
            } catch {
              // A session that cannot be told the batch went unserved is left
              // waiting for it, so it goes with the turn.
              this.dropChannel(brainId);
              this.finish(brainId, { kind: "failure", code: ConversationTurnFailureCode.ToolServingFailed });
              return;
            }
            break;
          }
          this.recordBatch(brainId, message, served);
          channel.send(served);
          this.beginDoing(brainId, { kind: "planning" });
          break;
        }
        case "turn:end":
          this.finish(brainId, { kind: "end", code: message.code });
          return;
        case "turn:start":
        case "session:accepted":
        case "session:refused":
          break;
        default:
          assertUnreachable(message);
      }
    }
  }
}
