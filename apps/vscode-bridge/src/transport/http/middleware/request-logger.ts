import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";

/** Returns middleware logging each request to `logger` as it arrives and again, with its status and duration, once answered. */
export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    const { method, path } = c.req;

    logger.info({ method, path }, "incoming request");

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;

    logger.info({ method, path, status, duration }, "request completed");
  };
}
