import { randomUUID } from "node:crypto";
import {
  type AppSessionJoinCodeMessage,
  type AppSessionWelcomeMessage,
  BridgeSessionErrorCode,
  type ControlPongMessage,
  type GeneralErrorMessage,
  PROTOCOL_VERSION,
  type SessionCounterpartAwayMessage,
  type SessionErrorMessage,
  type SessionHelloPayload,
  sessionHelloPayloadSchema,
} from "@wendoo/bridge-protocol";
import { generateTriplet } from "@wendoo/join-codes";
import type { Logger } from "pino";
import { BindingTokens } from "./binding-token.js";
import { TokenBucket } from "./throttle.js";

/**
 * Namespaces of the message types the relay handles itself, except a reply
 * carrying the id of a message the relay forwarded. A message type's namespace
 * is the text before its first `:`, or the whole type when it has none.
 */
const RELAY_CONTROL_NAMESPACES: readonly string[] = ["session", "control", "error"];

/** The relay's handle on one endpoint's connection. */
export interface RelaySocket {
  /** Sends one text frame to the endpoint. */
  send(data: string): void;
  /** Closes the connection. The transport reports the close back through {@link RelayConnection.closed}. */
  close(): void;
}

/** Receives the events of one connection, as its transport observes them. */
export interface RelayConnection {
  /** Handles one text frame received from the endpoint. */
  receive(data: string): void;
  /** Handles the connection having closed. Call once, after which the connection receives nothing. */
  closed(): void;
}

/**
 * A message the relay received that is not its own to handle: one outside
 * {@link RELAY_CONTROL_NAMESPACES} that is not a reply to a message the relay
 * forwarded. Its {@link FrameHandler} settles it by forwarding it, replying to
 * it, or neither, which drops it.
 */
export interface RelayFrame {
  /** Role of the connection the message arrived on. */
  readonly role: string;
  /** The message's `type`. */
  readonly type: string;
  /** The message's `id` when it is a string. */
  readonly id: string | undefined;
  /** The message's `seq` when it is a number. */
  readonly seq: number | undefined;
  /** The message's `payload`. */
  readonly payload: unknown;
  /** The exact text received. */
  readonly data: string;
  /**
   * Sends `data` to the peer of the connection the message arrived on and
   * returns `true`, or returns `false` when that connection has no peer.
   * When the message carries an `id`, the peer's next message carrying that
   * `id` within the reply deadline is its reply, which the relay sends back
   * to this connection as the exact text received.
   */
  forward(data: string): boolean;
  /** Sends `data` to the connection the message arrived on. */
  reply(data: string): void;
}

/** Settles each {@link RelayFrame} the relay receives, by forwarding it, replying to it, or dropping it. */
export type FrameHandler = (frame: RelayFrame) => void;

/** How long a session with no bound member lasts before it ends, in milliseconds. */
const DEFAULT_LINGER_MS = 5 * 60 * 1000;

/** How often every join code in service is replaced with a newly minted one, in milliseconds. */
const JOIN_CODE_ROTATION_MS = 10 * 60 * 1000;

/** How long after a rotation a hello presenting a session's previous join code still joins it, in milliseconds. */
const ENTRY_GRACE_MS = 2 * 60 * 1000;

/** How long a join code that has left service is kept from being minted again, in milliseconds. */
const RETIRED_JOIN_CODE_QUARANTINE_MS = DEFAULT_LINGER_MS;

/** How many generated triplets minting tries before it falls back to a triplet with a random suffix. */
const JOIN_CODE_MINT_ATTEMPTS = 100;

/** How many messages a connection may send in a burst before the relay refuses the excess. */
const MESSAGE_BURST = 100;
/** How many messages per second a connection may send once its burst is spent. */
const MESSAGES_PER_SECOND = 50;

/** How long a connection may send nothing before the relay closes it, in milliseconds. */
const ACTIVITY_TIMEOUT_MS = 60 * 1000;

/** How long after the relay forwards a message carrying an `id` the peer's message carrying it is still its reply, in milliseconds. */
const REPLY_DEADLINE_MS = 30 * 1000;

/**
 * Options for {@link Relay}.
 *
 * Only the test harness sets the timings -- `lingerMs`, `rotationMs`,
 * `graceMs`, `quarantineMs`, `activityTimeoutMs`, and `replyDeadlineMs`;
 * services leave them unset, so each takes the default its field states.
 */
