export type { FileContent, WireFileContent } from "@wendoo/service-api";
export {
  base64ToBytes,
  bytesToBase64,
  fileContentByteLength,
  fileContentEquals,
  fileContentFromBytes,
  fileContentFromWire,
  fileContentText,
  fileContentToBytes,
  fileContentToWire,
  isBinaryFileContent,
  LOWEST_CONTENT_VERSION,
} from "@wendoo/service-api";
export { AppHostError, AppHostErrorCode, appHostError } from "./app-host-error.js";
export type { DependencyPinProbe, UnstableDependency } from "./dependency-stability.js";
export { collectUnstableDependencies, UnstableDependencyCode } from "./dependency-stability.js";
export type { ExtensionAddInput, ExtensionAddInputResolution } from "./extension-add-input.js";
export {
  ExtensionAddInputErrorCode,
  parseExtensionAddInput,
  resolveExtensionAddInput,
} from "./extension-add-input.js";
export type {
  CatalogMoveApplication,
  CatalogMoveReferenceParts,
  CatalogMoveVersionLookup,
  ExtensionCatalogDocument,
  ExtensionCatalogDocumentEntry,
  ExtensionCatalogDocumentError,
  ExtensionCatalogDocumentParseResult,
  ExtensionCatalogDocumentWarning,
  ExtensionCatalogEntryPrior,
  ExtensionCatalogMoveEntry,
  ExtensionCatalogMoveObjectSelector,
  ExtensionCatalogMoveSelector,
  ExtensionCatalogMoves,
  ExtensionCatalogMoveTransport,
} from "./extension-catalog-document.js";
export {
  applyCatalogMove,
  buildApprovedCatalogEntryLookup,
  CATALOG_ENTRY_KIND_EXTENSION,
  CATALOG_ENTRY_KIND_TARGET,
  CatalogMoveApplyErrorCode,
  ExtensionCatalogDocumentErrorCode,
  ExtensionCatalogDocumentWarningCode,
  parseCatalogMoveReference,
  parseExtensionCatalogDocument,
  validateExtensionCatalogDocument,
  WENDOO_CATALOG_FORMAT,
} from "./extension-catalog-document.js";
export type {
  ExtensionFetchBranchResult,
  ExtensionFetchError,
  ExtensionFetchFileResult,
  ExtensionFetchResult,
  ExtensionFetchTransport,
  ExtensionVersionListResult,
  FetchedExtensionFile,
  FetchedExtensionSnapshot,
} from "./extension-fetch.js";
export { ExtensionFetchErrorCode, fetchExtensionSnapshot } from "./extension-fetch.js";
export type {
  ExtensionPublishBackend,
  ExtensionPublishCommit,
  ExtensionPublishError,
  ExtensionPublishOptions,
  ExtensionPublishResult,
  ExtensionPublishSource,
  PublishFile,
  PublishVersionBump,
} from "./extension-publish.js";
export {
  bumpVersion,
  deriveCoordinateFromRemoteUrl,
  ExtensionPublishErrorCode,
  generatePublishedReadme,
  githubRemoteUrlForCoordinate,
  publishExtensionVersion,
} from "./extension-publish.js";
export type {
  ApprovedCatalogEntryLookup,
  ExtensionUpdateApplication,
  ExtensionUpdateCheck,
} from "./extension-update.js";
export { checkExtensionReferenceUpdate, highestListedRelease } from "./extension-update.js";
export { createIdbProjectStore } from "./idb-project-store.js";
export type { InMemoryProjectFileSystemOptions } from "./in-memory-project-file-system.js";
export { applyProjectFileChangeToSnapshot, createInMemoryProjectFileSystem } from "./in-memory-project-file-system.js";
export type { JsDelivrExtensionTransportOptions } from "./jsdelivr-extension-transport.js";
export {
  createJsDelivrExtensionTransport,
  GITHUB_API_BASE_URL,
  JSDELIVR_CDN_BASE_URL,
} from "./jsdelivr-extension-transport.js";
export type { ProjectCollection, ProjectCollectionPinVerifier } from "./project-collection.js";
export {
  DEFAULT_PROJECT_COLLECTION_ID,
  DEFAULT_PROJECT_COLLECTION_NAME,
  normalizeProjectCollectionName,
  PROJECT_COLLECTION_NAME_MAX_LENGTH,
} from "./project-collection.js";
export {
  createProjectCollectionPinVerifier,
  normalizeProjectCollectionPin,
  PIN_HASH_BYTES,
  PIN_PBKDF2_ITERATIONS,
  PIN_SALT_BYTES,
  PROJECT_COLLECTION_PIN_MAX_LENGTH,
  PROJECT_COLLECTION_PIN_MIN_LENGTH,
  verifyProjectCollectionPin,
} from "./project-collection-pin.js";
export type {
  ExtensionReference,
  ExtensionTarget,
  GhRoutingSpecifier,
  ProjectContentManifest,
  ProjectContentManifestDeclaredSurface,
  ProjectContentManifestError,
  ProjectContentManifestHostApp,
  ProjectContentManifestParseResult,
  ProjectContentManifestRehearsalAdapter,
} from "./project-content-manifest.js";
export {
  isAbbreviatedCommitPin,
  isExtensionCoordinate,
  ProjectContentManifestErrorCode,
  parseExtensionReference,
  parseProjectContentManifest,
  projectContentManifestToJson,
  serializeProjectContentManifest,
  validateProjectContentManifest,
  validateProjectDeclaredSurface,
  validateProjectExtensions,
  validateProjectHostApp,
  validateProjectRehearsalAdapter,
  validateProjectTargets,
} from "./project-content-manifest.js";
export type {
  ProjectDirectoryEntry,
  ProjectFileChange,
  ProjectFileEntry,
  ProjectFileSnapshot,
  ProjectFileSystemEntry,
} from "./project-file-snapshot.js";
export type { ProjectFileSystem } from "./project-file-system.js";
export type {
  ExportAppChunk,
  ImportAppChunkCallback,
  ImportAppChunkResult,
  ImportDiagnostic,
  ImportResult,
  WendooProjectDocument,
  WendooProjectExtensions,
} from "./project-io.js";
export {
  buildActiveProjectExportDocument,
  buildProjectExportDocument,
  DEFAULT_MAX_FILE_SIZE,
  ImportDiagnosticCode,
  importProjectDocument,
} from "./project-io.js";
export type { ProjectLock, ProjectLockHandle } from "./project-lock.js";
export { createWebLocksProjectLock } from "./project-lock.js";
export type {
  ActiveProject,
  ProjectCollectionAccessState,
  ProjectCollectionEvent,
  ProjectCollectionProjectCommitResult,
  ProjectCollectionReloadUnlock,
  ProjectCollectionState,
  ProjectCollectionStateSubscription,
  ProjectCollectionSummary,
  ProjectCollectionSummaryChange,
  ProjectCollectionSummarySubscription,
  ProjectCollectionSwitchResult,
  ProjectCollectionUnlockResult,
  ProjectListSubscription,
  ProjectManagerOptions,
  ProjectPersistenceError,
  ProjectTransitionOptions,
} from "./project-manager.js";
export {
  DEFAULT_PROJECT_NAME,
  ProjectManager,
  RELOAD_UNLOCK_REFRESH_INTERVAL_MS,
  RELOAD_UNLOCK_TTL_MS,
} from "./project-manager.js";
export type { ProjectManifest } from "./project-manifest.js";
export type { ProjectCollectionTabSession, ProjectRef, ProjectStore } from "./project-store.js";
export { registryTargetEntry, seedProjectTargets } from "./project-target-seed.js";
export type { UnpackedTree, UnpackRefusal } from "./project-unpack.js";
export { buildUnpackedTree, isUnpackRefusal, UnpackErrorCode } from "./project-unpack.js";
export { isSupportedVersionRange, satisfiesRange } from "./semver-range.js";
export { WENDOO_JSON_PATH } from "./wendoo-json.js";
export { diffWendooJsonToManifest, syncManifestToWendooJson } from "./wendoo-json-sync.js";
