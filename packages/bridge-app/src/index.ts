export type { InMemoryProjectFileSystemOptions } from "@wendoo/app-host";
export { createInMemoryProjectFileSystem, WENDOO_JSON_PATH } from "@wendoo/app-host";
export type {
  FolderAppMessage,
  FolderHostMessage,
  FolderInstalledExtensionMetadata,
  PeerSessionHelloMessage,
} from "@wendoo/bridge-protocol";
export {
  FOLDER_HOST_MODE_FOLDER,
  FOLDER_HOST_MODE_GLOBAL,
  FOLDER_HOST_MODE_URL_PARAM,
  FolderSessionErrorCode,
  PeerSessionErrorCode,
} from "@wendoo/bridge-protocol";
export type {
  AppBridge,
  AppBridgeFeature,
  AppBridgeFeatureContext,
  AppBridgeFeatureStatus,
  AppBridgeOptions,
  AppBridgeSnapshot,
  AppBridgeState,
  DiagnosticEntry,
  ProjectFileChange,
  ProjectFileSnapshot,
  ProjectFileSystem,
} from "./app-bridge.js";
export { createAppBridge } from "./app-bridge.js";
export type {
  AppEnvironmentHostOptions,
  CatalogMovesOutcome,
  WorkspaceCompileDiagnostic,
} from "./app-environment-host.js";
export { AppEnvironmentHost } from "./app-environment-host.js";
export type { BrainDiagnosticEntry, TileCompileDiagnosticsLookup } from "./brain-diagnostics.js";
export { collectBrainErrorDiagnostics, collectBrainTileCompileDiagnostics } from "./brain-diagnostics.js";
export { CORE_LIB_COORDINATE, CORE_LIB_REFERENCE } from "./core-extension.js";
export type { EmbeddedExtensionIdViolation } from "./embedded-extension-id-gate.js";
export {
  findEmbeddedExtensionsMissingStableIds,
  formatEmbeddedExtensionIdViolations,
} from "./embedded-extension-id-gate.js";
export type {
  EmbeddedExtension,
  EmbeddedExtensionFile,
  ExtensionResolutionConflictWarning,
  ExtensionResolutionSources,
  ExtensionResolutionWarning,
  ExtensionResolutionWarningKind,
  FetchedExtensionContentMap,
  ResolvedExtensions,
  ResolvedOriginProvenance,
} from "./embedded-extensions.js";
export {
  CatalogMoveWarningCode,
  createCatalogMoveVersionLookup,
  ExtensionResolutionCycleError,
  resolveProjectExtensions,
} from "./embedded-extensions.js";
export type {
  ExtensionActionResult,
  ExtensionCatalogEntry,
  ExtensionCatalogOffer,
  ExtensionCatalogShelfEntry,
  ExtensionFetchFailures,
  PlatformStackLayer,
} from "./extension-catalog.js";
export {
  buildExtensionCatalog,
  buildExtensionCatalogOffers,
  buildExtensionCatalogShelf,
  deriveProjectPlatformStack,
  ExtensionActionResultCode,
  installEmbeddedExtension,
  installExtensionReference,
  isExtensionCompatible,
  satisfiesRange,
  uninstallExtension,
} from "./extension-catalog.js";
export type {
  ExtensionFetchClosureResult,
  ExtensionInstallOutcome,
  ExtensionInstallOutcomeKind,
  ExtensionInstallProblem,
  ExtensionInstallRefusal,
  ExtensionInstallReport,
  ProjectDiagnosticsState,
} from "./extension-install.js";
export {
  collectExtensionFetchClosure,
  diffProjectDiagnostics,
  floatingPinsFromSnapshots,
  movedClosureHasMissingContent,
  typecheckBrainProblems,
} from "./extension-install.js";
export type { ExtensionInstallLogEvent } from "./extension-install-log.js";
export {
  appendExtensionInstallLog,
  EXTENSION_INSTALL_LOG_APP_DATA_KEY,
  parseExtensionInstallLog,
} from "./extension-install-log.js";
export type { ExtensionTransactionFlavor, ExtensionTransactionToasts } from "./extension-report-presenter.js";
export { presentExtensionTransaction } from "./extension-report-presenter.js";
export type {
  InstalledExtensionSnapshot,
  InstalledExtensionSnapshots,
} from "./fetched-extension-snapshots.js";
export {
  decodeInstalledSnapshotFiles,
  fetchedContentFromSnapshots,
  INSTALLED_EXTENSIONS_APP_DATA_KEY,
  installedExtensionMetadataFromSnapshots,
  installedSnapshotFromFetched,
  parseInstalledExtensionMetadata,
  parseInstalledExtensionSnapshots,
  reconstructInstalledSnapshotsFromTree,
  serializeInstalledExtensionSnapshots,
} from "./fetched-extension-snapshots.js";
export type { FolderHostPort, FolderHostSession, FolderHostSessionOptions } from "./folder-host-session.js";
export {
  connectFolderHostSession,
  createFolderCompileDiagnosticsPublisher,
  FolderSessionError,
} from "./folder-host-session.js";
export type { LibraryInstallAttempt, LibraryOfferInstallSurface, LibraryOfferToasts } from "./library-offer.js";
export { addOfferedLibrary } from "./library-offer.js";
export type {
  LibraryUninstallGuardOutcome,
  LibraryUninstallImpact,
  UninstallGuardBrain,
} from "./library-uninstall-guard.js";
export { collectLibraryUninstallImpact, runGuardedLibraryUninstall } from "./library-uninstall-guard.js";
export type {
  PeerSession,
  PeerSessionKind,
  PeerSessionOptions,
  PeerSessionPort,
} from "./peer-session.js";
export { connectPeerSession, PeerSessionError } from "./peer-session.js";
export type { TileCompileDiagnostics, UserTileApplyResult, UserTileMetadata } from "./user-tile-registration.js";
export { applyCompiledUserTiles, collectMetadataFromCompile } from "./user-tile-registration.js";
export type { VfsAssetUrlProvider, VfsAssetUrlProviderOptions } from "./vfs-asset-url-provider.js";
export { createVfsAssetUrlProvider } from "./vfs-asset-url-provider.js";
export type {
  FolderAppDataCodec,
  WorkspaceFolderProjectStoreOptions,
  WorkspaceFolderRpc,
} from "./workspace-folder-project-store.js";
export {
  WORKSPACE_FOLDER_PROJECT_COLLECTION_ID,
  WorkspaceFolderProjectStore,
  WorkspaceFolderStoreError,
  WorkspaceFolderStoreErrorCode,
} from "./workspace-folder-project-store.js";