export interface RelayOptions {
  /** Secret that signs the binding tokens the relay issues. */
  bindingSecret: string;
  /** Destination of the relay's log records. */
  logger: Logger;
  /** How long a session with no bound member lasts before it ends, in milliseconds. Defaults to five minutes. */
  lingerMs?: number;
  /** How often every join code in service rotates, in milliseconds. Defaults to ten minutes. */
  rotationMs?: number;
  /** How long after a rotation a session's previous join code still joins it, in milliseconds. Defaults to two minutes. */
  graceMs?: number;
  /** How long a join code that has left service is kept from being minted again, in milliseconds. Defaults to five minutes. */
  quarantineMs?: number;
  /** How long a connection may send nothing before the relay closes it, in milliseconds. Defaults to one minute. */
  activityTimeoutMs?: number;
  /**
   * How long after the relay forwards a message carrying an `id` the peer's
   * next message carrying that `id` is still its reply, in milliseconds.
   * Defaults to 30 seconds.
   */
  replyDeadlineMs?: number;
  /**
   * Settles every {@link RelayFrame}. When omitted, the relay forwards each
   * one to the sender's peer as the exact text received.
   */
  frameHandler?: FrameHandler;
}

/**
 * The timing options of {@link RelayOptions}: `lingerMs`, `rotationMs`,
 * `graceMs`, `quarantineMs`, `activityTimeoutMs`, and `replyDeadlineMs`.
 */
export type RelayTimings = Pick<
  RelayOptions,
  "lingerMs" | "rotationMs" | "graceMs" | "quarantineMs" | "activityTimeoutMs" | "replyDeadlineMs"
>;

/** One session, as {@link Relay.sessions} reports it. */
export interface SessionSnapshot {
  /** The kind each of the session's connections named when it opened. */
  readonly kind: string;
  /** The session id its members are welcomed with. */
  readonly sessionId: string;
  /**
   * The join code a hello presents to join the session while one of its
   * roles is vacant; `undefined` while both roles are bound.
   */
  readonly joinCode: string | undefined;
  /** Each role bound into the session, in role-name order. */
  readonly roles: readonly RoleSnapshot[];
}

/** One role of a session, as {@link Relay.sessions} reports it. */
export interface RoleSnapshot {
  readonly role: string;
  /**
   * `connected` while a member's connection holds the role; `lingering` once
   * that connection has closed, until a member binds back in.
   */
  readonly state: "connected" | "lingering";
  /** Id of the connection holding the role, which {@link Relay.disconnectMember} takes; `undefined` while lingering. */
  readonly memberId: string | undefined;
  /**
   * When the role entered its state, in epoch milliseconds: when the
   * connection holding it opened, or when the connection that held it closed.
   */
  readonly since: number;
}

/** One connected endpoint. */
interface Member {
  /** Identifies this connection in the session snapshot. */
  readonly id: string;
  readonly kind: string;
  readonly role: string;
  readonly socket: RelaySocket;
  /** When the connection opened, in epoch milliseconds. */
  readonly connectedAt: number;
  /** When the relay last received a frame on the connection, in epoch milliseconds. */
  lastActivity: number;
  /** Fires to check the connection against the activity timeout; `undefined` once the connection is closing. */
  activityCheck: ReturnType<typeof setTimeout> | undefined;
  /** Whether the relay has closed the connection, after which it ignores the connection's frames. */
  closing: boolean;
  /**
   * The pairing this member belongs to; `undefined` before its hello is
   * accepted and after it leaves or is removed from it.
   */
  pairing: Pairing | undefined;
  /**
   * Ids of messages forwarded to this member that no message from it has
   * carried back yet, each with the time, in epoch milliseconds, its reply
   * deadline passes, in the order they were forwarded.
   */
  readonly awaitingReply: Map<string, number>;
  /** Limits the rate of the messages this member's connection sends. */
  readonly messageLimit: TokenBucket;
  /**
   * The id of this member's accepted hello and the protocol version it
   * declared, which every welcome it receives echoes. `undefined` before its
   * hello is accepted.
   */
  accepted: { id: string | undefined; protocolVersion: number } | undefined;
}

/**
 * Up to two members of one kind, each with a different role. Within a kind,
 * no two pairings share a binding id, and no join code in service is held by
 * two pairings, as a join code or a previous join code.
 */
interface Pairing {
  /** Identifier reported to both members as their session id. */
  readonly id: string;
  readonly kind: string;
  /**
   * The code that joins the pairing while one of its roles is vacant,
   * replaced at every rotation; `undefined` while both roles are bound.
   */
  joinCode: string | undefined;
  /**
   * The code the latest rotation replaced, which still joins the pairing
   * until the entry grace ends; `undefined` outside the grace and while both
   * roles are bound.
   */
  previousJoinCode: string | undefined;
  /** The pairing's most recently minted join code, which its answers and welcomes carry. */
  latestJoinCode: string;
  /** Identity the binding tokens for this pairing name. */
  readonly bindingId: string;
  /** Members by role. */
  readonly members: Map<string, Member>;
  /**
   * Roles whose member's connection closed and that no member has bound back
   * into since, each with the time, in epoch milliseconds, the connection
   * closed.
   */
  readonly lingeringRoles: Map<string, number>;
  /** Ends the pairing when it fires; set while the pairing has no member, `undefined` otherwise. */
  expiry: ReturnType<typeof setTimeout> | undefined;
}

