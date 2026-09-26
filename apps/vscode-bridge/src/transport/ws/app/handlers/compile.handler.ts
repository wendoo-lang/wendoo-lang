import type { CompileDiagnosticsMessage, CompileStatusMessage } from "@wendoo/bridge-protocol";
import { compileDiagnosticsPayloadSchema, compileStatusPayloadSchema } from "@wendoo/bridge-protocol";
import type { WsHandler, WsHandlerMap } from "#transport/ws/types.js";

const compileDiagnostics: WsHandler = (frame, logger) => {
  const parsed = compileDiagnosticsPayloadSchema.safeParse(frame.payload);
  if (!parsed.success) {
    logger.warn({ err: parsed.error }, "invalid compile:diagnostics payload");
    return;
  }
  const msg: CompileDiagnosticsMessage = { type: "compile:diagnostics", id: frame.id, payload: parsed.data };
  frame.forward(JSON.stringify(msg));
};

const compileStatus: WsHandler = (frame, logger) => {
  const parsed = compileStatusPayloadSchema.safeParse(frame.payload);
  if (!parsed.success) {
    logger.warn({ err: parsed.error }, "invalid compile:status payload");
    return;
  }
  const msg: CompileStatusMessage = { type: "compile:status", id: frame.id, payload: parsed.data };
  frame.forward(JSON.stringify(msg));
};

/** Forwards an app's compile results to its extension, dropping any whose payload is invalid. */
export const compileHandlers: WsHandlerMap = {
  "compile:diagnostics": compileDiagnostics,
  "compile:status": compileStatus,
};
