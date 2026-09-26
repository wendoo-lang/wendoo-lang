/** Wire-format version of the bridge protocol. Bumped on incompatible changes. */
export const PROTOCOL_VERSION = 1;

export type {
  FolderAckMessage,
  FolderAppMessage,
  FolderChangeMessage,
  FolderCompilerFilesMessage,
  FolderCompilerFilesPayload,
  FolderDiagnosticsMessage,
  FolderErrorMessage,
  FolderErrorPayload,
  FolderExternalChangeMessage,
  FolderFilesMessage,
  FolderHelloMessage,
  FolderHelloPayload,
  FolderHostMessage,
  FolderInstalledExtensionMetadata,
  FolderLoadFilesMessage,
  FolderManifestWriteMessage,
  FolderManifestWritePayload,
  FolderOpenExternalDocumentMessage,
  FolderOpenExternalDocumentPayload,
  FolderVolumeWriteMessage,
  FolderVolumeWritePayload,
  FolderWelcomeMessage,
  FolderWelcomePayload,
} from "./folder-session.js";
export {
  EXTENSIONS_TREE_PATH,
  FOLDER_HOST_MODE_FOLDER,
  FOLDER_HOST_MODE_GLOBAL,
  FOLDER_HOST_MODE_URL_PARAM,
  FOLDER_SESSION_PROTOCOL_VERSION,
  FolderSessionErrorCode,
  INSTALLED_EXTENSIONS_METADATA_PATH,
} from "./folder-session.js";
export type {
  AppClientMessage,
  AppServerMessage,
  AppSessionJoinCodeMessage,
  AppSessionJoinCodePayload,
  AppSessionWelcomeMessage,
  AppSessionWelcomePayload,
  CompileDiagnosticEntry,
  CompileDiagnosticRange,
  CompileDiagnosticsMessage,
  CompileDiagnosticsPayload,
  CompileStatusMessage,
  CompileStatusPayload,
  ControlPingMessage,
  ControlPongMessage,
  ErrorPayload,
  ExtensionClientMessage,
  ExtensionServerMessage,
  FilesystemChangeMessage,
  FilesystemSyncMessage,
  GeneralErrorMessage,
  SessionCounterpartAwayMessage,
  SessionErrorMessage,
  SessionGoodbyeMessage,
  SessionHelloMessage,
  SessionHelloPayload,
} from "./messages/index.js";
export {
  BridgeSessionErrorCode,
  compileDiagnosticsPayloadSchema,
  compileStatusPayloadSchema,
  sessionHelloPayloadSchema,
} from "./messages/index.js";
export type { FileContentPayload, FileSystemNotification, FilesystemSyncPayload } from "./notifications.js";
export {
  filesystemNotificationSchema,
  filesystemSyncPayloadSchema,
  MAX_FILE_CONTENT_BYTES,
  MAX_SNAPSHOT_CONTENT_BYTES,
} from "./notifications.js";
export type { PeerSessionHelloMessage, PeerSessionHelloPayload } from "./peer-session.js";
export { PeerSessionErrorCode } from "./peer-session.js";
export type { WsMessage } from "./schemas.js";
export { BRIDGE_PROTOCOL_NAMESPACES, wsMessageSchema } from "./schemas.js";
