import type { FileContent } from "@wendoo/app-host";
import { fileContentFromBytes, fileContentFromWire, fileContentToBytes, fileContentToWire } from "@wendoo/app-host";
import type {
  FileContentPayload,
  FileSystemNotification,
  FolderAppMessage,
  FolderCompilerFilesPayload,
  FolderHostMessage,
  FolderSessionErrorCode as FolderSessionErrorCodeType,
} from "@wendoo/bridge-protocol";
import {
  EXTENSIONS_TREE_PATH,
  FolderSessionErrorCode,
  filesystemNotificationSchema,
  MAX_FILE_CONTENT_BYTES,
} from "@wendoo/bridge-protocol";
import * as vscode from "vscode";
import { WENDOO_JSON } from "../wendoo-json";
import type { DiagnosticsManager } from "./diagnostics-manager";
import type { ExternalDocumentAccess } from "./external-document";
import { openExternalHtmlDocument } from "./external-document";
import { judgeFolderHello } from "./folder-hello";
import { containedRelativePath, isSafeRelativePath } from "./path-confinement";
import type { AffordanceFileAccess } from "./project-affordances";
import { GITIGNORE_PATH, ProjectAffordanceWriter, updatedGitignoreContent } from "./project-affordances";
import type { RemovableVolumeFileAccess, RemovableVolumeRoot } from "./removable-volume";
import { DEFAULT_REMOVABLE_VOLUME_ROOTS, writeFileToRemovableVolume } from "./removable-volume";

/** Marks a path in the self-write log whose latest host-side operation was a delete. */
const SELF_DELETED = "__self-deleted__";

type FolderFileEntry = [
  string,
  { kind: "file"; content: string; encoding?: "base64"; etag: string; isReadonly: boolean },
];
type FolderDirectoryEntry = [string, { kind: "directory" }];

/**
 * Extension-side host of one folder session: performs the project folder's
 * disk I/O for the embedded app, forwards external disk changes to it, and
 * publishes its compile diagnostics.
 *
 * All writes are confined to the project folder; a change naming a path
 * outside it is refused with a machine-readable error.
 */
export class FolderStoreHost {
  private readonly folder: vscode.Uri;
  private readonly postToApp: (message: FolderHostMessage) => void;
  private readonly diagnostics: DiagnosticsManager;
  private readonly onHandshakeComplete: (() => void) | undefined;
  /** Latest etag (or delete marker) this host produced per path, for watcher echo suppression. */
  private readonly selfWriteLog = new Map<string, string>();
  /** Writer materializing the app's compiler-controlled files into the project folder. */
  private readonly affordanceWriter: ProjectAffordanceWriter;
  /** Reused scratch file printable documents are written to before opening externally. */
  private readonly externalDocumentAccess: ExternalDocumentAccess;
  /** Backing field of {@link appProtocolVersion}. */
  private acceptedAppProtocolVersion: number | undefined;

  constructor(
    folder: vscode.Uri,
    postToApp: (message: FolderHostMessage) => void,
    diagnostics: DiagnosticsManager,
    onHandshakeComplete?: () => void
  ) {
    this.folder = folder;
    this.postToApp = postToApp;
    this.diagnostics = diagnostics;
    this.onHandshakeComplete = onHandshakeComplete;
    this.affordanceWriter = new ProjectAffordanceWriter(this.createAffordanceFileAccess());
    this.externalDocumentAccess = createExternalDocumentAccess(this.folder);
  }

  /**
   * Protocol version the connected app declared and this host accepted at
   * its latest `folder:hello`; the host speaks that version's semantics for
   * the session. Undefined before the first welcome and after a refused hello.
   */
  get appProtocolVersion(): number | undefined {
    return this.acceptedAppProtocolVersion;
  }

