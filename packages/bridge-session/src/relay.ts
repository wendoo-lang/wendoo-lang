import { randomUUID } from "node:crypto";
import {
  type AppSessionJoinCodeMessage,
  type AppSessionWelcomeMessage,
  BridgeSessionErrorCode,
  type ControlPongMessage,
  PROTOCOL_VERSION,
  type SessionCounterpartAwayMessage,
  type SessionErrorMessage,
  type SessionHelloPayload,
  sessionHelloPayloadSchema,
} from "@wendoo/bridge-protocol";
import { generateTriplet } from "@wendoo/join-codes";
import type { Logger } from "pino";
import { BindingTokens } from "./binding-token.js";

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

/** How long a session with no bound member lasts before it ends, in milliseconds, unless configured otherwise. */
const DEFAULT_LINGER_MS = 5 * 60 * 1000;

/** Options for {@link Relay}. */
export interface RelayOptions {
  /** Secret that signs the binding tokens the relay issues. */
  bindingSecret: string;
  /** Destination of the relay's log records. */
  logger: Logger;
  /** How long a session with no bound member lasts before it ends, in milliseconds. Defaults to five minutes. */
  lingerMs?: number;
}

/** One connected endpoint. */
interface Member {
  readonly kind: string;
  readonly role: string;
  readonly socket: RelaySocket;
  /**
   * The pairing this member belongs to; `undefined` before its hello is
   * accepted and after it leaves or is removed from it.
   */
  pairing: Pairing | undefined;
  /** Ids of messages forwarded to this member that no message from it has carried back yet. */
  readonly awaitingReply: Set<string>;
  /**
   * The id of this member's accepted hello and the protocol version it
   * declared, which every welcome it receives echoes. `undefined` before its
   * hello is accepted.
   */
  accepted: { id: string | undefined; protocolVersion: number } | undefined;
}

/**
 * Up to two members of one kind, each with a different role, joined by a
 * join code. Within a kind, no two pairings share a join code or a binding id.
 */
interface Pairing {
  /** Identifier reported to both members as their session id. */
  readonly id: string;
  readonly kind: string;
  readonly joinCode: string;
  /** Identity the binding tokens for this pairing name. */
  readonly bindingId: string;
  /** Members by role. */
  readonly members: Map<string, Member>;
  /** Ends the pairing when it fires; set while the pairing has no member, `undefined` otherwise. */
  expiry: ReturnType<typeof setTimeout> | undefined;
}

/** The envelope fields of a frame. */
interface Envelope {
  type: string;
  /** The frame's `id` when it is a string. */
  id: string | undefined;
  payload: unknown;
}

/**
 * Pairs endpoint connections into sessions and relays messages between the
 * two members of each.
 *
 * A connection names its kind and role when it opens, then sends
 * `session:hello`. A hello presenting a join code joins the pairing of the
 * connection's kind with that code; otherwise one presenting a valid binding
 * token joins the pairing of the binding id that token names, and when no
 * pairing of the kind holds that binding id, opens a new pairing under it,
 * with a new session id and join code; otherwise the hello opens a new
 * pairing under a new binding id, which keeps the presented join code when
 * there is one. The relay answers an accepted hello with `session:joinCode`,
 * carrying the pairing's join code.
 *
 * A binding token carries no expiry and stays valid for as long as the
 * relay's binding secret is unchanged, so a binding outlives its pairing:
 * after the relay restarts under the same secret, or after a pairing lingers
 * out, the first member presenting its token opens a new pairing under the
 * binding id, the other member's token joins it, and both are welcomed with
 * the new session id and join code and a binding token equal to the one each
 * presented. A relay started under a new secret verifies no earlier token, so
 * after such a restart each member's token opens a separate new pairing under
 * a new binding id.
 *
 * A pairing is the session: the binding of its two members, identified by
 * its session id and by the binding tokens that name it. A member leaving and
 * binding back in changes the session's status, not the session: when a
 * member's connection closes without being superseded, the member still
 * bound receives `session:counterpartAway`; a pairing whose members have all left keeps its
 * session id, join code, and binding id, and a hello presenting its join code
 * or a binding token for it binds back into it, until the pairing has had no
 * member for the linger time, which ends it. Each time the pairing comes to
 * have both members bound -- when the second member first arrives, and again
 * whenever a member binds back in -- BOTH members receive `session:welcome`,
 * carrying the session id, join code, and a binding token for the pairing. A
 * welcome means "the session is connected". Endpoints must restart the
 * handshake they scope to their counterpart's connection on every welcome,
 * including a further welcome on a connection already welcomed.
 *
 * A hello for a slot whose role is already taken supersedes the connection
 * holding it, which receives `session:error` carrying `SESSION_REPLACED`
 * before the relay closes it. When the hello presents a binding token for
 * that pairing, the member is returning to the same session: the relay
 * closes only the connection it held before, and a connected peer stays
 * connected and is welcomed again. Otherwise the hello is a new claimant,
 * which ends the session: the relay opens a new session under the same join
 * code, with a new session id and binding id, and moves the other role's
 * member, when one is bound, into it on its open connection. That member and
 * the newcomer are then both welcomed, each welcome carrying the new session
 * id and a binding token for the new session. Tokens naming the ended
 * session never reach the successor, so a member of the other role that was
 * away at the replacement does not return by its token: presenting it opens
 * a new session under the ended session's binding id, and the member joins
 * the successor only by a hello presenting the join code.
 *
 * Messages in {@link RELAY_CONTROL_NAMESPACES} are handled by the relay,
 * except a reply carrying the id of a message the relay forwarded, which goes
 * to the peer that sent the original. Every other message goes to the
 * sender's peer as the exact text received, or nowhere when the sender has no
 * peer. Frames that are not JSON objects with a string `type` are dropped.
 */