/** The envelope fields of a frame. */
interface Envelope {
  type: string;
  /** The frame's `id` when it is a string. */
  id: string | undefined;
  /** The frame's `seq` when it is a number. */
  seq: number | undefined;
  payload: unknown;
}

/**
 * Pairs endpoint connections into sessions and relays messages between the
 * two members of each.
 *
 * A connection names its kind and role when it opens, then sends
 * `session:hello`. A hello presenting a join code joins the pairing of the
 * connection's kind that holds that code in service, in the connection's
 * role; when no pairing of the kind holds it, or the pairing holding it has
 * the connection's role bound (and the hello presents no binding token for
 * that pairing), the relay answers with `session:error` carrying
 * `JOIN_CODE_UNKNOWN` and closes the connection. A hello presenting no join
 * code and a valid binding token joins the pairing of the binding id that
 * token names, and when no pairing of the kind holds that binding id, opens a
 * new pairing under it, with a new session id and join code; a hello
 * presenting neither opens a new pairing under a new binding id. The relay
 * answers an accepted hello with `session:joinCode`, carrying the pairing's
 * most recent join code.
 *
 * A join code is in service exactly while its pairing has a vacant role. A
 * pairing mints one when it opens and whenever a member's connection closes;
 * the code leaves service the moment both roles are bound, and when the
 * pairing ends. Every minted code is new: never one in service, and never one
 * in quarantine.
 *
 * A binding token carries no expiry and stays valid for as long as the
 * relay's binding secret is unchanged, so a binding outlives its pairing:
 * after the relay restarts under the same secret, after a pairing lingers
 * out, or after a pairing is ended on purpose, the first member presenting
 * its token opens a new pairing under the binding id, the other member's
 * token joins it, and both are welcomed with the new session id and a binding
 * token equal to the one each presented. A relay started under a new secret
 * verifies no earlier token, so after such a restart each member's token
 * opens a separate new pairing under a new binding id.
 *
 * A pairing is the session: the binding of its two members, identified by its
 * session id and by the binding tokens that name it. A member leaving and
 * binding back in changes the session's status, not the session: when a
 * member's connection closes, the member still bound receives
 * `session:counterpartAway` and then `session:joinCode` with the code the
 * pairing mints for the vacant role; a pairing whose members have all left
 * keeps its session id and binding id, and a hello presenting its join code
 * or a binding token for it binds back into it, until the pairing has had no
 * member for the linger time, which ends it. Each time the pairing comes to
 * have both members bound -- when the second member first arrives, and again
 * whenever a member binds back in -- BOTH members receive `session:welcome`,
 * carrying the session id, the pairing's most recent join code, and a binding
 * token for the pairing. A welcome means "the session is connected".
 * Endpoints must restart the handshake they scope to their counterpart's
 * connection on every welcome, including a further welcome on a connection
 * already welcomed.
 *
 * A hello presenting a binding token for a pairing whose role it names is
 * still held supersedes the connection holding it, which receives
 * `session:error` carrying `SESSION_REPLACED` before the relay closes it; a
 * connected peer stays connected and is welcomed again. A hello for a third
 * role of a pairing whose two roles are bound is answered with a
 * `session:error` carrying no code, and binds nothing.
 *
 * A member ends its session on purpose with `session:goodbye`: the pairing
 * ends at once, the other member, when connected, receives `session:error`
 * carrying `SESSION_ENDED`, and the relay closes both connections.
 * {@link Relay.endSession} ends a session the same way, telling every
 * connected member.
 *
 * A connection that sends nothing for the activity timeout is closed, and
 * its member has left as on any closed connection. Endpoints keep a live
 * connection active with `control:ping`, which the relay answers with
 * `control:pong`.
 *
 * Messages in {@link RELAY_CONTROL_NAMESPACES} are handled by the relay,
 * except a reply carrying the id of a message the relay forwarded, which goes
 * to the peer that sent the original as the exact text received. A message
 * carrying that id after the reply deadline is not a reply. Every other
 * message is a {@link RelayFrame} for the relay's {@link FrameHandler};
 * without one, it goes to the sender's peer as the exact text received, or
 * nowhere when the sender has no peer. Frames that are not JSON objects with
 * a string `type` are dropped.
 *
 * Join codes in service rotate. Every rotation interval while it holds any
 * pairing, the relay replaces the join code of every pairing that has one,
 * connected or lingering, with a newly minted one and sends each bound member
 * `session:joinCode` carrying it. For the entry grace after a rotation, or
 * until the next rotation if that comes first, a hello presenting a pairing's
 * previous join code still joins it; every answer and welcome carries the
 * current code. A join code leaves service when its pairing ends, when both
 * of its pairing's roles become bound, when a member's connection closes, or
 * when the grace after its replacement ends, and is not minted again for the
 * quarantine time after that. A minted join code is a generated triplet that
 * no pairing of the kind holds and that is not in quarantine; when 100
 * triplets in a row fail that test, the relay mints a triplet with a random
 * suffix instead.
 *
 * The linger time, rotation interval, entry grace, quarantine time, activity
 * timeout, and reply deadline are five minutes, ten minutes, two minutes,
 * five minutes, one minute, and 30 seconds unless {@link RelayOptions} sets
 * them.
 *
 * Each connection may send a burst of 100 messages, then 50 a second. The
 * relay answers each message beyond that with an `error` message and
 * otherwise ignores it.
 */