  /** Handle one message posted by the embedded app. */
  async handleAppMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
      return;
    }
    const message = raw as FolderAppMessage;
    switch (message.type) {
      case "folder:hello":
        await this.handleHello(message.id, message.payload?.protocolVersion);
        return;
      case "folder:loadFiles":
        await this.handleLoadFiles(message.id);
        return;
      case "folder:change":
        await this.handleChange(message.id, message.payload);
        return;
      case "folder:manifestWrite":
        await this.handleManifestWrite(message.id, message.payload?.content);
        return;
      case "folder:volumeWrite":
        await this.handleVolumeWrite(message.id, message.payload);
        return;
      case "folder:openExternalDocument":
        await this.handleOpenExternalDocument(message.id, message.payload);
        return;
      case "folder:diagnostics":
        if (message.payload) {
          this.diagnostics.handleDiagnostics(message.payload);
        }
        return;
      case "folder:compilerFiles":
        await this.handleCompilerFiles(message.payload);
        return;
    }
  }

  /** Handle one file watcher event under the project folder. */
  async handleWatcherEvent(kind: "create" | "change" | "delete", uri: vscode.Uri): Promise<void> {
    const path = this.toRelativePath(uri);
    if (
      path === undefined ||
      path.length === 0 ||
      isExcludedPath(path) ||
      this.affordanceWriter.isAffordancePath(path)
    ) {
      return;
    }

    if (kind === "delete") {
      if (this.selfWriteLog.get(path) === SELF_DELETED) {
        return;
      }
      this.postToApp({ type: "folder:externalChange", payload: { action: "delete", path } });
      return;
    }

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return;
    }
    if (stat.type === vscode.FileType.Directory) {
      this.postToApp({ type: "folder:externalChange", payload: { action: "mkdir", path } });
      return;
    }
    if (stat.type !== vscode.FileType.File) {
      return;
    }
    const etag = etagFromStat(stat);
    if (this.selfWriteLog.get(path) === etag) {
      return;
    }
    const content = await this.readFileContent(uri, stat);
    if (content === undefined) {
      return;
    }
    this.postToApp({
      type: "folder:externalChange",
      payload: { action: "write", path, ...fileContentToWire(content), newEtag: etag },
    });
  }

  private async handleHello(id: string | undefined, protocolVersion: unknown): Promise<void> {
    this.acceptedAppProtocolVersion = undefined;
    const verdict = judgeFolderHello(protocolVersion);
    if (!verdict.accepted) {
      this.postError(id, verdict.error.code, verdict.error.message);
      if (verdict.extensionUpdateNotice !== undefined) {
        void showExtensionUpdateNotice(verdict.extensionUpdateNotice);
      }
      return;
    }
    const manifestUri = vscode.Uri.joinPath(this.folder, WENDOO_JSON);
    let content: string;
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(manifestUri);
      content = new TextDecoder().decode(await vscode.workspace.fs.readFile(manifestUri));
    } catch {
      this.postError(
        id,
        FolderSessionErrorCode.PROJECT_MANIFEST_NOT_FOUND,
        `${this.folder.toString()} carries no readable ${WENDOO_JSON}`
      );
      return;
    }
    const extensionsCache = await this.collectExtensionsCacheEntries();
    this.acceptedAppProtocolVersion = verdict.protocolVersion;
    this.postToApp({
      type: "folder:welcome",
      id,
      payload: {
        protocolVersion: verdict.protocolVersion,
        projectId: this.folder.toString(),
        manifest: { content, etag: etagFromStat(stat) },
        ...(extensionsCache.length > 0 ? { extensionsCache } : {}),
      },
    });
    this.onHandshakeComplete?.();
  }

  /** The on-disk installed-extensions tree's files, as project-relative path/content pairs. */
  private async collectExtensionsCacheEntries(): Promise<Array<[string, FileContentPayload]>> {
    const entries: Array<[string, FileContentPayload]> = [];
    await this.collectTreeFiles(this.toUri(EXTENSIONS_TREE_PATH), EXTENSIONS_TREE_PATH, entries);
    return entries;
  }

  private async collectTreeFiles(
    directory: vscode.Uri,
    prefix: string,
    entries: Array<[string, FileContentPayload]>
  ): Promise<void> {
    let children: Array<[string, vscode.FileType]>;
    try {
      children = await vscode.workspace.fs.readDirectory(directory);
    } catch {
      return;
    }
    for (const [name, type] of children) {
      const path = `${prefix}/${name}`;
      const uri = vscode.Uri.joinPath(directory, name);
      if (type === vscode.FileType.Directory) {
        await this.collectTreeFiles(uri, path, entries);
        continue;
      }
      if (type !== vscode.FileType.File) {
        continue;
      }
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }
      const content = await this.readFileContent(uri, stat);
      if (content !== undefined) {
        entries.push([path, fileContentToWire(content)]);
      }
    }
  }

  private async handleLoadFiles(id: string | undefined): Promise<void> {
    const entries: Array<FolderFileEntry | FolderDirectoryEntry> = [];
    await this.collectEntries(this.folder, "", entries);
    this.postToApp({ type: "folder:files", id, payload: { entries } });
  }

  private async collectEntries(
    directory: vscode.Uri,
    prefix: string,
    entries: Array<FolderFileEntry | FolderDirectoryEntry>
  ): Promise<void> {
    let children: Array<[string, vscode.FileType]>;
    try {
      children = await vscode.workspace.fs.readDirectory(directory);
    } catch {
      return;
    }
    for (const [name, type] of children) {
      const path = prefix.length > 0 ? `${prefix}/${name}` : name;
      if (isExcludedPath(path) || path === WENDOO_JSON || this.affordanceWriter.isAffordancePath(path)) {
        continue;
      }
      if (type === vscode.FileType.Directory) {
        entries.push([path, { kind: "directory" }]);
        await this.collectEntries(vscode.Uri.joinPath(directory, name), path, entries);
        continue;
      }
      if (type !== vscode.FileType.File) {
        continue;
      }
      const uri = vscode.Uri.joinPath(directory, name);
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch {
        continue;
      }
      const content = await this.readFileContent(uri, stat);
      if (content === undefined) {
        continue;
      }
      entries.push([
        path,
        { kind: "file", ...fileContentToWire(content), etag: etagFromStat(stat), isReadonly: false },
      ]);
    }
  }

  private async handleChange(id: string | undefined, payload: unknown): Promise<void> {
    const parsed = filesystemNotificationSchema.safeParse(payload);
    if (!parsed.success) {
      this.postError(id, FolderSessionErrorCode.INVALID_PAYLOAD, "folder:change payload failed validation");
      return;
    }
    const change = parsed.data;
    if (change.action === "import") {
      this.postError(
        id,
        FolderSessionErrorCode.UNSUPPORTED_CHANGE,
        "A full-snapshot import is not applied to a project folder"
      );
      return;
    }
    const paths = change.action === "rename" ? [change.oldPath, change.newPath] : [change.path];
    for (const path of paths) {
      if (!isSafeRelativePath(path)) {
        this.postError(
          id,
          FolderSessionErrorCode.PATH_OUTSIDE_PROJECT,
          `"${path}" does not name a path inside the project folder`
        );
        return;
      }
    }
    try {
      await this.applyChange(change);
    } catch (error) {
      this.postError(id, FolderSessionErrorCode.WRITE_FAILED, describeError(error));
      return;
    }
    this.postToApp({ type: "folder:ack", id });
  }

  private async applyChange(change: Exclude<FileSystemNotification, { action: "import" }>): Promise<void> {
    switch (change.action) {
      case "write": {
        const uri = this.toUri(change.path);
        const parent = parentDirectoryPath(change.path);
        if (parent) {
          await vscode.workspace.fs.createDirectory(this.toUri(parent));
        }
        await vscode.workspace.fs.writeFile(uri, fileContentToBytes(fileContentFromWire(change)));
        await this.recordSelfWrite(change.path, uri);
        return;
      }
      case "delete": {
        await this.deleteIgnoringMissing(this.toUri(change.path), false);
        this.selfWriteLog.set(change.path, SELF_DELETED);
        return;
      }
      case "rename": {
        await vscode.workspace.fs.rename(this.toUri(change.oldPath), this.toUri(change.newPath), {
          overwrite: true,
        });
        this.selfWriteLog.set(change.oldPath, SELF_DELETED);
        await this.recordSelfWrite(change.newPath, this.toUri(change.newPath));
        return;
      }
      case "mkdir": {
        await vscode.workspace.fs.createDirectory(this.toUri(change.path));
        return;
      }
      case "rmdir": {
        await this.deleteIgnoringMissing(this.toUri(change.path), true);
        this.selfWriteLog.set(change.path, SELF_DELETED);
        return;
      }
    }
  }

  private async handleManifestWrite(id: string | undefined, content: string | undefined): Promise<void> {
    if (typeof content !== "string") {
      this.postError(id, FolderSessionErrorCode.INVALID_PAYLOAD, "folder:manifestWrite payload failed validation");
      return;
    }
    const uri = vscode.Uri.joinPath(this.folder, WENDOO_JSON);
    try {
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      await this.recordSelfWrite(WENDOO_JSON, uri);
    } catch (error) {
      this.postError(id, FolderSessionErrorCode.WRITE_FAILED, describeError(error));
      return;
    }
    this.postToApp({ type: "folder:ack", id });
  }

  /**
   * Handle one volume-write request: write the artifact to the root of the
   * named removable volume, discovered under `mountRoots`. Posts the reply
   * to the app and returns it.
   */
  async handleVolumeWrite(
    id: string | undefined,
    payload: unknown,
    mountRoots: readonly RemovableVolumeRoot[] = DEFAULT_REMOVABLE_VOLUME_ROOTS
  ): Promise<FolderHostMessage> {
    const request = payload as { volumeName?: unknown; filename?: unknown; contents?: unknown } | undefined;
    if (
      typeof request?.volumeName !== "string" ||
      typeof request.filename !== "string" ||
      typeof request.contents !== "string"
    ) {
      return this.postReply({
        type: "folder:error",
        id,
        payload: {
          code: FolderSessionErrorCode.INVALID_PAYLOAD,
          message: "folder:volumeWrite payload failed validation",
        },
      });
    }
    const outcome = await writeFileToRemovableVolume(
      request.volumeName,
      request.filename,
      request.contents,
      removableVolumeFileAccess,
      mountRoots
    );
    if (!outcome.ok) {
      return this.postReply({ type: "folder:error", id, payload: { code: outcome.code, message: outcome.message } });
    }
    return this.postReply({ type: "folder:ack", id });
  }

  private postReply(message: FolderHostMessage): FolderHostMessage {
    this.postToApp(message);
    return message;
  }

  /**
   * Handle one open-external-document request: write the app-generated HTML to
   * the reused temporary document file and open it in the user's default
   * external application. Posts the reply to the app.
   */
  async handleOpenExternalDocument(
    id: string | undefined,
    payload: unknown,
    access: ExternalDocumentAccess = this.externalDocumentAccess
  ): Promise<void> {
    const request = payload as { html?: unknown } | undefined;
    if (typeof request?.html !== "string") {
      this.postError(
        id,
        FolderSessionErrorCode.INVALID_PAYLOAD,
        "folder:openExternalDocument payload failed validation"
      );
      return;
    }
    const outcome = await openExternalHtmlDocument(request.html, access);
    if (!outcome.ok) {
      this.postError(id, outcome.code, outcome.message);
      return;
    }
    this.postToApp({ type: "folder:ack", id });
  }

  /**
   * Materialize the app's compiler-controlled file set into the project
   * folder. Every path must be a normalized project-relative path; a payload
   * naming a path outside the project is refused whole.
   */
  private async handleCompilerFiles(payload: FolderCompilerFilesPayload | undefined): Promise<void> {
    if (
      !payload ||
      !Array.isArray(payload.files) ||
      payload.installedExtensions === null ||
      typeof payload.installedExtensions !== "object"
    ) {
      this.postError(
        undefined,
        FolderSessionErrorCode.INVALID_PAYLOAD,
        "folder:compilerFiles payload failed validation"
      );
      return;
    }
    for (const [path] of payload.files) {
      if (!isSafeRelativePath(path)) {
        this.postError(
          undefined,
          FolderSessionErrorCode.PATH_OUTSIDE_PROJECT,
          `"${path}" does not name a path inside the project folder`
        );
        return;
      }
    }
    try {
      const result = await this.affordanceWriter.apply(payload);
      for (const path of result.writtenPaths) {
        if (!isExcludedPath(path)) {
          await this.recordSelfWrite(path, this.toUri(path));
        }
      }
      for (const path of result.deletedPaths) {
        if (!isExcludedPath(path)) {
          this.selfWriteLog.set(path, SELF_DELETED);
        }
      }
    } catch (error) {
      this.postError(undefined, FolderSessionErrorCode.WRITE_FAILED, describeError(error));
      void vscode.window.showErrorMessage(
        `Wendoo could not update the project's generated files: ${describeError(error)}`
      );
    }
  }

  /** The affordance writer's file operations, over the project folder. */
  private createAffordanceFileAccess(): AffordanceFileAccess {
    return {
      readFile: async (path) => {
        const uri = this.toUri(path);
        let stat: vscode.FileStat;
        try {
          stat = await vscode.workspace.fs.stat(uri);
        } catch {
          return undefined;
        }
        return this.readFileContent(uri, stat);
      },
      writeFile: async (path, content) => {
        const parent = parentDirectoryPath(path);
        if (parent) {
          await vscode.workspace.fs.createDirectory(this.toUri(parent));
        }
        await vscode.workspace.fs.writeFile(this.toUri(path), fileContentToBytes(content));
      },
      deleteFile: async (path) => {
        await this.deleteIgnoringMissing(this.toUri(path), false);
      },
      listFilesUnder: async (directory) => {
        const files: string[] = [];
        const walk = async (uri: vscode.Uri, prefix: string): Promise<void> => {
          let children: Array<[string, vscode.FileType]>;
          try {
            children = await vscode.workspace.fs.readDirectory(uri);
          } catch {
            return;
          }
          for (const [name, type] of children) {
            const path = `${prefix}/${name}`;
            if (type === vscode.FileType.Directory) {
              await walk(vscode.Uri.joinPath(uri, name), path);
            } else if (type === vscode.FileType.File) {
              files.push(path);
            }
          }
        };
        await walk(this.toUri(directory), directory);
        return files;
      },
      deleteDirectoryIfEmpty: async (path) => {
        try {
          await vscode.workspace.fs.delete(this.toUri(path), { recursive: false, useTrash: false });
        } catch {
          // Non-empty or already gone.
        }
      },
    };
  }

  private async recordSelfWrite(path: string, uri: vscode.Uri): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      this.selfWriteLog.set(path, etagFromStat(stat));
    } catch {
      this.selfWriteLog.delete(path);
    }
  }

  private async deleteIgnoringMissing(uri: vscode.Uri, recursive: boolean): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri, { recursive, useTrash: false });
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        return;
      }
      throw error;
    }
  }

  /**
   * Read the file at `uri` as project file content: its text when the bytes are
   * UTF-8 text, and the raw bytes otherwise. Undefined when the file exceeds
   * {@link MAX_FILE_CONTENT_BYTES} or cannot be read.
   */
  private async readFileContent(uri: vscode.Uri, stat: vscode.FileStat): Promise<FileContent | undefined> {
    if (stat.size > MAX_FILE_CONTENT_BYTES) {
      return undefined;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return undefined;
    }
    return fileContentFromBytes(bytes);
  }

  private toUri(path: string): vscode.Uri {
    return vscode.Uri.joinPath(this.folder, path);
  }

  private toRelativePath(uri: vscode.Uri): string | undefined {
    return containedRelativePath(this.folder.path, uri.path);
  }

  private postError(id: string | undefined, code: FolderSessionErrorCodeType, message: string): void {
    this.postToApp({ type: "folder:error", id, payload: { code, message } });
  }
}

