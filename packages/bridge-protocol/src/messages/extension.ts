import type { AppSessionJoinCodeMessage, AppSessionWelcomeMessage } from "./app.js";
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

/** Any message an extension client may send to the bridge. */
export type ExtensionClientMessage =
  | SessionHelloMessage
  | SessionGoodbyeMessage
  | ControlPingMessage
  | FilesystemChangeMessage
  | FilesystemSyncMessage;

/** Any message the bridge may send to an extension client. */
export type ExtensionServerMessage =
  | AppSessionWelcomeMessage
  | AppSessionJoinCodeMessage
  | SessionCounterpartAwayMessage
  | SessionErrorMessage
  | ControlPongMessage
  | GeneralErrorMessage
  | FilesystemChangeMessage
  | FilesystemSyncMessage
  | CompileDiagnosticsMessage
  | CompileStatusMessage;
