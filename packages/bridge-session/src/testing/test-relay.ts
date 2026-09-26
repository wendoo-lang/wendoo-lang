import { randomBytes } from "node:crypto";
import { pino } from "pino";
import type { RelayOptions } from "../relay.js";
import { assertJoinCode, assertWelcome, ScriptedPeer, type Welcome } from "./scripted-peer.js";
import { type RelayServer, startRelayServer } from "./server.js";
import { delay } from "./wait.js";

/** Options for {@link startTestRelay}. */
export interface TestRelayOptions {
  /**
   * Secret that signs the binding tokens the relay issues, kept across
   * {@link TestRelay.restart}. When omitted, every start and restart uses a
   * new random secret, so tokens issued before a restart stop verifying.
   */
  bindingSecret?: RelayOptions["bindingSecret"];
  /** How long a session with no bound member lasts before it ends, in milliseconds. Defaults to the relay's own. */
  lingerMs?: RelayOptions["lingerMs"];
}

/** Two scripted peers of one kind, paired by {@link TestRelay.pair}, with the welcome each received. */
export interface ScriptedPair {
  first: ScriptedPeer;
  second: ScriptedPeer;
  firstWelcome: Welcome;
  secondWelcome: Welcome;
}

/** A relay server running in this process on a loopback port, with no log output. */
export interface TestRelay {
  /** TCP port the relay listens on. Unchanged by {@link restart}. */
  readonly port: number;
  /** The relay's address as a bare loopback host and port, for a bridge client's bridge URL. */
  readonly address: string;
  /**
   * Opens a scripted peer connected to `/{path}`, where `path` is
   * `{kind}/{role}`. The peer is closed by {@link closePeers}.
   */
  connect(path: string): Promise<ScriptedPeer>;
  /**
   * Connects a peer at `firstPath` with no credentials, then one at
   * `secondPath` presenting the join code the first is answered with, and
   * resolves once both are welcomed. The two paths name the same kind and
   * different roles.
   */
  pair(firstPath: string, secondPath: string): Promise<ScriptedPair>;
  /**
   * Resolves after a round trip through the relay on a connection of its
   * own, giving the relay time to handle the closes of connections whose
   * close has already completed on the client side.
   */
  settle(): Promise<void>;
  /**
   * Resolves once every session the relay was lingering when this was called
   * has ended, by waiting out the linger time. Rejects when the relay was
   * started without `lingerMs`.
   */
  expireLinger(): Promise<void>;
  /**
   * Closes every connection and stops the relay, then starts a new relay,
   * holding no sessions, on the same port. Clients that reconnect reach the
   * new relay.
   */
  restart(): Promise<void>;
  /** Closes every scripted peer {@link connect} or {@link pair} opened. */
  closePeers(): Promise<void>;
  /** Closes every scripted peer and stops the relay. */
  close(): Promise<void>;
}

/** Starts a {@link TestRelay}. Resolves once it is listening. */
export async function startTestRelay(options: TestRelayOptions = {}): Promise<TestRelay> {
  const { lingerMs } = options;
  const logger = pino({ level: "silent" });
  const start = (port: number) =>
    startRelayServer({
      host: "127.0.0.1",
      port,
      bindingSecret: options.bindingSecret ?? randomBytes(32).toString("hex"),
      logger,
      lingerMs,
    });
  let server: RelayServer = await start(0);
  const { port } = server;
  const peers: ScriptedPeer[] = [];

  const connect = async (path: string): Promise<ScriptedPeer> => {
    const peer = await ScriptedPeer.open(port, path);
    peers.push(peer);
    return peer;
  };

  const settle = async (): Promise<void> => {
    const probe = await ScriptedPeer.open(port, "probe/witness");
    await probe.ping();
    await probe.close();
  };

  const closePeers = async (): Promise<void> => {
    await Promise.all(peers.splice(0).map((peer) => peer.close()));
  };

  return {
    port,
    address: `127.0.0.1:${port}`,
    connect,
    async pair(firstPath, secondPath) {
      const first = await connect(firstPath);
      const joinCode = assertJoinCode(await first.hello());
      const second = await connect(secondPath);
      assertJoinCode(await second.hello({ joinCode }));
      const secondWelcome = assertWelcome(await second.nextMessage());
      const firstWelcome = assertWelcome(await first.nextMessage());
      return { first, second, firstWelcome, secondWelcome };
    },
    settle,
    async expireLinger() {
      if (lingerMs === undefined) throw new Error("expireLinger needs a relay started with lingerMs");
      await settle();
      await delay(lingerMs);
      await settle();
    },
    async restart() {
      await server.close();
      server = await start(port);
    },
    closePeers,
    async close() {
      await closePeers();
      await server.close();
    },
  };
}