/** Removable-volume file access over the workbench file system, addressing machine paths as `file:` URIs. */
const removableVolumeFileAccess: RemovableVolumeFileAccess = {
  async isDirectory(path: string): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  },
  async listSubdirectories(path: string): Promise<string[]> {
    try {
      const children = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
      return children.filter(([, type]) => (type & vscode.FileType.Directory) !== 0).map(([name]) => name);
    } catch {
      return [];
    }
  },
  async writeTextFile(path: string, contents: string): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(path), new TextEncoder().encode(contents));
  },
};

/** Host-local scratch directory printable documents are written into, under the project folder. */
const SCRATCH_DIRECTORY = ".wendoo";

/** Name of the reused scratch file printable documents are written to under {@link SCRATCH_DIRECTORY}. */
const EXTERNAL_DOCUMENT_FILENAME = "print.html";

/** The `.gitignore` entry ignoring the whole scratch directory. */
const SCRATCH_GITIGNORE_ENTRY = `${SCRATCH_DIRECTORY}/`;

/**
 * External-document access over the workbench file system and the host's
 * default external opener: writes the document to a reused file under the
 * project folder's `.wendoo` scratch directory (a real `file:` path in the
 * desktop host), ensures that directory is gitignored, then opens the file.
 * The file is overwritten each call.
 */