export class Relay {
  private readonly _pairings = new Set<Pairing>();
  /** Every connection whose transport has not yet reported its close. */
  private readonly _connections = new Set<Member>();
  private readonly _tokens: BindingTokens;
  private readonly _logger: Logger;
  private readonly _lingerMs: number;
  private readonly _rotationMs: number;
  private readonly _graceMs: number;
  private readonly _quarantineMs: number;
  private readonly _activityTimeoutMs: number;
  private readonly _replyDeadlineMs: number;
  private readonly _frameHandler: FrameHandler;
  /** Rotates every join code in service on each tick; set while any pairing exists. */
  private _rotation: ReturnType<typeof setInterval> | undefined;
  /** Ends the entry grace of the latest rotation when it fires; set while that grace lasts. */
  private _grace: ReturnType<typeof setTimeout> | undefined;
  /** Join codes that have left service, each with the time, in epoch milliseconds, until which it is not minted. */
  private readonly _retiredJoinCodes = new Map<string, number>();

  constructor(options: RelayOptions) {
    this._tokens = new BindingTokens(options.bindingSecret);
    this._logger = options.logger;
    this._lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
    this._rotationMs = options.rotationMs ?? JOIN_CODE_ROTATION_MS;
    this._graceMs = options.graceMs ?? ENTRY_GRACE_MS;
    this._quarantineMs = options.quarantineMs ?? RETIRED_JOIN_CODE_QUARANTINE_MS;
    this._activityTimeoutMs = options.activityTimeoutMs ?? ACTIVITY_TIMEOUT_MS;
    this._replyDeadlineMs = options.replyDeadlineMs ?? REPLY_DEADLINE_MS;
    this._frameHandler = options.frameHandler ?? forwardVerbatim;
  }

  /** Ends every session and stops watching every connection's activity. Call once the relay's connections are closed. */
  dispose(): void {
    for (const pairing of this._pairings) {
      clearTimeout(pairing.expiry);
    }
    this._pairings.clear();
    for (const member of this._connections) {
      clearTimeout(member.activityCheck);
    }
    this._connections.clear();
    this.stopRotating();
    this._retiredJoinCodes.clear();
  }

  /** Reports every session the relay holds, in the order they opened. */
  sessions(): SessionSnapshot[] {
    return [...this._pairings].map((pairing) => {
      const connected = [...pairing.members.values()].map(
        (member): RoleSnapshot => ({
          role: member.role,
          state: "connected",
          memberId: member.id,
          since: member.connectedAt,
        })
      );
      const lingering = [...pairing.lingeringRoles].map(
        ([role, since]): RoleSnapshot => ({ role, state: "lingering", memberId: undefined, since })
      );
      return {
        kind: pairing.kind,
        sessionId: pairing.id,
        joinCode: pairing.joinCode,
        roles: [...connected, ...lingering].sort((a, b) => (a.role < b.role ? -1 : 1)),
      };
    });
  }

  /**
   * Ends the session with id `sessionId` at once: its join codes leave
   * service, and each member still bound receives `session:error` carrying
   * `SESSION_ENDED` before its connection closes. A member's binding token
   * then re-forms a session under the binding, with a new session id and join
   * code. Returns `false` when the relay holds no session with that id.
   */
  endSession(sessionId: string): boolean {
    for (const pairing of this._pairings) {
      if (pairing.id !== sessionId) continue;
      this._logger.info({ kind: pairing.kind, pairingId: pairing.id }, "session ended by an administrator");
      this.terminate(pairing, undefined);
      return true;
    }
    return false;
  }

  /**
   * Closes the connection of the bound member with id `memberId`. Once its
   * transport reports the close, the member has left as on any closed
   * connection: its counterpart receives `session:counterpartAway`, and its
   * binding token binds it back in. Returns `false` when no bound member has
   * that id.
   */
  disconnectMember(memberId: string): boolean {
    for (const pairing of this._pairings) {
      for (const member of pairing.members.values()) {
        if (member.id !== memberId) continue;
        this._logger.info(
          { kind: member.kind, role: member.role, pairingId: pairing.id },
          "member disconnected by an administrator"
        );
        this.close(member);
        return true;
      }
    }
    return false;
  }

