import type { ProjectCollection, ProjectCollectionState, ProjectManifest } from "@wendoo/app-host";
import { AppHostError } from "@wendoo/app-host";
import { assistantToolManifest } from "@wendoo/assistant-bridge/relay";
import type { EditedBrainWorkspaces } from "@wendoo/assistant-panel";
import {
  AssistantProvider,
  assistantSessionUrl,
  createEditedBrainWorkspaces,
  createPersonActivity,
  createWebSocketConnect,
  useAssistant,
} from "@wendoo/assistant-panel";
import type { BrainDef } from "@wendoo/core/app";
import type { ITileCatalog } from "@wendoo/core/brain";
import { DocsSidebar, DocsSidebarProvider, useDocsSidebar } from "@wendoo/docs";
import {
  BrainEditorDialog,
  type BrainEditorDialogProps,
  BrainEditorProvider,
  Button,
  ProjectPickerDialog,
  type ProjectPickerItem,
  Toaster,
} from "@wendoo/ui";
import { Lock, Menu, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { ArchetypeStats, ScoreSnapshot } from "@/brain/score";
import type { Archetype } from "./brain/actor";
import { ARCHETYPES } from "./brain/archetypes";
import type { BrainLoadFailure } from "./brain/brain-load-failure";
import { buildBrainEditorConfig } from "./brain/editor/config";
import { dataTypeIconMap, dataTypeNameMap } from "./brain/editor/data-type-icons";
import { createVfsAwareVisualProvider } from "./brain/editor/visual-provider";
import { AssistantSidePanel } from "./components/AssistantSidePanel";
import { NewProjectDialog } from "./components/NewProjectDialog";
import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
import { ProjectHeader } from "./components/ProjectHeader";
import { Sidebar } from "./components/Sidebar";
import { WendooLogotype } from "./components/WendooLogo";
import { WorkspacePinInput } from "./components/WorkspacePinInput";
import { useEcosimEnvironment } from "./contexts/ecosim-environment";
import { createDocsRegistry } from "./docs/docs-registry";
import type { Playground, SceneBrainState } from "./game/scenes/Playground";
import { PhaserGame } from "./PhaserGame";
import { createTargetAdapter } from "./rehearsal/adapter";
import { clientBuild } from "./services/client-build";
import { ecosimEmbeddedExtensions } from "./services/ecosim-embedded-extensions";
import {
  addEcosimLibrary,
  buildEcosimLibraryShelf,
  ecosimFeaturedNamespaces,
} from "./services/ecosim-extension-browser";
import { ecosimLibraryOfferToasts } from "./services/library-offer-toasts";
import { downloadTextFile } from "./utils/file-download";
import { pickFile } from "./utils/file-upload";

/** Compare two snapshots by display-relevant fields to skip no-op re-renders. */
function statsEqual(
  a: ScoreSnapshot[keyof ScoreSnapshot & string],
  b: ScoreSnapshot[keyof ScoreSnapshot & string]
): boolean {
  if (typeof a === "number") return a === b;
  const sa = a as ArchetypeStats;
  const sb = b as ArchetypeStats;
  return (
    sa.aliveCount === sb.aliveCount &&
    sa.deaths === sb.deaths &&
    Math.round(sa.totalEnergy) === Math.round(sb.totalEnergy) &&
    Math.round(sa.longestLife) === Math.round(sb.longestLife)
  );
}

function snapshotEqual(a: ScoreSnapshot, b: ScoreSnapshot): boolean {
  return (
    a.ecosystemScore === b.ecosystemScore &&
    Math.round(a.elapsed) === Math.round(b.elapsed) &&
    statsEqual(a.carnivore, b.carnivore) &&
    statsEqual(a.herbivore, b.herbivore) &&
    statsEqual(a.plant, b.plant)
  );
}

/** Name to present the entity by while the editor stands no working copy of it. */
function archetypeBrainName(archetype: Archetype | null): string {
  return archetype ? ARCHETYPES[archetype].brainName : "Brain";
}

/**
 * Wrapper that injects docs integration from the docs context, and the
 * assistant's conversation surface, into the brain editor config.
 */
function DocsBrainEditorProvider({
  archetype,
  brainId,
  workspaces,
  children,
}: {
  archetype: Archetype | null;
  /** Document id of the brain the editor is opening on, absent while it opens on none. */
  brainId: string | undefined;
  workspaces: EditedBrainWorkspaces;
  children: React.ReactNode;
}) {
  const {
    openDocsForTile,
    isOpen: isDocsOpen,
    toggle: toggleDocs,
    close: closeDocs,
    reportEditorMode,
  } = useDocsSidebar();
  const store = useEcosimEnvironment();
  // Whether the panel stands open, per brain the editor has opened on. A brain
  // not in it stands closed. Held for as long as the app runs, and no longer.
  const [assistantOpenByBrain, setAssistantOpenByBrain] = useState<Record<string, boolean>>({});
  // Where the panel stands while the editor names no brain, which nothing is
  // remembered for.
  const [isAssistantOpenForNoBrain, setIsAssistantOpenForNoBrain] = useState(false);
  const isAssistantOpen = brainId === undefined ? isAssistantOpenForNoBrain : assistantOpenByBrain[brainId] === true;
  // How many times the person themselves opened the panel. An open the editor
  // restores from what the panel stood at before raises nothing, so it takes no
  // keyboard.
  const [assistantOpensByPerson, setAssistantOpensByPerson] = useState<number | undefined>(undefined);
  const toggleAssistant = useCallback(() => {
    if (!isAssistantOpen) setAssistantOpensByPerson((opens) => (opens ?? 0) + 1);
    if (brainId === undefined) {
      setIsAssistantOpenForNoBrain((open) => !open);
      return;
    }
    setAssistantOpenByBrain((open) => ({ ...open, [brainId]: open[brainId] !== true }));
  }, [brainId, isAssistantOpen]);
  // The count is scoped to one editing: the editor standing another brain, or
  // none, starts it over, so an open restored from memory takes no keyboard.
  useEffect(() => {
    void brainId;
    setAssistantOpensByPerson(undefined);
  }, [brainId]);
  const vfsRevision = useSyncExternalStore(store.subscribeToVfsRevision, store.getVfsRevisionSnapshot);
  // Rebuild the config (and thus the isBrokenTile predicate identity) after each
  // workspace compile so broken-tile badges appear/disappear as tiles change
  // their compile status while the editor is open.
  const compileDiagnostics = useSyncExternalStore(
    store.subscribeToCompileDiagnostics,
    store.getCompileDiagnosticsSnapshot
  );
  const entityName = archetypeBrainName(archetype);
  const config = useMemo(() => {
    // A VFS revision bump re-creates the config so tiles re-resolve their
    // asset URLs against the new generation.
    void vfsRevision;
    void compileDiagnostics;
    return buildBrainEditorConfig({
      store,
      archetype: archetype ?? undefined,
      onTileDocs: openDocsForTile,
      docsIntegration: { isOpen: isDocsOpen, toggle: toggleDocs, close: closeDocs, reportMode: reportEditorMode },
      sidePanel: {
        isOpen: isAssistantOpen,
        toggle: toggleAssistant,
        label: entityName,
        content: (
          <AssistantSidePanel
            isOpen={isAssistantOpen}
            fallbackName={entityName}
            workspaces={workspaces}
            opensByPerson={assistantOpensByPerson}
          />
        ),
      },
      isBrokenTile: (tile) => store.host.getTileCompileDiagnostics(tile.action.key) !== undefined,
    });
  }, [
    store,
    archetype,
    entityName,
    workspaces,
    vfsRevision,
    compileDiagnostics,
    openDocsForTile,
    isDocsOpen,
    toggleDocs,
    closeDocs,
    reportEditorMode,
    isAssistantOpen,
    toggleAssistant,
    assistantOpensByPerson,
  ]);
  return <BrainEditorProvider config={config}>{children}</BrainEditorProvider>;
}

/**
 * The brain editor as this app stands it. Closing it -- by saving or by
 * discarding -- ends whatever the assistant is still doing.
 */
function ClosingBrainEditor({ isOpen, onOpenChange, srcBrainDef, onSubmit }: BrainEditorDialogProps) {
  const { stopAll } = useAssistant();
  return (
    <BrainEditorDialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) stopAll();
        onOpenChange(open);
      }}
      srcBrainDef={srcBrainDef}
      onSubmit={(newBrainDef) => {
        stopAll();
        onSubmit(newBrainDef);
      }}
    />
  );
}

