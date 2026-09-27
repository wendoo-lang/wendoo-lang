import type { CompileDiagnosticsPayload } from "./messages/compile.js";
import type { FileContentPayload, FileSystemNotification, FilesystemSyncPayload } from "./notifications.js";

/**
 * Wire-format version of the folder-session protocol spoken between a host
 * (for example a VS Code extension owning a workspace folder) and an embedded
 * app: the newest version this build speaks. Bumped on incompatible changes.
 *
 * The app declares its version in `folder:hello`. The host accepts any
 * declared version up to its own, welcomes with the declared version, and
 * speaks that version for the session; it refuses a newer declaration with
 * `FolderSessionErrorCode.PROTOCOL_VERSION_NEWER`, whose remedy is updating
 * the host. A host that bumps this constant must keep speaking every older
 * version.
 */
export const FOLDER_SESSION_PROTOCOL_VERSION = 3;

/** Project-relative directory holding the materialized installed-extensions tree. */
export const EXTENSIONS_TREE_PATH = ".libraries";

/**
 * Project-relative path of the installed fetched-extension metadata record a
 * folder-session host stores beside the materialized installed-extensions
 * tree. The file's JSON content maps each `<owner>/<repo>` origin to its
 * {@link FolderInstalledExtensionMetadata}.
 */
export const INSTALLED_EXTENSIONS_METADATA_PATH = ".libraries/installed.json";

/** URL search parameter a host adds to the embedded app's document URL as the host-mode bootstrap flag. */
export const FOLDER_HOST_MODE_URL_PARAM = "wendooHostMode";

/** Value of {@link FOLDER_HOST_MODE_URL_PARAM} selecting folder host mode. */
export const FOLDER_HOST_MODE_FOLDER = "folder";

/**
 * Name of the global property a host defines in the embedded app's document
 * as the host-mode bootstrap flag; carries the same values as
 * {@link FOLDER_HOST_MODE_URL_PARAM}. Used by hosts whose app document has no
 * queryable URL (for example an iframe loaded via `srcdoc`).
 */
export const FOLDER_HOST_MODE_GLOBAL = "__wendooHostMode";

/** Stable identifiers for folder-session errors reported by the host. */
export const FolderSessionErrorCode = {
  /**
   * The host's `folder:welcome` carried a protocol version other than the one
   * the app declared. Raised by the app.
   */
  PROTOCOL_VERSION_MISMATCH: "FOLDER_SESSION_PROTOCOL_VERSION_MISMATCH",
  /**
   * The app's `folder:hello` declared a protocol version newer than the
   * host's {@link FOLDER_SESSION_PROTOCOL_VERSION}. Raised by the host; the
   * remedy is updating the host.
   */
  PROTOCOL_VERSION_NEWER: "FOLDER_SESSION_PROTOCOL_VERSION_NEWER",
  /** The project folder carries no readable `wendoo.json`. */
  PROJECT_MANIFEST_NOT_FOUND: "FOLDER_SESSION_PROJECT_MANIFEST_NOT_FOUND",
  /** A message payload failed validation. */
  INVALID_PAYLOAD: "FOLDER_SESSION_INVALID_PAYLOAD",
  /** A change action the host does not apply to a project folder. */
  UNSUPPORTED_CHANGE: "FOLDER_SESSION_UNSUPPORTED_CHANGE",
  /** A change named a path that resolves outside the project folder. */
  PATH_OUTSIDE_PROJECT: "FOLDER_SESSION_PATH_OUTSIDE_PROJECT",
  /** A disk write failed. */
  WRITE_FAILED: "FOLDER_SESSION_WRITE_FAILED",
  /** The removable volume named by a volume write is not mounted. */
  REMOVABLE_VOLUME_NOT_FOUND: "FOLDER_SESSION_REMOVABLE_VOLUME_NOT_FOUND",
} as const;

/** Union of all {@link FolderSessionErrorCode} values. */
export type FolderSessionErrorCode = (typeof FolderSessionErrorCode)[keyof typeof FolderSessionErrorCode];

/** Payload of a {@link FolderHelloMessage}. */
export interface FolderHelloPayload {
  /**
   * Protocol version the app speaks: its build's
   * {@link FOLDER_SESSION_PROTOCOL_VERSION}. The host accepts any whole
   * version from 1 up to its own.
   */
  protocolVersion: number;
}

/**
 * First message the app sends to open a folder session. The host replies with
 * {@link FolderWelcomeMessage} carrying the same `id`, or {@link FolderErrorMessage}.
 */
export interface FolderHelloMessage {
  type: "folder:hello";
  id?: string;
  payload: FolderHelloPayload;
}

/** Payload of a {@link FolderWelcomeMessage}. */
export interface FolderWelcomePayload {
  /**
   * Protocol version the host accepted for the session: always the version
   * the app's hello declared.
   */
  protocolVersion: number;
  /** Stable opaque id of the host-provided project. */
  projectId: string;
  /** The project's `wendoo.json` as read from disk. */
  manifest: {
    /** Full JSON text of the manifest file. */
    content: string;
    /** Opaque version tag minted from the file's disk state. */
    etag: string;
  };
  /**
   * Files currently on disk under the project's installed-extensions tree, as
   * project-relative path/content pairs (including
   * {@link INSTALLED_EXTENSIONS_METADATA_PATH} when present). Absent when the
   * tree is absent or empty.
   */
  extensionsCache?: ReadonlyArray<[string, FileContentPayload]>;
}

/** Handshake confirmation: delivers the project identity and its manifest. */
export interface FolderWelcomeMessage {
  type: "folder:welcome";
  id?: string;
  payload: FolderWelcomePayload;
}