  /**
   * Registers a newly opened connection of `role` in session kind `kind` and
   * returns the handler its transport reports the connection's events to.
   */
  connect(kind: string, role: string, socket: RelaySocket): RelayConnection {
    const now = Date.now();
    const member: Member = {
      id: randomUUID(),
      kind,
      role,
      socket,
      connectedAt: now,
      lastActivity: now,
      activityCheck: undefined,
      closing: false,
      pairing: undefined,
      awaitingReply: new Map(),
      messageLimit: new TokenBucket(MESSAGE_BURST, MESSAGES_PER_SECOND),
      accepted: undefined,
    };
    this._connections.add(member);
    this.watchActivity(member, this._activityTimeoutMs);
    this._logger.info({ kind, role }, "connection opened");
    return {
      receive: (data) => {
        this.receive(member, data);
      },
      closed: () => {
        this._connections.delete(member);
        clearTimeout(member.activityCheck);
        member.activityCheck = undefined;
        this._logger.info({ kind, role, pairingId: member.pairing?.id }, "connection closed");
        this.leave(member);
      },
    };
  }

  private receive(member: Member, data: string): void {
    if (member.closing) return;
    member.lastActivity = Date.now();
    if (!member.messageLimit.consume()) {
      this._logger.warn({ kind: member.kind, role: member.role }, "refused a message over the rate limit");
      const refusal: GeneralErrorMessage = { type: "error", payload: { message: "rate limit exceeded" } };
      member.socket.send(JSON.stringify(refusal));
      return;
    }
    const envelope = readEnvelope(data);
    if (envelope === undefined) {
      this._logger.warn({ kind: member.kind, role: member.role }, "dropped a frame that is not a typed JSON object");
      return;
    }
    if (envelope.id !== undefined && this.takeReply(member, envelope.id)) {
      this.forward(member, data);
      return;
    }
    if (RELAY_CONTROL_NAMESPACES.includes(envelope.type.split(":", 1)[0])) {
      this.control(member, envelope);
      return;
    }
    this._frameHandler({
      role: member.role,
      type: envelope.type,
      id: envelope.id,
      seq: envelope.seq,
      payload: envelope.payload,
      data,
      forward: (forwarded) => {
        const peer = this.forward(member, forwarded);
        if (peer !== undefined && envelope.id !== undefined) {
          this.awaitReply(peer, envelope.id);
        }
        return peer !== undefined;
      },
      reply: (reply) => {
        member.socket.send(reply);
      },
    });
  }

  /** Sends `data` to the peer of `member` and returns that peer, or `undefined` when there is none. */
  private forward(member: Member, data: string): Member | undefined {
    const peer = peerOf(member);
    if (peer === undefined) {
      this._logger.debug({ kind: member.kind, role: member.role }, "dropped a message sent with no peer");
      return undefined;
    }
    peer.socket.send(data);
    return peer;
  }

  /** Records that `member`'s next message carrying `id`, within the reply deadline, is a reply to relay back. */
  private awaitReply(member: Member, id: string): void {
    const now = Date.now();
    this.expireReplies(member, now);
    member.awaitingReply.delete(id);
    member.awaitingReply.set(id, now + this._replyDeadlineMs);
  }

  /** Whether a message from `member` carrying `id` is a reply the relay awaits, which it then no longer awaits. */
  private takeReply(member: Member, id: string): boolean {
    this.expireReplies(member, Date.now());
    return member.awaitingReply.delete(id);
  }

  /** Stops awaiting every reply from `member` whose deadline has passed at `now`. */
  private expireReplies(member: Member, now: number): void {
    for (const [id, deadline] of member.awaitingReply) {
      if (deadline > now) return;
      member.awaitingReply.delete(id);
    }
  }

  /**
   * Checks `member`'s connection against the activity timeout in `delay`
   * milliseconds: closes it when it has received nothing for the timeout,
   * and otherwise checks again when the timeout would next pass.
   */
  private watchActivity(member: Member, delay: number): void {
    member.activityCheck = setTimeout(() => {
      const idle = Date.now() - member.lastActivity;
      if (idle < this._activityTimeoutMs) {
        this.watchActivity(member, this._activityTimeoutMs - idle);
        return;
      }
      this._logger.info({ kind: member.kind, role: member.role }, "closed a connection that sent nothing for too long");
      member.activityCheck = undefined;
      this.leave(member);
      this.close(member);
    }, delay);
    member.activityCheck.unref();
  }

