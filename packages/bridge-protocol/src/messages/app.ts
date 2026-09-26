import type { CompileDiagnosticsMessage, CompileStatusMessage } from "./compile.js";
import type {
  ControlPingMessage,
  ControlPongMessage,
  FilesystemChangeMessage,
  FilesystemSyncMessage,
  GeneralErrorMessage,
  SessionCounterpartAwayMessage,
  SessionErrorMessage,
  SessionGoodbyeMessage,
  SessionHelloMessage,
} from "./shared.js";

/** Payload of {@link AppSessionWelcomeMessage}. */
export interface AppSessionWelcomePayload {
  protocolVersion: number;
  sessionId: string;
  /** The join code the session's second role was bound by; it no longer joins the session. */
  joinCode: string;
  /** Token the member stores and presents to bind back into the same session on reconnect. */
  bindingToken?: string;
}

/** Payload of {@link AppSessionJoinCodeMessage}. */
export interface AppSessionJoinCodePayload {
  joinCode: string;
}

/** Any message an app client may send to the bridge. */
export type AppClientMessage =
  | SessionHelloMessage
  | SessionGoodbyeMessage
  | SessionErrorMessage
  | ControlPingMessage
  | FilesystemChangeMessage
  | FilesystemSyncMessage
  | CompileDiagnosticsMessage
  | CompileStatusMessage;

/**
 * Tells a member of either role that its session is connected: the bridge
 * sends it to both members each time both roles of the session are bound.
 */
export interface AppSessionWelcomeMessage {
  type: "session:welcome";
  id?: string;
  payload: AppSessionWelcomePayload;
}

/**
 * Tells a member of either role its session's join code, for display: in
 * answer to its hello, and whenever the session mints a new code while one of
 * its roles is vacant.
 */
export interface AppSessionJoinCodeMessage {
  type: "session:joinCode";
  payload: AppSessionJoinCodePayload;
}

/** Any message the bridge may send to an app client. */
export type AppServerMessage =
  | AppSessionWelcomeMessage
  | AppSessionJoinCodeMessage
  | SessionCounterpartAwayMessage
  | SessionErrorMessage
  | ControlPongMessage
  | GeneralErrorMessage
  | FilesystemChangeMessage
  | FilesystemSyncMessage;
