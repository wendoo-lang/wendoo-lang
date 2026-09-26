import type {
  ApprovedCatalogEntryLookup,
  ExtensionAddInputResolution,
  ExtensionCatalogMoves,
  ExtensionFetchResult,
  ExtensionFetchTransport,
  ExtensionUpdateApplication,
  ExtensionUpdateCheck,
  ProjectCollectionProjectCommitResult,
  ProjectCollectionUnlockResult,
  ProjectFileSystem,
  ProjectManifest,
  UnstableDependency,
} from "@wendoo/app-host";
import {
  AppHostError,
  AppHostErrorCode,
  appHostError,
  applyCatalogMove,
  checkExtensionReferenceUpdate,
  collectUnstableDependencies,
  diffWendooJsonToManifest,
  ExtensionFetchErrorCode,
  type FileContent,
  fetchExtensionSnapshot,
  fileContentText,
  highestListedRelease,
  type ProjectManager,
  parseCatalogMoveReference,
  parseExtensionAddInput,
  parseProjectContentManifest,
  resolveExtensionAddInput,
  syncManifestToWendooJson,
  WENDOO_JSON_PATH,
} from "@wendoo/app-host";
import type { BridgeSessionErrorCode, FolderInstalledExtensionMetadata } from "@wendoo/bridge-protocol";
import type { IBrainDef, WendooEnvironment, WendooModule } from "@wendoo/core/app";
import {
  createWendooEnvironment,
  Dict,
  encodePersistedBrainJson,
  logger,
  renameBrainNamespaces,
} from "@wendoo/core/app";
import type { PersistedBrainJson } from "@wendoo/core/brain/model";
import type { Localizer } from "@wendoo/core/localization";
import type { ActionKey, IRngServices, ProfileNumerics } from "@wendoo/core/runtime";
import type { Mount, WorkspaceCompileResult, WorkspaceDiagnosticEntry } from "@wendoo/ts-compiler";
import type { AppBridge, AppBridgeState, ProjectFileChange } from "./app-bridge.js";
import type { BridgeProjectHandle, ProjectCompilerHandle } from "./compilation.js";
import { augmentProjectFileSystem, createBridgeProject, createProjectCompiler } from "./compilation.js";
import type {
  EmbeddedExtension,
  ExtensionResolutionWarning,
  FetchedExtensionContentMap,
  ResolvedExtensions,
} from "./embedded-extensions.js";
import {
  CatalogMoveWarningCode,
  createCatalogMoveVersionLookup,
  ExtensionResolutionCycleError,
  resolveProjectExtensions,
} from "./embedded-extensions.js";
import type { ExtensionCatalogEntry, ExtensionFetchFailures } from "./extension-catalog.js";
import type { ExtensionInstallReport, ProjectDiagnosticsState } from "./extension-install.js";
import {
  collectExtensionFetchClosure,
  diffProjectDiagnostics,
  floatingPinsFromSnapshots,
  movedClosureHasMissingContent,
  typecheckBrainProblems,
} from "./extension-install.js";
import type { ExtensionInstallLogEvent } from "./extension-install-log.js";
import {
  appendExtensionInstallLog,
  EXTENSION_INSTALL_LOG_APP_DATA_KEY,
  parseExtensionInstallLog,
} from "./extension-install-log.js";
import type { InstalledExtensionSnapshot, InstalledExtensionSnapshots } from "./fetched-extension-snapshots.js";
import {
  decodeInstalledSnapshotFiles,
  fetchedContentFromSnapshots,
  INSTALLED_EXTENSIONS_APP_DATA_KEY,
  installedExtensionMetadataFromSnapshots,
  parseInstalledExtensionSnapshots,
  serializeInstalledExtensionSnapshots,
} from "./fetched-extension-snapshots.js";
import type { TileCompileDiagnostics, UserTileApplyResult, UserTileMetadata } from "./user-tile-registration.js";
import { applyCompiledUserTiles, collectTileSourceCompileErrors } from "./user-tile-registration.js";

// Project app-data keys.
const BRAINS_APP_DATA_KEY = "brains";

/**
 * Build the `BRAIN_RECORD_UNREADABLE` error for a stored brain record that
 * could not be read or parsed, carrying `cause`'s text as detail.
 */
function brainRecordUnreadable(cause: unknown): AppHostError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return appHostError(AppHostErrorCode.BRAIN_RECORD_UNREADABLE, `Stored brains could not be read: ${detail}`);
}

/**
 * Build the `EXTENSION_RECORD_UNREADABLE` error for a stored installed-extension
 * record that could not be read, carrying `cause`'s text as detail.
 */
function extensionRecordUnreadable(cause: unknown): AppHostError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return appHostError(
    AppHostErrorCode.EXTENSION_RECORD_UNREADABLE,
    `Stored installed libraries could not be read: ${detail}`
  );
}

/** A successful read of the active project's stored brains. */
interface StoredBrains {
  /** The stored text the record was parsed from; undefined when the project has never stored a record. */
  readonly raw: string | undefined;
  /** The parsed record, keyed by the app-defined brain key; empty when `raw` is undefined. */
  readonly record: Record<string, unknown>;
}

/** The outcome of one load's catalog-move application. */
export interface CatalogMovesOutcome {
  /** Reports of the per-move install transactions this load ran, in application order. */
  readonly reports: readonly ExtensionInstallReport[];
  /** Stable-coded findings for moves that could not be applied this load. */
  readonly warnings: readonly ExtensionResolutionWarning[];
}

/** One diagnostic of the latest workspace compile, located at its workspace path. */
export type WorkspaceCompileDiagnostic = WorkspaceDiagnosticEntry & {
  /** Workspace path of the file the diagnostic is located in. */
  readonly path: string;
};

const NO_COMPILE_DIAGNOSTICS: readonly WorkspaceCompileDiagnostic[] = [];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link AppEnvironmentHost}. */
export interface AppEnvironmentHostOptions {
  projectManager: ProjectManager;
  /** Wendoo modules to register with the environment. */
  modules: readonly WendooModule[];
  /** Read-only content mounts supplied to the project compiler and remote VFS. */
  mounts: readonly Mount[];
  /**
   * Extensions bundled with the host application. A project's `embedded:<repo>`
   * dependency resolves against this record by the origin's repository segment,
   * delivering the extension's content to the compiler as a mounted dependency
   * keyed by its `<owner>/<repo>` coordinate. Empty when the app bundles none.
   */
  embeddedExtensions?: readonly EmbeddedExtension[];

  /**
   * Transport used to fetch remote (`gh:`) extension content at install time.
   * When omitted, an install transaction needing a fetch refuses as
   * unreachable; already-installed fetched extensions still load from their
   * stored snapshots.
   */
  extensionFetchTransport?: ExtensionFetchTransport;

  /**
   * Curated catalog moves from the host's catalog, keyed by source coordinate.
   * On project load a top-level manifest entry a move entry captures is
   * rewritten to the entry's destination through an install transaction, and a
   * transitive dependency reference an entry captures resolves through the
   * destination. Empty when the host declares none.
   */
  catalogMoves?: ExtensionCatalogMoves;

  /**
   * Resolves a coordinate to the approved pin the host's catalog entry offers.
   * An update check for a listed coordinate offers that pin and does not read
   * the source. When omitted, every update check reads the source.
   */
  approvedCatalogEntry?: ApprovedCatalogEntryLookup;

  /**
   * Host-supplied RNG. The bridge app forwards this to
   * {@link createWendooEnvironment} so brains pull randomness from the host
   * (e.g. the simulator's seeded RNG). When omitted, the environment falls back
   * to a default-seeded one, which draws the same sequence every run.
   */
  rng?: IRngServices;

  /**
   * Brain-observable numeric semantics for the host's device profile,
   * forwarded to {@link createWendooEnvironment}. When omitted, the
   * environment falls back to the f64 (native double-precision) default.
   */
  numerics?: ProfileNumerics;

  /**
   * Host-supplied display-time translation service, forwarded to
   * {@link createWendooEnvironment}. When omitted, the environment falls
   * back to the default localizer, which renders every source string as
   * authored.
   */
  localizer?: Localizer;

  /** When set, enables the optional bridge connection to a remote peer. */
  bridgeUrl?: string;
  /** Loads a previously persisted bridge binding token. */
  loadBindingToken?: () => string | undefined;
  /** Persists an updated bridge binding token. */
  saveBindingToken?: (token: string) => void;

  /** Invoked after every successful project compile. */
  onDidCompile?: (result: WorkspaceCompileResult, tileResult: UserTileApplyResult | undefined) => void;
}

// ---------------------------------------------------------------------------
// AppEnvironmentHost
// ---------------------------------------------------------------------------

/**
 * Glue layer that wires a {@link ProjectManager}, a {@link WendooEnvironment},
 * the project compiler, user-tile registration, and (optionally) the bridge
 * into a single host an app UI can drive.
 */
export class AppEnvironmentHost {
  readonly env: WendooEnvironment;
  readonly projectManager: ProjectManager;

  private readonly mounts: readonly Mount[];
  private readonly embeddedExtensions: readonly EmbeddedExtension[];
  private readonly extensionFetchTransport: ExtensionFetchTransport | undefined;
  private readonly catalogMoves: ExtensionCatalogMoves;
  private readonly approvedCatalogEntry: ApprovedCatalogEntryLookup | undefined;
  private readonly onDidCompileCallback?: (
    result: WorkspaceCompileResult,
    tileResult: UserTileApplyResult | undefined
  ) => void;