  private control(member: Member, envelope: Envelope): void {
    switch (envelope.type) {
      case "session:hello":
        this.hello(member, envelope);
        return;
      case "session:goodbye":
        this.goodbye(member);
        return;
      case "control:ping": {
        const pong: ControlPongMessage = { type: "control:pong", id: envelope.id };
        member.socket.send(JSON.stringify(pong));
        return;
      }
      default:
        this._logger.debug({ kind: member.kind, role: member.role, type: envelope.type }, "ignored a control message");
    }
  }

  private hello(member: Member, envelope: Envelope): void {
    const { kind, role } = member;
    if (member.pairing !== undefined) {
      this._logger.warn({ kind, role, pairingId: member.pairing.id }, "ignored a hello on an established connection");
      return;
    }
    const hello = readHello(envelope.payload);
    if (hello === undefined) {
      this._logger.warn({ kind, role }, "rejected a hello declaring an unsupported protocol version");
      this.refuse(
        member,
        envelope.id,
        BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH,
        `This relay speaks bridge protocol versions 1 to ${PROTOCOL_VERSION}.`
      );
      return;
    }

    const bindingId = hello.bindingToken === undefined ? undefined : this._tokens.verify(hello.bindingToken);
    let pairing: Pairing;
    if (hello.joinCode !== undefined) {
      const holder = this.findByJoinCode(kind, hello.joinCode);
      if (holder === undefined || (holder.members.has(role) && bindingId !== holder.bindingId)) {
        this._logger.warn({ kind, role }, "rejected a hello presenting a join code that opens no vacant role");
        this.refuse(
          member,
          envelope.id,
          BridgeSessionErrorCode.JOIN_CODE_UNKNOWN,
          "This join code does not match a session waiting to be joined."
        );
        return;
      }
      pairing = holder;
    } else {
      pairing =
        this.find(kind, (candidate) => candidate.bindingId === bindingId) ??
        (bindingId === undefined ? this.open(kind) : this.adopt(kind, bindingId));
    }

    const superseded = pairing.members.get(role);
    if (superseded !== undefined) {
      this._logger.info({ kind, role, pairingId: pairing.id }, "member superseded by its own reconnect");
      this.displace(superseded);
    } else if (pairing.members.size >= 2) {
      this._logger.warn({ kind, role, pairingId: pairing.id }, "refused a third role into a pairing");
      const refusal: SessionErrorMessage = {
        type: "session:error",
        id: envelope.id,
        payload: { message: "This session already has two members." },
      };
      member.socket.send(JSON.stringify(refusal));
      return;
    }

    pairing.members.set(role, member);
    pairing.lingeringRoles.delete(role);
    member.pairing = pairing;
    clearTimeout(pairing.expiry);
    pairing.expiry = undefined;
    member.accepted = { id: envelope.id, protocolVersion: hello.protocolVersion };
    this._logger.info({ kind, role, pairingId: pairing.id, joinCode: pairing.latestJoinCode }, "member joined");
    this.sendJoinCode(member, pairing.latestJoinCode);
    if (pairing.members.size === 2) {
      this.retireJoinCodes(pairing);
      for (const paired of pairing.members.values()) {
        this.welcome(paired, pairing);
      }
    }
  }

  /** Sends `member` the pairing's `session:welcome`. `member` is a bound member of `pairing`. */
  private welcome(member: Member, pairing: Pairing): void {
    const accepted = member.accepted!;
    const welcome: AppSessionWelcomeMessage = {
      type: "session:welcome",
      id: accepted.id,
      payload: {
        protocolVersion: accepted.protocolVersion,
        sessionId: pairing.id,
        joinCode: pairing.latestJoinCode,
        bindingToken: this._tokens.create(pairing.bindingId),
      },
    };
    member.socket.send(JSON.stringify(welcome));
  }

  /** Sends `member` a `session:joinCode` carrying `joinCode`. */
  private sendJoinCode(member: Member, joinCode: string): void {
    const push: AppSessionJoinCodeMessage = { type: "session:joinCode", payload: { joinCode } };
    member.socket.send(JSON.stringify(push));
  }

  /**
   * Answers the hello with id `helloId` on `member`'s connection with a
   * `session:error` carrying `code` and `message`, then closes the connection.
   */
  private refuse(member: Member, helloId: string | undefined, code: BridgeSessionErrorCode, message: string): void {
    const refusal: SessionErrorMessage = { type: "session:error", id: helloId, payload: { message, code } };
    member.socket.send(JSON.stringify(refusal));
    this.close(member);
  }

  /**
   * Tells `member` that a newer connection of its own has taken its place,
   * with `session:error` carrying `SESSION_REPLACED`, then removes it from its
   * pairing and closes its connection.
   */
  private displace(member: Member): void {
    const replaced: SessionErrorMessage = {
      type: "session:error",
      payload: {
        message: "A newer connection of this member has taken this one's place.",
        code: BridgeSessionErrorCode.SESSION_REPLACED,
      },
    };
    member.socket.send(JSON.stringify(replaced));
    member.pairing?.members.delete(member.role);
    member.pairing = undefined;
    this.close(member);
  }

