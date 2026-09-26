import { randomBytes } from "node:crypto";
import { pino } from "pino";
import type { RelayOptions, RelayTimings } from "../relay.js";
import { assertJoinCode, assertWelcome, ScriptedPeer, type Welcome } from "./scripted-peer.js";
import { type RelayServer, type RelayServerStarter, startRelayServer } from "./server.js";
import { delay } from "./wait.js";

/** Options for {@link startTestRelay}. The timings default to the relay's own. */
export interface TestRelayOptions extends RelayTimings {
  /**
   * Secret that signs the binding tokens the relay issues, kept across
   * {@link TestRelay.restart}. When omitted, every start and restart uses a
   * new random secret, so tokens issued before a restart stop verifying.
   */
  bindingSecret?: RelayOptions["bindingSecret"];
  /**
   * Starts the server the test relay runs, at every start and restart. When
   * omitted, a server accepting an endpoint at `/{kind}/{role}` runs.
   */
  server?: RelayServerStarter;
  /**
   * Path, without its leading `/`, of the connection {@link TestRelay.settle}
   * opens. The server must accept a connection there. Defaults to
   * `probe/witness`.
   */
  probePath?: string;
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
   * Opens a scripted peer connected to `/{path}`, where `path` names a route
   * the server accepts an endpoint at: `{kind}/{role}` on the default server.
   * The peer is closed by {@link closePeers}.
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
   * own, opened at the `probePath` the relay was started with, giving the
   * relay time to handle the closes of connections whose close has already
   * completed on the client side.
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
  const { bindingSecret, server: startServer = startRelayServer, probePath = "probe/witness", ...timings } = options;
  const { lingerMs } = timings;
  const logger = pino({ level: "silent" });
  const start = (port: number) =>
    startServer({
      host: "127.0.0.1",
      port,
      bindingSecret: bindingSecret ?? randomBytes(32).toString("hex"),
      logger,
      ...timings,
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
    const probe = await ScriptedPeer.open(port, probePath);
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
