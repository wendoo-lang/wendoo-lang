import { env } from "#config/env.js";
import { logger } from "#core/logging/logger.js";
import { startRepl } from "#repl.js";
import { startBridgeServer } from "#server.js";

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled rejection");
  process.exit(1);
});

const server = await startBridgeServer({ port: env.PORT, bindingSecret: env.BRIDGE_BINDING_SECRET, logger });
logger.info({ port: server.port }, "server started");

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "shutting down");
  server.close().then(
    () => {
      logger.info("server closed");
      process.exit(0);
    },
    (err: unknown) => {
      logger.error({ err }, "shutdown failed");
      process.exit(1);
    }
  );

  setTimeout(() => {
    logger.error("forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (env.NODE_ENV === "development" && process.stdin.isTTY) {
  startRepl({
    admin: server.admin,
    onExit: () => {
      logger.info("repl exit requested");
      shutdown("SIGTERM");
    },
  });
}