  /** Ends the session of `member`, which sent `session:goodbye`; a goodbye from a connection bound to no session does nothing. */
  private goodbye(member: Member): void {
    const { kind, role, pairing } = member;
    if (pairing === undefined) {
      this._logger.debug({ kind, role }, "ignored a goodbye on a connection bound to no session");
      return;
    }
    this._logger.info({ kind, role, pairingId: pairing.id }, "session ended by a member");
    this.terminate(pairing, member);
  }

  /**
   * Ends `pairing` on purpose: removes it, then tells each of its bound
   * members other than `requester` with `session:error` carrying
   * `SESSION_ENDED`, and closes every bound member's connection.
   */
  private terminate(pairing: Pairing, requester: Member | undefined): void {
    this.end(pairing);
    const ended: SessionErrorMessage = {
      type: "session:error",
      payload: { message: "This session has ended.", code: BridgeSessionErrorCode.SESSION_ENDED },
    };
    const data = JSON.stringify(ended);
    for (const member of pairing.members.values()) {
      member.pairing = undefined;
      if (member !== requester) member.socket.send(data);
      this.close(member);
    }
    pairing.members.clear();
  }

  /** Marks `member`'s connection as closing, so its frames are ignored, and closes it. */
  private close(member: Member): void {
    member.closing = true;
    member.socket.close();
  }

  /**
   * Removes `member` from its pairing, if it is bound, leaving its role
   * lingering. The pairing mints a join code for the vacant role and sends
   * each member still bound `session:counterpartAway`, then that code; a
   * pairing with no member left ends after the linger time.
   */
  private leave(member: Member): void {
    const { kind, role, pairing } = member;
    if (pairing === undefined) return;
    member.pairing = undefined;
    pairing.members.delete(role);
    pairing.lingeringRoles.set(role, Date.now());
    this.retireJoinCodes(pairing);
    const joinCode = this.mintJoinCode(kind);
    pairing.joinCode = joinCode;
    pairing.latestJoinCode = joinCode;
    if (pairing.members.size > 0) {
      const away: SessionCounterpartAwayMessage = { type: "session:counterpartAway" };
      const data = JSON.stringify(away);
      for (const remaining of pairing.members.values()) {
        remaining.socket.send(data);
        this.sendJoinCode(remaining, joinCode);
      }
      return;
    }
    pairing.expiry = setTimeout(() => {
      this._logger.info({ kind, pairingId: pairing.id }, "session ended after lingering with no member");
      this.end(pairing);
    }, this._lingerMs);
    pairing.expiry.unref();
  }

  /**
   * Removes `pairing`, retires its join codes, and stops rotating once no
   * pairing remains. Leaves the connections of its members as they are.
   */
  private end(pairing: Pairing): void {
    clearTimeout(pairing.expiry);
    this._pairings.delete(pairing);
    this.retireJoinCodes(pairing);
    if (this._pairings.size === 0) this.stopRotating();
  }

  /** Takes `pairing`'s join code and previous join code out of service, retiring each. */
  private retireJoinCodes(pairing: Pairing): void {
    if (pairing.joinCode !== undefined) this.retire(pairing.joinCode);
    if (pairing.previousJoinCode !== undefined) this.retire(pairing.previousJoinCode);
    pairing.joinCode = undefined;
    pairing.previousJoinCode = undefined;
  }

  /**
   * Replaces every join code in service with a newly minted one, sending it
   * to the bound members of the pairing holding it, and starts the entry grace
   * of the codes replaced. The grace of the previous rotation ends first.
   */
  private rotate(): void {
    this.endGrace();
    this.pruneRetiredJoinCodes();
    let rotated = 0;
    for (const pairing of this._pairings) {
      if (pairing.joinCode === undefined) continue;
      rotated++;
      pairing.previousJoinCode = pairing.joinCode;
      pairing.joinCode = this.mintJoinCode(pairing.kind);
      pairing.latestJoinCode = pairing.joinCode;
      for (const member of pairing.members.values()) {
        this.sendJoinCode(member, pairing.joinCode);
      }
    }
    this._grace = setTimeout(() => {
      this.endGrace();
    }, this._graceMs);
    this._grace.unref();
    this._logger.info({ joinCodes: rotated }, "rotated join codes");
  }

  /** Ends the entry grace of the latest rotation, retiring every pairing's previous join code. */
  private endGrace(): void {
    clearTimeout(this._grace);
    this._grace = undefined;
    for (const pairing of this._pairings) {
      if (pairing.previousJoinCode === undefined) continue;
      this.retire(pairing.previousJoinCode);
      pairing.previousJoinCode = undefined;
    }
  }

