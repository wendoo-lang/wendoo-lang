import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import type { Logger } from "pino";
import { Relay, type RelayConnection } from "../relay.js";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
  /** Host name or address to listen on. */
  host: string;
  /** TCP port to listen on; `0` picks a free one. */
  port: number;
  /** Secret that signs the binding tokens the relay issues. */
  bindingSecret: string;
  /** Destination of the server's log records. */
  logger: Logger;
  /** How long a session with no bound member lasts before it ends, in milliseconds. Defaults to the relay's own. */
  lingerMs?: number;
}

/** A running relay server. */
export interface RelayServer {
  /** TCP port the server listens on. */
  readonly port: number;
  /** Closes every connection, stops listening, and resolves once the server has shut down. */
  close(): Promise<void>;
}

/**
 * Starts a relay server. An endpoint connects with a WebSocket to
 * `/{kind}/{role}`, naming the session kind it speaks and its role in it; see
 * {@link Relay} for what the relay does with the connection. Binary frames
 * are dropped. Resolves once the server is listening.
 */
export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const { logger } = options;
  const relay = new Relay({ bindingSecret: options.bindingSecret, logger, lingerMs: options.lingerMs });
  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });

  app.get(
    "/:kind/:role",
    upgradeWebSocket((c) => {
      const { kind, role } = c.req.param<"/:kind/:role">();
      let connection: RelayConnection | undefined;
      return {
        onOpen(_event, ws) {
          connection = relay.connect(kind, role, {
            send: (data) => {
              ws.send(data);
            },
            close: () => {
              ws.close();
            },
          });
        },
        onMessage(event) {
          if (typeof event.data === "string") {
            connection?.receive(event.data);
          } else {
            logger.warn({ kind, role }, "dropped a binary frame");
          }
        },
        onClose() {
          connection?.closed();
        },
        onError(event) {
          logger.error({ kind, role, err: event }, "connection error");
        },
      };
    })
  );

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, (info) => {
      resolve({
        port: info.port,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            for (const client of wss.clients) {
              client.close(1001);
            }
            server.close((error) => {
              relay.dispose();
              if (error) rejectClose(error);
              else resolveClose();
            });
          }),
      });
    });
    injectWebSocket(server);
  });
}