  // -- Installed fetched-extension snapshots (persisted in the project store) --
  private _installedSnapshots: InstalledExtensionSnapshots = {};
  private _installedContent: FetchedExtensionContentMap = new Map();

  // -- Latest resolved extension closure of the active project --
  private _lastResolution: ResolvedExtensions | undefined;
  private readonly _resolutionWarningsListeners = new Set<() => void>();

  // -- Last recorded fetch failure per reference (seeded from the install log) --
  private _fetchFailures = new Map<string, { code: string; message: string }>();

  // -- Latest workspace compile result --
  private _lastCompileResult: WorkspaceCompileResult | undefined;

  // -- Per-tile error compile diagnostics and source path, keyed by ActionKey; rebuilt from the latest compile --
  private _tileCompileDiagnostics: Map<ActionKey, TileCompileDiagnostics> = new Map();

  // -- Brain cache --
  private readonly _brainCache = new Map<string, IBrainDef>();
  private readonly _defaultBrainCache = new Map<string, IBrainDef>();

  // -- First stored-record read failure of the active project's load --
  private _projectRecordFailure: AppHostError | undefined;

  // -- Brain rebuild coordination --
  private _pendingBrainRebuild = false;

  // -- Doc / VFS revision counters (useSyncExternalStore pattern) --
  private _docRevision = 0;
  private _vfsRevision = 0;
  private readonly _docRevisionListeners = new Set<() => void>();
  private readonly _vfsRevisionListeners = new Set<() => void>();

  // -- Brain-diagnostics revision counter (useSyncExternalStore pattern) --
  private _brainDiagnosticsRevision = 0;
  private readonly _brainDiagnosticsListeners = new Set<() => void>();

  // -- Latest workspace-compile diagnostics (useSyncExternalStore pattern) --
  private _compileDiagnostics: readonly WorkspaceCompileDiagnostic[] = NO_COMPILE_DIAGNOSTICS;
  private readonly _compileDiagnosticsListeners = new Set<() => void>();

  // -- Project lifecycle --
  private readonly _projectUnloadingListeners = new Set<() => void>();
  private readonly _projectLoadedListeners = new Set<() => void>();

  // -- Bridge --
  private _bridge: BridgeProjectHandle | undefined;
  private _bridgeUrl: string | undefined;
  private _bridgeStatus: AppBridgeState = "disconnected";
  private _bridgeJoinCode: string | undefined;
  private _bridgeErrorCode: BridgeSessionErrorCode | undefined;
  private _bridgePaired = false;
  private readonly _bridgeStatusListeners = new Set<() => void>();
  private readonly _bridgeJoinCodeListeners = new Set<() => void>();
  private readonly _bridgeErrorCodeListeners = new Set<() => void>();
  private readonly _bridgePairedListeners = new Set<() => void>();
  private _bridgeStateUnsub: (() => void) | undefined;
  private _bridgeWelcomeUnsub: (() => void) | undefined;
  private _remoteChangeUnsub: (() => void) | undefined;

  private readonly _loadBindingToken: () => string | undefined;
  private readonly _saveBindingToken: (token: string) => void;

  // -- User tile metadata (last known) --
  private _lastUserTileMetadata: readonly UserTileMetadata[] | undefined;

  // -- Compilation --
  private _compiler: ProjectCompilerHandle | undefined;

  // -- Served file system (raw project files plus compiler-controlled files) --
  private _servedFileSystem: ProjectFileSystem | undefined;

  // -- Compiler-controlled file set changes --
  private readonly _compilerControlledFilesListeners = new Set<(files: ReadonlyMap<string, FileContent>) => void>();

