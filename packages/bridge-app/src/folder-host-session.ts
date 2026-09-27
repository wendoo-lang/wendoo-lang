import type { FileContent, ProjectFileChange, ProjectFileSnapshot, ProjectStore } from "@wendoo/app-host";
import { fileContentFromWire, fileContentText, fileContentToWire } from "@wendoo/app-host";
import type {
  CompileDiagnosticEntry,
  CompileDiagnosticsPayload,
  FileContentPayload,
  FileSystemNotification,
  FolderAppMessage,
  FolderHostMessage,
  FolderInstalledExtensionMetadata,
  FolderSessionErrorCode,
  FolderWelcomePayload,
} from "@wendoo/bridge-protocol";
import {
  FOLDER_SESSION_PROTOCOL_VERSION,
  FolderSessionErrorCode as FolderSessionErrorCodes,
  INSTALLED_EXTENSIONS_METADATA_PATH,
} from "@wendoo/bridge-protocol";
import {
  parseInstalledExtensionMetadata,
  reconstructInstalledSnapshotsFromTree,
} from "./fetched-extension-snapshots.js";
import type { FolderAppDataCodec, WorkspaceFolderStoreErrorCode } from "./workspace-folder-project-store.js";
import { WorkspaceFolderProjectStore } from "./workspace-folder-project-store.js";

export type { FolderAppDataCodec } from "./workspace-folder-project-store.js";

/**
 * Transport carrying folder-session messages between the app and its host.
 * Message order is preserved in both directions.
 */
export interface FolderHostPort {
  /** Send one message to the host. */
  postMessage(message: FolderAppMessage): void;
  /** Subscribe to messages from the host. Returns an unsubscribe function. */
  onMessage(listener: (message: FolderHostMessage) => void): () => void;
}

/** Error raised by a folder session: a host-reported or client-detected fault. */
export class FolderSessionError extends Error {
  /** Stable machine-readable error code. */
  readonly code: FolderSessionErrorCode | WorkspaceFolderStoreErrorCode;

  constructor(code: FolderSessionErrorCode | WorkspaceFolderStoreErrorCode, message: string) {
    super(message);
    this.name = "FolderSessionError";
    this.code = code;
  }
}

/** Options for {@link connectFolderHostSession}. */
export interface FolderHostSessionOptions {
  /** Transport to the folder-session host. */
  port: FolderHostPort;
  /** App name keying this app's chunk in the manifest's `app` map. */
  appName: string;
  /** Translator between app-data entries and this app's manifest chunk. */
  appDataCodec?: FolderAppDataCodec;
}

/**
 * A connected folder session: the host-backed project store, the project
 * identity, and the app-side ends of the diagnostics and external-change
 * channels.
 */
export interface FolderHostSession {
  /** Store persisting the host-provided project to its workspace folder. */
  readonly store: ProjectStore;
  /** Stable opaque id of the host-provided project. */
  readonly projectId: string;
  /** Publish compile diagnostics for one file to the host. */
  publishDiagnostics(payload: CompileDiagnosticsPayload): void;
  /**
   * Publish the app's full compiler-controlled file set and the install
   * provenance of its fetched dependencies to the host.
   */
  publishCompilerControlledFiles(
    files: ReadonlyMap<string, FileContent>,
    installedExtensions: Readonly<Record<string, FolderInstalledExtensionMetadata>>
  ): void;
  /**
   * Write a text file to the root of a removable volume mounted on the host
   * machine, replacing any existing file with the same name. Resolves when
   * the write completes; rejects with {@link FolderSessionError} carrying
   * `REMOVABLE_VOLUME_NOT_FOUND` when no volume named `volumeName` is
   * mounted, or `WRITE_FAILED` when the write fails.
   */
  writeRemovableVolumeFile(volumeName: string, filename: string, contents: string): Promise<void>;
  /**
   * Ask the host to open a self-contained HTML document in the user's default
   * external application (the system browser). Resolves when the host has
   * opened it; rejects with {@link FolderSessionError} when the host cannot
   * write or open it.
   */
  openExternalDocument(html: string): Promise<void>;
  /**
   * Subscribe to project file changes observed on disk outside the app. Each
   * change has already been absorbed by the session's store; apply it to the
   * live project file system. Changes received before the first listener
   * attaches are replayed to it. Returns an unsubscribe function.
   */
  onExternalChange(listener: (change: ProjectFileChange) => void): () => void;
  /** Detach from the port. */
  dispose(): void;
}