export class Relay {
  private readonly _pairings = new Set<Pairing>();
  private readonly _tokens: BindingTokens;
  private readonly _logger: Logger;
  private readonly _lingerMs: number;

  constructor(options: RelayOptions) {
    this._tokens = new BindingTokens(options.bindingSecret);
    this._logger = options.logger;
    this._lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  }

  /** Ends every session. Call once the relay's connections are closed. */
  dispose(): void {
    for (const pairing of this._pairings) {
      clearTimeout(pairing.expiry);
    }
    this._pairings.clear();
  }

  /**
   * Registers a newly opened connection of `role` in session kind `kind` and
   * returns the handler its transport reports the connection's events to.
   */
  connect(kind: string, role: string, socket: RelaySocket): RelayConnection {
    const member: Member = {
      kind,
      role,
      socket,
      pairing: undefined,
      awaitingReply: new Set(),
      accepted: undefined,
    };
    this._logger.info({ kind, role }, "connection opened");
    return {
      receive: (data) => {
        this.receive(member, data);
      },
      closed: () => {
        this.leave(member);
      },
    };
  }

  private receive(member: Member, data: string): void {
    const envelope = readEnvelope(data);
    if (envelope === undefined) {
      this._logger.warn({ kind: member.kind, role: member.role }, "dropped a frame that is not a typed JSON object");
      return;
    }
    if (envelope.id !== undefined && member.awaitingReply.delete(envelope.id)) {
      this.forward(member, data);
      return;
    }
    if (RELAY_CONTROL_NAMESPACES.includes(envelope.type.split(":", 1)[0])) {
      this.control(member, envelope);
      return;
    }
    const peer = this.forward(member, data);
    if (peer !== undefined && envelope.id !== undefined) {
      peer.awaitingReply.add(envelope.id);
    }
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

  private control(member: Member, envelope: Envelope): void {
    switch (envelope.type) {
      case "session:hello":
        this.hello(member, envelope);
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
      const rejection: SessionErrorMessage = {
        type: "session:error",
        id: envelope.id,
        payload: {
          message: `This relay speaks bridge protocol versions 1 to ${PROTOCOL_VERSION}.`,
          code: BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH,
        },
      };
      member.socket.send(JSON.stringify(rejection));
      member.socket.close();
      return;
    }

    const bindingId = hello.bindingToken === undefined ? undefined : this._tokens.verify(hello.bindingToken);
    let pairing =
      this.find(kind, (candidate) => candidate.joinCode === hello.joinCode) ??
      this.find(kind, (candidate) => candidate.bindingId === bindingId) ??
      (bindingId === undefined ? this.open(kind, hello.joinCode) : this.adopt(kind, bindingId));

    const holder = pairing.members.get(role);
    if (holder !== undefined && bindingId === pairing.bindingId) {
      this._logger.info({ kind, role, pairingId: pairing.id }, "member superseded by its own reconnect");
      this.displace(holder);
    } else if (holder !== undefined) {
      pairing = this.replace(pairing, role);
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
    member.pairing = pairing;
    clearTimeout(pairing.expiry);
    pairing.expiry = undefined;
    member.accepted = { id: envelope.id, protocolVersion: hello.protocolVersion };
    this._logger.info({ kind, role, pairingId: pairing.id, joinCode: pairing.joinCode }, "member joined");
    const joinCode: AppSessionJoinCodeMessage = { type: "session:joinCode", payload: { joinCode: pairing.joinCode } };
    member.socket.send(JSON.stringify(joinCode));
    if (pairing.members.size === 2) {
      for (const paired of pairing.members.values()) {
        this.welcome(paired, pairing);
      }
    }
  }

  /** Sends `member`, a bound member of `pairing`, the pairing's `session:welcome`. */
  private welcome(member: Member, pairing: Pairing): void {
    const accepted = member.accepted!;
    const welcome: AppSessionWelcomeMessage = {
      type: "session:welcome",
      id: accepted.id,
      payload: {
        protocolVersion: accepted.protocolVersion,
        sessionId: pairing.id,
        joinCode: pairing.joinCode,
        bindingToken: this._tokens.create(pairing.bindingId),
      },
    };
    member.socket.send(JSON.stringify(welcome));
  }

  /**
   * Ends `pairing` for a new claimant of `role` and returns the pairing that
   * succeeds it under the same join code, with a new session id and binding
   * id. The member holding `role` is displaced. The other member, if bound,
   * moves into the successor on its open connection. Sends no welcome; the
   * caller welcomes the successor's members.
   */
  private replace(pairing: Pairing, role: string): Pairing {
    this._logger.info({ kind: pairing.kind, pairingId: pairing.id }, "session ended by a new claimant");
    clearTimeout(pairing.expiry);
    this._pairings.delete(pairing);
    const successor = this.open(pairing.kind, pairing.joinCode);
    for (const member of pairing.members.values()) {
      if (member.role === role) {
        this.displace(member);
      } else {
        successor.members.set(member.role, member);
        member.pairing = successor;
      }
    }
    return successor;
  }

  /**
   * Tells `member` that another connection of its role has taken its place,
   * with `session:error` carrying `SESSION_REPLACED`, then removes it from its
   * pairing and closes its connection.
   */
  private displace(member: Member): void {
    const replaced: SessionErrorMessage = {
      type: "session:error",
      payload: {
        message: "Another connection of this role has taken this one's place.",
        code: BridgeSessionErrorCode.SESSION_REPLACED,
      },
    };
    member.socket.send(JSON.stringify(replaced));
    member.pairing?.members.delete(member.role);
    member.pairing = undefined;
    member.socket.close();
  }

  private leave(member: Member): void {
    const { kind, role, pairing } = member;
    this._logger.info({ kind, role, pairingId: pairing?.id }, "connection closed");
    if (pairing === undefined) return;
    member.pairing = undefined;
    pairing.members.delete(role);
    if (pairing.members.size > 0) {
      const away: SessionCounterpartAwayMessage = { type: "session:counterpartAway" };
      for (const remaining of pairing.members.values()) {
        remaining.socket.send(JSON.stringify(away));
      }
      return;
    }
    pairing.expiry = setTimeout(() => {
      this._logger.info({ kind, pairingId: pairing.id }, "session ended after lingering with no member");
      this._pairings.delete(pairing);
    }, this._lingerMs);
    pairing.expiry.unref();
  }

  private find(kind: string, predicate: (pairing: Pairing) => boolean): Pairing | undefined {
    for (const pairing of this._pairings) {
      if (pairing.kind === kind && predicate(pairing)) return pairing;
    }
    return undefined;
  }

  /**
   * Opens an empty pairing of `kind` under `bindingId`, which no pairing of
   * `kind` holds, with a new session id and a generated join code.
   */
  private adopt(kind: string, bindingId: string): Pairing {
    const pairing = this.open(kind, undefined, bindingId);
    this._logger.info({ kind, pairingId: pairing.id }, "session rebuilt from a binding token");
    return pairing;
  }

  /**
   * Opens an empty pairing of `kind` under `bindingId`, a new binding id when
   * omitted. The caller guarantees that no pairing of `kind` holds `joinCode`
   * or `bindingId`; an absent join code is generated.
   */
  private open(kind: string, joinCode: string | undefined, bindingId: string = randomUUID()): Pairing {
    const pairing: Pairing = {
      id: randomUUID(),
      kind,
      joinCode: joinCode ?? this.unusedJoinCode(kind),
      bindingId,
      members: new Map(),
      expiry: undefined,
    };
    this._pairings.add(pairing);
    return pairing;
  }

  private unusedJoinCode(kind: string): string {
    for (;;) {
      const joinCode = generateTriplet();
      if (this.find(kind, (pairing) => pairing.joinCode === joinCode) === undefined) return joinCode;
    }
  }
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
  const { type, id, payload } = value as Record<string, unknown>;
  if (typeof type !== "string") return undefined;
  return { type, id: typeof id === "string" ? id : undefined, payload };
}

/** The hello payload `payload`, or `undefined` when it is malformed or declares an unsupported protocol version. */
function readHello(payload: unknown): SessionHelloPayload | undefined {
  const parsed = sessionHelloPayloadSchema.safeParse(payload);
  if (!parsed.success) return undefined;
  const { protocolVersion } = parsed.data;
  return protocolVersion >= 1 && protocolVersion <= PROTOCOL_VERSION ? parsed.data : undefined;
}