  constructor(options: AppEnvironmentHostOptions) {
    this.projectManager = options.projectManager;
    this.mounts = options.mounts;
    this.embeddedExtensions = options.embeddedExtensions ?? [];
    this.extensionFetchTransport = options.extensionFetchTransport;
    this.catalogMoves = options.catalogMoves ?? {};
    this.approvedCatalogEntry = options.approvedCatalogEntry;
    this.onDidCompileCallback = options.onDidCompile;
    this._bridgeUrl = options.bridgeUrl;
    this._loadBindingToken = options.loadBindingToken ?? (() => undefined);
    this._saveBindingToken = options.saveBindingToken ?? (() => {});

    this.env = createWendooEnvironment({
      modules: [...options.modules],
      rng: options.rng,
      numerics: options.numerics,
      localizer: options.localizer,
    });

    this.env.onBrainsInvalidated((event) => {
      if (event.invalidatedBrains.length > 0) {
        this._pendingBrainRebuild = true;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Project file system
  // ---------------------------------------------------------------------------

  get projectFileSystem(): ProjectFileSystem {
    return this.projectManager.activeProject!.filesystem;
  }

  /**
   * The file system whose exported snapshot carries both the raw project files
   * and the compiler-controlled files (ambient declarations, `tsconfig.json`,
   * and the installed-extensions tree), including extension-owned assets such
   * as tile icons. Each `exportSnapshot()` reads the live compiler, so
   * installing or uninstalling an extension is reflected without a rebuild.
   * Falls back to the raw project file system until the compiler is wired.
   */
  get servedProjectFileSystem(): ProjectFileSystem {
    return this._servedFileSystem ?? this.projectFileSystem;
  }

  get activeProjectManifest(): ProjectManifest | undefined {
    return this.projectManager.activeProject?.manifest;
  }

  /** Release bridge and project-manager resources owned by this host. */
  dispose(): void {
    this.teardownBridge();
    this.projectManager.dispose();
  }

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  async initialize(defaultProjectName: string): Promise<void> {
    await this.projectManager.init();
    const state = await this.projectManager.getProjectCollectionState();
    if (state.access === "locked") {
      return;
    }
    await this.projectManager.ensureDefaultProject(defaultProjectName);
    await this.initCompiler();
    this.absorbCatalogMovesOutcome(await this.applyCatalogMoves());
    await this.loadBrainsFromProject();
  }

  // ---------------------------------------------------------------------------
  // Compilation (always available, independent of bridge)
  // ---------------------------------------------------------------------------

  /**
   * Resolve the active project's extension dependency graph against the host's
   * embed record and the project's stored fetched snapshots. Logs any conflict
   * warnings. On this load path a dependency cycle is logged and resolution
   * falls back to no extension dependencies, so the project still loads and
   * unresolved imports surface as ordinary compiler diagnostics; an install
   * transaction refuses on a cycle instead.
   */
  private resolveExtensions(): ResolvedExtensions {
    try {
      const resolved = resolveProjectExtensions(
        this.projectManager.activeProject!.manifest.extensions,
        {
          embedded: this.embeddedExtensions,
          fetched: this._installedContent,
          moves: this.catalogMoves,
          floatingPins: floatingPinsFromSnapshots(this._installedSnapshots),
        },
        this.projectManager.activeProject!.manifest.targets
      );
      for (const warning of resolved.warnings) {
        logger.warn(`[extension-resolution] ${warning.message}`);
      }
      return resolved;
    } catch (err) {
      if (err instanceof ExtensionResolutionCycleError) {
        logger.warn(`[extension-resolution] ${err.message}`);
        return { dependencies: [], dependencyMounts: [], origins: [], warnings: [] };
      }
      throw err;
    }
  }

  /** Replace the project's installed snapshot records, in memory and in the project store. */
  private async persistInstalledSnapshots(snapshots: InstalledExtensionSnapshots): Promise<void> {
    this._installedSnapshots = snapshots;
    this._installedContent = fetchedContentFromSnapshots(snapshots);
    await this.projectManager.saveAppData(
      INSTALLED_EXTENSIONS_APP_DATA_KEY,
      serializeInstalledExtensionSnapshots(snapshots)
    );
  }

  /**
   * Read the active project's stored extension records: the installed
   * snapshots and the install log. Both are empty when the project has stored
   * neither. Returns undefined when the store could not serve them, recording
   * the failure on {@link AppEnvironmentHost.projectRecordFailure}. On
   * undefined the caller must leave the stored records untouched.
   */
  private async readStoredExtensionRecordsForLoad(): Promise<
    { snapshots: InstalledExtensionSnapshots; log: readonly ExtensionInstallLogEvent[] } | undefined
  > {
    try {
      const snapshots = parseInstalledExtensionSnapshots(
        await this.projectManager.loadAppData(INSTALLED_EXTENSIONS_APP_DATA_KEY)
      );
      const log = parseExtensionInstallLog(await this.projectManager.loadAppData(EXTENSION_INSTALL_LOG_APP_DATA_KEY));
      return { snapshots, log };
    } catch (err) {
      const failure = extensionRecordUnreadable(err);
      logger.warn("Failed to load installed-library records:", failure);
      this._projectRecordFailure ??= failure;
      return undefined;
    }
  }

  private async initCompiler(): Promise<void> {
    // The installed-extensions tree regenerates from the stored snapshots;
    // loading a project never reaches the network.
    const stored = await this.readStoredExtensionRecordsForLoad();
    this._installedSnapshots = stored?.snapshots ?? {};
    this._installedContent = fetchedContentFromSnapshots(this._installedSnapshots);
    this._fetchFailures = new Map();
    for (const event of stored?.log ?? []) {
      if (event.kind === "fetch-refusal") {
        this._fetchFailures.set(event.reference, { code: event.code, message: event.message });
      }
    }
    const resolution = this.resolveExtensions();
    this.setLastResolution(resolution);
    const { dependencies, dependencyMounts } = resolution;
    this._compiler = createProjectCompiler({
      environment: this.env,
      filesystem: this.projectFileSystem,
      projectNamespace: this.projectManager.activeProject!.manifest.id,
      mounts: this.mounts,
      dependencies,
      dependencyMounts,
      onDidCompile: (result) => {
        this._lastCompileResult = result;
        this.setCompileDiagnostics(result);
        this.persistMintedActionIds(result.projectResult.sourceRewrites);
        logWorkspaceCompile(result);
        const tileResult = applyCompiledUserTiles(this.env, result);
        if (tileResult) {
          this._lastUserTileMetadata = tileResult.metadata;
          this.bumpDocRevision();
          if (tileResult.changedActionKeys.length > 0) {
            // A changed action bundle can make a previously unbuildable brain
            // buildable, including one born invalidated because its action was
            // missing at creation. Schedule the rebuild flush to retry the
            // invalidated set even when this compile invalidated no live brain.
            this._pendingBrainRebuild = true;
          }
        }
        this.onDidCompileCallback?.(result, tileResult);
        // A compile can change a tile's broken/clean status, which the per-brain
        // diagnostics feed reads through the tile-compile map. Refresh the feed's
        // subscribers so the brain-list badge tracks the newest compile.
        this.bumpBrainDiagnosticsRevision();
      },
    });
    this._servedFileSystem = augmentProjectFileSystem(this.projectFileSystem, this._compiler.compiler, {
      onCompilerControlledFilesChanged: (files) => {
        for (const listener of this._compilerControlledFilesListeners) {
          listener(files);
        }
      },
    });
    syncManifestToWendooJson(this.projectFileSystem, this.projectManager.activeProject!.manifest);
    this._compiler.initialize();
  }

  /**
   * Persist source files whose user-action declaration had a stable `id` minted
   * during compilation. Writes the updated text to the project file system and
   * to the compiler's in-memory view.
   */
  private persistMintedActionIds(sourceRewrites: ReadonlyMap<string, string>): void {
    if (sourceRewrites.size === 0) {
      return;
    }
    for (const [path, content] of sourceRewrites) {
      const newEtag = `idgen-${Date.now()}`;
      this.projectFileSystem.applyLocalChange({ action: "write", path, content, newEtag });
      this._compiler?.compiler.applyWorkspaceChange({ action: "write", path, content, newEtag });
    }
  }

  // ---------------------------------------------------------------------------
  // Brain persistence (keyed by app-defined string)
  // ---------------------------------------------------------------------------

  async saveBrainForKey(key: string, brainDef: IBrainDef): Promise<void> {
    this._brainCache.set(key, brainDef);
    const record = await this.loadBrainRecord();
    record[key] = this.serializeBrainForStorage(brainDef);
    await this.projectManager.saveAppData(BRAINS_APP_DATA_KEY, JSON.stringify(record));
    this.bumpBrainDiagnosticsRevision();
  }

  /**
   * Serialize a brain into its persisted form: identifiers qualified by the
   * active project's namespace are stored with the namespace absent.
   */
  serializeBrainForStorage(brainDef: IBrainDef): PersistedBrainJson {
    return encodePersistedBrainJson(brainDef, this.projectManager.activeProject!.manifest.id);
  }

  async removeBrain(key: string): Promise<void> {
    this._brainCache.delete(key);
    const record = await this.loadBrainRecord();
    delete record[key];
    await this.projectManager.saveAppData(BRAINS_APP_DATA_KEY, JSON.stringify(record));
  }

  async loadBrainFromProject(key: string): Promise<IBrainDef | undefined> {
    const record = await this.loadBrainRecord();
    const json = record[key];
    if (!json) return undefined;
    return this.deserializeBrainForKey(key, json);
  }

  /**
   * Returns the active project's in-memory brain for `key`, or undefined when none is cached. The
   * cache is loaded on project load and updated by `saveBrainForKey` and `removeBrain`.
   */
  getCachedBrain(key: string): IBrainDef | undefined {
    return this._brainCache.get(key);
  }

  /** Returns the keys of the active project's cached brains, in cache order. */
  getCachedBrainKeys(): readonly string[] {
    return [...this._brainCache.keys()];
  }

  setDefaultBrain(key: string, brainDef: IBrainDef): void {
    this._defaultBrainCache.set(key, brainDef);
  }

  getDefaultBrain(key: string): IBrainDef | undefined {
    return this._defaultBrainCache.get(key);
  }

  private async saveAllBrains(): Promise<void> {
    // Overlay the cache onto the stored record: an entry that failed to
    // deserialize on load has no cache slot, and its stored bytes must survive.
    const record = await this.loadBrainRecord();
    for (const [key, def] of this._brainCache) {
      record[key] = this.serializeBrainForStorage(def);
    }
    await this.projectManager.saveAppData(BRAINS_APP_DATA_KEY, JSON.stringify(record));
  }

  /**
   * Read the active project's stored brain record together with the raw stored
   * text it was parsed from. Both are empty -- `raw` undefined, `record` `{}` --
   * when the project has never stored a record. Throws {@link AppHostError} with
   * code `BRAIN_RECORD_UNREADABLE` -- and no other error -- when a stored record
   * exists but cannot be read or parsed.
   */
  private async readStoredBrains(): Promise<StoredBrains> {
    let raw: string | undefined;
    try {
      raw = await this.projectManager.loadAppData(BRAINS_APP_DATA_KEY);
    } catch (err) {
      throw brainRecordUnreadable(err);
    }
    if (!raw) return { raw, record: {} };
    try {
      return { raw, record: JSON.parse(raw) as Record<string, unknown> };
    } catch (err) {
      throw brainRecordUnreadable(err);
    }
  }

  /**
   * Read the active project's stored brain record. Returns an empty record when
   * the project has never stored one. Throws {@link AppHostError} with code
   * `BRAIN_RECORD_UNREADABLE` -- and no other error -- when a stored record
   * exists but cannot be read or parsed.
   */
  private async loadBrainRecord(): Promise<Record<string, unknown>> {
    return (await this.readStoredBrains()).record;
  }

  /**
   * Read the stored brains on a project-load path. Returns the record and the
   * raw stored text, or undefined when they could not be read, recording the
   * failure on {@link AppEnvironmentHost.projectRecordFailure}. On undefined the
   * caller must leave the stored brains untouched.
   */
  private async readStoredBrainsForLoad(): Promise<StoredBrains | undefined> {
    try {
      return await this.readStoredBrains();
    } catch (err) {
      if (!(err instanceof AppHostError)) {
        throw err;
      }
      logger.warn("Failed to load brain record:", err);
      this._projectRecordFailure ??= err;
      return undefined;
    }
  }

  /**
   * The first failure that stopped one of the active project's stored records
   * from loading, or undefined when they all loaded. Its `code` names the
   * record: `BRAIN_RECORD_UNREADABLE` for the saved brains,
   * `EXTENSION_RECORD_UNREADABLE` for the installed-library snapshots and the
   * install log. While it is set the brain cache is empty because a record
   * could not be read, not because the project has no brains, every brain
   * write refuses, and no write replaces a record that could not be read.
   * Cleared when the project unloads.
   */
  get projectRecordFailure(): AppHostError | undefined {
    return this._projectRecordFailure;
  }

  /** True while the active project's stored extension records could not be read. */
  private get extensionRecordUnreadable(): boolean {
    return this._projectRecordFailure?.code === AppHostErrorCode.EXTENSION_RECORD_UNREADABLE;
  }

  /**
   * Deserialize the project's stored brains into the cache. Call after the
   * load's catalog moves have applied: deserialization resolves saved tile
   * references against the current action bundle. Caches nothing when the load
   * already recorded a stored-record failure: the extension closure is then
   * unknown, so no saved tile reference resolves.
   */
  private async loadBrainsFromProject(): Promise<void> {
    if (this._projectRecordFailure) {
      return;
    }
    const stored = await this.readStoredBrainsForLoad();
    if (!stored) {
      return;
    }
    for (const [key, json] of Object.entries(stored.record)) {
      const def = this.deserializeBrainForKey(key, json);
      if (def) {
        this._brainCache.set(key, def);
      }
    }
  }

  /**
   * Reconcile the in-memory brain cache against the project store's current
   * brain record: cached brains absent from the record are dropped, and
   * record entries whose stored form differs from the cached brain are
   * deserialized into the cache. Returns the changed and removed brain keys.
   */
  async reconcileBrainsFromStore(): Promise<{ changed: readonly string[]; removed: readonly string[] }> {
    const record = await this.loadBrainRecord();
    const changed: string[] = [];
    const removed: string[] = [];
    for (const key of [...this._brainCache.keys()]) {
      if (!(key in record)) {
        this._brainCache.delete(key);
        removed.push(key);
      }
    }
    for (const [key, json] of Object.entries(record)) {
      const cached = this._brainCache.get(key);
      if (cached && JSON.stringify(json) === JSON.stringify(this.serializeBrainForStorage(cached))) {
        continue;
      }
      const def = this.deserializeBrainForKey(key, json);
      if (!def) {
        continue;
      }
      this._brainCache.set(key, def);
      changed.push(key);
    }
    return { changed, removed };
  }

  private deserializeBrainForKey(key: string, json: unknown): IBrainDef | undefined {
    try {
      const brainDef = this.env.deserializeBrainJsonFromPlain(json, this.projectManager.activeProject!.manifest.id);
      if (brainDef.pages().size() === 0) {
        brainDef.appendNewPage();
      }
      // Establish the stored typecheck state consumers of the loaded brain
      // read (badges, diagnostics baselines).
      typecheckBrainProblems(brainDef);
      return brainDef;
    } catch (err) {
      logger.warn(`Failed to load brain "${key}":`, err);
      return undefined;
    }
  }

  /**
   * Re-resolve every cached brain's tile references against the current
   * catalogs by round-tripping it through its persisted form -- the same
   * resolution a project load performs, so a tile whose library left the
   * closure becomes a placeholder and a placeholder whose library returned
   * becomes the real tile again. A brain whose round-trip fails keeps its
   * current definition.
   */
  private refreshBrainCache(): void {
    for (const [key, brainDef] of [...this._brainCache]) {
      const refreshed = this.deserializeBrainForKey(key, this.serializeBrainForStorage(brainDef));
      if (refreshed) {
        this._brainCache.set(key, refreshed);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Project metadata
  // ---------------------------------------------------------------------------

  async updateProjectMetadata(updates: Partial<Pick<ProjectManifest, "name" | "description">>): Promise<void> {
    await this.projectManager.updateActive(updates);
    syncManifestToWendooJson(this.projectFileSystem, this.projectManager.activeProject!.manifest);
  }

  /** The installed fetched-extension content available to the active project, keyed by reference. */
  get installedExtensionContent(): FetchedExtensionContentMap {
    return this._installedContent;
  }

  /**
   * The compiler-controlled file set of the active project's workspace: the
   * generated `tsconfig.json`, ambient declarations, and the materialized
   * installed-extensions tree. Undefined until the compiler is wired.
   */
  getCompilerControlledFiles(): ReadonlyMap<string, FileContent> | undefined {
    return this._compiler?.compiler.getCompilerControlledFiles();
  }

  /**
   * Subscribe to compiler-controlled file set changes. The listener receives
   * the full new set after each compile that changed it. Returns an
   * unsubscribe function.
   */
  onCompilerControlledFilesChanged(listener: (files: ReadonlyMap<string, FileContent>) => void): () => void {
    this._compilerControlledFilesListeners.add(listener);
    return () => {
      this._compilerControlledFilesListeners.delete(listener);
    };
  }

  /** Install provenance of every installed fetched dependency, keyed by `<owner>/<repo>` origin. */
  getInstalledExtensionMetadata(): Record<string, FolderInstalledExtensionMetadata> {
    return installedExtensionMetadataFromSnapshots(this._installedSnapshots);
  }

  /**
   * The installed libraries of the active project's resolved extension
   * closure: one record per resolved origin, carrying the coordinate a
   * compiled tile's identity namespace names and the display name the
   * library's own `wendoo.json` declares. Empty until the compiler is
   * wired.
   */
  get installedLibraries(): readonly Pick<ExtensionCatalogEntry, "coordinate" | "name">[] {
    const origins = this._lastResolution?.origins ?? [];
    return origins.map((origin) => ({ coordinate: origin.origin, name: origin.name }));
  }

  /** The last recorded fetch failure per reference, keyed by the reference string as written. */
  get extensionFetchFailures(): ExtensionFetchFailures {
    return this._fetchFailures;
  }

  /**
   * Non-fatal warnings of the active project's latest extension resolution,
   * including the stable-coded catalog-move findings the load's move
   * application recorded. Empty until the compiler is wired.
   */
  get resolutionWarnings(): readonly ExtensionResolutionWarning[] {
    return this._lastResolution?.warnings ?? NO_RESOLUTION_WARNINGS;
  }

  /**
   * Subscribe to resolution-warning changes for `useSyncExternalStore`. The
   * listener fires whenever the active project's latest resolution is
   * replaced: on project load and switch, and after each install transaction.
   * Returns an unsubscribe function.
   */
  subscribeToResolutionWarnings = (listener: () => void): (() => void) => {
    this._resolutionWarningsListeners.add(listener);
    return () => this._resolutionWarningsListeners.delete(listener);
  };

  /** Snapshot of {@link resolutionWarnings} for `useSyncExternalStore`. */
  getResolutionWarningsSnapshot = (): readonly ExtensionResolutionWarning[] => {
    return this.resolutionWarnings;
  };

  /** Record the latest resolution and notify resolution-warning subscribers. */
  private setLastResolution(resolution: ResolvedExtensions | undefined): void {
    this._lastResolution = resolution;
    for (const listener of this._resolutionWarningsListeners) {
      listener();
    }
  }

  /** Merge a load's catalog-move findings into the latest resolution's warnings, skipping duplicates. */
  private absorbCatalogMovesOutcome(outcome: CatalogMovesOutcome | undefined): void {
    if (outcome === undefined || outcome.warnings.length === 0 || this._lastResolution === undefined) {
      return;
    }
    const seen = new Set(this._lastResolution.warnings.map(resolutionWarningKey));
    const added = outcome.warnings.filter((warning) => !seen.has(resolutionWarningKey(warning)));
    if (added.length === 0) {
      return;
    }
    this.setLastResolution({
      ...this._lastResolution,
      warnings: [...this._lastResolution.warnings, ...added],
    });
  }

  /** Fetch one `gh:` reference's snapshot through the host's transport. */
  private fetchSnapshot(reference: string): Promise<ExtensionFetchResult> {
    if (!this.extensionFetchTransport) {
      return Promise.resolve({
        ok: false,
        error: {
          code: ExtensionFetchErrorCode.UNREACHABLE,
          reference,
          message: "The host application provides no extension fetch transport.",
        },
      });
    }
    return fetchExtensionSnapshot(reference, this.extensionFetchTransport);
  }

  /** Materialize a resolution: dependencies, `wendoo.json`, and a recompile of the whole workspace. */
  private applyResolution(resolution: ResolvedExtensions): void {
    if (!this._compiler) {
      return;
    }
    this.setLastResolution(resolution);
    this._compiler.compiler.setDependencies(resolution.dependencies, resolution.dependencyMounts);
    syncManifestToWendooJson(this.projectFileSystem, this.projectManager.activeProject!.manifest);
    this._compiler.replaceProjectFiles();
  }

  /** Rewrite `wendoo.json` from the store manifest, restoring the file after a refused transaction. */
  private resyncManifestFile(): void {
    const active = this.projectManager.activeProject;
    if (active) {
      syncManifestToWendooJson(this.projectFileSystem, active.manifest);
    }
  }

  /**
   * The active project's diagnostic state: the latest workspace compile's
   * per-file diagnostics plus a fresh typecheck of every cached brain.
   */
  private captureProjectDiagnostics(): ProjectDiagnosticsState {
    const files = this._lastCompileResult?.files ?? new Map<string, never>();
    const brains = new Map<string, readonly string[]>();
    for (const [key, brain] of this._brainCache) {
      brains.set(key, typecheckBrainProblems(brain));
    }
    return { files, brains };
  }

  /**
   * Append the transaction's events to the project's install log. Appends
   * nothing while the stored extension records are unreadable: the log's
   * existing entries are unknown, so a write would replace them with these
   * events alone.
   */
  private async appendInstallLogEvents(events: readonly ExtensionInstallLogEvent[]): Promise<void> {
    if (events.length === 0 || this.extensionRecordUnreadable) {
      return;
    }
    const raw = await this.projectManager.loadAppData(EXTENSION_INSTALL_LOG_APP_DATA_KEY);
    await this.projectManager.saveAppData(EXTENSION_INSTALL_LOG_APP_DATA_KEY, appendExtensionInstallLog(raw, events));
  }

  /**
   * The install and remove events between two resolved closures, plus the new
   * resolution's warnings. An origin present in both closures records an
   * install event when its winning reference or installed specifier changed
   * (an update).
   */
  private installLogEventsForChange(
    previous: ResolvedExtensions,
    next: ResolvedExtensions,
    previousSnapshots: InstalledExtensionSnapshots,
    nextSnapshots: InstalledExtensionSnapshots
  ): ExtensionInstallLogEvent[] {
    const at = Date.now();
    const previousByOrigin = new Map(previous.origins.map((origin) => [origin.origin, origin]));
    const nextOrigins = new Set(next.origins.map((origin) => origin.origin));
    const events: ExtensionInstallLogEvent[] = [];
    for (const origin of next.origins) {
      const specifier = nextSnapshots[origin.origin]?.specifier;
      const before = previousByOrigin.get(origin.origin);
      if (
        before !== undefined &&
        before.reference === origin.reference &&
        previousSnapshots[origin.origin]?.specifier === specifier
      ) {
        continue;
      }
      events.push({
        kind: "install",
        at,
        origin: origin.origin,
        reference: origin.reference,
        ...(specifier !== undefined ? { specifier } : {}),
      });
    }
    for (const origin of previous.origins) {
      if (!nextOrigins.has(origin.origin)) {
        events.push({ kind: "remove", at, origin: origin.origin });
      }
    }
    for (const warning of next.warnings) {
      events.push({ kind: "resolution-warning", at, warning });
    }
    return events;
  }

  /**
   * Apply an extensions-map change to the active project as one transaction:
   * fetch content for every newly reachable `gh:` reference, resolve the
   * transitive dependency graph, then commit -- persist the manifest entries
   * and the fetched snapshots, re-materialize the installed-extensions tree,
   * recompile the workspace, and re-typecheck the project's brains -- and
   * report the diagnostic difference against the pre-change baseline.
   *
   * Improved, unchanged, and worsened outcomes all commit. The transaction
   * refuses outright only on mechanics failures -- an unreachable source, a
   * missing or unparseable manifest, a missing listed file, a dependency
   * cycle, or stored extension records the store could not serve -- leaving
   * the project unchanged. Every commit appends its install, remove, and
   * resolution-warning events to the project's install log.
   *
   * @param extensions - The active project's next extensions map, keyed by coordinate.
   * @param options.refetchReferences - References fetched fresh even when a stored snapshot matches.
   */
  async updateProjectExtensions(
    extensions: Readonly<Record<string, string>>,
    options?: { refetchReferences?: ReadonlySet<string> }
  ): Promise<ExtensionInstallReport> {
    if (this.extensionRecordUnreadable) {
      const failure = this._projectRecordFailure!;
      return { committed: false, refusal: { kind: "store", code: failure.code, message: failure.message } };
    }
    const previousSnapshots = this._installedSnapshots;
    const previousResolution = this.resolveExtensions();
    const baseline = this.captureProjectDiagnostics();

    const closure = await collectExtensionFetchClosure({
      extensions,
      embedded: this.embeddedExtensions,
      stored: previousSnapshots,
      refetch: options?.refetchReferences,
      moves: this.catalogMoves,
      fetchSnapshot: (reference) => this.fetchSnapshot(reference),
      ...(this.extensionFetchTransport !== undefined
        ? {
            listVersions: (owner: string, repo: string) => this.extensionFetchTransport!.listVersionTags(owner, repo),
          }
        : {}),
    });
    if (!closure.ok) {
      this.resyncManifestFile();
      this._fetchFailures.set(closure.error.reference, {
        code: closure.error.code,
        message: closure.error.message,
      });
      await this.appendInstallLogEvents([
        {
          kind: "fetch-refusal",
          at: Date.now(),
          reference: closure.error.reference,
          code: closure.error.code,
          message: closure.error.message,
        },
      ]);
      return { committed: false, refusal: { kind: "fetch", error: closure.error } };
    }

    const fetchedContent = new Map<string, ReadonlyMap<string, FileContent>>();
    for (const [reference, record] of closure.snapshotsByReference) {
      fetchedContent.set(reference, decodeInstalledSnapshotFiles(record));
    }
    let resolution: ResolvedExtensions;
    try {
      resolution = resolveProjectExtensions(
        extensions,
        {
          embedded: this.embeddedExtensions,
          fetched: fetchedContent,
          moves: this.catalogMoves,
          floatingPins: closure.floatingPins,
        },
        this.projectManager.activeProject!.manifest.targets
      );
    } catch (err) {
      if (err instanceof ExtensionResolutionCycleError) {
        this.resyncManifestFile();
        return { committed: false, refusal: { kind: "cycle", cycle: err.cycle, message: err.message } };
      }
      throw err;
    }

    // Commit. Snapshot records persist for exactly the fetched origins in the
    // resolved closure; records for origins the change dropped are pruned.
    // Invariant: the installed content swaps in before the manifest commit,
    // and the commit's active-project notification observes the new closure's
    // content. A manifest commit failure restores the previous snapshots.
    const nextSnapshots: Record<string, InstalledExtensionSnapshot> = {};
    for (const origin of resolution.origins) {
      const record = closure.snapshotsByReference.get(origin.reference);
      if (record) {
        nextSnapshots[origin.origin] = record;
      }
    }
    await this.persistInstalledSnapshots(nextSnapshots);
    try {
      await this.projectManager.updateActive({ extensions });
    } catch (err) {
      await this.persistInstalledSnapshots(previousSnapshots);
      throw err;
    }
    for (const reference of closure.snapshotsByReference.keys()) {
      this._fetchFailures.delete(reference);
    }
    this.applyResolution(resolution);
    this.refreshBrainCache();

    const outcome = diffProjectDiagnostics(baseline, this.captureProjectDiagnostics());
    this.bumpBrainDiagnosticsRevision();
    await this.appendInstallLogEvents(
      this.installLogEventsForChange(previousResolution, resolution, previousSnapshots, nextSnapshots)
    );

    for (const warning of closure.warnings) {
      logger.warn(
        `[catalog-moves] ${warning.kind === "catalog-move-failed" ? warning.code : warning.kind}: ${warning.message}`
      );
    }
    const warnings = [...resolution.warnings, ...closure.warnings];
    return { committed: true, outcome, warnings };
  }

  /** Version lookup over the embed record and the project's persisted snapshot content. */
  private moveVersionLookup(): ReturnType<typeof createCatalogMoveVersionLookup> {
    return createCatalogMoveVersionLookup({
      embedded: this.embeddedExtensions,
      contentForReference: (reference) => this._installedContent.get(reference),
    });
  }

  /**
   * Resolve a floating catalog-move destination for a coordinate to a pinned
   * `gh:` reference: the coordinate's persisted snapshot pin when one exists,
   * otherwise the highest stable published version listed by the host's
   * transport. Returns undefined when no pin can be produced.
   */
  private async resolveFloatingMoveReference(coordinate: string): Promise<string | undefined> {
    const known = floatingPinsFromSnapshots(this._installedSnapshots).get(coordinate.toLowerCase());
    if (known !== undefined) {
      return known;
    }
    if (!this.extensionFetchTransport) {
      return undefined;
    }
    const slash = coordinate.indexOf("/");
    const listed = await this.extensionFetchTransport.listVersionTags(
      coordinate.slice(0, slash),
      coordinate.slice(slash + 1)
    );
    const version = listed.ok ? highestListedRelease(listed.versions) : undefined;
    return version === undefined ? undefined : `gh:${coordinate}@${version}`;
  }

  /**
   * Apply the host's curated catalog moves to the active project. Each
   * captured top-level manifest entry is one move-application unit: its
   * manifest rewrite, its saved-brain namespace rewrite (when the entry's
   * final coordinate differs), and the fetches its chain requires run as one
   * install transaction, rolled back together when the transaction refuses. A
   * failed unit writes nothing, surfaces a stable-coded warning, and is
   * retried on the next load, while other units proceed independently.
   *
   * Application interleaves apply, fetch, and re-apply: after each committed
   * transaction the entries are re-applied with the versions the new content
   * determines, and a transitive moved dependency whose content the project
   * never persisted is healed by a fetch transaction, until nothing changes.
   * A floating destination is resolved to a pin before its transaction runs;
   * the pin is what the manifest receives. Returns undefined when the host
   * declares no moves or the project is a true no-op; otherwise the
   * transactions' reports and the load's stable-coded move warnings. Returns
   * undefined without applying anything while the stored extension records are
   * unreadable, so no move writes over a record the store could not serve.
   */
  async applyCatalogMoves(): Promise<CatalogMovesOutcome | undefined> {
    if (Object.keys(this.catalogMoves).length === 0 || this.extensionRecordUnreadable) {
      return undefined;
    }
    const reports: ExtensionInstallReport[] = [];
    const warnings: ExtensionResolutionWarning[] = [];
    const warned = new Set<string>();
    const warn = (reference: string, code: CatalogMoveWarningCode, message: string): void => {
      const key = `${reference} ${code}`;
      if (warned.has(key)) {
        return;
      }
      warned.add(key);
      warnings.push({
        kind: "catalog-move-failed",
        origin: parseCatalogMoveReference(reference)?.coordinate ?? reference,
        reference,
        code,
        message,
      });
    };
    // Entries whose unit failed this load; they are not retried until the next load.
    const failedEntries = new Set<string>();

    let progressed = true;
    while (progressed) {
      progressed = false;

      // Top-level entries: each captured entry is its own transaction.
      const lookup = this.moveVersionLookup();
      const current = this.projectManager.activeProject?.manifest.extensions ?? {};
      for (const [coordinate, reference] of Object.entries(current)) {
        if (failedEntries.has(coordinate)) {
          continue;
        }
        const applied = applyCatalogMove(reference, this.catalogMoves, lookup);
        if (!applied.ok) {
          warn(reference, applied.code, applied.message);
          failedEntries.add(coordinate);
          continue;
        }
        if (!applied.moved) {
          continue;
        }
        let finalReference = applied.reference;
        const parts = parseCatalogMoveReference(finalReference);
        if (parts === undefined) {
          continue;
        }
        if (parts.floating) {
          const pin = await this.resolveFloatingMoveReference(parts.coordinate);
          if (pin === undefined) {
            warn(
              reference,
              CatalogMoveWarningCode.FLOATING_UNRESOLVED,
              `Catalog move for "${reference}" resolves to the floating "${finalReference}" and no stable ` +
                "published version could be pinned; the move is skipped this load."
            );
            failedEntries.add(coordinate);
            continue;
          }
          finalReference = pin;
        }
        const finalCoordinate = parts.coordinate;

        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries(current)) {
          if (key !== coordinate) {
            next[key] = value;
          }
        }
        next[finalCoordinate] = finalReference;

        // A rename rewrites saved-brain namespaces in the same unit, restored
        // together when the transaction refuses. A brain record the store
        // cannot serve fails the unit before any write.
        let brainsBeforeRename: string | undefined;
        let brainsRewritten = false;
        if (finalCoordinate !== coordinate) {
          const stored = await this.readStoredBrainsForLoad();
          if (stored === undefined) {
            warn(
              reference,
              CatalogMoveWarningCode.BRAINS_UNREADABLE,
              `Catalog move for "${reference}" renames the coordinate to "${finalCoordinate}", and the project's ` +
                "stored brains could not be read to rewrite their references; the move is skipped this load."
            );
            failedEntries.add(coordinate);
            continue;
          }
          brainsBeforeRename = stored.raw;
          brainsRewritten = await this.renameBrainNamespaces(stored.record, [
            { from: coordinate, to: finalCoordinate },
          ]);
        }
        const report = await this.updateProjectExtensions(next);
        reports.push(report);
        if (!report.committed) {
          if (brainsRewritten) {
            await this.restoreBrains(brainsBeforeRename);
          }
          const detail =
            report.refusal.kind === "fetch"
              ? `${report.refusal.error.code}: ${report.refusal.error.message}`
              : report.refusal.message;
          warn(
            reference,
            CatalogMoveWarningCode.FETCH_FAILED,
            `Catalog move for "${reference}" to "${finalReference}" was refused (${detail}); the move is ` +
              "skipped this load."
          );
          failedEntries.add(coordinate);
          continue;
        }
        progressed = true;
        break;
      }
      if (progressed) {
        continue;
      }

      // Transitive heal: a moved dependency at any depth may lack content on
      // this load -- a dependency installed while the moved library was
      // bundled has no persisted snapshot, and a floating destination may not
      // be pinned yet. The fetch transaction fetches and persists exactly the
      // missing content; content it learns can enable further captures.
      const extensions = this.projectManager.activeProject?.manifest.extensions ?? {};
      const needsHeal = await movedClosureHasMissingContent({
        extensions,
        embedded: this.embeddedExtensions,
        stored: this._installedSnapshots,
        moves: this.catalogMoves,
      });
      if (needsHeal) {
        const before = new Set(Object.values(this._installedSnapshots).map((record) => record.reference));
        const report = await this.updateProjectExtensions(extensions);
        reports.push(report);
        if (report.committed) {
          if (Object.values(this._installedSnapshots).some((record) => !before.has(record.reference))) {
            progressed = true;
          }
        } else if (report.refusal.kind === "fetch") {
          warn(report.refusal.error.reference, CatalogMoveWarningCode.FETCH_FAILED, report.refusal.error.message);
        }
      }
    }

    // A version-scoped capture still unevaluable at the end of the loop is a
    // loud skip, retried on the next load.
    const lookup = this.moveVersionLookup();
    for (const reference of Object.values(this.projectManager.activeProject?.manifest.extensions ?? {})) {
      const applied = applyCatalogMove(reference, this.catalogMoves, lookup);
      if (applied.ok && applied.pendingVersion) {
        warn(
          reference,
          CatalogMoveWarningCode.VERSION_UNKNOWN,
          `The version of "${reference}" could not be determined, so its version-scoped catalog move cannot be ` +
            "evaluated; the move is skipped this load."
        );
      }
    }
    for (const warning of warnings) {
      if (warning.kind === "catalog-move-failed") {
        logger.warn(`[catalog-moves] ${warning.code}: ${warning.message}`);
      }
    }
    if (reports.length === 0 && warnings.length === 0) {
      return undefined;
    }
    return { reports, warnings };
  }

  /**
   * Rewrite every saved brain's foreign-namespace references from each rename's
   * source coordinate to its target, persisting the rewritten brains record and
   * re-deserializing the changed brains into the cache. Returns true when at
   * least one brain changed.
   *
   * @param record - The stored brain record to rewrite, read by the caller; mutated in place.
   * @param renames - The coordinate renames to apply, each a source and its target.
   */
  private async renameBrainNamespaces(
    record: Record<string, unknown>,
    renames: readonly { from: string; to: string }[]
  ): Promise<boolean> {
    const rewrite = (namespace: string): string => {
      for (const rename of renames) {
        if (rename.from === namespace) {
          return rename.to;
        }
      }
      return namespace;
    };
    const changedKeys: string[] = [];
    for (const [key, json] of Object.entries(record)) {
      const result = renameBrainNamespaces(json, rewrite);
      if (result.changed) {
        record[key] = result.brain;
        changedKeys.push(key);
      }
    }
    if (changedKeys.length === 0) {
      return false;
    }
    await this.projectManager.saveAppData(BRAINS_APP_DATA_KEY, JSON.stringify(record));
    for (const key of changedKeys) {
      const def = this.deserializeBrainForKey(key, record[key]);
      if (def) {
        this._brainCache.set(key, def);
      }
    }
    return true;
  }

  /** Restore the brains record and cache to a pre-rewrite snapshot after a refused migration. */
  private async restoreBrains(raw: string | undefined): Promise<void> {
    if (raw === undefined) {
      return;
    }
    await this.projectManager.saveAppData(BRAINS_APP_DATA_KEY, raw);
    const record = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, json] of Object.entries(record)) {
      const def = this.deserializeBrainForKey(key, json);
      if (def) {
        this._brainCache.set(key, def);
      }
    }
  }

  /**
   * Normalize add-by-reference input to an installable extension reference: a
   * complete reference, an `<owner>/<repo>` coordinate, or a GitHub repository
   * URL. Input naming a repository without a version resolves to the
   * repository's latest published version through the host's transport. Fails
   * with a stable code when the input is unrecognized, no version can be
   * resolved, or the host has no transport to resolve one through.
   *
   * @param input - The pasted add-field text.
   */
  async resolveExtensionInstallInput(input: string): Promise<ExtensionAddInputResolution> {
    if (this.extensionFetchTransport) {
      return resolveExtensionAddInput(input, this.extensionFetchTransport);
    }
    const parsed = parseExtensionAddInput(input);
    switch (parsed.kind) {
      case "reference":
        return { ok: true, reference: parsed.reference };
      case "coordinate":
        return {
          ok: false,
          code: ExtensionFetchErrorCode.UNREACHABLE,
          message: "The host application provides no extension fetch transport.",
        };
      case "invalid":
        return { ok: false, code: parsed.code, message: parsed.message };
    }
  }

  /**
   * Check one installed fetched dependency of the active project for newer
   * content: a `@<pin>` reference against the host catalog's approved pin when
   * the catalog lists the coordinate and against the source's published
   * versions when it does not, a `#<branch>` reference against the branch's
   * head commit. The check runs on request, reaches the source through the
   * host's transport, and changes nothing.
   *
   * @param coordinate - The dependency's `<owner>/<repo>` coordinate in the project's extensions map.
   */
  async checkExtensionUpdate(coordinate: string): Promise<ExtensionUpdateCheck> {
    const reference = this.projectManager.activeProject!.manifest.extensions?.[coordinate];
    const record = this._installedSnapshots[coordinate];
    if (reference === undefined || record === undefined || record.reference !== reference) {
      return {
        ok: false,
        error: {
          code: ExtensionFetchErrorCode.INVALID_REFERENCE,
          reference: reference ?? coordinate,
          message: `"${coordinate}" is not an installed fetched dependency of the active project.`,
        },
      };
    }
    if (!this.extensionFetchTransport) {
      return {
        ok: false,
        error: {
          code: ExtensionFetchErrorCode.UNREACHABLE,
          reference,
          message: "The host application provides no extension fetch transport.",
        },
      };
    }
    const manifestEntry = decodeInstalledSnapshotFiles(record).get(`/${WENDOO_JSON_PATH}`);
    const manifestContent = manifestEntry === undefined ? undefined : fileContentText(manifestEntry);
    const parsed = manifestContent !== undefined ? parseProjectContentManifest(manifestContent) : undefined;
    return checkExtensionReferenceUpdate({
      reference,
      installedSpecifier: record.specifier,
      installedVersion: parsed?.ok ? parsed.manifest.version : "0.0.0",
      transport: this.extensionFetchTransport,
      ...(this.approvedCatalogEntry !== undefined ? { approvedEntry: this.approvedCatalogEntry } : {}),
    });
  }

  /**
   * Apply one or more dependency updates to the active project as a single
   * install transaction with one outcome: each update's coordinate takes its
   * new reference in the extensions map, and each updated reference is fetched
   * fresh, never satisfied from its stored snapshot. The report and the
   * install log are those of {@link updateProjectExtensions}.
   *
   * @param updates - The updates to apply, as returned by update checks.
   */
  async applyExtensionUpdates(updates: readonly ExtensionUpdateApplication[]): Promise<ExtensionInstallReport> {
    const next: Record<string, string> = { ...(this.projectManager.activeProject!.manifest.extensions ?? {}) };
    const refetchReferences = new Set<string>();
    for (const update of updates) {
      next[update.coordinate] = update.reference;
      refetchReferences.add(update.reference);
    }
    return this.updateProjectExtensions(next, { refetchReferences });
  }

  /**
   * Collect the active project's dependencies that are not stable for
   * consumers: branch references, and pinned references whose content the
   * project has no installed snapshot for. Exporting or publishing such a
   * project should ask for confirmation first.
   */
  async collectUnstableProjectDependencies(): Promise<readonly UnstableDependency[]> {
    const extensions = this.projectManager.activeProject!.manifest.extensions ?? {};
    return collectUnstableDependencies(extensions, async (owner, repo, pin) =>
      this._installedContent.has(`gh:${owner}/${repo}@${pin}`)
    );
  }

  // ---------------------------------------------------------------------------
  // Project lifecycle events
  // ---------------------------------------------------------------------------

  onProjectUnloading(listener: () => void): () => void {
    this._projectUnloadingListeners.add(listener);
    return () => this._projectUnloadingListeners.delete(listener);
  }

  onProjectLoaded(listener: () => void): () => void {
    this._projectLoadedListeners.add(listener);
    return () => this._projectLoadedListeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // Project switching / creation
  // ---------------------------------------------------------------------------

  async createProject(name: string): Promise<ProjectManifest> {
    await this.prepareProjectTransition();
    const manifest = await this.projectManager.create(name, {
      beforeActiveProjectChange: () => this.notifyProjectUnloading(),
    });
    await this.completeProjectTransition();
    return manifest;
  }

  async switchProject(id: string): Promise<void> {
    if (this.projectManager.activeProject?.manifest.id === id) {
      return;
    }
    await this.prepareProjectTransition();
    await this.projectManager.open(id, {
      beforeActiveProjectChange: () => this.notifyProjectUnloading(),
    });
    await this.completeProjectTransition();
  }

  async switchProjectCollectionAndOpenProject(
    projectCollectionId: string,
    projectId: string
  ): Promise<ProjectCollectionProjectCommitResult> {
    if (
      this.projectManager.activeProjectCollection?.projectCollectionId === projectCollectionId &&
      this.projectManager.activeProject?.manifest.id === projectId
    ) {
      return {
        collection: this.projectManager.activeProjectCollection,
        project: this.projectManager.activeProject.manifest,
        access: "ready",
      };
    }
    await this.prepareProjectTransition();
    const result = await this.projectManager.switchProjectCollectionAndOpenProject(projectCollectionId, projectId, {
      beforeActiveProjectChange: () => this.notifyProjectUnloading(),
    });
    await this.completeProjectTransition();
    return result;
  }

  async switchProjectCollectionAndCreateProject(
    projectCollectionId: string,
    name: string
  ): Promise<ProjectCollectionProjectCommitResult> {
    await this.prepareProjectTransition();
    const result = await this.projectManager.switchProjectCollectionAndCreateProject(projectCollectionId, name, {
      beforeActiveProjectChange: () => this.notifyProjectUnloading(),
    });
    await this.completeProjectTransition();
    return result;
  }

  /**
   * Unlock a project collection and initialize the project environment when
   * unlocking restores the active project.
   *
   * @param projectCollectionId - Project collection to unlock.
   * @param pin - User-entered PIN or phrase.
   * @returns The unlocked project collection and its ready access status.
   */
  async unlockProjectCollection(projectCollectionId: string, pin: string): Promise<ProjectCollectionUnlockResult> {
    const result = await this.projectManager.unlockProjectCollection(projectCollectionId, pin);
    if (
      this.projectManager.activeProjectCollection?.projectCollectionId === projectCollectionId &&
      this.projectManager.activeProject
    ) {
      await this.completeProjectTransition();
    }
    return result;
  }

  /**
   * Lock a project collection after flushing app-owned project state.
   *
   * @param projectCollectionId - Project collection to lock.
   */
  async lockProjectCollection(projectCollectionId: string): Promise<void> {
    const locksActiveProject =
      this.projectManager.activeProjectCollection?.projectCollectionId === projectCollectionId &&
      this.projectManager.activeProject !== undefined;
    if (locksActiveProject) {
      await this.prepareProjectTransition();
    }
    await this.projectManager.lockProjectCollection(projectCollectionId, {
      beforeActiveProjectChange: () => this.notifyProjectUnloading(),
    });
    if (locksActiveProject) {
      this.completeProjectUnload();
    }
  }

  private async prepareProjectTransition(): Promise<void> {
    // A project whose load hit an unreadable record has an empty brain cache,
    // and flushing it would write over brains the store still holds.
    if (this.projectManager.activeProject && !this._projectRecordFailure) {
      await this.saveAllBrains();
    }
  }

  private notifyProjectUnloading(): void {
    for (const listener of this._projectUnloadingListeners) {
      listener();
    }
  }

  private completeProjectUnload(): void {
    this._brainCache.clear();
    this._projectRecordFailure = undefined;
    this._pendingBrainRebuild = false;
    this.env.replaceActionBundle({ revision: "", tiles: [], actions: Dict.empty(), roots: [] });
    // Compiles invalidate types per project namespace, so the outgoing
    // project's registrations must be cleared here or they outlive it.
    this.env.brainServices.runtime.types.removeUserTypes();
    this._lastUserTileMetadata = undefined;
    this._installedSnapshots = {};
    this._installedContent = new Map();
    this._fetchFailures = new Map();
    this._lastCompileResult = undefined;
    this.setCompileDiagnostics(undefined);
    this.setLastResolution(undefined);
    this.bumpDocRevision();
    this.teardownBridge();
  }

  private async completeProjectTransition(): Promise<void> {
    this.completeProjectUnload();
    await this.initCompiler();
    this.absorbCatalogMovesOutcome(await this.applyCatalogMoves());
    await this.loadBrainsFromProject();

    for (const listener of this._projectLoadedListeners) {
      listener();
    }
  }

  // ---------------------------------------------------------------------------
  // Brain rebuild flush
  // ---------------------------------------------------------------------------

  flushPendingBrainRebuilds(): void {
    if (!this._pendingBrainRebuild) {
      return;
    }
    this._pendingBrainRebuild = false;
    try {
      this.env.rebuildInvalidatedBrains();
    } catch (err) {
      logger.warn("Failed to rebuild invalidated brains:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // User tile metadata
  // ---------------------------------------------------------------------------

  get lastUserTileMetadata(): readonly UserTileMetadata[] | undefined {
    return this._lastUserTileMetadata;
  }

  /**
   * Error compile diagnostics of the user tile registered under `key` together
   * with the defining source file's path, from the latest workspace compile.
   * Undefined when the tile compiled cleanly, produced only warnings or infos,
   * or is absent from the latest compile. Each stored diagnostic is the
   * compiler's verbatim object, exposing `message`, `severity`, and
   * `line`/`column`.
   */
  getTileCompileDiagnostics(key: ActionKey): TileCompileDiagnostics | undefined {
    return this._tileCompileDiagnostics.get(key);
  }

  // ---------------------------------------------------------------------------
  // Doc / VFS revision (useSyncExternalStore pattern)
  // ---------------------------------------------------------------------------

  get docRevision(): number {
    return this._docRevision;
  }

  bumpDocRevision(): void {
    this._docRevision++;
    for (const listener of this._docRevisionListeners) {
      listener();
    }
  }

  bumpVfsRevision(): void {
    this._vfsRevision++;
    for (const listener of this._vfsRevisionListeners) {
      listener();
    }
  }

  subscribeToDocRevision = (listener: () => void): (() => void) => {
    this._docRevisionListeners.add(listener);
    return () => this._docRevisionListeners.delete(listener);
  };

  /**
   * Subscribe to brain-diagnostics revision changes for
   * `useSyncExternalStore`. The revision bumps whenever the diagnostics a brain
   * surfaces may have changed: after each extension transaction, after each brain
   * save, and after each workspace compile (which can change a used tile's
   * broken/clean status). Returns an unsubscribe function.
   */
  subscribeToBrainDiagnostics = (listener: () => void): (() => void) => {
    this._brainDiagnosticsListeners.add(listener);
    return () => this._brainDiagnosticsListeners.delete(listener);
  };

  /** Snapshot of the current brain-diagnostics revision for `useSyncExternalStore`. */
  getBrainDiagnosticsRevision = (): number => {
    return this._brainDiagnosticsRevision;
  };

  private bumpBrainDiagnosticsRevision(): void {
    this._brainDiagnosticsRevision++;
    for (const listener of this._brainDiagnosticsListeners) {
      listener();
    }
  }

  /**
   * Subscribe to workspace-compile diagnostic changes for
   * `useSyncExternalStore`. The listener fires after every workspace compile
   * and on project unload. Returns an unsubscribe function.
   */
  subscribeToCompileDiagnostics = (listener: () => void): (() => void) => {
    this._compileDiagnosticsListeners.add(listener);
    return () => this._compileDiagnosticsListeners.delete(listener);
  };

  /** Snapshot of the latest workspace compile's diagnostics for `useSyncExternalStore`; empty when clean. */
  getCompileDiagnosticsSnapshot = (): readonly WorkspaceCompileDiagnostic[] => {
    return this._compileDiagnostics;
  };

  /** Record a compile's per-file diagnostics as one flat located list and notify subscribers. */
  private setCompileDiagnostics(result: WorkspaceCompileResult | undefined): void {
    // Rebuilt from the latest compile so a fixed tile drops out and a newly
    // broken tile appears; cleared to empty when a project unloads.
    this._tileCompileDiagnostics = result ? collectTileSourceCompileErrors(result) : new Map();

    const diagnostics: WorkspaceCompileDiagnostic[] = [];
    for (const [path, entries] of result?.files ?? []) {
      for (const entry of entries) {
        diagnostics.push({ ...entry, path });
      }
    }
    if (diagnostics.length === 0 && this._compileDiagnostics.length === 0) {
      return;
    }
    this._compileDiagnostics = diagnostics.length === 0 ? NO_COMPILE_DIAGNOSTICS : diagnostics;
    for (const listener of this._compileDiagnosticsListeners) {
      listener();
    }
  }

  getDocRevisionSnapshot = (): number => {
    return this._docRevision;
  };

  subscribeToVfsRevision = (listener: () => void): (() => void) => {
    this._vfsRevisionListeners.add(listener);
    return () => this._vfsRevisionListeners.delete(listener);
  };

  getVfsRevisionSnapshot = (): number => {
    return this._vfsRevision;
  };

  // ---------------------------------------------------------------------------
  // Bridge (optional -- only available if bridgeUrl was provided)
  // ---------------------------------------------------------------------------

  initBridge(): void {
    if (!this._bridgeUrl || !this._compiler) {
      return;
    }

    this.teardownBridge();

    this._bridge = createBridgeProject({
      projectCompiler: this._compiler,
      servedFileSystem: this.servedProjectFileSystem,
      bridgeUrl: this._bridgeUrl,
      bindingToken: this._loadBindingToken(),
      onBindingTokenChange: (token) => {
        this._saveBindingToken(token);
      },
    });

    this.wireBridgeState(this._bridge.bridge);
  }

  connectBridge(): void {
    if (!this._bridge) {
      this.initBridge();
    }

    if (!this._bridge || this._bridge.bridge.snapshot().status !== "disconnected") {
      return;
    }

    this._bridge.bridge.start();
  }

  disconnectBridge(): void {
    this._bridge?.bridge.stop();
  }

  /**
   * Ends the bridge's session on purpose, as `AppBridge.end()` does, and
   * discards the bridge, so the next `connectBridge()` opens a new one
   * presenting the token `loadBindingToken` returns then.
   */
  endBridge(): void {
    this._bridge?.bridge.end();
    this.teardownBridge();
  }

  private teardownBridge(): void {
    this._bridgeStateUnsub?.();
    this._bridgeStateUnsub = undefined;
    this._bridgeWelcomeUnsub?.();
    this._bridgeWelcomeUnsub = undefined;
    this._remoteChangeUnsub?.();
    this._remoteChangeUnsub = undefined;
    this._bridge?.bridge.stop();
    this._bridge = undefined;

    if (this._bridgeStatus !== "disconnected") {
      this._bridgeStatus = "disconnected";
      for (const listener of this._bridgeStatusListeners) {
        listener();
      }
    }

    if (this._bridgeJoinCode !== undefined) {
      this._bridgeJoinCode = undefined;
      for (const listener of this._bridgeJoinCodeListeners) {
        listener();
      }
    }

    this.setBridgeErrorCode(undefined);
    this.setBridgePaired(false);
  }

  updateBridgeUrl(bridgeUrl: string): void {
    this._bridgeUrl = bridgeUrl;
    if (!this._bridge) {
      return;
    }
    const shouldStart = this._bridgeStatus !== "disconnected";
    this._bridgeStateUnsub?.();
    this._bridgeStateUnsub = undefined;
    this._bridge.recreateBridge(bridgeUrl);
    this.wireBridgeState(this._bridge.bridge);
    if (shouldStart) {
      this._bridge.bridge.start();
    }
  }

  subscribeToBridgeStatus = (listener: () => void): (() => void) => {
    this._bridgeStatusListeners.add(listener);
    return () => this._bridgeStatusListeners.delete(listener);
  };

  getBridgeStatusSnapshot = (): AppBridgeState => {
    return this._bridgeStatus;
  };

  subscribeToBridgeJoinCode = (listener: () => void): (() => void) => {
    this._bridgeJoinCodeListeners.add(listener);
    return () => this._bridgeJoinCodeListeners.delete(listener);
  };

  getBridgeJoinCodeSnapshot = (): string | undefined => {
    return this._bridgeJoinCode;
  };

  /** Subscribes to changes of {@link getBridgeErrorCodeSnapshot}. Returns an unsubscribe function. */
  subscribeToBridgeErrorCode = (listener: () => void): (() => void) => {
    this._bridgeErrorCodeListeners.add(listener);
    return () => this._bridgeErrorCodeListeners.delete(listener);
  };

  /**
   * Stable code of the failure that ended the bridge's latest connection, or
   * `undefined` when none did. Cleared when the bridge connects again.
   */
  getBridgeErrorCodeSnapshot = (): BridgeSessionErrorCode | undefined => {
    return this._bridgeErrorCode;
  };

  /** Subscribes to changes of {@link getBridgePairedSnapshot}. Returns an unsubscribe function. */
  subscribeToBridgePaired = (listener: () => void): (() => void) => {
    this._bridgePairedListeners.add(listener);
    return () => this._bridgePairedListeners.delete(listener);
  };

  /**
   * `true` while the bridge's session is connected with its counterpart:
   * from each welcome the bridge accepts until the counterpart is reported
   * away or the bridge's connection is no longer open.
   */
  getBridgePairedSnapshot = (): boolean => {
    return this._bridgePaired;
  };

  /**
   * Apply a project file change observed outside the app (a folder-session
   * external edit): applies it to the project file system and the workspace
   * compiler, recompiles, and absorbs any `wendoo.json` manifest change.
   */
  applyExternalProjectFileChange(change: ProjectFileChange): void {
    this.projectFileSystem.applyRemoteChange(change);
    if (this._compiler) {
      this._compiler.compiler.applyWorkspaceChange(change);
      this._compiler.compiler.compile();
    }
    this.handleRemoteProjectFileChange(change);
  }

  /**
   * Absorb a project file change made by a remote peer: bumps the VFS
   * revision, and a `wendoo.json` write is diffed against the active
   * manifest -- an extensions change runs through the install transaction and
   * the remaining synced fields patch the manifest. The change itself must
   * already be applied to the project file system.
   */
  handleRemoteProjectFileChange(change: ProjectFileChange): void {
    this.bumpVfsRevision();
    if (change.action === "write" && change.path === WENDOO_JSON_PATH && this.projectManager.activeProject) {
      const manifestText = fileContentText(change.content);
      const patch =
        manifestText === undefined
          ? undefined
          : diffWendooJsonToManifest(manifestText, this.projectManager.activeProject.manifest);
      if (patch) {
        // An extensions change flows through the install transaction, the
        // same pipeline the extension browser uses; the remaining synced
        // fields patch the manifest directly.
        const { extensions, ...rest } = patch;
        if (extensions !== undefined) {
          void this.updateProjectExtensions(extensions);
        }
        if (Object.keys(rest).length > 0) {
          void this.projectManager.updateActive(rest);
        }
      }
    }
  }

  private wireBridgeState(bridge: AppBridge): void {
    this._bridgeStateUnsub?.();
    this._bridgeWelcomeUnsub?.();
    this._remoteChangeUnsub?.();
    this._bridgeStateUnsub = bridge.onStateChange(() => {
      this.applyBridgeSnapshot(bridge);
    });
    this._bridgeWelcomeUnsub = bridge.onWelcome(() => {
      this.setBridgePaired(true);
    });
    this._remoteChangeUnsub = bridge.onRemoteChange((change: ProjectFileChange) => {
      this.handleRemoteProjectFileChange(change);
    });
    this.applyBridgeSnapshot(bridge);
  }

  private applyBridgeSnapshot(bridge: AppBridge): void {
    const snapshot = bridge.snapshot();

    if (snapshot.status !== this._bridgeStatus) {
      this._bridgeStatus = snapshot.status;
      for (const listener of this._bridgeStatusListeners) {
        listener();
      }
    }

    if (snapshot.joinCode !== this._bridgeJoinCode) {
      this._bridgeJoinCode = snapshot.joinCode;
      for (const listener of this._bridgeJoinCodeListeners) {
        listener();
      }
    }

    this.setBridgeErrorCode(snapshot.errorCode);
    if (snapshot.status !== "connected" || snapshot.counterpartAway) {
      this.setBridgePaired(false);
    }
  }

  private setBridgeErrorCode(errorCode: BridgeSessionErrorCode | undefined): void {
    if (errorCode === this._bridgeErrorCode) {
      return;
    }
    this._bridgeErrorCode = errorCode;
    for (const listener of this._bridgeErrorCodeListeners) {
      listener();
    }
  }

  private setBridgePaired(paired: boolean): void {
    if (paired === this._bridgePaired) {
      return;
    }
    this._bridgePaired = paired;
    for (const listener of this._bridgePairedListeners) {
      listener();
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable empty warnings array, the snapshot value while no resolution is recorded. */
const NO_RESOLUTION_WARNINGS: readonly ExtensionResolutionWarning[] = [];

/** Identity key of a resolution warning: the fields that name the same finding across sources. */
function resolutionWarningKey(warning: ExtensionResolutionWarning): string {
  const reference = "reference" in warning ? warning.reference : "";
  const code = warning.kind === "catalog-move-failed" ? warning.code : "";
  return `${warning.kind} ${warning.origin} ${reference} ${code}`;
}

function logWorkspaceCompile(result: WorkspaceCompileResult): void {
  const resultsByPath = result.projectResult.results;

  for (const [path, diagnostics] of result.files) {
    if (diagnostics.length > 0) {
      logger.warn(`[user-tile-compiler] ${path}: ${diagnostics.length} diagnostic(s)`);
      for (const diagnostic of diagnostics) {
        const range = diagnostic.range;
        logger.warn(`  ${path}:${range.startLine}:${range.startColumn} - ${diagnostic.message}`);
      }
      continue;
    }

    const program = resultsByPath.get(path)?.program;
    if (program) {
      logger.debug(`[user-tile-compiler] ${path}: compiled ${program.kind} "${program.name}"`);
    }
  }
}