  /** Stops the rotation timer and the entry grace timer. */
  private stopRotating(): void {
    clearInterval(this._rotation);
    this._rotation = undefined;
    clearTimeout(this._grace);
    this._grace = undefined;
  }

  /** Keeps `joinCode`, which has just left service, from being minted again for the quarantine time. */
  private retire(joinCode: string): void {
    this._retiredJoinCodes.set(joinCode, Date.now() + this._quarantineMs);
  }

  /** Forgets every retired join code whose quarantine has ended. */
  private pruneRetiredJoinCodes(): void {
    const now = Date.now();
    for (const [joinCode, until] of this._retiredJoinCodes) {
      if (until <= now) this._retiredJoinCodes.delete(joinCode);
    }
  }

  /** Whether `joinCode` left service within the quarantine time. */
  private isRetired(joinCode: string): boolean {
    const until = this._retiredJoinCodes.get(joinCode);
    return until !== undefined && until > Date.now();
  }

  private find(kind: string, predicate: (pairing: Pairing) => boolean): Pairing | undefined {
    for (const pairing of this._pairings) {
      if (pairing.kind === kind && predicate(pairing)) return pairing;
    }
    return undefined;
  }

  /**
   * The pairing of `kind` that holds `joinCode` in service: the one whose
   * join code it is, or the one whose previous join code it is.
   */
  private findByJoinCode(kind: string, joinCode: string): Pairing | undefined {
    return this.find(kind, (pairing) => pairing.joinCode === joinCode || pairing.previousJoinCode === joinCode);
  }

  /**
   * Opens an empty pairing of `kind` under `bindingId`, which no pairing of
   * `kind` holds, with a new session id and a newly minted join code.
   */
  private adopt(kind: string, bindingId: string): Pairing {
    const pairing = this.open(kind, bindingId);
    this._logger.info({ kind, pairingId: pairing.id }, "session rebuilt from a binding token");
    return pairing;
  }

  /**
   * Opens an empty pairing of `kind` under `bindingId`, a new binding id when
   * omitted, with a newly minted join code, and starts rotating if no pairing
   * existed. The caller guarantees that no pairing of `kind` holds
   * `bindingId`.
   */
  private open(kind: string, bindingId: string = randomUUID()): Pairing {
    const joinCode = this.mintJoinCode(kind);
    const pairing: Pairing = {
      id: randomUUID(),
      kind,
      joinCode,
      previousJoinCode: undefined,
      latestJoinCode: joinCode,
      bindingId,
      members: new Map(),
      lingeringRoles: new Map(),
      expiry: undefined,
    };
    this._pairings.add(pairing);
    if (this._rotation === undefined) {
      this._rotation = setInterval(() => {
        this.rotate();
      }, this._rotationMs);
      this._rotation.unref();
    }
    return pairing;
  }

  /**
   * A join code for a pairing of `kind`: a generated triplet that no pairing
   * of `kind` holds in service, as a join code or a previous join code, and
   * that is not retired; or, when {@link JOIN_CODE_MINT_ATTEMPTS} triplets in
   * a row fail that test, a triplet with a random suffix.
   */
  private mintJoinCode(kind: string): string {
    for (let attempt = 0; attempt < JOIN_CODE_MINT_ATTEMPTS; attempt++) {
      const joinCode = generateTriplet();
      if (!this.isRetired(joinCode) && this.findByJoinCode(kind, joinCode) === undefined) return joinCode;
    }
    return `${generateTriplet()}-${randomUUID().slice(0, 8)}`;
  }
}

/** Forwards `frame` to the sender's peer as the exact text received. */
function forwardVerbatim(frame: RelayFrame): void {
  frame.forward(frame.data);
}

/** The other member of the pairing `member` belongs to, if there is one. */
function peerOf(member: Member): Member | undefined {
  for (const candidate of member.pairing?.members.values() ?? []) {
    if (candidate !== member) return candidate;
  }
  return undefined;
}

/** The envelope of the frame `data`, or `undefined` when it is not a JSON object with a string `type`. */
function readEnvelope(data: string): Envelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { type, id, seq, payload } = value as Record<string, unknown>;
  if (typeof type !== "string") return undefined;
  return {
    type,
    id: typeof id === "string" ? id : undefined,
    seq: typeof seq === "number" ? seq : undefined,
    payload,
  };
}

/** The hello payload `payload`, or `undefined` when it is malformed or declares an unsupported protocol version. */
function readHello(payload: unknown): SessionHelloPayload | undefined {
  const parsed = sessionHelloPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const { protocolVersion } = parsed.data;
  return protocolVersion >= 1 && protocolVersion <= PROTOCOL_VERSION ? parsed.data : undefined;
}
