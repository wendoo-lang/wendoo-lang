import type {
  ProjectCollection,
  ProjectCollectionState,
  ProjectCollectionSummary,
  ProjectCollectionSummaryChange,
} from "@wendoo/app-host";
import { AppHostError, DEFAULT_PROJECT_COLLECTION_ID } from "@wendoo/app-host";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Input,
} from "@wendoo/ui";
import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  Lock,
  LockOpen,
  Menu,
  Pencil,
  Plus,
  Shield,
  Trash2,
  Unlock,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useEcosimEnvironment } from "@/contexts/ecosim-environment";
import { WorkspacePinDialog, type WorkspacePinDialogMode } from "./WorkspacePinDialog";

interface ProjectHeaderProps {
  projectName: string;
  projectCollectionState: ProjectCollectionState | undefined;
  onBrowseProjects: (collection: ProjectCollection, context?: string) => void;
  onUnlockWorkspace: (projectCollectionId: string, pin: string) => Promise<ProjectCollection>;
  onNewProject: () => void;
  onNewWorkspace: () => void;
  onExportProject: () => void;
  onImportProject: () => void;
}

interface WorkspacePinDialogState {
  mode: WorkspacePinDialogMode;
  summary: ProjectCollectionSummary;
  context?: string;
  browseAfterUnlock: boolean;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  if (hours < 24) return `Updated ${hours}h ago`;
  if (days === 1) return "Updated yesterday";
  if (days < 30) return `Updated ${days}d ago`;
  return `Created ${new Date(timestamp).toLocaleDateString()}`;
}

function formatProjectCount(projectCount: number): string {
  return projectCount === 1 ? "1 project" : `${projectCount} projects`;
}

function applySummaryChange(
  summaries: ProjectCollectionSummary[],
  change: ProjectCollectionSummaryChange
): ProjectCollectionSummary[] {
  if (change.type === "remove") {
    return summaries.filter((summary) => summary.collection.projectCollectionId !== change.projectCollectionId);
  }
  const index = summaries.findIndex(
    (summary) => summary.collection.projectCollectionId === change.summary.collection.projectCollectionId
  );
  if (index === -1) {
    return [...summaries, change.summary].sort((a, b) => a.collection.createdAt - b.collection.createdAt);
  }
  const next = summaries.slice();
  next[index] = change.summary;
  return next;
}

