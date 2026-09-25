import type {
  ExtensionAppStatusMessage,
  ExtensionSessionWelcomeMessage,
  SessionErrorMessage,
} from "@wendoo/bridge-protocol";
import { BridgeSessionErrorCode, PROTOCOL_VERSION, sessionHelloPayloadSchema } from "@wendoo/bridge-protocol";
import { createBindingToken } from "#core/binding-token.js";
import { logger } from "#core/logging/logger.js";
import {
  discardExtensionSession,
  getAppSessionById,
  getExtensionSession,
  getSessionCount,
  reclaimExtensionSession,
  registerExtensionSession,
} from "#core/session-registry.js";
import { safeSend } from "#transport/ws/safe-send.js";
import type { WsHandler, WsHandlerMap } from "#transport/ws/types.js";

const hello: WsHandler = (ws, payload, id) => {
  const existing = getExtensionSession(ws);
  if (existing) {
    const err: SessionErrorMessage = {
      type: "session:error",
      id,
      payload: { message: "session already established" },
    };
    safeSend(ws, JSON.stringify(err));
    return;
  }

  const parsed = sessionHelloPayloadSchema.optional().safeParse(payload);
  if (!parsed.success) {
    const err: SessionErrorMessage = {
      type: "session:error",
      id,
      payload: { message: "invalid hello payload" },
    };
    safeSend(ws, JSON.stringify(err));
    return;
  }

  const helloPayload = parsed.data;

  const clientVersion = helloPayload?.protocolVersion;
  if (clientVersion === undefined || clientVersion < 1 || clientVersion > PROTOCOL_VERSION) {
    logger.warn({ clientVersion, serverVersion: PROTOCOL_VERSION }, "extension protocol version mismatch");
    const err: SessionErrorMessage = {
      type: "session:error",
      id,
      payload: {
        message: `unsupported protocol version ${clientVersion}; server supports 1..${PROTOCOL_VERSION}`,
        code: BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH,
      },
    };
    safeSend(ws, JSON.stringify(err));
    try {
      ws.close(1000, "unsupported protocol version");
    } catch {}
    return;
  }

  const session =
    (helloPayload?.sessionId && reclaimExtensionSession(helloPayload.sessionId, ws)) ||
    registerExtensionSession(ws, helloPayload?.joinCode, helloPayload?.bindingToken);
  const counts = getSessionCount();

  logger.info(
    { sessionId: session.id, reclaimed: session !== undefined && !!helloPayload?.sessionId, ...counts },
    "extension hello accepted"
  );

  const welcome: ExtensionSessionWelcomeMessage = {
    type: "session:welcome",
    id,
    payload: { protocolVersion: clientVersion, sessionId: session.id },
  };
  safeSend(ws, JSON.stringify(welcome));

  if (session.pendingJoinCode || session.pendingBindingId) {
    return;
  }

  const bound = session.appSessionId !== undefined;
  const appStatusPayload: ExtensionAppStatusMessage["payload"] = { bound };
  if (bound) {
    const app = getAppSessionById(session.appSessionId!);
    if (app) {
      appStatusPayload.clientConnected = true;
      appStatusPayload.bindingToken = createBindingToken(app.bindingId);
    }
  }
  const appStatus: ExtensionAppStatusMessage = {
    type: "session:appStatus",
    payload: appStatusPayload,
  };
  safeSend(ws, JSON.stringify(appStatus));
};

const goodbye: WsHandler = (ws) => {
  const session = discardExtensionSession(ws);
  if (session) {
    logger.info({ sessionId: session.id }, "extension session goodbye");
  }
};

export const sessionHandlers: WsHandlerMap = {
  "session:hello": hello,
  "session:goodbye": goodbye,
};