/**
 * Open a folder session over `port`: performs the hello/welcome handshake and
 * builds the workspace-folder project store from the delivered manifest.
 *
 * The hello declares this build's {@link FOLDER_SESSION_PROTOCOL_VERSION}, and
 * the resulting session speaks that version. Rejects with
 * {@link FolderSessionError}: `PROTOCOL_VERSION_MISMATCH` when the welcome
 * carries any other version, or the host's code when the host refuses the
 * hello -- `PROTOCOL_VERSION_NEWER` when this build's version is newer than
 * the host's; the remedy is updating the host.
 */
export async function connectFolderHostSession(options: FolderHostSessionOptions): Promise<FolderHostSession> {
  const rpc = new FolderPortRpc(options.port);
  const declaredVersion = FOLDER_SESSION_PROTOCOL_VERSION;
  const welcome = await rpc.request({
    type: "folder:hello",
    payload: { protocolVersion: declaredVersion },
  });
  if (welcome.type !== "folder:welcome") {
    rpc.dispose();
    throw new FolderSessionError(
      FolderSessionErrorCodes.INVALID_PAYLOAD,
      `Expected folder:welcome, received ${welcome.type}`
    );
  }
  const payload: FolderWelcomePayload = welcome.payload;
  if (payload.protocolVersion !== declaredVersion) {
    rpc.dispose();
    throw new FolderSessionError(
      FolderSessionErrorCodes.PROTOCOL_VERSION_MISMATCH,
      `Host welcomed folder-session protocol version ${payload.protocolVersion}; this app declared ${declaredVersion}`
    );
  }

  const store = new WorkspaceFolderProjectStore({
    rpc: {
      sendChange: async (change) => {
        await rpc.request({ type: "folder:change", payload: change });
      },
      writeManifest: async (content) => {
        await rpc.request({ type: "folder:manifestWrite", payload: { content } });
      },
      loadFiles: async () => {
        const reply = await rpc.request({ type: "folder:loadFiles" });
        const snapshot: ProjectFileSnapshot = new Map();
        if (reply.type === "folder:files") {
          for (const [path, entry] of reply.payload.entries) {
            snapshot.set(path, entry);
          }
        }
        return snapshot;
      },
    },
    projectId: payload.projectId,
    manifestContent: payload.manifest.content,
    appName: options.appName,
    appDataCodec: options.appDataCodec,
    installedExtensionSnapshots: reconstructSnapshotsFromWelcome(payload.extensionsCache),
  });

  const externalChangeListeners = new Set<(change: ProjectFileChange) => void>();
  const bufferedExternalChanges: ProjectFileChange[] = [];
  rpc.onExternalChange((notification) => {
    const change = store.absorbExternalChange(notification);
    if (externalChangeListeners.size === 0) {
      bufferedExternalChanges.push(change);
      return;
    }
    for (const listener of externalChangeListeners) {
      listener(change);
    }
  });

  return {
    store,
    projectId: payload.projectId,
    publishDiagnostics(payload: CompileDiagnosticsPayload): void {
      options.port.postMessage({ type: "folder:diagnostics", payload });
    },
    publishCompilerControlledFiles(
      files: ReadonlyMap<string, FileContent>,
      installedExtensions: Readonly<Record<string, FolderInstalledExtensionMetadata>>
    ): void {
      options.port.postMessage({
        type: "folder:compilerFiles",
        payload: {
          files: [...files].map(([path, content]) => [path, fileContentToWire(content)]),
          installedExtensions,
        },
      });
    },
    async writeRemovableVolumeFile(volumeName: string, filename: string, contents: string): Promise<void> {
      await rpc.request({ type: "folder:volumeWrite", payload: { volumeName, filename, contents } });
    },
    async openExternalDocument(html: string): Promise<void> {
      await rpc.request({ type: "folder:openExternalDocument", payload: { html } });
    },
    onExternalChange(listener: (change: ProjectFileChange) => void): () => void {
      externalChangeListeners.add(listener);
      if (bufferedExternalChanges.length > 0) {
        const replay = bufferedExternalChanges.splice(0);
        for (const change of replay) {
          listener(change);
        }
      }
      return () => {
        externalChangeListeners.delete(listener);
      };
    },
    dispose(): void {
      rpc.dispose();
    },
  };
}

