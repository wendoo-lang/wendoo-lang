import type { GeneralErrorMessage } from "@wendoo/bridge-protocol";
import type { FrameHandler } from "@wendoo/bridge-session";
import type { Logger } from "pino";
import { APP_ROLE, EXTENSION_ROLE } from "#session-kind.js";
import type { WsHandlerMap } from "#transport/ws/types.js";
import { compileHandlers } from "./app/handlers/compile.handler.js";
import { filesystemHandlers } from "./app/handlers/filesystem.handler.js";
import { vfsHandlers } from "./extension/handlers/vfs.handler.js";

/** The handlers for the messages each role's connection sends, by role. */
const handlersByRole: Record<string, WsHandlerMap> = {
  [APP_ROLE]: { ...compileHandlers, ...filesystemHandlers },
  [EXTENSION_ROLE]: { ...vfsHandlers },
};

/**
 * Returns the service's frame handler for the session engine: it settles each
 * message through the handler its sender's role registers for its type, and
 * answers a type the role registers no handler for, or a handler that throws,
 * with an `error` message.
 */
export function createFrameHandler(logger: Logger): FrameHandler {
  return (frame) => {
    const handlers = handlersByRole[frame.role] ?? {};
    const handler = Object.hasOwn(handlers, frame.type) ? handlers[frame.type] : undefined;
    if (!handler) {
      logger.warn({ role: frame.role, type: frame.type }, "unknown message type");
      const err: GeneralErrorMessage = { type: "error", payload: { message: `unknown type: ${frame.type}` } };
      frame.reply(JSON.stringify(err));
      return;
    }
    try {
      handler(frame, logger);
    } catch (err) {
      logger.error({ err, role: frame.role, type: frame.type }, "handler error");
      const errMsg: GeneralErrorMessage = { type: "error", id: frame.id, payload: { message: "internal error" } };
      frame.reply(JSON.stringify(errMsg));
    }
  };
}
