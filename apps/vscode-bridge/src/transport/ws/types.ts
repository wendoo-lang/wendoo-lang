import type { RelayFrame } from "@wendoo/bridge-session";
import type { Logger } from "pino";

/**
 * Settles one message of the type it is registered for: forwards it to the
 * sender's peer, replies to the sender, or drops it, logging to `logger`.
 */
export type WsHandler = (frame: RelayFrame, logger: Logger) => void;

/** Handlers keyed by the message type each settles. */
export type WsHandlerMap = Record<string, WsHandler>;
