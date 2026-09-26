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
  SessionJoinCodeMessage,
  SessionWelcomeMessage,
} from "./shared.js";

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

/** Any message the bridge may send to an app client. */
export type AppServerMessage =
  | SessionWelcomeMessage
  | SessionJoinCodeMessage
  | SessionCounterpartAwayMessage
  | SessionErrorMessage
  | ControlPongMessage
  | GeneralErrorMessage
  | FilesystemChangeMessage
  | FilesystemSyncMessage;
