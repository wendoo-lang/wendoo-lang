import {
  createIdbProjectStore,
  createJsDelivrExtensionTransport,
  createWebLocksProjectLock,
  DEFAULT_PROJECT_NAME,
  type ImportAppChunkResult,
  type ImportResult,
  importProjectDocument,
  type ProjectCollection,
  type ProjectCollectionProjectCommitResult,
  type ProjectFileSystem,
  ProjectManager,
  type ProjectManifest,
  WENDOO_JSON_PATH,
} from "@wendoo/app-host";
import {
  type AppBridgeState,
  AppEnvironmentHost,
  type BrainDiagnosticEntry,
  type BridgeSessionErrorCode,
  collectBrainErrorDiagnostics,
  collectBrainTileCompileDiagnostics,
  createFolderCompileDiagnosticsPublisher,
  createVfsAssetUrlProvider,
  type FolderHostSession,
  type UserTileMetadata,
  type VfsAssetUrlProvider,
  type WorkspaceCompileDiagnostic,
} from "@wendoo/bridge-app";
import {
  type ActionKind,
  type BrainDef,
  coreModule,
  createEntropySeededRng,
  mkActionTileId,
  type WendooEnvironment,
} from "@wendoo/core/app";
import { createDefaultLocalizer } from "@wendoo/core/localization";
import type { DocsTileEntry } from "@wendoo/docs";
import { isCompilerControlledPath, type Mount } from "@wendoo/ts-compiler";
import type { PrintTransport } from "@wendoo/ui";
import { createEcosimModule } from "@/brain";
import type { Archetype } from "@/brain/actor";
import { ARCHETYPES } from "@/brain/archetypes";
import type { Obstacle } from "@/brain/vision";
import { defaultDesiredCounts } from "@/brain/world-definition";
import { name as simName } from "../../package.json";
import { type AppSettings, loadAppSettings, normalizeAppSettings, persistAppSettings } from "./app-settings";
import { loadBindingToken, saveBindingToken } from "./binding-token-persistence";
import { ecosimDefaultExtensions, ecosimEmbeddedExtensions } from "./ecosim-embedded-extensions";
import { ecosimApprovedCatalogEntry, ecosimLibraryCatalogMoves } from "./ecosim-extension-browser";
import { type AppChrome, appChromeForMode, connectEcosimFolderSession, isFolderHostMode } from "./folder-host-mode";
import {
  buildEcosimExportDocument,
  DESIRED_COUNTS_KEY,
  OBSTACLES_KEY,
  parseDesiredCounts,
  parseObstacles,
  translateEcosimAppChunk,
} from "./project-io";

/**
 * Platform content mounts for the sim, applied at the workspace root. Empty:
 * the layer ambient `.d.ts` are carried by the resolved layer extensions as
 * their own extension content.
 */
const ecosimMounts: readonly Mount[] = [];

// -- AppSettings --

type AppSettingsListener = (settings: AppSettings, prev: AppSettings) => void;

// -- UiPreferences (per-project, non-portable) --

const UI_PREFS_KEY_PREFIX = `${simName}:project-ui:`;

export interface UiPreferences {
  timeScale: number;
  bridgeEnabled: boolean;
  debugEnabled: boolean;
}

const DEFAULT_UI_PREFS: UiPreferences = {
  timeScale: 1,
  bridgeEnabled: false,
  debugEnabled: false,
};

// -- Collapsed archetypes (global, not per-project) --

const COLLAPSED_ARCHETYPES_KEY = `${simName}:collapsed-archetypes`;

function loadCollapsedArchetypes(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_ARCHETYPES_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    // corrupted data
  }
  return {};
}

function persistCollapsedArchetypes(value: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSED_ARCHETYPES_KEY, JSON.stringify(value));
  } catch {
    // storage full or unavailable
  }
}

// -- Collapsed Dev Panel (global, not per-project) --

const DEV_PANEL_COLLAPSED_KEY = `${simName}:dev-panel-collapsed`;

