import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Logger } from "pino";

/**
 * Returns the error handler answering a request whose handling threw: an
 * `HTTPException` with its own status and message, anything else with 500.
 * Logs each to `logger`.
 */
export function errorHandler(logger: Logger): ErrorHandler {
  return (err, c) => {
    if (err instanceof HTTPException) {
      logger.warn({ status: err.status, message: err.message }, "HTTP exception");
      return c.json({ error: err.message }, err.status);
    }

    logger.error({ err }, "unhandled error");
    return c.json({ error: "Internal Server Error" }, 500);
  };
}
