import type { FilesystemChangeMessage, FilesystemSyncMessage, SessionErrorMessage } from "@wendoo/bridge-protocol";
import { filesystemNotificationSchema } from "@wendoo/bridge-protocol";
import type { RelayFrame } from "@wendoo/bridge-session";
import type { WsHandler, WsHandlerMap } from "#transport/ws/types.js";

/** Answers `frame` with a `session:error` carrying its id and `message`; does nothing when `frame` has no id. */
function sendChangeError(frame: RelayFrame, message: string): void {
  if (!frame.id) return;
  const err: SessionErrorMessage = { type: "session:error", id: frame.id, payload: { message } };
  frame.reply(JSON.stringify(err));
}

const filesystemChange: WsHandler = (frame, logger) => {
  const parsed = filesystemNotificationSchema.safeParse(frame.payload);
  if (!parsed.success) {
    logger.warn({ err: parsed.error }, "invalid filesystem:change payload");
    sendChangeError(frame, "invalid payload");
    return;
  }
  const msg: FilesystemChangeMessage = {
    type: "filesystem:change",
    id: frame.id,
    payload: parsed.data,
    seq: frame.seq,
  };
  if (!frame.forward(JSON.stringify(msg))) {
    logger.warn({ id: frame.id }, "filesystem:change from an extension with no app connected");
    sendChangeError(frame, "no app connected");
  }
};

const filesystemSync: WsHandler = (frame, logger) => {
  const msg: FilesystemSyncMessage = { type: "filesystem:sync", id: frame.id, seq: frame.seq };
  if (frame.forward(JSON.stringify(msg))) {
    logger.info({ id: frame.id }, "relayed a filesystem:sync request to the app");
  } else {
    logger.warn({ id: frame.id }, "filesystem:sync from an extension with no app connected");
    sendChangeError(frame, "no app connected");
  }
};

/**
 * Forwards an extension's filesystem changes and snapshot requests to its app.
 * A change with an invalid payload, and either message while no app is
 * connected, is answered with a `session:error` carrying the message's id
 * instead.
 */
export const vfsHandlers: WsHandlerMap = {
  "filesystem:change": filesystemChange,
  "filesystem:sync": filesystemSync,
};
