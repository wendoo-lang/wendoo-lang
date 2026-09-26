import assert from "node:assert/strict";
import {
  type AppSessionWelcomePayload,
  BridgeSessionErrorCode,
  PROTOCOL_VERSION,
  type SessionHelloPayload,
  type WsMessage,
} from "@wendoo/bridge-protocol";
import { WAIT_MS } from "./wait.js";

/** The `id` every {@link ScriptedPeer.hello} carries, which the relay echoes in its welcome and version rejection. */
const HELLO_ID = "hello";

/** The shape of a join code the relay generates: three words of lowercase letters joined by `-`. */
const JOIN_CODE_SHAPE = /^[a-z]+-[a-z]+-[a-z]+$/;

/** A WebSocket endpoint driven by hand, recording every frame it receives as text. */
export class ScriptedPeer {
  private readonly _inbox: string[] = [];
  private readonly _waiters: ((frame: string) => void)[] = [];
  private readonly _socket: WebSocket;
  private _pingCount = 0;
  /** Resolves when the connection has closed, from either side. */
  readonly closed: Promise<void>;

  private constructor(socket: WebSocket) {
    this._socket = socket;
    socket.addEventListener("message", (event) => {
      const frame = String(event.data);
      const waiter = this._waiters.shift();
      if (waiter) waiter(frame);
      else this._inbox.push(frame);
    });
    this.closed = new Promise((resolve) => {
      socket.addEventListener("close", () => {
        resolve();
      });
    });
  }

  /** Opens a connection to `/{path}` on the relay listening on loopback `port`. Rejects if it cannot connect. */
  static open(port: number, path: string): Promise<ScriptedPeer> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/${path}`);
    const peer = new ScriptedPeer(socket);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve(peer);
      });
      socket.addEventListener("error", () => {
        reject(new Error(`could not connect to /${path}`));
      });
    });
  }

  /** Sends `text` as one text frame, unchanged. */
  sendText(text: string): void {
    this._socket.send(text);
  }

  /** Sends `message` serialized as JSON. */
  send(message: object): void {
    this.sendText(JSON.stringify(message));
  }

  /** Sends a binary frame. */
  sendBinary(bytes: Uint8Array): void {
    this._socket.send(bytes);
  }

  /** The next frame received, as text. Rejects when none arrives within {@link WAIT_MS}. */
  next(): Promise<string> {
    const queued = this._inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.splice(this._waiters.indexOf(waiter), 1);
        reject(new Error("no frame arrived"));
      }, WAIT_MS);
      const waiter = (frame: string) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this._waiters.push(waiter);
    });
  }

  /** The next frame received, parsed. */
  async nextMessage(): Promise<WsMessage> {
    return JSON.parse(await this.next()) as WsMessage;
  }

  /**
   * Sends `session:hello` with `fields` merged over the current protocol
   * version and returns the relay's first answer. Pass any combination of
   * credentials -- `joinCode`, `bindingToken` -- or none, and
   * `protocolVersion` to declare a version other than the current one.
   */
  async hello(fields: Partial<SessionHelloPayload> = {}): Promise<WsMessage> {
    this.send({ type: "session:hello", id: HELLO_ID, payload: { protocolVersion: PROTOCOL_VERSION, ...fields } });
    return this.nextMessage();
  }

  /**
   * Round-trips a `control:ping`, asserting the next frame is its pong. Every
   * frame this peer sent earlier has been processed by the relay once this
   * resolves, and every frame the relay sent it earlier has been received.
   */
  async ping(): Promise<void> {
    const id = `ping-${++this._pingCount}`;
    this.send({ type: "control:ping", id });
    assert.deepEqual(await this.nextMessage(), { type: "control:pong", id });
  }

  /** Asserts that no frame has arrived that has not been consumed. */
  assertNothingReceived(): void {
    assert.deepEqual(this._inbox, []);
  }

  /** Closes the connection and resolves once it has closed. */
  close(): Promise<void> {
    this._socket.close();
    return this.closed;
  }
}

/** The payload of a `session:welcome` answering a {@link ScriptedPeer.hello}. */
export type Welcome = Required<AppSessionWelcomePayload>;

/** Asserts that `message` is a `session:joinCode` carrying a join code of the generated shape, and returns the code. */
export function assertJoinCode(message: WsMessage): string {
  assert.equal(message.type, "session:joinCode");
  const { joinCode } = message.payload as { joinCode: string };
  assert.match(joinCode, JOIN_CODE_SHAPE);
  return joinCode;
}

/**
 * Asserts that `message` is a `session:welcome` answering a
 * {@link ScriptedPeer.hello} that declared the current protocol version, and
 * returns its payload. Holds for a first welcome and for every repeated one.
 */
export function assertWelcome(message: WsMessage): Welcome {
  assert.equal(message.type, "session:welcome");
  assert.equal(message.id, HELLO_ID);
  const payload = message.payload as Welcome;
  assert.equal(payload.protocolVersion, PROTOCOL_VERSION);
  assert.equal(typeof payload.sessionId, "string");
  assert.match(payload.joinCode, JOIN_CODE_SHAPE);
  assert.equal(typeof payload.bindingToken, "string");
  return payload;
}

/** Asserts that `message` is the payload-less `session:counterpartAway` status signal. */
export function assertCounterpartAway(message: WsMessage): void {
  assert.deepEqual(message, { type: "session:counterpartAway" });
}

/**
 * Asserts that `message` is a `session:error` carrying `code`, or carrying no
 * code when `code` is `undefined`.
 */
export function assertSessionError(message: WsMessage, code: BridgeSessionErrorCode | undefined): void {
  assert.equal(message.type, "session:error");
  assert.equal((message.payload as { code?: string }).code, code);
}

/** Asserts that `message` is the `session:error` rejecting a {@link ScriptedPeer.hello} for its protocol version. */
export function assertVersionRejected(message: WsMessage): void {
  assertSessionError(message, BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH);
  assert.equal(message.id, HELLO_ID);
}
