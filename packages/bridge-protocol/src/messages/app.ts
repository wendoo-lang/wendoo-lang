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

/** Payload of {@link AppSessionWelcomeMessage} sent by the bridge to the app client. */
export interface AppSessionWelcomePayload {
  protocolVersion: number;
  sessionId: string;
  joinCode: string;
  /** Token the app stores to rebind to the same session on reconnect. */
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

/** Initial greeting from the bridge to a newly connected app client. */
export interface AppSessionWelcomeMessage {
  type: "session:welcome";
  id?: string;
  payload: AppSessionWelcomePayload;
}

/** Notifies the app of an updated join code. */
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
