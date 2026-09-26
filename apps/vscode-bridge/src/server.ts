import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { GeneralErrorMessage } from "@wendoo/bridge-protocol";
import { Relay, type RelayConnection, type RelayTimings, TokenBucketMap } from "@wendoo/bridge-session";
import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import type { Logger } from "pino";
import { APP_ROLE, EXTENSION_ROLE, SESSION_KIND } from "#session-kind.js";
import { getClientIp } from "#transport/http/client-ip.js";
import { errorHandler } from "#transport/http/middleware/error-handler.js";
import { requestLogger } from "#transport/http/middleware/request-logger.js";
import { health } from "#transport/http/routes/health.js";
import { createFrameHandler } from "#transport/ws/frame-router.js";

/** Longest text frame the service accepts, in UTF-16 code units. */
const MAX_MESSAGE_BYTES = 1_048_576;

/**
 * Options for {@link startBridgeServer}. The session engine timings default
 * to the engine's own.
 */
export interface BridgeServerOptions extends RelayTimings {
  /** Host name or address to listen on. Listens on every interface when omitted. */
  host?: string;
  /** TCP port to listen on; `0` picks a free one. */
  port: number;
  /** Secret that signs the binding tokens the service issues. */
  bindingSecret: string;
  /** Destination of the service's log records. */
  logger: Logger;
}

/** The session engine's inspection and administration operations, as a running bridge server exposes them. */
export type BridgeAdmin = Pick<Relay, "sessions" | "endSession" | "disconnectMember">;

/** A running bridge server. */
export interface BridgeServer {
  /** TCP port the server listens on. */
  readonly port: number;
  /** Lists and ends the server's sessions and disconnects their members. */
  readonly admin: BridgeAdmin;
  /** Closes every connection, stops listening, and resolves once the server has shut down. */
  close(): Promise<void>;
}

/** Sends `data` on `ws`. Logs a failed send to `logger`; never throws. */
function safeSend(ws: WSContext, data: string, logger: Logger): void {
  try {
    ws.send(data);
  } catch (err) {
    logger.warn({ err }, "failed to send WebSocket message");
  }
}

/** The `error` message carrying `message`, as text. */
function errorFrame(message: string): string {
  const err: GeneralErrorMessage = { type: "error", payload: { message } };
  return JSON.stringify(err);
}

/**
 * Starts the bridge server. A Wendoo app connects with a WebSocket to `/app`
 * and a VS Code extension to `/extension`; each connection joins the session
 * engine's `vscode` session kind in the role its route names, and the
 * service's frame handler routes the messages the two members exchange.
 * `GET /health` reports the service's package and uptime.
 *
 * Each client address may open a burst of 10 connections, then one every two
 * seconds, and request `/health` 30 times in a burst, then twice a second; an
 * excess request is answered with status 429. A binary frame or a text frame
 * over 1 MiB is answered with an `error` message and otherwise ignored.
 * Resolves once the server is listening.
 */
export function startBridgeServer(options: BridgeServerOptions): Promise<BridgeServer> {
  const { host, port, ...relayOptions } = options;
  const { logger } = relayOptions;
  const relay = new Relay({ ...relayOptions, frameHandler: createFrameHandler(logger) });
  const httpThrottle = new TokenBucketMap(30, 2);
  const connectionThrottle = new TokenBucketMap(10, 0.5);

  const app = new Hono();
  const { upgradeWebSocket, injectWebSocket, wss } = createNodeWebSocket({ app });

  app.use("*", requestLogger(logger));

  app.use("/health", async (c, next) => {
    if (!httpThrottle.consume(getClientIp(c))) {
      return c.json({ error: "rate limit exceeded" }, 429);
    }
    await next();
  });
  app.route("/", health);

  for (const role of [APP_ROLE, EXTENSION_ROLE]) {
    app.use(`/${role}`, async (c, next) => {
      if (!connectionThrottle.consume(getClientIp(c))) {
        return c.json({ error: "too many connections" }, 429);
      }
      await next();
    });
    app.get(
      `/${role}`,
      upgradeWebSocket(() => {
        let connection: RelayConnection | undefined;
        return {
          onOpen(_event, ws) {
            connection = relay.connect(SESSION_KIND, role, {
              send: (data) => {
                safeSend(ws, data, logger);
              },
              close: () => {
                ws.close();
              },
            });
          },
          onMessage(event, ws) {
            if (typeof event.data !== "string") {
              safeSend(ws, errorFrame("binary messages not supported"), logger);
              return;
            }
            if (event.data.length > MAX_MESSAGE_BYTES) {
              safeSend(ws, errorFrame("message too large"), logger);
              return;
            }
            connection?.receive(event.data);
          },
          onClose() {
            connection?.closed();
          },
          onError(event) {
            logger.error({ role, err: event }, "connection error");
          },
        };
      })
    );
  }

  app.onError(errorHandler(logger));

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      resolve({
        port: info.port,
        admin: relay,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            httpThrottle.dispose();
            connectionThrottle.dispose();
            for (const client of wss.clients) {
              client.close(1001, "server shutting down");
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