/**
 * Build a compile-diagnostics publisher for a folder session: publishes each
 * file's diagnostics with a per-file version, and publishes an empty list for
 * a file whose previously reported diagnostics have cleared.
 */
export function createFolderCompileDiagnosticsPublisher(
  session: FolderHostSession
): (files: ReadonlyMap<string, readonly CompileDiagnosticEntry[]>) => void {
  const versions = new Map<string, number>();
  const previousDiagnosticFiles = new Set<string>();

  const publish = (file: string, diagnostics: readonly CompileDiagnosticEntry[]): void => {
    const version = (versions.get(file) ?? 0) + 1;
    versions.set(file, version);
    session.publishDiagnostics({ file, version, diagnostics: [...diagnostics] });
  };

  return (files) => {
    const currentFiles = new Set<string>();
    for (const [file, diagnostics] of files) {
      currentFiles.add(file);
      if (diagnostics.length > 0 || previousDiagnosticFiles.has(file)) {
        publish(file, diagnostics);
      }
    }
    for (const file of previousDiagnosticFiles) {
      if (!currentFiles.has(file)) {
        publish(file, []);
      }
    }
    previousDiagnosticFiles.clear();
    for (const [file, diagnostics] of files) {
      if (diagnostics.length > 0) {
        previousDiagnosticFiles.add(file);
      }
    }
  };
}

/**
 * Rebuild the installed snapshot records from the welcome's on-disk
 * installed-extensions tree offer. Returns `undefined` when the offer is
 * absent or carries no metadata record.
 */
function reconstructSnapshotsFromWelcome(extensionsCache: ReadonlyArray<[string, FileContentPayload]> | undefined) {
  if (!extensionsCache) {
    return undefined;
  }
  const files = extensionsCache.map(([path, payload]) => [path, fileContentFromWire(payload)] as [string, FileContent]);
  const metadataEntry = files.find(([path]) => path === INSTALLED_EXTENSIONS_METADATA_PATH);
  const metadata = parseInstalledExtensionMetadata(fileContentText(metadataEntry?.[1] ?? ""));
  if (Object.keys(metadata).length === 0) {
    return undefined;
  }
  return reconstructInstalledSnapshotsFromTree(metadata, files);
}

/** Request/reply and event demultiplexer over a {@link FolderHostPort}. */
class FolderPortRpc {
  private readonly port: FolderHostPort;
  private readonly unsubscribe: () => void;
  private readonly pending = new Map<
    string,
    { resolve: (message: FolderHostMessage) => void; reject: (error: Error) => void }
  >();
  private readonly externalChangeListeners = new Set<(notification: FileSystemNotification) => void>();
  private nextRequestId = 1;

  constructor(port: FolderHostPort) {
    this.port = port;
    this.unsubscribe = port.onMessage((message) => {
      this.handleMessage(message);
    });
  }

  request(message: FolderAppMessage): Promise<FolderHostMessage> {
    const id = `folder-request-${this.nextRequestId++}`;
    return new Promise<FolderHostMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ ...message, id });
    });
  }

  onExternalChange(listener: (notification: FileSystemNotification) => void): void {
    this.externalChangeListeners.add(listener);
  }

  dispose(): void {
    this.unsubscribe();
    this.pending.clear();
  }

  private handleMessage(message: FolderHostMessage): void {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!entry) {
        return;
      }
      if (message.type === "folder:error") {
        entry.reject(new FolderSessionError(message.payload.code, message.payload.message));
      } else {
        entry.resolve(message);
      }
      return;
    }
    if (message.type === "folder:externalChange") {
      for (const listener of this.externalChangeListeners) {
        listener(message.payload);
      }
    }
  }
}
