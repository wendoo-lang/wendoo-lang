import type { FileSystemNotification, FilesystemChangeMessage, GeneralErrorMessage } from "@wendoo/bridge-protocol";
import type { WSContext } from "hono/ws";
import { logger } from "#core/logging/logger.js";
import { takePendingRequest } from "#core/pending-requests.js";
import { getExtensionsByAppSessionId } from "#core/session-registry.js";
import { safeSend } from "#transport/ws/safe-send.js";
import type { WsHandlerMap } from "#transport/ws/types.js";
import { wsMessageSchema } from "#transport/ws/types.js";
import { compileHandlers } from "./handlers/compile.handler.js";
import { controlHandlers } from "./handlers/control.handler.js";
import { filesystemHandlers } from "./handlers/filesystem.handler.js";
import { sessionHandlers } from "./handlers/session.handler.js";

const handlers: WsHandlerMap = {
  ...sessionHandlers,
  ...controlHandlers,
  ...filesystemHandlers,
  ...compileHandlers,
};

function broadcastToOtherExtensions(appSessionId: string, senderWs: WSContext, payload: FileSystemNotification): void {
  const broadcastPayload = { ...payload };
  if ("expectedEtag" in broadcastPayload) {
    delete (broadcastPayload as { expectedEtag?: string }).expectedEtag;
  }
  const msg: FilesystemChangeMessage = { type: "filesystem:change", payload: broadcastPayload };
  const raw = JSON.stringify(msg);
  for (const ext of getExtensionsByAppSessionId(appSessionId)) {
    if (ext.ws !== senderWs) {
      safeSend(ext.ws, raw);
    }
  }
}

export function routeAppMessage(ws: WSContext, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const err: GeneralErrorMessage = { type: "error", payload: { message: "invalid JSON" } };
    safeSend(ws, JSON.stringify(err));
    return;
  }

  const result = wsMessageSchema.safeParse(parsed);
  if (!result.success) {
    const err: GeneralErrorMessage = { type: "error", payload: { message: "invalid message envelope" } };
    safeSend(ws, JSON.stringify(err));
    return;
  }

  const msg = result.data;

  if (msg.id) {
    const pending = takePendingRequest(msg.id);
    if (pending) {
      safeSend(pending.extensionWs, raw);
      if (msg.type !== "session:error") {
        broadcastToOtherExtensions(pending.appSessionId, pending.extensionWs, pending.payload);
      }
      return;
    }
  }

  const handler = handlers[msg.type];
  if (!handler) {
    logger.warn({ type: msg.type }, "unknown app message type");
    const err: GeneralErrorMessage = { type: "error", payload: { message: `unknown type: ${msg.type}` } };
    safeSend(ws, JSON.stringify(err));
    return;
  }

  try {
    handler(ws, msg.payload, msg.id, msg.seq);
  } catch (err) {
    logger.error({ err, type: msg.type }, "handler error");
    const errMsg: GeneralErrorMessage = { type: "error", id: msg.id, payload: { message: "internal error" } };
    safeSend(ws, JSON.stringify(errMsg));
  }
}