function createExternalDocumentAccess(folder: vscode.Uri): ExternalDocumentAccess {
  const scratchUri = vscode.Uri.joinPath(folder, SCRATCH_DIRECTORY);
  const documentUri = vscode.Uri.joinPath(scratchUri, EXTERNAL_DOCUMENT_FILENAME);
  const gitignoreUri = vscode.Uri.joinPath(folder, GITIGNORE_PATH);
  return {
    async writeTempDocument(html: string): Promise<string> {
      await ensureScratchGitignored(gitignoreUri);
      await vscode.workspace.fs.createDirectory(scratchUri);
      await vscode.workspace.fs.writeFile(documentUri, new TextEncoder().encode(html));
      return documentUri.toString();
    },
    async openExternal(target: string): Promise<void> {
      await vscode.env.openExternal(vscode.Uri.parse(target));
    },
  };
}

/** Append the scratch-directory entry to the project's `.gitignore` when absent; a no-op when present. */
async function ensureScratchGitignored(gitignoreUri: vscode.Uri): Promise<void> {
  let existing: string | undefined;
  try {
    existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(gitignoreUri));
  } catch {
    existing = undefined;
  }
  const updated = updatedGitignoreContent(existing, [SCRATCH_GITIGNORE_ENTRY]);
  if (updated !== undefined) {
    await vscode.workspace.fs.writeFile(gitignoreUri, new TextEncoder().encode(updated));
  }
}

/** Label of the notification action that checks for a newer release of this extension. */
const CHECK_FOR_UPDATES_LABEL = "Check for Updates";

/** Show `message` as an error notification offering to check for extension updates, and run the check when chosen. */
async function showExtensionUpdateNotice(message: string): Promise<void> {
  const choice = await vscode.window.showErrorMessage(message, CHECK_FOR_UPDATES_LABEL);
  if (choice === CHECK_FOR_UPDATES_LABEL) {
    await vscode.commands.executeCommand("workbench.extensions.action.checkForUpdates");
  }
}

function etagFromStat(stat: vscode.FileStat): string {
  return `${stat.mtime}-${stat.size}`;
}

function parentDirectoryPath(path: string): string | undefined {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : undefined;
}

/**
 * True for paths the folder session does not sync: any segment starting with
 * a dot (`.git`, `.libraries`) or a `node_modules` directory.
 */
export function isExcludedPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