function getDuplicateNames(summaries: readonly ProjectCollectionSummary[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    counts.set(summary.collection.name, (counts.get(summary.collection.name) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) {
      duplicates.add(name);
    }
  }
  return duplicates;
}

function getWorkspaceContext(summary: ProjectCollectionSummary, duplicateNames: ReadonlySet<string>): string {
  if (duplicateNames.has(summary.collection.name)) {
    return formatRelativeTime(summary.collection.updatedAt);
  }
  return formatProjectCount(summary.projectCount);
}

function formatDeleteWorkspaceDescription(summary: ProjectCollectionSummary | undefined): string {
  if (!summary) {
    return "This workspace and its projects will be deleted.";
  }
  return `Workspace "${summary.collection.name}" and ${formatProjectCount(summary.projectCount)} will be deleted.`;
}

export function ProjectHeader({
  projectName,
  projectCollectionState,
  onBrowseProjects,
  onUnlockWorkspace,
  onNewProject,
  onNewWorkspace,
  onExportProject,
  onImportProject,
}: ProjectHeaderProps) {
  const store = useEcosimEnvironment();
  const { showProjectMenu } = store.chrome;
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [projectNameValue, setProjectNameValue] = useState("");
  const [workspaceSummaries, setWorkspaceSummaries] = useState<ProjectCollectionSummary[] | undefined>();
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | undefined>();
  const [openWorkspaceActionId, setOpenWorkspaceActionId] = useState<string | undefined>();
  const [workspaceNameValue, setWorkspaceNameValue] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<ProjectCollectionSummary | undefined>();
  const [removePinCandidate, setRemovePinCandidate] = useState<ProjectCollectionSummary | undefined>();
  const [pinDialog, setPinDialog] = useState<WorkspacePinDialogState | undefined>();
  const [pinDialogError, setPinDialogError] = useState<string | undefined>();
  const [pinDialogBusy, setPinDialogBusy] = useState(false);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const workspaceInputRef = useRef<HTMLInputElement>(null);
  const workspaceAcceptButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceCancelButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceDropdownContentRef = useRef<HTMLDivElement>(null);
  const previousRenamingWorkspaceIdRef = useRef<string | undefined>(undefined);
  const pendingWorkspaceFocusIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!showProjectMenu) {
      return;
    }
    let active = true;
    let unsubscribe = () => {};
    store.projectManager
      .watchProjectCollectionSummaries((change) => {
        setWorkspaceSummaries((current) => applySummaryChange(current ?? [], change));
      })
      .then(
        (subscription) => {
          if (!active) {
            subscription.unsubscribe();
            return;
          }
          unsubscribe = subscription.unsubscribe;
          setWorkspaceSummaries(subscription.initial);
        },
        () => {
          if (active) {
            toast.error("Failed to load workspaces");
            setWorkspaceSummaries([]);
          }
        }
      );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [showProjectMenu, store]);

  useEffect(() => {
    if (!pinDialog || workspaceSummaries === undefined) {
      return;
    }
    const exists = workspaceSummaries.some(
      (summary) => summary.collection.projectCollectionId === pinDialog.summary.collection.projectCollectionId
    );
    if (!exists) {
      setPinDialog(undefined);
      setPinDialogError(undefined);
      setPinDialogBusy(false);
      toast.error("Workspace was removed in another tab");
    }
  }, [pinDialog, workspaceSummaries]);

  useEffect(() => {
    if (isEditingProject) {
      projectInputRef.current?.select();
    }
  }, [isEditingProject]);

  useEffect(() => {
    if (renamingWorkspaceId) {
      workspaceInputRef.current?.select();
    }
  }, [renamingWorkspaceId]);

  useLayoutEffect(() => {
    const previousRenamingWorkspaceId = previousRenamingWorkspaceIdRef.current;
    if (previousRenamingWorkspaceId && !renamingWorkspaceId) {
      pendingWorkspaceFocusIdRef.current = previousRenamingWorkspaceId;
    }
    previousRenamingWorkspaceIdRef.current = renamingWorkspaceId;
  }, [renamingWorkspaceId]);

  useLayoutEffect(() => {
    const pendingWorkspaceFocusId = pendingWorkspaceFocusIdRef.current;
    if (!pendingWorkspaceFocusId || renamingWorkspaceId) {
      return;
    }
    const workspaceRowIsReady =
      workspaceSummaries?.some((summary) => summary.collection.projectCollectionId === pendingWorkspaceFocusId) ??
      false;
    if (!workspaceRowIsReady) {
      return;
    }
    const rows = workspaceDropdownContentRef.current?.querySelectorAll<HTMLButtonElement>("[data-workspace-row-id]");
    const targetRow = rows
      ? Array.from(rows).find((row) => row.dataset.workspaceRowId === pendingWorkspaceFocusId)
      : undefined;
    if (targetRow) {
      targetRow.focus();
      pendingWorkspaceFocusIdRef.current = undefined;
    }
  }, [renamingWorkspaceId, workspaceSummaries]);

  const duplicateWorkspaceNames = useMemo(() => getDuplicateNames(workspaceSummaries ?? []), [workspaceSummaries]);
  const activeWorkspace = projectCollectionState?.activeProjectCollection;
  const activeWorkspaceIsLocked = projectCollectionState?.access === "locked";
  const activeWorkspaceName = activeWorkspace?.name ?? (projectCollectionState ? "No Workspace" : "Loading Workspace");
  const activeWorkspaceSummary = workspaceSummaries?.find(
    (summary) => summary.collection.projectCollectionId === activeWorkspace?.projectCollectionId
  );
  const activeWorkspaceContext = activeWorkspaceSummary
    ? getWorkspaceContext(activeWorkspaceSummary, duplicateWorkspaceNames)
    : undefined;

  const startEditingProject = useCallback(() => {
    setProjectNameValue(projectName);
    setIsEditingProject(true);
  }, [projectName]);

  const commitProjectRename = useCallback(() => {
    const trimmed = projectNameValue.trim();
    if (trimmed && trimmed !== projectName) {
      store.updateProjectMetadata({ name: trimmed }).catch(() => setProjectNameValue(projectName));
    }
    setIsEditingProject(false);
  }, [projectNameValue, projectName, store]);

  const cancelProjectRename = useCallback(() => {
    setIsEditingProject(false);
  }, []);

  const handleProjectKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        commitProjectRename();
      } else if (e.key === "Escape") {
        cancelProjectRename();
      }
    },
    [commitProjectRename, cancelProjectRename]
  );

  const handleWorkspaceRename = useCallback((summary: ProjectCollectionSummary) => {
    setRenamingWorkspaceId(summary.collection.projectCollectionId);
    setWorkspaceNameValue(summary.collection.name);
  }, []);

  const openPinDialog = useCallback(
    (
      summary: ProjectCollectionSummary,
      mode: WorkspacePinDialogMode,
      options?: { context?: string; browseAfterUnlock?: boolean }
    ) => {
      if (summary.collection.projectCollectionId === DEFAULT_PROJECT_COLLECTION_ID && mode !== "unlock") {
        toast.error("Default workspace cannot use a PIN");
        return;
      }
      setOpenWorkspaceActionId(undefined);
      setPinDialog({
        mode,
        summary,
        context: options?.context,
        browseAfterUnlock: options?.browseAfterUnlock === true,
      });
      setPinDialogError(undefined);
      setPinDialogBusy(false);
    },
    []
  );

  const closePinDialog = useCallback(
    (open: boolean) => {
      if (open) {
        return;
      }
      if (pinDialog?.mode === "unlock" && !pinDialogBusy) {
        toast.message("Workspace unlock canceled");
      }
      setPinDialog(undefined);
      setPinDialogError(undefined);
      setPinDialogBusy(false);
    },
    [pinDialog, pinDialogBusy]
  );

  const handlePinSubmit = useCallback(
    (pin: string) => {
      const dialog = pinDialog;
      if (!dialog) {
        return;
      }
      const projectCollectionId = dialog.summary.collection.projectCollectionId;
      if (projectCollectionId === DEFAULT_PROJECT_COLLECTION_ID && dialog.mode !== "unlock") {
        setPinDialogError("Default workspace cannot use a PIN");
        return;
      }
      setPinDialogBusy(true);
      setPinDialogError(undefined);
      const action =
        dialog.mode === "unlock"
          ? onUnlockWorkspace(projectCollectionId, pin)
          : store.projectManager.setProjectCollectionPin(projectCollectionId, pin);
      action.then(
        (collection) => {
          setPinDialog(undefined);
          setPinDialogBusy(false);
          if (dialog.mode === "unlock") {
            toast.success("Workspace unlocked");
            if (dialog.browseAfterUnlock) {
              onBrowseProjects(collection, dialog.context);
            }
          } else {
            toast.success(dialog.mode === "change" ? "Workspace PIN changed" : "Workspace PIN set");
          }
        },
        (error: unknown) => {
          setPinDialogBusy(false);
          if (error instanceof AppHostError) {
            if (error.code === "PROJECT_COLLECTION_NOT_FOUND") {
              setPinDialog(undefined);
              toast.error("Workspace was removed in another tab");
              return;
            }
            setPinDialogError(error.message);
            return;
          }
          setPinDialogError(dialog.mode === "unlock" ? "Failed to unlock workspace" : "Failed to save workspace PIN");
        }
      );
    },
    [onBrowseProjects, onUnlockWorkspace, pinDialog, store]
  );

  const clearPinDialogError = useCallback(() => {
    setPinDialogError(undefined);
  }, []);

  const confirmRemovePin = useCallback(() => {
    const candidate = removePinCandidate;
    if (!candidate) {
      return;
    }
    store.projectManager.clearProjectCollectionPin(candidate.collection.projectCollectionId).then(
      () => {
        setRemovePinCandidate(undefined);
        toast.success("Workspace PIN removed");
      },
      (error: unknown) => {
        if (error instanceof AppHostError) {
          toast.error(error.message);
          return;
        }
        toast.error("Failed to remove workspace PIN");
      }
    );
  }, [removePinCandidate, store]);

  const handleLockWorkspace = useCallback(
    (summary: ProjectCollectionSummary) => {
      setOpenWorkspaceActionId(undefined);
      if (summary.collection.projectCollectionId === DEFAULT_PROJECT_COLLECTION_ID) {
        toast.error("Default workspace cannot be locked");
        return;
      }
      store.lockProjectCollection(summary.collection.projectCollectionId).then(
        () => {
          toast.success("Workspace locked");
        },
        (error: unknown) => {
          if (error instanceof AppHostError) {
            toast.error(error.message);
            return;
          }
          toast.error("Failed to lock workspace");
        }
      );
    },
    [store]
  );

  const handleWorkspaceEditTabKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Tab") {
      return;
    }
    const controls: Array<HTMLElement | null> = [
      workspaceInputRef.current,
      workspaceAcceptButtonRef.current,
      workspaceCancelButtonRef.current,
    ];
    const focusableControls = controls.filter((control): control is HTMLElement => control !== null);
    const activeElement = document.activeElement;
    const activeIndex = activeElement instanceof HTMLElement ? focusableControls.indexOf(activeElement) : -1;
    if (activeIndex === -1) {
      return;
    }
    const nextControl = focusableControls[activeIndex + (e.shiftKey ? -1 : 1)];
    if (!nextControl) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    nextControl.focus();
  }, []);

  const cancelWorkspaceRename = useCallback(() => {
    setRenamingWorkspaceId(undefined);
  }, []);

  const commitWorkspaceRename = useCallback(
    (projectCollectionId: string) => {
      store.projectManager.renameProjectCollection(projectCollectionId, workspaceNameValue).then(
        () => {
          setRenamingWorkspaceId(undefined);
        },
        (error: unknown) => {
          if (error instanceof AppHostError) {
            toast.error(error.message);
            return;
          }
          toast.error("Failed to rename workspace");
        }
      );
    },
    [store, workspaceNameValue]
  );

  const handleWorkspaceKeyDown = useCallback(
    (e: React.KeyboardEvent, projectCollectionId: string) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        commitWorkspaceRename(projectCollectionId);
      } else if (e.key === "Escape") {
        cancelWorkspaceRename();
      }
    },
    [commitWorkspaceRename, cancelWorkspaceRename]
  );

  const confirmWorkspaceDelete = useCallback(() => {
    const candidate = deleteCandidate;
    if (!candidate) {
      return;
    }
    store.projectManager.deleteProjectCollection(candidate.collection.projectCollectionId).then(
      () => {
        setDeleteCandidate(undefined);
      },
      () => {
        toast.error("Failed to delete workspace");
      }
    );
  }, [deleteCandidate, store]);

  const pinDialogWorkspaceName = pinDialog?.summary.collection.name ?? "workspace";

  return (
    <div className="absolute top-3 left-3 right-16 z-40 flex min-w-0 items-center gap-1 md:right-auto md:max-w-[calc(100%-24rem)]">
      {showProjectMenu && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center justify-center w-8 h-8 rounded-lg bg-background/80 backdrop-blur border border-border shadow-md hover:bg-background/90"
                aria-label="Project menu"
              >
                <Menu className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={4}>
              <DropdownMenuItem disabled={activeWorkspaceIsLocked} onSelect={onNewProject}>
                <Plus className="w-4 h-4 mr-2" />
                New Project
              </DropdownMenuItem>
              {activeWorkspace && (
                <DropdownMenuItem
                  disabled={activeWorkspaceIsLocked}
                  onSelect={() =>
                    onBrowseProjects(
                      activeWorkspace,
                      activeWorkspaceSummary && duplicateWorkspaceNames.has(activeWorkspaceSummary.collection.name)
                        ? activeWorkspaceContext
                        : undefined
                    )
                  }
                >
                  <FolderOpen className="w-4 h-4 mr-2" />
                  Browse Projects
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={activeWorkspaceIsLocked} onSelect={onExportProject}>
                <Download className="w-4 h-4 mr-2" />
                Export Project
              </DropdownMenuItem>
              <DropdownMenuItem disabled={activeWorkspaceIsLocked} onSelect={onImportProject}>
                <Upload className="w-4 h-4 mr-2" />
                Import Project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 min-w-0 max-w-56 items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 text-sm font-medium shadow-md backdrop-blur hover:bg-background/90"
                aria-label={`Workspace: ${activeWorkspaceName}`}
                title={activeWorkspaceName}
              >
                <span className="truncate">{activeWorkspaceName}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent ref={workspaceDropdownContentRef} align="start" sideOffset={4} className="w-72">
              {workspaceSummaries === undefined ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">Loading workspaces...</div>
              ) : workspaceSummaries.length === 0 ? (
                <div className="px-2 py-3 text-sm text-muted-foreground">No workspaces found</div>
              ) : (
                workspaceSummaries.map((summary) => {
                  const collection = summary.collection;
                  const isActive = collection.projectCollectionId === activeWorkspace?.projectCollectionId;
                  const isDefault = collection.projectCollectionId === DEFAULT_PROJECT_COLLECTION_ID;
                  const isProtected = collection.pinVerifier !== undefined;
                  const isLocked = summary.access === "locked";
                  const deleteDisabledReason = isActive
                    ? "Cannot delete the active workspace"
                    : isDefault
                      ? "Cannot delete the default workspace"
                      : isProtected && isLocked
                        ? "Unlock the workspace before deleting it"
                        : undefined;
                  const renameDisabledReason =
                    isProtected && isLocked ? "Unlock the workspace before renaming it" : undefined;
                  const isRenaming = renamingWorkspaceId === collection.projectCollectionId;
                  const context = getWorkspaceContext(summary, duplicateWorkspaceNames);
                  const browseWorkspace = () => {
                    if (isProtected && isLocked) {
                      openPinDialog(summary, "unlock", {
                        context: duplicateWorkspaceNames.has(collection.name) ? context : undefined,
                        browseAfterUnlock: !isActive,
                      });
                      return;
                    }
                    onBrowseProjects(collection, duplicateWorkspaceNames.has(collection.name) ? context : undefined);
                  };

                  if (isRenaming) {
                    return (
                      <div key={collection.projectCollectionId} className="p-2">
                        <div className="flex items-center gap-1" onKeyDownCapture={handleWorkspaceEditTabKeyDown}>
                          <Input
                            ref={workspaceInputRef}
                            value={workspaceNameValue}
                            className="h-8 bg-background text-sm"
                            onChange={(e) => setWorkspaceNameValue(e.target.value)}
                            onKeyDown={(e) => handleWorkspaceKeyDown(e, collection.projectCollectionId)}
                          />
                          <Button
                            ref={workspaceAcceptButtonRef}
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            aria-label={`Save workspace name for ${collection.name}`}
                            onClick={() => commitWorkspaceRename(collection.projectCollectionId)}
                          >
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            ref={workspaceCancelButtonRef}
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            aria-label={`Cancel renaming ${collection.name}`}
                            onClick={cancelWorkspaceRename}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={collection.projectCollectionId} className="flex items-stretch rounded-sm">
                      <DropdownMenuItem asChild className="min-w-0 flex-1 py-2">
                        <button
                          data-workspace-row-id={collection.projectCollectionId}
                          type="button"
                          onClick={browseWorkspace}
                          aria-label={`${collection.name}${isLocked ? ", locked" : isProtected ? ", protected" : ""}`}
                        >
                          <span className="min-w-0 flex-1 text-left">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="truncate">{collection.name}</span>
                              {isActive && (
                                <span className="shrink-0 rounded border border-emerald-200 bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-100">
                                  Current
                                </span>
                              )}
                              {isDefault && (
                                <span className="shrink-0 rounded border border-slate-300 bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-800 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100">
                                  Default
                                </span>
                              )}
                              {isProtected && (
                                <span
                                  title={isLocked ? "Locked workspace" : "Unlocked protected workspace"}
                                  className={
                                    isLocked
                                      ? "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-100"
                                      : "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-800 dark:bg-sky-900/60 dark:text-sky-100"
                                  }
                                >
                                  {isLocked ? (
                                    <Lock className="h-3 w-3" aria-hidden="true" />
                                  ) : (
                                    <LockOpen className="h-3 w-3" aria-hidden="true" />
                                  )}
                                  <span className="sr-only">
                                    {isLocked ? "Locked workspace" : "Unlocked protected workspace"}
                                  </span>
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <span className="truncate">{context}</span>
                            </span>
                          </span>
                        </button>
                      </DropdownMenuItem>
                      <DropdownMenuSub
                        open={openWorkspaceActionId === collection.projectCollectionId}
                        onOpenChange={(open) =>
                          setOpenWorkspaceActionId(open ? collection.projectCollectionId : undefined)
                        }
                      >
                        <DropdownMenuSubTrigger
                          className="w-9 justify-center px-2"
                          aria-label={`Workspace actions for ${collection.name}`}
                        ></DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {!isDefault && !isProtected && (
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                openPinDialog(summary, "set");
                              }}
                            >
                              <Shield className="h-4 w-4 mr-2" />
                              Set PIN
                            </DropdownMenuItem>
                          )}
                          {isProtected && isLocked && (
                            <DropdownMenuItem
                              onSelect={(event) => {
                                event.preventDefault();
                                openPinDialog(summary, "unlock");
                              }}
                            >
                              <Unlock className="h-4 w-4 mr-2" />
                              Unlock
                            </DropdownMenuItem>
                          )}
                          {isProtected && !isLocked && (
                            <>
                              {!isDefault && (
                                <DropdownMenuItem
                                  onSelect={(event) => {
                                    event.preventDefault();
                                    openPinDialog(summary, "change");
                                  }}
                                >
                                  <Shield className="h-4 w-4 mr-2" />
                                  Change PIN
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onSelect={() => {
                                  setOpenWorkspaceActionId(undefined);
                                  setRemovePinCandidate(summary);
                                }}
                              >
                                <X className="h-4 w-4 mr-2" />
                                Remove PIN
                              </DropdownMenuItem>
                              {!isDefault && (
                                <DropdownMenuItem onSelect={() => handleLockWorkspace(summary)}>
                                  <Lock className="h-4 w-4 mr-2" />
                                  Lock
                                </DropdownMenuItem>
                              )}
                            </>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={renameDisabledReason !== undefined}
                            title={renameDisabledReason}
                            aria-label={renameDisabledReason ?? `Rename ${collection.name}`}
                            onSelect={(event) => {
                              event.preventDefault();
                              if (renameDisabledReason !== undefined) {
                                return;
                              }
                              setOpenWorkspaceActionId(undefined);
                              handleWorkspaceRename(summary);
                            }}
                          >
                            <Pencil className="h-4 w-4 mr-2" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={deleteDisabledReason !== undefined}
                            title={deleteDisabledReason}
                            aria-label={deleteDisabledReason ?? `Delete ${collection.name}`}
                            onSelect={() => setDeleteCandidate(summary)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </div>
                  );
                })
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onNewWorkspace}>
                <Plus className="w-4 h-4 mr-2" />
                New Workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="text-sm font-medium text-background/80 drop-shadow-sm">/</span>
        </>
      )}

      {activeWorkspaceIsLocked ? (
        <span className="flex h-8 min-w-24 max-w-64 items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 text-sm font-medium shadow-md backdrop-blur">
          <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
          <span className="truncate">Locked</span>
        </span>
      ) : isEditingProject ? (
        <div className="flex min-w-0 items-center gap-1">
          <Input
            ref={projectInputRef}
            value={projectNameValue}
            onChange={(e) => setProjectNameValue(e.target.value)}
            onBlur={commitProjectRename}
            onKeyDown={handleProjectKeyDown}
            className="h-8 w-48 min-w-32 bg-background/90 backdrop-blur border-border text-sm"
            autoFocus
          />
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-background/80 backdrop-blur border border-border shadow-md hover:bg-background/90"
            onMouseDown={(e) => {
              e.preventDefault();
              commitProjectRename();
            }}
            aria-label="Save name"
          >
            <Check className="w-4 h-4" />
          </button>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-background/80 backdrop-blur border border-border shadow-md hover:bg-background/90"
            onMouseDown={(e) => {
              e.preventDefault();
              cancelProjectRename();
            }}
            aria-label="Cancel rename"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={startEditingProject}
          className="flex h-8 min-w-32 max-w-64 items-center gap-1.5 rounded-lg border border-border bg-background/80 px-3 text-sm font-medium shadow-md backdrop-blur hover:bg-background/90"
          aria-label="Rename project"
        >
          <span className="truncate">{projectName}</span>
          <Pencil className="w-3 h-3 shrink-0 opacity-60" />
        </button>
      )}

      <Dialog open={deleteCandidate !== undefined} onOpenChange={(open) => !open && setDeleteCandidate(undefined)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Workspace?</DialogTitle>
            <DialogDescription>{formatDeleteWorkspaceDescription(deleteCandidate)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="cancel" onClick={() => setDeleteCandidate(undefined)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmWorkspaceDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={removePinCandidate !== undefined}
        onOpenChange={(open) => !open && setRemovePinCandidate(undefined)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Workspace PIN?</DialogTitle>
            <DialogDescription>
              {removePinCandidate?.collection.name ?? "This workspace"} will no longer require a PIN to open.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="cancel" onClick={() => setRemovePinCandidate(undefined)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmRemovePin}>
              Remove PIN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <WorkspacePinDialog
        open={pinDialog !== undefined}
        mode={pinDialog?.mode ?? "unlock"}
        workspaceName={pinDialogWorkspaceName}
        busy={pinDialogBusy}
        error={pinDialogError}
        onOpenChange={closePinDialog}
        onSubmit={handlePinSubmit}
        onInputChange={clearPinDialogError}
      />
    </div>
  );
}