function loadDevPanelCollapsed(): boolean {
  try {
    return localStorage.getItem(DEV_PANEL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistDevPanelCollapsed(value: boolean): void {
  try {
    localStorage.setItem(DEV_PANEL_COLLAPSED_KEY, String(value));
  } catch {
    // storage full or unavailable
  }
}

function loadUiPreferences(projectId: string): UiPreferences {
  try {
    const raw = localStorage.getItem(`${UI_PREFS_KEY_PREFIX}${projectId}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<UiPreferences>;
      return {
        timeScale: typeof parsed.timeScale === "number" ? parsed.timeScale : DEFAULT_UI_PREFS.timeScale,
        bridgeEnabled: parsed.bridgeEnabled === true,
        debugEnabled: parsed.debugEnabled === true,
      };
    }
  } catch {
    // corrupted data -- fall through to defaults
  }
  return { ...DEFAULT_UI_PREFS };
}

function persistUiPreferences(projectId: string, prefs: UiPreferences): void {
  try {
    localStorage.setItem(`${UI_PREFS_KEY_PREFIX}${projectId}`, JSON.stringify(prefs));
  } catch {
    // storage full or unavailable
  }
}

const DESIRED_COUNTS_DEBOUNCE_MS = 200;

/** Project data an external `wendoo.json` edit changed, for the running scene to apply. */
export interface ExternalProjectDataChange {
  /** Archetypes whose stored brain the edit changed or removed. */
  readonly brains: readonly Archetype[];
  /** Whether the edit changed the stored obstacles. */
  readonly obstaclesChanged: boolean;
}

function sameObstacles(a: readonly Obstacle[] | undefined, b: readonly Obstacle[] | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export class EcosimEnvironmentStore {
  readonly host: AppEnvironmentHost;

  userTileDocEntries: DocsTileEntry[] = [];

  private _appSettings: AppSettings = loadAppSettings();
  private readonly _appSettingsListeners = new Set<AppSettingsListener>();

  private _uiPreferences: UiPreferences = { ...DEFAULT_UI_PREFS };
  private _collapsedArchetypes: Record<string, boolean> = loadCollapsedArchetypes();
  private _devPanelCollapsed: boolean = loadDevPanelCollapsed();

  private _desiredCounts: Record<Archetype, number> = defaultDesiredCounts();
  private readonly _desiredCountsListeners = new Set<() => void>();
  private _desiredCountsSaveTimer: ReturnType<typeof setTimeout> | undefined;

  private _obstacles: Obstacle[] | undefined;
  private _projectDataReloadPromise: Promise<void> = Promise.resolve();

  private _isSwitchingProject = false;
  private _vfsRevisionWiringInitialized = false;
  private readonly _vfsAssetUrlProvider: VfsAssetUrlProvider;
  private readonly _folderSession: FolderHostSession | undefined;
  private readonly _chrome: AppChrome;
  private readonly _printTransport: PrintTransport | undefined;
  private readonly _externalProjectDataListeners = new Set<(change: ExternalProjectDataChange) => void>();

  private constructor(host: AppEnvironmentHost, folderSession: FolderHostSession | undefined) {
    this.host = host;
    this._folderSession = folderSession;
    this._chrome = appChromeForMode(folderSession !== undefined);
    this._printTransport = folderSession
      ? (html) => {
          void folderSession.openExternalDocument(html);
        }
      : undefined;
    this._vfsAssetUrlProvider = createVfsAssetUrlProvider({
      getProjectFileSystem: () => this.host.servedProjectFileSystem,
      getVfsRevision: () => this.host.getVfsRevisionSnapshot(),
    });

    this.host.onProjectLoaded(() => {
      const prefs = loadUiPreferences(this.host.projectManager.activeProject!.manifest.id);
      this._uiPreferences = this._isSwitchingProject ? { ...prefs, bridgeEnabled: false } : prefs;
      this.userTileDocEntries = [];
      this._projectDataReloadPromise = this.reloadProjectData();
    });
    if (folderSession) {
      this.host.onCompilerControlledFilesChanged(() => {
        this.publishCompilerControlledFiles();
      });
    }
  }

  private async reloadProjectData(): Promise<void> {
    await Promise.all([this.reloadDesiredCountsFromProject(), this.reloadObstaclesFromProject()]);
  }

  /**
   * Resolves once the most recent project-load reload of cached app data
   * (desired counts, obstacles) has finished. Consumers that depend on
   * cached project data after a project switch should await this before
   * reading {@link getObstacles} or {@link getDesiredCounts}.
   */
  waitForProjectDataReload(): Promise<void> {
    return this._projectDataReloadPromise;
  }

  private async reloadObstaclesFromProject(): Promise<void> {
    let next: Obstacle[] | undefined;
    try {
      const raw = await this.host.projectManager.loadAppData(OBSTACLES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        next = parseObstacles(parsed);
      }
    } catch {
      // corrupted or missing data -- leave undefined so the scene reseeds
    }
    this._obstacles = next;
  }

  private async reloadDesiredCountsFromProject(): Promise<void> {
    if (this._desiredCountsSaveTimer !== undefined) {
      clearTimeout(this._desiredCountsSaveTimer);
      this._desiredCountsSaveTimer = undefined;
    }
    let raw: string | undefined;
    try {
      raw = await this.host.projectManager.loadAppData(DESIRED_COUNTS_KEY);
    } catch {
      // unreadable data -- fall back to defaults
    }
    this._desiredCounts = parseDesiredCounts(raw);
    for (const fn of this._desiredCountsListeners) {
      fn();
    }
  }

  /**
   * Creates the store. In folder host mode it first opens the folder session
   * and backs the project with the host's workspace folder; otherwise the
   * project lives in IndexedDB. Rejects with `FolderSessionError` when the
   * folder host refuses the session.
   */
  static async create(): Promise<EcosimEnvironmentStore> {
    const appSettings = loadAppSettings();
    const folderSession = isFolderHostMode() ? await connectEcosimFolderSession() : undefined;
    const publishFolderDiagnostics = folderSession ? createFolderCompileDiagnosticsPublisher(folderSession) : undefined;
    const projectStore = folderSession ? folderSession.store : await createIdbProjectStore(simName);
    let instanceRef: EcosimEnvironmentStore | undefined;
    const host = new AppEnvironmentHost({
      projectManager: new ProjectManager(projectStore, {
        filesystemOptions: {
          shouldExclude: (path) => isCompilerControlledPath(path, ecosimMounts),
        },
        ...(folderSession ? {} : { lock: createWebLocksProjectLock(simName) }),
        defaultExtensions: ecosimDefaultExtensions,
      }),
      modules: [coreModule(), createEcosimModule()],
      localizer: createDefaultLocalizer(),
      mounts: ecosimMounts,
      embeddedExtensions: ecosimEmbeddedExtensions,
      extensionFetchTransport: createJsDelivrExtensionTransport(),
      catalogMoves: ecosimLibraryCatalogMoves,
      approvedCatalogEntry: ecosimApprovedCatalogEntry,
      ...(folderSession ? {} : { bridgeUrl: appSettings.vscodeBridgeUrl }),
      loadBindingToken,
      saveBindingToken,
      rng: createEntropySeededRng(),
      onDidCompile: (result, tileResult) => {
        if (tileResult && instanceRef) {
          instanceRef.userTileDocEntries = buildDocEntries(tileResult.metadata);
        }
        publishFolderDiagnostics?.(result.files);
      },
    });
    const instance = new EcosimEnvironmentStore(host, folderSession);
    instanceRef = instance;
    instance._appSettings = appSettings;
    return instance;
  }

  get env(): WendooEnvironment {
    return this.host.env;
  }

  get projectManager(): ProjectManager {
    return this.host.projectManager;
  }

  get projectFileSystem(): ProjectFileSystem {
    return this.host.projectFileSystem;
  }

  get servedProjectFileSystem(): ProjectFileSystem {
    return this.host.servedProjectFileSystem;
  }

  get activeProjectManifest(): ProjectManifest | undefined {
    return this.host.activeProjectManifest;
  }

  /**
   * Opens or creates the active project and loads its runtime state. In
   * folder host mode it then applies each change the host observes in the
   * workspace folder and publishes the generated project files to the host.
   */
  async initialize(): Promise<void> {
    await this.host.initialize(DEFAULT_PROJECT_NAME);
    await this.loadActiveProjectRuntime();
    if (this._folderSession) {
      this._folderSession.onExternalChange((change) => {
        this.host.applyExternalProjectFileChange(change);
        if (change.action === "write" && change.path === WENDOO_JSON_PATH) {
          void this.refreshFromExternalManifest();
        }
      });
      this.publishCompilerControlledFiles();
      return;
    }
    this.onAppSettingsChange((settings, prev) => {
      if (settings.vscodeBridgeUrl !== prev.vscodeBridgeUrl) {
        this.host.updateBridgeUrl(settings.vscodeBridgeUrl);
      }
    });
  }

  private async loadActiveProjectRuntime(): Promise<void> {
    const activeProject = this.host.projectManager.activeProject;
    if (!activeProject) {
      return;
    }
    this._uiPreferences = loadUiPreferences(activeProject.manifest.id);
    const metadata = this.host.lastUserTileMetadata;
    if (metadata) {
      this.userTileDocEntries = buildDocEntries(metadata);
    }
    this._projectDataReloadPromise = this.reloadProjectData();
    await this._projectDataReloadPromise;
    if (!this._vfsRevisionWiringInitialized) {
      this.initVfsRevisionWiring();
      this._vfsRevisionWiringInitialized = true;
    }
    this.host.initBridge();
  }

  /**
   * Bumps the VFS revision on every local file-system change, re-subscribing
   * to the new project's file system on each project load.
   */
  private initVfsRevisionWiring(): void {
    let unsubLocalChange = this.projectFileSystem.onLocalChange(() => this.bumpVfsRevision());
    this.host.onProjectLoaded(() => {
      unsubLocalChange();
      unsubLocalChange = this.projectFileSystem.onLocalChange(() => this.bumpVfsRevision());
      this.bumpVfsRevision();
    });
  }

  /** Visibility of the app's top-level chrome sections for the current mode. */
  get chrome(): AppChrome {
    return this._chrome;
  }

  /**
   * Print sink for the current mode: a transport routing the printable
   * document to the host in folder mode, or undefined in browser mode (where
   * printing uses `window.print()`).
   */
  get printTransport(): PrintTransport | undefined {
    return this._printTransport;
  }

  /**
   * Registers a listener fired after an external `wendoo.json` edit has been
   * applied to the store: the brain cache and the desired counts and
   * obstacles are current when it runs. Fires only when the edit changed a
   * brain or the obstacles. Returns an unsubscribe function.
   */
  onExternalProjectDataChange(listener: (change: ExternalProjectDataChange) => void): () => void {
    this._externalProjectDataListeners.add(listener);
    return () => {
      this._externalProjectDataListeners.delete(listener);
    };
  }

  /** Release host resources owned by this store. */
  dispose(): void {
    if (this._desiredCountsSaveTimer !== undefined) {
      clearTimeout(this._desiredCountsSaveTimer);
      this._desiredCountsSaveTimer = undefined;
    }
    this._folderSession?.dispose();
    this.host.dispose();
  }

  /**
   * Publishes the compiler-controlled file set and the installed
   * fetched-extension provenance to the folder-session host. A no-op outside
   * a folder session or before the compiler is wired.
   */
  private publishCompilerControlledFiles(): void {
    if (!this._folderSession) {
      return;
    }
    const files = this.host.getCompilerControlledFiles();
    if (!files) {
      return;
    }
    this._folderSession.publishCompilerControlledFiles(files, this.host.getInstalledExtensionMetadata());
  }

  /**
   * Applies an external `wendoo.json` edit to the live app state: the brain
   * cache reconciles against the stored brains, the desired counts and
   * obstacles reload (desired-count listeners fire), and the external
   * project-data listeners hear which brains and whether the obstacles
   * changed.
   */
  private async refreshFromExternalManifest(): Promise<void> {
    const { changed, removed } = await this.host.reconcileBrainsFromStore();
    const obstaclesBefore = this._obstacles;
    await this.reloadProjectData();
    const brains = [...changed, ...removed].filter((key): key is Archetype => key in ARCHETYPES);
    const obstaclesChanged = !sameObstacles(obstaclesBefore, this._obstacles);
    if (brains.length === 0 && !obstaclesChanged) {
      return;
    }
    for (const listener of this._externalProjectDataListeners) {
      listener({ brains, obstaclesChanged });
    }
  }

  // -- Brain Persistence (archetype-typed wrappers) --

  async saveBrainForArchetype(archetype: Archetype, brainDef: BrainDef): Promise<void> {
    await this.host.saveBrainForKey(archetype, brainDef);
  }

  async loadBrainFromProject(archetype: Archetype): Promise<BrainDef | undefined> {
    return this.host.loadBrainFromProject(archetype) as Promise<BrainDef | undefined>;
  }

  setDefaultBrain(archetype: Archetype, brainDef: BrainDef): void {
    this.host.setDefaultBrain(archetype, brainDef);
  }

  getDefaultBrain(archetype: Archetype): BrainDef | undefined {
    return this.host.getDefaultBrain(archetype) as BrainDef | undefined;
  }

  /** Subscribes to brain-diagnostics revision changes for `useSyncExternalStore`. Returns an unsubscribe function. */
  subscribeToBrainDiagnostics = (listener: () => void): (() => void) => {
    return this.host.subscribeToBrainDiagnostics(listener);
  };

  /** Snapshot of the current brain-diagnostics revision for `useSyncExternalStore`. */
  getBrainDiagnosticsRevision = (): number => {
    return this.host.getBrainDiagnosticsRevision();
  };

  /** Subscribes to workspace-compile diagnostic changes for `useSyncExternalStore`. Returns an unsubscribe function. */
  subscribeToCompileDiagnostics = (listener: () => void): (() => void) => {
    return this.host.subscribeToCompileDiagnostics(listener);
  };

  /** Snapshot of the latest workspace compile's diagnostics for `useSyncExternalStore`; empty when clean. */
  getCompileDiagnosticsSnapshot = (): readonly WorkspaceCompileDiagnostic[] => {
    return this.host.getCompileDiagnosticsSnapshot();
  };

  /**
   * The verbatim error diagnostics an archetype brain surfaces: the stored
   * per-rule typecheck errors, followed by the compile diagnostics of any
   * broken user tile the brain uses (deduplicated per distinct tile key).
   * Empty when the brain is not cached or is clean.
   */
  getBrainDiagnostics(archetype: Archetype): readonly BrainDiagnosticEntry[] {
    const brain = this.host.getCachedBrain(archetype);
    if (!brain) {
      return [];
    }
    return [
      ...collectBrainErrorDiagnostics(brain),
      ...collectBrainTileCompileDiagnostics(brain, (key) => this.host.getTileCompileDiagnostics(key)),
    ];
  }

  // -- Project metadata --

  async updateProjectMetadata(updates: Partial<Pick<ProjectManifest, "name" | "description">>): Promise<void> {
    await this.host.updateProjectMetadata(updates);
  }

  // -- Project lifecycle (delegate) --

  onProjectUnloading(listener: () => void): () => void {
    return this.host.onProjectUnloading(listener);
  }

  onProjectLoaded(listener: () => void): () => void {
    return this.host.onProjectLoaded(listener);
  }

  // -- Project switching / creation --

  async createProject(name: string): Promise<ProjectManifest> {
    this._isSwitchingProject = true;
    try {
      return await this.host.createProject(name);
    } finally {
      this._isSwitchingProject = false;
    }
  }

  async switchProject(id: string): Promise<void> {
    this._isSwitchingProject = true;
    try {
      await this.host.switchProject(id);
    } finally {
      this._isSwitchingProject = false;
    }
  }

  async switchProjectCollectionAndOpenProject(
    projectCollectionId: string,
    projectId: string
  ): Promise<ProjectCollectionProjectCommitResult> {
    this._isSwitchingProject = true;
    try {
      return await this.host.switchProjectCollectionAndOpenProject(projectCollectionId, projectId);
    } finally {
      this._isSwitchingProject = false;
    }
  }

  async switchProjectCollectionAndCreateProject(
    projectCollectionId: string,
    name: string
  ): Promise<ProjectCollectionProjectCommitResult> {
    this._isSwitchingProject = true;
    try {
      return await this.host.switchProjectCollectionAndCreateProject(projectCollectionId, name);
    } finally {
      this._isSwitchingProject = false;
    }
  }

  async unlockProjectCollection(projectCollectionId: string, pin: string): Promise<ProjectCollection> {
    const result = await this.host.unlockProjectCollection(projectCollectionId, pin);
    if (this.host.projectManager.activeProjectCollection?.projectCollectionId === projectCollectionId) {
      await this.loadActiveProjectRuntime();
    }
    return result.collection;
  }

  async lockProjectCollection(projectCollectionId: string): Promise<void> {
    await this.host.lockProjectCollection(projectCollectionId);
  }

  // -- Project export / import --

  async exportProject(): Promise<string> {
    return buildEcosimExportDocument(this.host.projectManager, this.getDesiredCounts(), this._obstacles);
  }

  async importProject(file: File): Promise<ImportResult> {
    return importProjectDocument(file, simName, this.host.projectManager, {
      appChunkCallback: translateEcosimAppChunk,
    });
  }

  async loadAppData(key: string): Promise<string | undefined> {
    return this.host.projectManager.loadAppData(key);
  }

  flushPendingBrainRebuilds(): void {
    this.host.flushPendingBrainRebuilds();
  }

  // -- Doc / VFS revision (delegate) --

  get docRevision(): number {
    return this.host.docRevision;
  }

  bumpDocRevision(): void {
    this.host.bumpDocRevision();
  }

  bumpVfsRevision(): void {
    this.host.bumpVfsRevision();
  }

  subscribeToDocRevision = (listener: () => void): (() => void) => {
    return this.host.subscribeToDocRevision(listener);
  };

  getDocRevisionSnapshot = (): number => {
    return this.host.getDocRevisionSnapshot();
  };

  subscribeToVfsRevision = (listener: () => void): (() => void) => {
    return this.host.subscribeToVfsRevision(listener);
  };

  getVfsRevisionSnapshot = (): number => {
    return this.host.getVfsRevisionSnapshot();
  };

  /**
   * Resolves a compiler-minted `/vfs/<path>` asset URL to an object URL over
   * the served project file system, cached per VFS revision. Other URLs pass
   * through unchanged.
   */
  resolveVfsAssetUrl(url: string): string {
    return this._vfsAssetUrlProvider.resolveAssetUrl(url);
  }

  // -- App Settings (sim-specific) --

  getAppSettings(): AppSettings {
    return this._appSettings;
  }

  updateAppSettings(patch: Partial<AppSettings>): void {
    const prev = this._appSettings;
    this._appSettings = normalizeAppSettings({ ...this._appSettings, ...patch });
    persistAppSettings(this._appSettings);
    for (const fn of this._appSettingsListeners) {
      fn(this._appSettings, prev);
    }
  }

  onAppSettingsChange(fn: AppSettingsListener): () => void {
    this._appSettingsListeners.add(fn);
    return () => {
      this._appSettingsListeners.delete(fn);
    };
  }

  // -- UI Preferences (sim-specific) --

  getUiPreferences(): UiPreferences {
    return this._uiPreferences;
  }

  updateUiPreferences(patch: Partial<UiPreferences>): void {
    this._uiPreferences = { ...this._uiPreferences, ...patch };
    const projectId = this.host.projectManager.activeProject?.manifest.id;
    if (projectId) {
      persistUiPreferences(projectId, this._uiPreferences);
    }
  }

  // -- Collapsed archetypes (global) --

  getCollapsedArchetypes(): Record<string, boolean> {
    return this._collapsedArchetypes;
  }

  updateCollapsedArchetypes(value: Record<string, boolean>): void {
    this._collapsedArchetypes = value;
    persistCollapsedArchetypes(value);
  }

  // -- Collapsed Dev Panel (global) --

  getDevPanelCollapsed(): boolean {
    return this._devPanelCollapsed;
  }

  updateDevPanelCollapsed(value: boolean): void {
    this._devPanelCollapsed = value;
    persistDevPanelCollapsed(value);
  }

  // -- Desired population counts (per-project, debounced auto-save) --

  getDesiredCounts(): Record<Archetype, number> {
    return this._desiredCounts;
  }

  setDesiredCount(archetype: Archetype, count: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(count)));
    this._desiredCounts = { ...this._desiredCounts, [archetype]: clamped };
    if (this._desiredCountsSaveTimer !== undefined) {
      clearTimeout(this._desiredCountsSaveTimer);
    }
    this._desiredCountsSaveTimer = setTimeout(() => {
      this._desiredCountsSaveTimer = undefined;
      void this.host.projectManager.saveAppData(DESIRED_COUNTS_KEY, JSON.stringify(this._desiredCounts));
    }, DESIRED_COUNTS_DEBOUNCE_MS);
  }

  onDesiredCountsReloaded(listener: () => void): () => void {
    this._desiredCountsListeners.add(listener);
    return () => {
      this._desiredCountsListeners.delete(listener);
    };
  }

  // -- Obstacles (per-project, persisted on first generation) --

  /**
   * Returns the cached obstacles for the active project. `undefined` means
   * no obstacles have been persisted yet -- the scene should generate a
   * fresh set and call {@link setObstacles}.
   */
  getObstacles(): Obstacle[] | undefined {
    return this._obstacles;
  }

  setObstacles(obstacles: ReadonlyArray<Obstacle>): void {
    const next = obstacles.map((o) => ({
      x: o.x,
      y: o.y,
      width: o.width,
      height: o.height,
      ...(o.rotation !== undefined ? { rotation: o.rotation } : {}),
    }));
    this._obstacles = next;
    void this.host.projectManager.saveAppData(OBSTACLES_KEY, JSON.stringify(next));
  }

  // -- Bridge (delegate) --

  connectBridge(): void {
    this.host.connectBridge();
  }

  /**
   * Ends the bridge's session on purpose -- VS Code is told it ended -- and
   * discards the bridge, so the next connect presents whatever binding token
   * is persisted then.
   */
  endBridge(): void {
    this.host.endBridge();
  }

  subscribeToBridgeStatus = (listener: () => void): (() => void) => {
    return this.host.subscribeToBridgeStatus(listener);
  };

  getBridgeStatusSnapshot = (): AppBridgeState => {
    return this.host.getBridgeStatusSnapshot();
  };

  subscribeToBridgeJoinCode = (listener: () => void): (() => void) => {
    return this.host.subscribeToBridgeJoinCode(listener);
  };

  getBridgeJoinCodeSnapshot = (): string | undefined => {
    return this.host.getBridgeJoinCodeSnapshot();
  };

  subscribeToBridgeErrorCode = (listener: () => void): (() => void) => {
    return this.host.subscribeToBridgeErrorCode(listener);
  };

  /** Stable code of the failure that ended the bridge's latest connection, or undefined when none did. */
  getBridgeErrorCodeSnapshot = (): BridgeSessionErrorCode | undefined => {
    return this.host.getBridgeErrorCodeSnapshot();
  };

  subscribeToBridgePaired = (listener: () => void): (() => void) => {
    return this.host.subscribeToBridgePaired(listener);
  };

  /** Whether the bridge's session is connected with VS Code: welcomed, and VS Code not away since. */
  getBridgePairedSnapshot = (): boolean => {
    return this.host.getBridgePairedSnapshot();
  };
}

/** Docs category label for each tile-bearing user-action kind. */
const kUserTileDocCategories: Record<Exclude<ActionKind, "conversion">, string> = {
  sensor: "Sensors",
  actuator: "Actuators",
};

function buildDocEntries(metadata: readonly UserTileMetadata[]): DocsTileEntry[] {
  const entries: DocsTileEntry[] = [];
  for (const entry of metadata) {
    entries.push({
      tileId: mkActionTileId(entry.kind, entry.key),
      tags: entry.tags ? [...entry.tags] : [],
      category: kUserTileDocCategories[entry.kind],
      content: entry.docsMarkdown ?? "",
    });
  }
  return entries;
}
