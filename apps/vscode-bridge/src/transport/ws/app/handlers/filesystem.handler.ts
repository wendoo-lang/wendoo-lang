import type { FilesystemChangeMessage, FilesystemSyncMessage } from "@wendoo/bridge-protocol";
import { filesystemNotificationSchema, filesystemSyncPayloadSchema } from "@wendoo/bridge-protocol";
import type { WsHandler, WsHandlerMap } from "#transport/ws/types.js";

const filesystemChange: WsHandler = (frame, logger) => {
  const parsed = filesystemNotificationSchema.safeParse(frame.payload);
  if (!parsed.success) {
    logger.warn({ err: parsed.error }, "invalid filesystem:change payload");
    return;
  }
  const msg: FilesystemChangeMessage = {
    type: "filesystem:change",
    id: frame.id,
    payload: parsed.data,
    seq: frame.seq,
  };
  frame.forward(JSON.stringify(msg));
};

const filesystemSync: WsHandler = (frame, logger) => {
  const parsed = filesystemSyncPayloadSchema.safeParse(frame.payload);
  if (!parsed.success) {
    logger.warn({ err: parsed.error }, "invalid filesystem:sync payload");
    return;
  }
  const msg: FilesystemSyncMessage = { type: "filesystem:sync", id: frame.id, payload: parsed.data, seq: frame.seq };
  const entryCount = parsed.data.entries?.length ?? 0;
  if (frame.forward(JSON.stringify(msg))) {
    logger.info({ id: frame.id, entryCount }, "relayed a filesystem:sync snapshot to the extension");
  } else {
    logger.info({ id: frame.id }, "dropped a filesystem:sync snapshot with no extension connected");
  }
};

/** Forwards an app's filesystem changes and snapshots to its extension, dropping any whose payload is invalid. */
export const filesystemHandlers: WsHandlerMap = {
  "filesystem:change": filesystemChange,
  "filesystem:sync": filesystemSync,
};