/**
 * Requests the project's file snapshot from the host. The host replies with
 * {@link FolderFilesMessage} carrying the same `id`. The `wendoo.json`
 * manifest is not included; it is delivered by the handshake.
 */
export interface FolderLoadFilesMessage {
  type: "folder:loadFiles";
  id?: string;
}

/** Full project file snapshot sent in reply to {@link FolderLoadFilesMessage}. */
export interface FolderFilesMessage {
  type: "folder:files";
  id?: string;
  payload: FilesystemSyncPayload;
}

/**
 * A single change-granular project file write from the app. The host applies
 * it to the project folder and replies with {@link FolderAckMessage} carrying
 * the same `id`, or {@link FolderErrorMessage} when the write fails.
 */
export interface FolderChangeMessage {
  type: "folder:change";
  id?: string;
  payload: FileSystemNotification;
}

/** Payload of a {@link FolderManifestWriteMessage}. */
export interface FolderManifestWritePayload {
  /** Full JSON text to store as the project's `wendoo.json`. */
  content: string;
}

/**
 * Replaces the project's `wendoo.json` on disk. The host replies with
 * {@link FolderAckMessage} carrying the same `id`, or {@link FolderErrorMessage}.
 */
export interface FolderManifestWriteMessage {
  type: "folder:manifestWrite";
  id?: string;
  payload: FolderManifestWritePayload;
}

/** Payload of a {@link FolderVolumeWriteMessage}. */
export interface FolderVolumeWritePayload {
  /** Name of the mounted removable volume to write to. */
  volumeName: string;
  /** Name of the file to write at the volume's root. */
  filename: string;
  /** Full text content of the file. */
  contents: string;
}

/**
 * Writes an artifact file to the root of a mounted removable volume. The host
 * replies with {@link FolderAckMessage} carrying the same `id`, or
 * {@link FolderErrorMessage} when the volume is not mounted or the write
 * fails.
 */
export interface FolderVolumeWriteMessage {
  type: "folder:volumeWrite";
  id?: string;
  payload: FolderVolumeWritePayload;
}

/** Payload of a {@link FolderOpenExternalDocumentMessage}. */
export interface FolderOpenExternalDocumentPayload {
  /** Full text of the self-contained HTML document to open externally. */
  html: string;
}

/**
 * Asks the host to open a self-contained HTML document in the user's default
 * external application (the system browser). The host writes it to a temporary
 * file and opens that file; the document is app-generated content, opened
 * outside the embedding surface. The host replies with {@link FolderAckMessage}
 * carrying the same `id`, or {@link FolderErrorMessage} when it cannot be
 * written or opened.
 */
export interface FolderOpenExternalDocumentMessage {
  type: "folder:openExternalDocument";
  id?: string;
  payload: FolderOpenExternalDocumentPayload;
}

/** Confirms that the request with the same `id` was applied. */
export interface FolderAckMessage {
  type: "folder:ack";
  id?: string;
}

/**
 * A project file change observed on disk outside the app (an external edit).
 * A `write` carries the file's new content and an etag minted from its disk
 * state; a change to `wendoo.json` is delivered on this channel too.
 */
export interface FolderExternalChangeMessage {
  type: "folder:externalChange";
  id?: string;
  payload: FileSystemNotification;
}

/** Compile diagnostics for one file, published by the app to the host. */
export interface FolderDiagnosticsMessage {
  type: "folder:diagnostics";
  id?: string;
  payload: CompileDiagnosticsPayload;
}

/** Install provenance of one installed fetched dependency. */
export interface FolderInstalledExtensionMetadata {
  /** The manifest reference the dependency's content was installed from, as written. */
  reference: string;
  /** The immutable routing specifier the content was fetched at. */
  specifier: string;
}

/** Payload of a {@link FolderCompilerFilesMessage}. */
export interface FolderCompilerFilesPayload {
  /**
   * The app's full compiler-controlled file set -- the generated
   * `tsconfig.json`, ambient declarations, and the materialized
   * installed-extensions tree -- as project-relative path/content pairs.
   */
  files: ReadonlyArray<[string, FileContentPayload]>;
  /**
   * Install provenance of every installed fetched dependency, keyed by
   * `<owner>/<repo>` origin. The host stores it at
   * {@link INSTALLED_EXTENSIONS_METADATA_PATH}.
   */
  installedExtensions: Readonly<Record<string, FolderInstalledExtensionMetadata>>;
}

/**
 * The app's compiler-controlled file set, published to the host for
 * materialization into the project folder: the full set after the project
 * loads, and again whenever a compile changes the set.
 */
export interface FolderCompilerFilesMessage {
  type: "folder:compilerFiles";
  id?: string;
  payload: FolderCompilerFilesPayload;
}

/** Payload of a {@link FolderErrorMessage}. */
export interface FolderErrorPayload {
  /** Stable machine-readable error code. */
  code: FolderSessionErrorCode;
  /** Human-readable error message. */
  message: string;
}

/**
 * Reports a failed request (carrying the request's `id`) or a session-level
 * fault from the host.
 */
export interface FolderErrorMessage {
  type: "folder:error";
  id?: string;
  payload: FolderErrorPayload;
}

/** Messages sent by the app to the folder-session host. */
export type FolderAppMessage =
  | FolderHelloMessage
  | FolderLoadFilesMessage
  | FolderChangeMessage
  | FolderManifestWriteMessage
  | FolderVolumeWriteMessage
  | FolderOpenExternalDocumentMessage
  | FolderDiagnosticsMessage
  | FolderCompilerFilesMessage;

/** Messages sent by the folder-session host to the app. */
export type FolderHostMessage =
  | FolderWelcomeMessage
  | FolderFilesMessage
  | FolderAckMessage
  | FolderExternalChangeMessage
  | FolderErrorMessage;