interface PickerWorkspace {
  collection: ProjectCollection;
  pending: boolean;
  createdByFlow: boolean;
  context?: string;
}

interface PickerProjectListState {
  projectCollectionId: string;
  projects: ProjectManifest[];
}

function App() {
  const store = useEcosimEnvironment();
  const assistant = useMemo(() => {
    const adapter = createTargetAdapter();
    const activity = createPersonActivity();
    return {
      manifest: assistantToolManifest(adapter),
      clientBuild,
      activity,
      workspaces: createEditedBrainWorkspaces({
        environment: store.env,
        adapter,
        activity,
        featuring: () => ({
          featured: ecosimFeaturedNamespaces,
          ...(store.activeProjectManifest ? { hostNamespace: store.activeProjectManifest.id } : {}),
        }),
        libraryShelf: () => buildEcosimLibraryShelf(store.activeProjectManifest?.extensions, ecosimEmbeddedExtensions),
        installLibrary: (coordinate) =>
          addEcosimLibrary(
            store.host,
            store.activeProjectManifest?.extensions,
            ecosimEmbeddedExtensions,
            coordinate,
            ecosimLibraryOfferToasts
          ),
      }),
      connect: () => createWebSocketConnect(assistantSessionUrl(store.getAppSettings().assistantServiceUrl))(),
    };
  }, [store]);
  const [isBrainEditorOpen, setIsBrainEditorOpen] = useState(false);
  const [editingArchetype, setEditingArchetype] = useState<Archetype | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [timeSpeed, setTimeSpeed] = useState(() => store.getUiPreferences().timeScale);
  const [debugEnabled, setDebugEnabled] = useState(() => store.getUiPreferences().debugEnabled);
  const [isPlaying, setIsPlaying] = useState(true);
  const [scene, setScene] = useState<Playground | null>(null);
  const [brainsLoaded, setBrainsLoaded] = useState(false);
  const [brainLoadFailure, setBrainLoadFailure] = useState<BrainLoadFailure | undefined>();
  const [snapshot, setSnapshot] = useState<ScoreSnapshot | null>(null);
  const prevSnapshotRef = useRef<ScoreSnapshot | null>(null);

  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);
  const [isNewWorkspaceOpen, setIsNewWorkspaceOpen] = useState(false);
  const [pickerWorkspace, setPickerWorkspace] = useState<PickerWorkspace | undefined>();
  const [projectCollectionState, setProjectCollectionState] = useState<ProjectCollectionState | undefined>();
  const [projectName, setProjectName] = useState(() => store.activeProjectManifest?.name ?? "");
  const [activeUnlockPin, setActiveUnlockPin] = useState("");
  const [activeUnlockError, setActiveUnlockError] = useState<string | undefined>();
  const [activeUnlockBusy, setActiveUnlockBusy] = useState(false);
  const [projectListState, setProjectListState] = useState<PickerProjectListState | undefined>();
  const pickerCommitInProgressRef = useRef(false);
  const newProjectCommitInProgressRef = useRef(false);
  const pendingWorkspaceCleanupRef = useRef<string | undefined>(undefined);

  /** Closes the brain editor and drops the archetype it was editing. */
  const closeBrainEditor = useCallback(() => {
    setIsBrainEditorOpen(false);
    setEditingArchetype(null);
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribeProjectCollectionState = () => {};
    store.projectManager
      .watchProjectCollectionState((state) => {
        setProjectCollectionState(state);
        setProjectName(store.activeProjectManifest?.name ?? "");
      })
      .then(
        (subscription) => {
          if (!active) {
            subscription.unsubscribe();
            return;
          }
          unsubscribeProjectCollectionState = subscription.unsubscribe;
          setProjectCollectionState(subscription.initial);
          setProjectName(store.activeProjectManifest?.name ?? "");
        },
        () => {
          if (active) {
            toast.error("Failed to load workspace state");
          }
        }
      );
    const unsubLoaded = store.onProjectLoaded(() => {
      const prefs = store.getUiPreferences();
      setTimeSpeed(prefs.timeScale);
      setDebugEnabled(prefs.debugEnabled);
      // An open editor holds a working copy of the outgoing project's brain,
      // which submitting would write into the project that just loaded.
      closeBrainEditor();
    });
    const unsubPersistenceError = store.projectManager.onProjectPersistenceError(() => {
      toast.error("Autosave failed");
    });
    return () => {
      active = false;
      unsubscribeProjectCollectionState();
      unsubLoaded();
      unsubPersistenceError();
    };
  }, [closeBrainEditor, store]);

  useEffect(() => {
    const projectCollectionId = pickerWorkspace?.collection.projectCollectionId;
    if (!projectCollectionId) {
      setProjectListState(undefined);
      return;
    }
    setProjectListState(undefined);
    let active = true;
    let unsubscribeProjectList = () => {};
    store.projectManager
      .watchProjectListForCollection(projectCollectionId, (projects) => {
        setProjectListState({ projectCollectionId, projects });
      })
      .then(
        (subscription) => {
          if (!active) {
            subscription.unsubscribe();
            return;
          }
          unsubscribeProjectList = subscription.unsubscribe;
          setProjectListState({ projectCollectionId, projects: subscription.initial });
        },
        () => {
          if (active) {
            toast.error("Failed to load projects");
            setProjectListState(undefined);
            setIsPickerOpen(false);
            setPickerWorkspace(undefined);
          }
        }
      );
    return () => {
      active = false;
      unsubscribeProjectList();
    };
  }, [pickerWorkspace?.collection.projectCollectionId, store]);

  useEffect(() => {
    if (!pickerWorkspace?.pending) {
      return;
    }
    return store.projectManager.onProjectCollectionEvent((event) => {
      if (
        event.type === "project-collection-tombstoned" &&
        event.projectCollectionId === pickerWorkspace.collection.projectCollectionId
      ) {
        if (pendingWorkspaceCleanupRef.current === event.projectCollectionId) {
          return;
        }
        setIsPickerOpen(false);
        setPickerWorkspace(undefined);
        toast.error("Workspace was removed in another tab");
      }
    });
  }, [pickerWorkspace, store]);

  useEffect(() => {
    if (!scene) return;
    const isDebug = scene.matter.world.drawDebug;
    if (debugEnabled !== isDebug) {
      scene.toggleDebugMode();
    }
  }, [scene, debugEnabled]);

  const pickerProjectCollectionId = pickerWorkspace?.collection.projectCollectionId;
  const pickerProjectListReady =
    pickerProjectCollectionId !== undefined && projectListState?.projectCollectionId === pickerProjectCollectionId;
  const projectList = pickerProjectListReady ? projectListState.projects : [];
  const pickerItems = useMemo<ProjectPickerItem[]>(
    () =>
      projectList.map((p) => ({
        id: p.id,
        title: p.name,
        updatedAt: p.updatedAt,
      })),
    [projectList]
  );

  const openProjectPickerForWorkspace = useCallback(
    (collection: ProjectCollection, context?: string) => {
      const activeCollectionId =
        projectCollectionState?.activeProjectCollection?.projectCollectionId ??
        store.projectManager.activeProjectCollection?.projectCollectionId;
      setPickerWorkspace({
        collection,
        pending: activeCollectionId !== undefined && collection.projectCollectionId !== activeCollectionId,
        createdByFlow: false,
        context,
      });
      setIsPickerOpen(true);
    },
    [projectCollectionState?.activeProjectCollection?.projectCollectionId, store]
  );

  const unlockWorkspace = useCallback(
    async (projectCollectionId: string, pin: string): Promise<ProjectCollection> => {
      return store.unlockProjectCollection(projectCollectionId, pin);
    },
    [store]
  );

  const clearPickerWorkspace = useCallback(() => {
    setPickerWorkspace(undefined);
    setProjectListState(undefined);
  }, []);

  const cancelPickerWorkspace = useCallback(() => {
    const workspace = pickerWorkspace;
    setIsPickerOpen(false);
    clearPickerWorkspace();
    if (workspace?.pending && workspace.createdByFlow) {
      const projectCollectionId = workspace.collection.projectCollectionId;
      pendingWorkspaceCleanupRef.current = projectCollectionId;
      store.projectManager
        .deleteProjectCollection(projectCollectionId)
        .catch(() => {
          toast.error("Failed to delete workspace");
        })
        .finally(() => {
          if (pendingWorkspaceCleanupRef.current === projectCollectionId) {
            pendingWorkspaceCleanupRef.current = undefined;
          }
        });
    }
  }, [clearPickerWorkspace, pickerWorkspace, store]);

  const finishPickerCommit = useCallback(() => {
    pickerCommitInProgressRef.current = false;
    newProjectCommitInProgressRef.current = false;
    setIsPickerOpen(false);
    setIsNewProjectOpen(false);
    clearPickerWorkspace();
  }, [clearPickerWorkspace]);

  const handleSelectProject = useCallback(
    (id: string) => {
      const workspace = pickerWorkspace;
      if (!workspace || pickerCommitInProgressRef.current) {
        return;
      }
      const projects =
        projectListState?.projectCollectionId === workspace.collection.projectCollectionId
          ? projectListState.projects
          : [];
      if (!projects.some((project) => project.id === id)) {
        return;
      }
      pickerCommitInProgressRef.current = true;
      const commit = workspace.pending
        ? store.switchProjectCollectionAndOpenProject(workspace.collection.projectCollectionId, id)
        : store.switchProject(id);
      commit.then(
        () => {
          finishPickerCommit();
        },
        (error: unknown) => {
          pickerCommitInProgressRef.current = false;
          if (error instanceof AppHostError && error.code === "PROJECT_ALREADY_OPEN_IN_ANOTHER_TAB") {
            toast.error("This project is already open in another tab");
          } else {
            toast.error("Failed to open project");
          }
          if (workspace.pending) {
            setIsPickerOpen(true);
          }
        }
      );
    },
    [finishPickerCommit, pickerWorkspace, projectListState, store]
  );

  const handleDeleteProject = useCallback(
    (id: string) => {
      store.projectManager.delete(id).catch(() => {
        toast.error("Failed to delete project");
      });
    },
    [store]
  );

  const handleNewProject = useCallback(() => {
    if (!pickerProjectListReady) {
      return;
    }
    setIsPickerOpen(false);
    setIsNewProjectOpen(true);
  }, [pickerProjectListReady]);

  const handleNewProjectConfirm = useCallback(
    (name: string) => {
      const workspace = pickerWorkspace;
      if (workspace?.pending) {
        newProjectCommitInProgressRef.current = true;
        store.switchProjectCollectionAndCreateProject(workspace.collection.projectCollectionId, name).then(
          () => {
            finishPickerCommit();
          },
          () => {
            newProjectCommitInProgressRef.current = false;
            toast.error("Failed to create project");
            setIsPickerOpen(true);
          }
        );
        return;
      }
      store.createProject(name).then(
        () => {
          finishPickerCommit();
        },
        () => {
          toast.error("Failed to create project");
        }
      );
    },
    [finishPickerCommit, pickerWorkspace, store]
  );

  const handleNewProjectOpenChange = useCallback(
    (open: boolean) => {
      setIsNewProjectOpen(open);
      if (!open && pickerWorkspace?.pending && !newProjectCommitInProgressRef.current) {
        setIsPickerOpen(true);
      }
    },
    [pickerWorkspace]
  );

  const handleProjectPickerOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setIsPickerOpen(true);
        return;
      }
      if (pickerCommitInProgressRef.current) {
        setIsPickerOpen(false);
        return;
      }
      cancelPickerWorkspace();
    },
    [cancelPickerWorkspace]
  );

  const handleNewWorkspaceConfirm = useCallback(
    (name: string) => {
      store.projectManager.createProjectCollection(name).then(
        (collection) => {
          setIsNewWorkspaceOpen(false);
          setPickerWorkspace({
            collection,
            pending: true,
            createdByFlow: true,
            context: `Created ${new Date(collection.createdAt).toLocaleDateString()}`,
          });
          setIsPickerOpen(true);
        },
        (error: unknown) => {
          if (error instanceof AppHostError && error.code === "INVALID_PROJECT_COLLECTION_NAME") {
            toast.error(error.message);
            return;
          }
          toast.error("Failed to create workspace");
        }
      );
    },
    [store]
  );

  const handleActiveWorkspaceUnlock = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const projectCollectionId = projectCollectionState?.activeProjectCollection?.projectCollectionId;
      if (!projectCollectionId || activeUnlockBusy) {
        return;
      }
      setActiveUnlockBusy(true);
      setActiveUnlockError(undefined);
      unlockWorkspace(projectCollectionId, activeUnlockPin).then(
        () => {
          setActiveUnlockPin("");
          setActiveUnlockBusy(false);
          toast.success("Workspace unlocked");
        },
        (error: unknown) => {
          setActiveUnlockBusy(false);
          if (error instanceof AppHostError) {
            setActiveUnlockError(error.message);
            return;
          }
          setActiveUnlockError("Failed to unlock workspace");
        }
      );
    },
    [
      activeUnlockBusy,
      activeUnlockPin,
      projectCollectionState?.activeProjectCollection?.projectCollectionId,
      unlockWorkspace,
    ]
  );

  const handleExportProject = useCallback(() => {
    void (async () => {
      try {
        const unstable = await store.host.collectUnstableProjectDependencies();
        if (unstable.length > 0) {
          const detail = unstable.map((dependency) => `${dependency.coordinate} (${dependency.code})`).join(", ");
          const proceed = window.confirm(
            `This project depends on libraries that are not stable for consumers: ${detail}. ` +
              "The exported project may not work, or may not keep working, for anyone else. Export anyway?"
          );
          if (!proceed) {
            return;
          }
        }
        const json = await store.exportProject();
        const safeName =
          (store.activeProjectManifest?.name ?? "project")
            .replace(/[^a-zA-Z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .toLowerCase() || "project";
        downloadTextFile(json, `${safeName}.wendoo`);
      } catch {
        toast.error("Failed to export project");
      }
    })();
  }, [store]);

  const handleImportProject = useCallback(() => {
    pickFile(".wendoo,.json").then(
      (file) => {
        if (!file) return;
        store.importProject(file).then(
          async (result) => {
            if (!result.success || !result.projectId) {
              const errorMsg = result.diagnostics.find((d) => d.severity === "error")?.message ?? "Import failed";
              toast.error(errorMsg);
              return;
            }

            try {
              await store.switchProject(result.projectId);
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Failed to open imported project";
              toast.error(msg);
              return;
            }

            const warnings = result.diagnostics.filter((d) => d.severity === "warning");
            if (warnings.length > 0) {
              toast.warning(`Imported with ${warnings.length} warning(s)`, {
                description: warnings.map((w) => w.message).join("\n"),
              });
            } else {
              toast.success("Project imported successfully");
            }
          },
          () => {
            toast.error("Failed to import project");
          }
        );
      },
      () => {
        toast.error("Failed to open file picker");
      }
    );
  }, [store]);

  const defaultNewProjectName = useMemo(() => `Project ${projectList.length + 1}`, [projectList.length]);
  const activeWorkspaceLocked = projectCollectionState?.access === "locked";
  const activeWorkspaceName = projectCollectionState?.activeProjectCollection?.name ?? "Workspace";

  useEffect(() => {
    if (activeWorkspaceLocked) {
      setScene(null);
      setBrainsLoaded(false);
      setBrainLoadFailure(undefined);
      setSnapshot(null);
      setIsSidebarOpen(false);
      closeBrainEditor();
      prevSnapshotRef.current = null;
    }
  }, [activeWorkspaceLocked, closeBrainEditor]);

  const docRevision = useSyncExternalStore(store.subscribeToDocRevision, store.getDocRevisionSnapshot);
  const vfsRevision = useSyncExternalStore(store.subscribeToVfsRevision, store.getVfsRevisionSnapshot);
  const docsResolveTileVisual = useMemo(() => {
    // A VFS revision bump re-creates the resolver so docs tiles re-resolve
    // their asset URLs against the new generation.
    void vfsRevision;
    return createVfsAwareVisualProvider((url) => store.resolveVfsAssetUrl(url));
  }, [store, vfsRevision]);
  const docsRegistry = useMemo(() => {
    void docRevision;
    return createDocsRegistry(store.userTileDocEntries);
  }, [docRevision, store]);
  const docsLibraries = useMemo(() => {
    void docRevision;
    return store.host.installedLibraries;
  }, [docRevision, store]);
  const docsTileCatalog = useMemo<ITileCatalog>(() => {
    return {
      get: (tileId: string) => {
        for (const catalog of store.env.tileCatalogs()) {
          const def = catalog.get(tileId);
          if (def) return def;
        }
        return undefined;
      },
    } as ITileCatalog;
  }, [store]);

  useEffect(() => {
    scene?.setTimeSpeed(timeSpeed);
  }, [scene, timeSpeed]);

  useEffect(() => {
    scene?.setPaused(!isPlaying);
  }, [scene, isPlaying]);

  // Restore persisted population counts when the scene becomes available, and
  // re-push them whenever a different project is loaded.
  useEffect(() => {
    if (!scene) return;
    const pushCountsToScene = () => {
      const counts = store.getDesiredCounts();
      for (const [arch, count] of Object.entries(counts)) {
        scene.setDesiredCount(arch as Archetype, count);
      }
    };
    pushCountsToScene();
    return store.onDesiredCountsReloaded(pushCountsToScene);
  }, [scene, store]);

  // Poll the engine for score data. The snapshot is a fresh object each call,
  // so compare rounded display values to avoid re-renders when nothing the
  // user can see has changed.
  useEffect(() => {
    if (!scene) return;
    const id = setInterval(() => {
      const next = scene.getScoreSnapshot();
      const prev = prevSnapshotRef.current;
      if (prev && snapshotEqual(prev, next)) return;
      prevSnapshotRef.current = next;
      setSnapshot(next);
    }, 250);
    return () => clearInterval(id);
  }, [scene]);

  const handleTogglePlay = useCallback((playing: boolean) => {
    setIsPlaying(playing);
  }, []);

  const handleTimeSpeedChange = useCallback(
    (speed: number) => {
      setTimeSpeed(speed);
      store.updateUiPreferences({ timeScale: speed });
    },
    [store]
  );

  const handleEditBrain = useCallback((archetype: Archetype) => {
    setEditingArchetype(archetype);
    setIsBrainEditorOpen(true);
  }, []);

  const handleDesiredCountChange = useCallback(
    (archetype: Archetype, count: number) => {
      scene?.setDesiredCount(archetype, count);
      store.setDesiredCount(archetype, count);
    },
    [scene, store]
  );

  const handleToggleDebug = useCallback(() => {
    scene?.toggleDebugMode();
    setDebugEnabled((prev) => {
      const next = !prev;
      store.updateUiPreferences({ debugEnabled: next });
      return next;
    });
  }, [scene, store]);

  const brainDefForEditing: BrainDef | undefined = editingArchetype ? scene?.getBrainDef(editingArchetype) : undefined;

  const handleBrainSubmit = (brainDef: BrainDef) => {
    if (editingArchetype) {
      scene?.updateBrainDef(editingArchetype, brainDef);
      void store.saveBrainForArchetype(editingArchetype, brainDef);
    }
    setEditingArchetype(null);
    setIsBrainEditorOpen(false);
  };

  const handleSceneBrainState = useCallback((state: SceneBrainState) => {
    setScene(state.scene);
    setBrainsLoaded(state.brainsLoaded);
    setBrainLoadFailure(state.brainLoadFailure);
  }, []);

  return (
    <AssistantProvider
      connect={assistant.connect}
      manifest={assistant.manifest}
      clientBuild={assistant.clientBuild}
      workspace={assistant.workspaces.workspaceFor}
      activity={assistant.activity}
    >
      <DocsSidebarProvider
        registry={docsRegistry}
        tileCatalog={docsTileCatalog}
        brainServices={store.env.brainServices}
        libraries={docsLibraries}
        dataTypeNames={dataTypeNameMap}
        dataTypeIcons={dataTypeIconMap}
        resolveTileVisual={docsResolveTileVisual}
      >
        <div className="h-screen flex bg-background overflow-hidden">
          <h1 className="sr-only">Wendoo Simulation</h1>
          {/* Game Canvas -- flex-1 lets the Phaser Scale.FIT fill available space */}
          <main className="flex-1 min-w-0 relative bg-canvas" aria-label="Game canvas">
            {activeWorkspaceLocked ? (
              <div className="flex h-full min-h-screen items-center justify-center bg-background p-4 text-foreground">
                <form
                  className="w-full max-w-sm rounded-lg border border-border bg-card p-5 shadow-2xl"
                  onSubmit={handleActiveWorkspaceUnlock}
                >
                  <div className="mb-4 flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning">
                      <Lock className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate text-lg font-semibold">Workspace Locked</h2>
                      <p className="truncate text-sm text-muted-foreground">{activeWorkspaceName}</p>
                    </div>
                  </div>
                  <WorkspacePinInput
                    label="PIN"
                    value={activeUnlockPin}
                    disabled={activeUnlockBusy}
                    autoFocus
                    labelClassName="text-sm font-medium text-foreground"
                    inputClassName="border-input bg-background"
                    buttonClassName="text-muted-foreground hover:text-foreground"
                    resetVisibilityKey={projectCollectionState?.activeProjectCollection?.projectCollectionId}
                    onValueChange={(value) => {
                      setActiveUnlockPin(value);
                      setActiveUnlockError(undefined);
                    }}
                  />
                  {activeUnlockError && (
                    <p className="mt-2 text-sm text-destructive" role="alert">
                      {activeUnlockError}
                    </p>
                  )}
                  <Button className="mt-4 w-full" type="submit" disabled={!activeUnlockPin || activeUnlockBusy}>
                    {activeUnlockBusy ? "Unlocking..." : "Unlock Workspace"}
                  </Button>
                </form>
              </div>
            ) : (
              <PhaserGame store={store} onSceneBrainState={handleSceneBrainState} />
            )}
            <ProjectHeader
              projectName={projectName}
              projectCollectionState={projectCollectionState}
              onBrowseProjects={openProjectPickerForWorkspace}
              onUnlockWorkspace={unlockWorkspace}
              onNewProject={() => setIsNewProjectOpen(true)}
              onNewWorkspace={() => setIsNewWorkspaceOpen(true)}
              onExportProject={handleExportProject}
              onImportProject={handleImportProject}
            />
            {!activeWorkspaceLocked && (
              <button
                type="button"
                className="absolute top-3 right-3 z-40 md:hidden flex items-center justify-center w-10 h-10 rounded-lg bg-background/80 backdrop-blur border border-border shadow-md"
                onClick={() => setIsSidebarOpen((o) => !o)}
                aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
              >
                {isSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            )}
            {!activeWorkspaceLocked && (
              <WendooLogotype className="pointer-events-none absolute bottom-3 left-3 z-30 h-7 w-auto text-foreground/30" />
            )}
          </main>

          {/* Backdrop -- mobile only */}
          {!activeWorkspaceLocked && isSidebarOpen && (
            <div
              className="fixed inset-0 z-40 bg-black/50 md:hidden"
              onClick={() => setIsSidebarOpen(false)}
              aria-hidden="true"
            />
          )}

          {!activeWorkspaceLocked && (
            <Sidebar
              snapshot={snapshot}
              timeSpeed={timeSpeed}
              onTimeSpeedChange={handleTimeSpeedChange}
              isPlaying={isPlaying}
              onTogglePlay={handleTogglePlay}
              onEditBrain={handleEditBrain}
              brainsReady={scene !== null && brainsLoaded}
              brainLoadFailure={brainLoadFailure}
              onDesiredCountChange={handleDesiredCountChange}
              onToggleDebug={handleToggleDebug}
              debugEnabled={debugEnabled}
              isOpen={isSidebarOpen}
              onClose={() => setIsSidebarOpen(false)}
            />
          )}

          {/* Brain Editor Dialog (rendered at root for proper overlay) */}
          <DocsBrainEditorProvider
            archetype={editingArchetype}
            brainId={brainDefForEditing?.id()}
            workspaces={assistant.workspaces}
          >
            <ClosingBrainEditor
              isOpen={isBrainEditorOpen}
              onOpenChange={(open) => {
                setIsBrainEditorOpen(open);
                if (!open) {
                  setEditingArchetype(null);
                }
              }}
              srcBrainDef={brainDefForEditing}
              onSubmit={handleBrainSubmit}
            />
          </DocsBrainEditorProvider>

          <ProjectPickerDialog
            open={isPickerOpen}
            onOpenChange={handleProjectPickerOpenChange}
            title={`Projects in ${pickerWorkspace?.collection.name ?? "Workspace"}`}
            description={
              pickerWorkspace?.pending
                ? `Choose a project to open this workspace, or close to stay in ${
                    projectCollectionState?.activeProjectCollection?.name ?? "the current workspace"
                  }.`
                : "Select a project to open, or create a new one."
            }
            workspaceContext={pickerWorkspace?.context}
            emptyStateMessage={
              pickerProjectListReady
                ? `${pickerWorkspace?.collection.name ?? "This workspace"} has no projects yet.`
                : "Loading projects..."
            }
            projects={pickerItems}
            activeProjectId={projectCollectionState?.activeProjectId}
            projectDeletionDisabled={pickerWorkspace?.pending === true}
            onSelect={handleSelectProject}
            onDelete={handleDeleteProject}
            onCreate={handleNewProject}
          />

          <NewProjectDialog
            open={isNewProjectOpen}
            onOpenChange={handleNewProjectOpenChange}
            onConfirm={handleNewProjectConfirm}
            defaultName={defaultNewProjectName}
          />

          <NewWorkspaceDialog
            open={isNewWorkspaceOpen}
            onOpenChange={setIsNewWorkspaceOpen}
            onConfirm={handleNewWorkspaceConfirm}
          />
        </div>

        {/* Docs sidebar -- fixed overlay, sibling to main layout */}
        <DocsSidebar />
        <Toaster />
      </DocsSidebarProvider>
    </AssistantProvider>
  );
}

export default App;
