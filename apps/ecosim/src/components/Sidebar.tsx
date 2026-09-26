import { parseExtensionReference } from "@wendoo/app-host";
import type { ExtensionTransactionToasts, LibraryUninstallImpact } from "@wendoo/bridge-app";
import { presentExtensionTransaction, runGuardedLibraryUninstall } from "@wendoo/bridge-app";
import { useDocsSidebar } from "@wendoo/docs";
import { Button, ExtensionBrowserDialog, Slider, Switch } from "@wendoo/ui";
import { Blocks, BookOpen, ChevronDown, ChevronRight, CircleHelp, FileText, Info, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { Archetype } from "@/brain/actor";
import { ARCHETYPES } from "@/brain/archetypes";
import type { BrainLoadFailure } from "@/brain/brain-load-failure";
import type { ScoreSnapshot } from "@/brain/score";
import { BrainDiagnosticsList, BrainErrorBadge, toggledBrainKey } from "@/components/BrainDiagnostics";
import { BridgeConnectionStatus } from "@/components/BridgeConnectionStatus";
import { CompileDiagnosticsConsole } from "@/components/CompileDiagnosticsConsole";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { UninstallImpactMessage } from "@/components/UninstallImpactMessage";
import { useEcosimEnvironment } from "@/contexts/ecosim-environment";
import { clearBindingToken } from "@/services/binding-token-persistence";
import { ecosimEmbeddedExtensions } from "@/services/ecosim-embedded-extensions";
import {
  buildEcosimCatalogOffers,
  buildEcosimExtensionEntries,
  checkSimExtensionUpdates,
  ecosimCatalogCoordinateOrder,
  ecosimLibraryDisplayName,
  installEcosimExtension,
  installEcosimReference,
  uninstallEcosimExtension,
} from "@/services/ecosim-extension-browser";
import { collectSimLibraryUninstallImpact } from "@/services/library-uninstall-guard";

const ARCHETYPE_COLORS: Record<string, string> = {
  carnivore: "#e63946",
  herbivore: "#f4a261",
  plant: "#52b788",
};

const ARCHETYPE_LABELS: Record<string, string> = {
  carnivore: "Carnivore",
  herbivore: "Herbivore",
  plant: "Plant",
};

const ARCHETYPES_LIST: Archetype[] = ["carnivore", "herbivore", "plant"];

/** An uninstall waiting on the in-use confirmation dialog. */
interface PendingUninstall {
  /** The library's display name; titles the dialog. */
  name: string;
  /** The computed in-use impact the dialog lists. */
  impact: LibraryUninstallImpact;
  /** Resolves the confirmation: true removes anyway, false cancels. */
  resolve: (confirmed: boolean) => void;
}

function failedToast(prefix: string): ExtensionTransactionToasts["failed"] {
  return ({ code, message }) => {
    toast.error(`${prefix} ${code !== undefined ? `${code}: ` : ""}${message}`);
  };
}

const installToasts: ExtensionTransactionToasts = {
  failed: failedToast("Could not install library."),
  confirmed: (name) => toast.success(`Installed ${name}`),
};

const uninstallToasts: ExtensionTransactionToasts = {
  failed: failedToast("Could not remove library."),
  confirmed: (name) => toast.success(`Removed ${name}`),
};

const refreshToasts: ExtensionTransactionToasts = {
  failed: failedToast("Could not load libraries."),
  confirmed: () => undefined,
};

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtNum(n: number): string {
  return n.toFixed(1);
}

export interface SidebarProps {
  snapshot: ScoreSnapshot | null;
  timeSpeed: number;
  onTimeSpeedChange: (speed: number) => void;
  isPlaying: boolean;
  onTogglePlay: (playing: boolean) => void;
  onEditBrain: (archetype: Archetype) => void;
  /**
   * Whether an archetype's brain can be resolved right now. False until the
   * simulation has finished starting up, after a brain load has failed, and
   * while a project switch reloads the brains; the brain edit controls stay
   * disabled while it is false.
   */
  brainsReady: boolean;
  /**
   * Why the brains could not be loaded, when a load has failed. Undefined
   * while they are still loading and once they are loaded.
   */
  brainLoadFailure?: BrainLoadFailure;
  onDesiredCountChange: (archetype: Archetype, count: number) => void;
  onToggleDebug: () => void;
  debugEnabled: boolean;
  /** Whether the sidebar is open on mobile. Ignored on md+ screens. */
  isOpen?: boolean;
  /** Callback to close the sidebar on mobile. */
  onClose?: () => void;
}

export function Sidebar({
  snapshot,
  timeSpeed,
  onTimeSpeedChange,
  isPlaying,
  onTogglePlay,
  onEditBrain,
  brainsReady,
  brainLoadFailure,
  onDesiredCountChange,
  onToggleDebug,
  debugEnabled,
  isOpen,
  onClose,
}: SidebarProps) {
  const store = useEcosimEnvironment();
  const [desiredCounts, setDesiredCounts] = useState<Record<Archetype, number>>(() => store.getDesiredCounts());
  const [collapsedArchetypes, setCollapsedArchetypes] = useState<Record<string, boolean>>(() =>
    store.getCollapsedArchetypes()
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [pendingUninstall, setPendingUninstall] = useState<PendingUninstall | null>(null);
  const [expandedDiagnostics, setExpandedDiagnostics] = useState<ReadonlySet<string>>(new Set());
  const [devPanelCollapsed, setDevPanelCollapsed] = useState(() => store.getDevPanelCollapsed());
  const toggleDevPanelCollapsed = () =>
    setDevPanelCollapsed((previous) => {
      const next = !previous;
      store.updateDevPanelCollapsed(next);
      return next;
    });
  useSyncExternalStore(store.subscribeToBrainDiagnostics, store.getBrainDiagnosticsRevision);
  const subscribeToActiveProject = useCallback(
    (listener: () => void) => store.projectManager.onActiveProjectChange(listener),
    [store]
  );
  const extensions = useSyncExternalStore(subscribeToActiveProject, () => store.activeProjectManifest?.extensions);
  const catalogOffers = useMemo(() => buildEcosimCatalogOffers(extensions, ecosimEmbeddedExtensions), [extensions]);
  const extensionEntries = useMemo(
    () =>
      buildEcosimExtensionEntries(
        extensions,
        ecosimEmbeddedExtensions,
        store.host.installedExtensionContent,
        store.host.extensionFetchFailures
      ),
    [extensions, store]
  );

  const handleInstallExtension = async (coordinate: string) => {
    const result = await installEcosimExtension(
      store.host,
      store.activeProjectManifest?.extensions,
      coordinate,
      ecosimEmbeddedExtensions
    );
    if (!result.action.ok) {
      toast.error(`Could not install library (${result.action.code})`);
      return;
    }
    presentExtensionTransaction({
      report: result.report,
      flavor: "install",
      libraryName: ecosimLibraryDisplayName(store.host.installedLibraries, coordinate),
      toasts: installToasts,
    });
  };

  const handleInstallExtensionReference = async (input: string) => {
    const result = await installEcosimReference(
      store.host,
      store.activeProjectManifest?.extensions,
      ecosimEmbeddedExtensions,
      input
    );
    if (!result.ok) {
      toast.error(`Could not add library. ${result.code}: ${result.message}`);
      return;
    }
    if (!result.action.ok) {
      toast.error(`Could not add library (${result.action.code})`);
      return;
    }
    const parsed = parseExtensionReference(result.reference);
    const coordinate =
      parsed === undefined
        ? result.reference
        : parsed.transport === "gh"
          ? `${parsed.owner}/${parsed.repo}`
          : parsed.coordinate;
    presentExtensionTransaction({
      report: result.report,
      flavor: "install",
      libraryName: ecosimLibraryDisplayName(store.host.installedLibraries, coordinate),
      toasts: installToasts,
    });
  };

  const handleUninstallExtension = async (coordinate: string) => {
    const extensionsMap = store.activeProjectManifest?.extensions;
    const name = ecosimLibraryDisplayName(store.host.installedLibraries, coordinate);
    const impact = collectSimLibraryUninstallImpact(
      store.host,
      extensionsMap,
      coordinate,
      ecosimEmbeddedExtensions,
      store.host.installedExtensionContent,
      (key) => ARCHETYPE_LABELS[key] ?? key
    );
    await runGuardedLibraryUninstall({
      impact,
      confirmRemoval: () =>
        new Promise<boolean>((resolve) => {
          setPendingUninstall({ name, impact, resolve });
        }),
      uninstall: async () => {
        const result = await uninstallEcosimExtension(
          store.host,
          extensionsMap,
          coordinate,
          ecosimEmbeddedExtensions,
          store.host.installedExtensionContent
        );
        if (!result.action.ok) {
          toast.error(`Could not remove library (${result.action.code})`);
          return;
        }
        presentExtensionTransaction({
          report: result.report,
          flavor: "uninstall",
          libraryName: name,
          toasts: uninstallToasts,
        });
      },
    });
  };

  const handleCheckUpdates = async (coordinates: readonly string[]) => {
    const summary = await checkSimExtensionUpdates(store.host, coordinates);
    for (const failure of summary.failures) {
      toast.error(`Could not check ${failure.coordinate} for updates. ${failure.error.code}: ${failure.error.message}`);
    }
    if (summary.updates.length === 0) {
      if (summary.failures.length === 0) {
        toast.success("Libraries are up to date");
      }
      return;
    }
    const updates = summary.updates;
    const description = updates
      .map((update) => `${update.coordinate} -> ${update.latestVersion ?? update.resolvedSha?.slice(0, 12) ?? ""}`)
      .join("\n");
    toast.info(`${updates.length} update(s) available`, {
      description,
      action: {
        label: updates.length > 1 ? "Update all" : "Update",
        onClick: () => {
          void (async () => {
            presentExtensionTransaction({
              report: await store.host.applyExtensionUpdates(updates),
              flavor: "refresh",
              toasts: refreshToasts,
            });
          })();
        },
      },
    });
  };

  const handleCheckAllUpdates = () =>
    handleCheckUpdates(extensionEntries.filter((entry) => entry.updatable === true).map((entry) => entry.coordinate));

  const handleRetryExtension = async () => {
    presentExtensionTransaction({
      report: await store.host.updateProjectExtensions(store.activeProjectManifest?.extensions ?? {}),
      flavor: "refresh",
      toasts: refreshToasts,
    });
  };
  const [bridgeEnabled, setBridgeEnabled] = useState(() => store.getUiPreferences().bridgeEnabled);
  const bridgeStatus = useSyncExternalStore(store.subscribeToBridgeStatus, store.getBridgeStatusSnapshot);
  const joinCode = useSyncExternalStore(store.subscribeToBridgeJoinCode, store.getBridgeJoinCodeSnapshot);
  const bridgePaired = useSyncExternalStore(store.subscribeToBridgePaired, store.getBridgePairedSnapshot);
  const bridgeErrorCode = useSyncExternalStore(store.subscribeToBridgeErrorCode, store.getBridgeErrorCodeSnapshot);
  const compileDiagnostics = useSyncExternalStore(
    store.subscribeToCompileDiagnostics,
    store.getCompileDiagnosticsSnapshot
  );

  useEffect(() => {
    return store.onProjectLoaded(() => {
      setBridgeEnabled(store.getUiPreferences().bridgeEnabled);
    });
  }, [store]);

  useEffect(() => {
    return store.onDesiredCountsReloaded(() => {
      setDesiredCounts(store.getDesiredCounts());
    });
  }, [store]);

  useEffect(() => {
    if (bridgeEnabled) {
      store.connectBridge();
    }
  }, [bridgeEnabled, store]);

  const { toggle: toggleDocs, isOpen: isDocsOpen, open: openDocs, navigateToEntry } = useDocsSidebar();

  const openAbout = () => {
    openDocs();
    navigateToEntry("concepts", "about");
  };

  const updateDesiredCount = (archetype: Archetype, count: number) => {
    setDesiredCounts((prev) => ({ ...prev, [archetype]: count }));
    store.setDesiredCount(archetype, count);
    onDesiredCountChange(archetype, count);
  };

  const totalDeaths = snapshot ? snapshot.carnivore.deaths + snapshot.herbivore.deaths + snapshot.plant.deaths : 0;

  return (
    <aside
      aria-label="Simulation dashboard"
      className={`fixed inset-y-0 right-0 z-50 w-64 border-l border-border bg-background flex flex-col transition-transform duration-200 ease-in-out md:static md:z-auto md:translate-x-0 md:shrink-0 ${
        isOpen ? "translate-x-0" : "translate-x-full"
      }`}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-end gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <Button
          onClick={openAbout}
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="About"
          aria-label="About this app"
        >
          <Info className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          onClick={toggleDocs}
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="Documentation"
          aria-label="Toggle documentation panel"
          aria-expanded={isDocsOpen}
          aria-controls="docs-sidebar"
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          onClick={() => setExtensionsOpen(true)}
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="Libraries"
          aria-label="Open libraries"
        >
          <Blocks className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          onClick={() => setSettingsOpen(true)}
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="Settings"
          aria-label="Open settings"
        >
          <Settings className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onBridgeDisabled={() => setBridgeEnabled(false)}
      />

      {pendingUninstall !== null && (
        <ConfirmDialog
          title={pendingUninstall.name}
          message={<UninstallImpactMessage impact={pendingUninstall.impact} />}
          confirmLabel="Remove anyway"
          destructive
          onConfirm={async () => pendingUninstall.resolve(true)}
          onClose={() => {
            pendingUninstall.resolve(false);
            setPendingUninstall(null);
          }}
        />
      )}

      <ExtensionBrowserDialog
        open={extensionsOpen}
        onOpenChange={setExtensionsOpen}
        entries={extensionEntries}
        onInstall={handleInstallExtension}
        onUninstall={handleUninstallExtension}
        onCheckUpdate={(coordinate) => handleCheckUpdates([coordinate])}
        onRetry={handleRetryExtension}
        onOpenRepo={(url) => window.open(url, "_blank", "noopener")}
        onCheckAllUpdates={handleCheckAllUpdates}
        onInstallReference={handleInstallExtensionReference}
        catalogOffers={catalogOffers}
        catalogCoordinates={ecosimCatalogCoordinateOrder}
      />

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Dashboard</h2>
          {snapshot && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Liveliness</span>
              <span className="font-mono tabular-nums text-sm font-semibold">{snapshot.ecosystemScore}</span>
            </div>
          )}
        </div>

        {/* Playback & Time Scale */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Play/Pause</span>
            <Switch
              id="play-pause-toggle"
              checked={isPlaying}
              onCheckedChange={onTogglePlay}
              aria-label="Toggle simulation playback"
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <span id="time-scale-label" className="text-xs font-medium">
                Time Scale
              </span>
              <span className="text-xs text-muted-foreground font-mono tabular-nums">{timeSpeed.toFixed(1)}x</span>
            </div>
            <Slider
              value={[timeSpeed]}
              onValueChange={([value]) => onTimeSpeedChange(value)}
              min={0}
              max={2}
              step={0.1}
              className="w-full"
              aria-labelledby="time-scale-label"
            />
          </div>
        </div>

        <div className="border-t border-border" />

        {/* Why the Edit Brain buttons below are unavailable */}
        {brainLoadFailure && (
          <div
            role="alert"
            data-testid="brain-load-failure"
            className="space-y-1 rounded-lg border border-destructive/40 bg-panel p-2.5"
          >
            <p className="text-xs font-medium text-destructive">
              Brains failed to load, so Edit Brain is unavailable. Reload the page to try again.
            </p>
            <p className="font-mono text-xs break-words text-muted-foreground">
              {brainLoadFailure.code ? `${brainLoadFailure.code}: ` : ""}
              {brainLoadFailure.message}
            </p>
          </div>
        )}

        {/* Per-archetype sections */}
        {ARCHETYPES_LIST.map((arch) => {
          const s = snapshot?.[arch];
          const avgLife = s && s.deaths > 0 ? s.totalLifespan / s.deaths : 0;
          const avgEnergy = s && s.aliveCount > 0 ? s.totalEnergy / s.aliveCount : 0;
          const isCollapsed = collapsedArchetypes[arch] ?? false;
          const diagnostics = store.getBrainDiagnostics(arch);
          const diagnosticsExpanded = expandedDiagnostics.has(arch) && diagnostics.length > 0;
          const toggleCollapsed = () =>
            setCollapsedArchetypes((prev) => {
              const next = { ...prev, [arch]: !prev[arch] };
              store.updateCollapsedArchetypes(next);
              return next;
            });
          return (
            // biome-ignore lint/a11y/useSemanticElements: fieldset would break layout; role="group" provides accessible grouping
            <div
              key={arch}
              className="space-y-2 rounded-lg bg-panel p-2.5"
              role="group"
              aria-label={`${ARCHETYPE_LABELS[arch]} settings`}
            >
              {/* Archetype header */}
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={isCollapsed ? `Expand ${ARCHETYPE_LABELS[arch]}` : `Collapse ${ARCHETYPE_LABELS[arch]}`}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                </button>
                <img
                  src={`/assets/brain/icons/${arch}.svg`}
                  alt={`${ARCHETYPE_LABELS[arch]} icon`}
                  className="w-5 h-5 mr-1"
                />
                <span className="text-sm font-medium" style={{ color: ARCHETYPE_COLORS[arch] }}>
                  {ARCHETYPE_LABELS[arch]}
                </span>
                {diagnostics.length > 0 && (
                  <BrainErrorBadge
                    count={diagnostics.length}
                    expanded={diagnosticsExpanded}
                    onToggle={() => setExpandedDiagnostics((previous) => toggledBrainKey(previous, arch))}
                    brainName={ARCHETYPE_LABELS[arch] ?? arch}
                  />
                )}
                {s && (
                  <span className="ml-auto font-mono tabular-nums text-xs text-muted-foreground">
                    {s.aliveCount} alive
                  </span>
                )}
              </div>

              {diagnosticsExpanded && <BrainDiagnosticsList diagnostics={diagnostics} />}

              {/* Stats */}
              {!isCollapsed && s && (
                <div className="text-xs text-muted-foreground grid grid-cols-3 gap-1">
                  <div className="flex flex-col">
                    <abbr title="average lifespan" className="no-underline">
                      avg
                    </abbr>
                    <span className="font-mono tabular-nums text-foreground/70">{fmtNum(avgLife)}s</span>
                  </div>
                  <div className="flex flex-col">
                    <abbr title="best lifespan" className="no-underline">
                      best
                    </abbr>
                    <span className="font-mono tabular-nums text-foreground/70">{fmtNum(s.longestLife)}s</span>
                  </div>
                  <div className="flex flex-col">
                    <abbr title="average energy" className="no-underline">
                      nrg
                    </abbr>
                    <span className="font-mono tabular-nums text-foreground/70">{Math.round(avgEnergy)}</span>
                  </div>
                </div>
              )}

              {/* Population slider */}
              {!isCollapsed && (
                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-muted-foreground">Population</span>
                    <span className="text-xs text-muted-foreground font-mono tabular-nums">{desiredCounts[arch]}</span>
                  </div>
                  <Slider
                    value={[desiredCounts[arch]]}
                    onValueChange={([value]) => updateDesiredCount(arch, value)}
                    min={0}
                    max={100}
                    step={1}
                    className="w-full"
                    aria-label={`${ARCHETYPE_LABELS[arch]} population`}
                  />
                </div>
              )}

              {/* Brain edit button */}
              {!isCollapsed && (
                <Button
                  onClick={() => {
                    onEditBrain(arch);
                    onClose?.();
                  }}
                  variant="outline"
                  size="sm"
                  disabled={!brainsReady}
                  className="w-full h-7 text-xs border-border"
                  aria-label={`Edit ${ARCHETYPE_LABELS[arch]} brain`}
                >
                  Edit Brain
                </Button>
              )}
            </div>
          );
        })}

        <div className="border-t border-border" />

        {/* Footer stats */}
        {snapshot && (
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="font-mono tabular-nums" title="Elapsed time">
              {fmtTime(snapshot.elapsed)}
            </span>
            <span title="Total deaths">{totalDeaths} deaths</span>
          </div>
        )}

        {/* Dev Panel: the VS Code bridge section and the build-output console */}
        {store.getAppSettings().showBridgePanel && (
          // biome-ignore lint/a11y/useSemanticElements: fieldset would break layout; role="group" provides accessible grouping
          <div className="space-y-2 rounded-lg bg-panel p-2.5" role="group" aria-label="Dev Panel">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={toggleDevPanelCollapsed}
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                aria-label={devPanelCollapsed ? "Expand Dev Panel" : "Collapse Dev Panel"}
                aria-expanded={!devPanelCollapsed}
              >
                {devPanelCollapsed ? (
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                )}
              </button>
              <span className="text-sm font-medium">Dev Panel</span>
            </div>
            {!devPanelCollapsed && (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-0.5">
                    <span className="text-xs font-medium">VS Code Bridge</span>
                    <button
                      type="button"
                      className="shrink-0 flex items-center p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="VS Code Bridge Help"
                      onClick={() => {
                        openDocs();
                        navigateToEntry("concepts", "vscode");
                      }}
                    >
                      <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    </button>
                  </div>
                  <Switch
                    id="bridge-toggle"
                    checked={bridgeEnabled}
                    onCheckedChange={(checked) => {
                      setBridgeEnabled(checked);
                      store.updateUiPreferences({ bridgeEnabled: checked });
                      if (!checked) {
                        store.endBridge();
                        clearBindingToken();
                      }
                    }}
                    aria-label="Toggle VS Code bridge connection"
                  />
                </div>
                <BridgeConnectionStatus
                  status={bridgeStatus}
                  paired={bridgePaired}
                  errorCode={bridgeErrorCode}
                  joinCode={joinCode}
                  onReconnect={() => {
                    store.connectBridge();
                  }}
                />
                <div className="text-center w-full">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-2 hover:underline hover:text-foreground transition-colors text-left cursor-pointer"
                    onClick={() => {
                      openDocs();
                      navigateToEntry("concepts", "vscode");
                    }}
                  >
                    <span className="flex items-center gap-1">How to connect VS Code</span>
                  </button>
                </div>
                {compileDiagnostics.length > 0 && (
                  <div className="space-y-1">
                    <span className="text-xs font-medium">Build issues</span>
                    <CompileDiagnosticsConsole diagnostics={compileDiagnostics} />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Debug toggle */}
        <div className="space-y-2 rounded-lg bg-panel p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Debug Draw</span>
            <Switch
              id="debug-toggle"
              checked={debugEnabled}
              onCheckedChange={onToggleDebug}
              aria-label="Toggle debug overlay"
            />
          </div>
        </div>
      </div>

      {/* GitHub link */}
      <div className="border-t border-border p-3 flex justify-end">
        <a
          href="https://github.com/wendoo-lang/wendoo-lang"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="GitHub repository"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor" role="img" aria-label="GitHub">
            <title>GitHub</title>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      </div>
    </aside>
  );
}
