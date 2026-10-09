import type { IBrainTileDef, ITileCatalog } from "@wendoo/core/brain";
import { groupTilesByLibrary, type LibraryTileGroups } from "@wendoo/ui/brain-editor/tile-library-groups";
import type { TileVisual } from "@wendoo/ui/brain-editor/types";
import { kDocsPanelInsetVar, publishInset, withdrawInset } from "@wendoo/ui/ui/surface-insets";
import { BookOpen, ChevronLeft, ChevronRight, ExternalLink, GripVertical, Printer, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AcceleratorHelp } from "./AcceleratorHelp";
import { DocMarkdown } from "./DocMarkdown";
import { DocsEntryLink } from "./DocsEntryLink";
import { DocsPrintView } from "./DocsPrintView";
import type { DocsConceptEntry, DocsPatternEntry, DocsRegistry, DocsTileEntry } from "./DocsRegistry";
import { type DocTab, useDocsResolveTileVisual, useDocsSidebar } from "./DocsSidebarContext";
import { DocsTileArgsSection } from "./DocsTileArgs";
import { useDocsPrint } from "./useDocsPrint";

// ---------------------------------------------------------------------------
// Panel width -- stored as a viewport-relative percentage so that resizing
// the window naturally reflows the panel. Persisted in localStorage.
// ---------------------------------------------------------------------------

const PANEL_WIDTH_KEY = "docs-sidebar-width-pct";
const DEFAULT_WIDTH_PCT = 26; // ~350px on a 1350px viewport
const MIN_WIDTH_PCT = 14;
const MAX_WIDTH_PCT = 55;
const KEYBOARD_STEP_PCT = 1;

function clampWidth(pct: number): number {
  return Math.min(MAX_WIDTH_PCT, Math.max(MIN_WIDTH_PCT, pct));
}

/**
 * The clamped panel width, as a percentage of the viewport, that puts the
 * panel's left edge under the viewport x-coordinate `clientX`.
 */
export function panelWidthPctAtPointer(clientX: number, viewportWidth: number): number {
  return clampWidth(((viewportWidth - clientX) / viewportWidth) * 100);
}

/**
 * What the resize separator does with a pointer move: `"resize"` moves the
 * panel edge to the pointer, `"end"` finishes the drag and leaves the edge
 * where it stands, and `"ignore"` touches nothing.
 */
export type SeparatorMoveAction = "ignore" | "end" | "resize";

/**
 * The action a pointer move over the resize separator takes, given whether a
 * drag is recorded as in progress and the `buttons` bitmask of the move.
 *
 * A move with no button held (`buttons` of 0) while a drag is recorded means
 * the drag ended somewhere the separator never heard about, and yields
 * `"end"`.
 */
export function separatorMoveAction(isDragging: boolean, buttons: number): SeparatorMoveAction {
  if (!isDragging) return "ignore";
  return buttons === 0 ? "end" : "resize";
}

function readStoredWidth(): number {
  try {
    const stored = localStorage.getItem(PANEL_WIDTH_KEY);
    if (stored !== null) {
      const n = Number.parseFloat(stored);
      if (!Number.isNaN(n)) return clampWidth(n);
    }
  } catch {
    // localStorage unavailable
  }
  return DEFAULT_WIDTH_PCT;
}

const STORAGE_DEBOUNCE_MS = 300;

function usePanelWidth(): [number, (pct: number) => void] {
  const [widthPct, setWidthPctState] = useState<number>(readStoredWidth);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setWidthPct = useCallback((pct: number) => {
    const clamped = clampWidth(pct);
    // Update React state immediately for instant visual feedback.
    setWidthPctState(clamped);
    // Debounce the localStorage write so rapid keyboard steps or a fast
    // pointer-move flush only result in one write after the gesture settles.
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(clamped));
      } catch {
        // localStorage unavailable
      }
    }, STORAGE_DEBOUNCE_MS);
  }, []);

  return [widthPct, setWidthPct];
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  return isMobile;
}

const TABS: { id: DocTab; label: string }[] = [
  { id: "tiles", label: "Tiles" },
  { id: "patterns", label: "Patterns" },
  { id: "concepts", label: "Concepts" },
  { id: "keyboard", label: "Keyboard" },
];

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

function matchesSearch(query: string, ...fields: (string | string[] | undefined)[]): boolean {
  const q = query.toLowerCase();
  for (const field of fields) {
    if (!field) continue;
    if (Array.isArray(field)) {
      for (const f of field) {
        if (f.toLowerCase().includes(q)) return true;
      }
    } else {
      if (field.toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

/** The label and icon the docs show for one tile entry. */
export interface TileEntryVisual {
  /** Display label. */
  label: string;
  /** Icon, as an image source, or undefined when there is none. */
  iconUrl: string | undefined;
}

/**
 * The label and icon the docs show for the tile entry under `tileId`. While
 * `tileCatalog` holds a tile under the id, they are that tile's, as
 * `resolveTileVisual` resolves it; while it holds none, they are the
 * `label` and `iconUrl` `entry` carries. A label neither gives is the id's
 * last segment after `->`.
 *
 * @param tileCatalog - Catalog the entry's tile is read from.
 * @param resolveTileVisual - Resolves a held tile's label and icon.
 * @param tileId - The entry's tile id.
 * @param entry - The entry registered under `tileId`, or undefined when there is none.
 */
export function tileEntryVisual(
  tileCatalog: ITileCatalog | undefined,
  resolveTileVisual: (tileDef: IBrainTileDef) => TileVisual | undefined,
  tileId: string,
  entry: DocsTileEntry | undefined
): TileEntryVisual {
  const tileDef = tileCatalog?.get(tileId);
  const visual = tileDef ? resolveTileVisual(tileDef) : { label: entry?.label, iconUrl: entry?.iconUrl };
  if (visual?.label) {
    return { label: visual.label, iconUrl: visual.iconUrl };
  }
  const arrow = tileId.indexOf("->");
  return { label: arrow >= 0 ? tileId.slice(arrow + 2) : tileId, iconUrl: visual?.iconUrl };
}

/**
 * True for tile kinds documented in the arg-tile section of their placing
 * action's doc page. The browse list omits entries of these kinds; search
 * still surfaces them.
 */
function isActionArgTileKind(kind: IBrainTileDef["kind"] | undefined): boolean {
  return kind === "parameter" || kind === "modifier";
}

/** A tile entry the Tiles tab lists: one carrying a category. */
export type ListedDocsTileEntry = DocsTileEntry & { category: string };

/**
 * The tile entries the Tiles tab lists, in registration order: each entry of
 * `registry` carrying a category whose tile `tileCatalog` holds neither hidden
 * nor deprecated -- a tile it does not hold counts as neither. While `search`
 * is empty, entries whose tile is of a kind documented on its placing action's
 * page are left out; while it is set, only the entries it matches by label,
 * tile id, tag, category or content are listed, whatever their kind. An entry
 * carrying no category is never listed.
 *
 * @param registry - The registry whose tile entries are listed.
 * @param tileCatalog - Catalog the entries' tiles are read from; `undefined` reads every tile as visible.
 * @param search - The search text; `""` while the reader is browsing.
 * @param labelOf - The display label of the tile with the given id.
 */
export function listedTileEntries(
  registry: DocsRegistry,
  tileCatalog: ITileCatalog | undefined,
  search: string,
  labelOf: (tileId: string) => string
): ListedDocsTileEntry[] {
  const tiles = Array.from(registry.tiles.values()).filter((t): t is ListedDocsTileEntry => {
    const tileDef = tileCatalog?.get(t.tileId);
    return t.category !== undefined && !tileDef?.hidden && !tileDef?.deprecated;
  });
  if (!search) return tiles.filter((t) => !isActionArgTileKind(tileCatalog?.get(t.tileId)?.kind));
  return tiles.filter((t) => matchesSearch(search, labelOf(t.tileId), t.tileId, t.tags, t.category, t.content));
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

function SearchBar({ value, onChange, inputRef }: SearchBarProps) {
  return (
    <div className="px-3 py-2 border-b border-border shrink-0">
      <div className="flex items-center gap-2 rounded-md bg-muted border border-border px-2.5 py-1.5">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search docs..."
          className="flex-1 bg-transparent text-sm pointer-coarse:text-base text-foreground placeholder:text-muted-foreground"
          aria-label="Search documentation"
        />
      </div>
    </div>
  );
}

interface TabBarProps {
  activeTab: DocTab;
  setTab: (tab: DocTab) => void;
  itemClassName?: string;
}

function TabBar({ activeTab, setTab, itemClassName = "py-2 text-xs" }: TabBarProps) {
  const { editorMode } = useDocsSidebar();
  const tabs = useMemo(() => TABS.filter((tab) => tab.id !== "keyboard" || editorMode !== undefined), [editorMode]);
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const tabIds = tabs.map((t) => t.id);
      const currentIndex = tabIds.indexOf(activeTab);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setTab(tabIds[(currentIndex + 1) % tabIds.length]);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setTab(tabIds[(currentIndex - 1 + tabIds.length) % tabIds.length]);
      } else if (e.key === "Home") {
        e.preventDefault();
        setTab(tabIds[0]);
      } else if (e.key === "End") {
        e.preventDefault();
        setTab(tabIds[tabIds.length - 1]);
      }
    },
    [activeTab, setTab, tabs]
  );

  return (
    <div
      className="flex border-b border-border shrink-0"
      role="tablist"
      aria-label="Documentation sections"
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            id={`docs-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => setTab(tab.id)}
            className={`flex-1 font-medium transition-colors border-b-2 ${itemClassName} ${
              isActive
                ? "text-foreground border-foreground"
                : "text-muted-foreground border-transparent hover:text-foreground hover:border-border"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canonical section order -- mirrors the tile picker's groupOrder so that
// the sidebar sections always appear in the same sequence as the picker.
// Categories not in this list are appended after in their registration order.
// ---------------------------------------------------------------------------

const TILES_CATEGORY_ORDER: readonly string[] = [
  "Actuators",
  "Control Flow", // switch-page / restart-page (actuator kind, shown separately for clarity)
  "Sensors",
  "Functions", // inline sensors (e.g., random number)
  "Parameters & Modifiers",
  "Variables",
  "Accessors",
  "Literals",
  "Pages",
  "Operators",
];

// ---------------------------------------------------------------------------
// Category section with collapsible groups
// ---------------------------------------------------------------------------

interface CategorySectionProps {
  category: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function CategorySection({ category, children, defaultOpen = true }: CategorySectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setIsOpen((o) => !o)}
        aria-expanded={isOpen}
        className="flex items-center gap-1.5 w-full px-1 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? "rotate-90" : ""}`} aria-hidden="true" />
        {category}
      </button>
      {isOpen && <div className="space-y-1">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List item cards
// ---------------------------------------------------------------------------

interface TileCardProps {
  entry: DocsTileEntry;
  onClick: () => void;
}

function TileCard({ entry, onClick }: TileCardProps) {
  const { tileCatalog } = useDocsSidebar();
  const resolveTileVisual = useDocsResolveTileVisual();
  const { label, iconUrl } = tileEntryVisual(tileCatalog, resolveTileVisual, entry.tileId, entry);

  return (
    <DocsEntryLink href={`/docs/tiles/${encodeURIComponent(entry.tileId)}`} onOpen={onClick}>
      {iconUrl ? (
        <img src={iconUrl} alt="" className="w-6 h-6 shrink-0" aria-hidden="true" />
      ) : (
        <div className="w-6 h-6 rounded bg-muted opacity-40 shrink-0" aria-hidden="true" />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{label}</div>
      </div>
      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
    </DocsEntryLink>
  );
}

interface PatternCardProps {
  entry: DocsPatternEntry;
  onClick: () => void;
}

function PatternCard({ entry, onClick }: PatternCardProps) {
  return (
    <DocsEntryLink href={`/docs/patterns/${encodeURIComponent(entry.id)}`} onOpen={onClick}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{entry.title}</div>
        <div className="text-xs text-muted-foreground truncate">{entry.tags.join(", ")}</div>
      </div>
      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
    </DocsEntryLink>
  );
}

interface ConceptCardProps {
  entry: DocsConceptEntry;
  onClick: () => void;
}

function ConceptCard({ entry, onClick }: ConceptCardProps) {
  return (
    <DocsEntryLink href={`/docs/concepts/${encodeURIComponent(entry.id)}`} onOpen={onClick}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{entry.title}</div>
        <div className="text-xs text-muted-foreground truncate">{entry.tags.join(", ")}</div>
      </div>
      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
    </DocsEntryLink>
  );
}

// ---------------------------------------------------------------------------
// Content panel -- shared between desktop and mobile
// ---------------------------------------------------------------------------

/** Props for {@link DocsPanelContent}. */
export interface DocsPanelContentProps {
  tabBarClassName?: string;
  scrollClassName?: string;
  searchRef?: React.Ref<HTMLInputElement>;
}

/** Tab bar plus searchable list/detail content shared by the desktop and mobile sidebars. */
export function DocsPanelContent({ tabBarClassName, scrollClassName = "p-3", searchRef }: DocsPanelContentProps) {
  const { activeTab, setTab, registry, navKey, navTab, navigateToEntry, navigateBack, tileCatalog, libraries } =
    useDocsSidebar();
  const resolveTileVisual = useDocsResolveTileVisual();
  const [search, setSearch] = useState("");

  // Reset search when tab changes
  const handleSetTab = useCallback(
    (tab: DocTab) => {
      setTab(tab);
      setSearch("");
    },
    [setTab]
  );

  const openDetail = useCallback(
    (key: string) => {
      navigateToEntry(activeTab, key);
    },
    [activeTab, navigateToEntry]
  );

  // Filter entries based on search
  const filteredTiles = useMemo(
    () =>
      listedTileEntries(
        registry,
        tileCatalog,
        search,
        (tileId) => tileEntryVisual(tileCatalog, resolveTileVisual, tileId, registry.tiles.get(tileId)).label
      ),
    [registry, search, tileCatalog, resolveTileVisual]
  );

  const filteredPatterns = useMemo(() => {
    const patterns = Array.from(registry.patterns.values());
    if (!search) return patterns;
    return patterns.filter((p) => matchesSearch(search, p.title, p.tags, p.category, p.content));
  }, [registry, search]);

  const filteredConcepts = useMemo(() => {
    const concepts = Array.from(registry.concepts.values());
    if (!search) return concepts;
    return concepts.filter((c) => matchesSearch(search, c.title, c.tags, c.content));
  }, [registry, search]);

  // Group tiles by category, sorted by the canonical tile picker section
  // order, then subgroup each category by source library (unattributed
  // entries first, one cluster per library) to mirror the tile picker.
  const tilesByCategory = useMemo(() => {
    const groups = new Map<string, DocsTileEntry[]>();
    for (const tile of filteredTiles) {
      const existing = groups.get(tile.category);
      if (existing) {
        existing.push(tile);
      } else {
        groups.set(tile.category, [tile]);
      }
    }
    // Reorder groups to match the tile picker's section order.
    const ordered = new Map<string, LibraryTileGroups<DocsTileEntry>>();
    const subgroup = (entries: DocsTileEntry[]) =>
      groupTilesByLibrary(entries, (entry) => tileCatalog?.get(entry.tileId), libraries);
    for (const cat of TILES_CATEGORY_ORDER) {
      const entries = groups.get(cat);
      if (entries) ordered.set(cat, subgroup(entries));
    }
    // Append remaining categories not covered by the order list.
    for (const [cat, entries] of groups) {
      if (!ordered.has(cat)) ordered.set(cat, subgroup(entries));
    }
    return ordered;
  }, [filteredTiles, tileCatalog, libraries]);

  // Group patterns by category
  const patternsByCategory = useMemo(() => {
    const groups = new Map<string, DocsPatternEntry[]>();
    for (const pattern of filteredPatterns) {
      const existing = groups.get(pattern.category);
      if (existing) {
        existing.push(pattern);
      } else {
        groups.set(pattern.category, [pattern]);
      }
    }
    return groups;
  }, [filteredPatterns]);

  // Resolve detail content
  const detailContent = useMemo(() => {
    if (!navKey || !navTab) return null;
    if (navTab === "tiles") {
      return registry.tiles.get(navKey)?.content ?? null;
    }
    if (navTab === "patterns") {
      return registry.patterns.get(navKey)?.content ?? null;
    }
    if (navTab === "concepts") {
      return registry.concepts.get(navKey)?.content ?? null;
    }
    return null;
  }, [navKey, navTab, registry]);

  // Detail view
  if (navKey && detailContent) {
    return (
      <>
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
          <button
            type="button"
            onClick={navigateBack}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-sm"
            aria-label="Back to list"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            Back
          </button>
        </div>
        <article
          className={`flex-1 min-h-0 overflow-y-auto ${scrollClassName}`}
          onWheel={(e) => e.nativeEvent.stopPropagation()}
        >
          <DocMarkdown>{detailContent}</DocMarkdown>
          {navTab === "tiles" && <DocsTileArgsSection tileId={navKey} />}
        </article>
      </>
    );
  }

  // No-docs fallback -- navKey is set but no content found in registry
  if (navKey) {
    const tileLabel = tileEntryVisual(tileCatalog, resolveTileVisual, navKey, registry.tiles.get(navKey)).label;
    return (
      <>
        <div className="flex items-center gap-1 px-3 py-2 border-b border-border shrink-0">
          <button
            type="button"
            onClick={navigateBack}
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-sm"
            aria-label="Back to list"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
            Back
          </button>
        </div>
        <div className={`flex-1 min-h-0 overflow-y-auto ${scrollClassName}`}>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="w-12 h-12 rounded-full bg-muted border border-border flex items-center justify-center mb-3">
              <BookOpen className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">No documentation available</p>
            <p className="text-xs text-muted-foreground max-w-48">
              {tileLabel ? `There is no doc page for "${tileLabel}" yet.` : "There is no doc page for this tile yet."}
            </p>
          </div>
        </div>
      </>
    );
  }

  // List view
  return (
    <>
      <SearchBar value={search} onChange={setSearch} inputRef={searchRef} />
      <TabBar activeTab={activeTab} setTab={handleSetTab} itemClassName={tabBarClassName} />
      {/* Live region: announces result counts when search query is active */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {search.trim() && activeTab !== "keyboard"
          ? activeTab === "tiles"
            ? `${filteredTiles.length} tile${filteredTiles.length === 1 ? "" : "s"} found`
            : activeTab === "patterns"
              ? `${filteredPatterns.length} pattern${filteredPatterns.length === 1 ? "" : "s"} found`
              : `${filteredConcepts.length} concept${filteredConcepts.length === 1 ? "" : "s"} found`
          : ""}
      </div>
      <div
        role="tabpanel"
        aria-labelledby={`docs-tab-${activeTab}`}
        className={`flex-1 min-h-0 overflow-y-auto ${scrollClassName}`}
        onWheel={(e) => e.nativeEvent.stopPropagation()}
      >
        {activeTab === "tiles" && (
          <>
            {filteredTiles.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">No tiles match your search.</p>
            )}
            {Array.from(tilesByCategory.entries()).map(([category, groups]) => (
              <CategorySection key={category} category={category}>
                {groups.unattributed.map((tile) => (
                  <TileCard key={tile.tileId} entry={tile} onClick={() => openDetail(tile.tileId)} />
                ))}
                {groups.clusters.map((cluster) => (
                  <div key={cluster.library.coordinate} className="space-y-1">
                    <div className="px-1 pt-1.5 text-xs font-medium text-muted-foreground">{cluster.library.name}</div>
                    {cluster.items.map((tile) => (
                      <TileCard key={tile.tileId} entry={tile} onClick={() => openDetail(tile.tileId)} />
                    ))}
                  </div>
                ))}
              </CategorySection>
            ))}
          </>
        )}

        {activeTab === "patterns" && (
          <>
            {filteredPatterns.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">No patterns match your search.</p>
            )}
            {Array.from(patternsByCategory.entries()).map(([category, patterns]) => (
              <CategorySection key={category} category={category}>
                {patterns.map((pattern) => (
                  <PatternCard key={pattern.id} entry={pattern} onClick={() => openDetail(pattern.id)} />
                ))}
              </CategorySection>
            ))}
          </>
        )}

        {activeTab === "concepts" && (
          <>
            {filteredConcepts.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">No concepts match your search.</p>
            )}
            <div className="space-y-1">
              {filteredConcepts.map((concept) => (
                <ConceptCard key={concept.id} entry={concept} onClick={() => openDetail(concept.id)} />
              ))}
            </div>
          </>
        )}

        {activeTab === "keyboard" && <AcceleratorHelp search={search} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Desktop panel
// ---------------------------------------------------------------------------

function PanelContent({ searchRef }: { searchRef?: React.Ref<HTMLInputElement> }) {
  const { close, activeTab, navKey, navTab, registry, showDocsPageLinks, printTransport } = useDocsSidebar();
  const { printContent, triggerPrint, getPrintRoot } = useDocsPrint(printTransport);

  // Resolve the current detail content for the print button
  const detailContent = useMemo(() => {
    if (!navKey || !navTab) return null;
    if (navTab === "tiles") return registry.tiles.get(navKey)?.content ?? null;
    if (navTab === "patterns") return registry.patterns.get(navKey)?.content ?? null;
    if (navTab === "concepts") return registry.concepts.get(navKey)?.content ?? null;
    return null;
  }, [navKey, navTab, registry]);

  const canPrint = detailContent !== null;

  // Build URL for the corresponding /docs page so it can be opened in a new tab.
  const docsPageUrl = useMemo(() => {
    if (navKey && navTab) return `/docs/${navTab}/${encodeURIComponent(navKey)}`;
    return `/docs/${activeTab}`;
  }, [navKey, navTab, activeTab]);
  /** Whether the standalone docs page stands a route to what the panel is showing. */
  const hasDocsPage = showDocsPageLinks && activeTab !== "keyboard";

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2 text-foreground">
          <BookOpen className="w-4 h-4" aria-hidden="true" />
          <span className="text-sm font-semibold tracking-tight">Docs</span>
        </div>
        <div className="flex items-center gap-1">
          {hasDocsPage && (
            <a
              href={docsPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Open in docs page"
              title="Open in docs page"
            >
              <ExternalLink className="w-4 h-4" aria-hidden="true" />
            </a>
          )}
          {canPrint && (
            <button
              type="button"
              onClick={() => triggerPrint(detailContent)}
              className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="Print this page"
              title="Print this page"
            >
              <Printer className="w-4 h-4" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={close}
            className="flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Close docs"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <DocsPanelContent tabBarClassName="py-2 text-xs" scrollClassName="p-3" searchRef={searchRef} />

      {/* Print portal -- rendered into a hidden root, shown only during window.print() */}
      {printContent && createPortal(<DocsPrintView content={printContent} />, getPrintRoot())}
    </>
  );
}

// ---------------------------------------------------------------------------
// Mobile panel
// ---------------------------------------------------------------------------

function MobilePanel() {
  const { close, navKey, navTab, registry, printTransport } = useDocsSidebar();
  const { printContent, triggerPrint, getPrintRoot } = useDocsPrint(printTransport);

  const detailContent = useMemo(() => {
    if (!navKey || !navTab) return null;
    if (navTab === "tiles") return registry.tiles.get(navKey)?.content ?? null;
    if (navTab === "patterns") return registry.patterns.get(navKey)?.content ?? null;
    if (navTab === "concepts") return registry.concepts.get(navKey)?.content ?? null;
    return null;
  }, [navKey, navTab, registry]);

  const canPrint = detailContent !== null;

  return (
    <div
      id="docs-sidebar"
      role="dialog"
      aria-modal="true"
      aria-label="Documentation"
      className="fixed inset-0 z-60 pointer-events-auto bg-background flex flex-col"
    >
      {/* Header with back button */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border shrink-0">
        <button
          type="button"
          onClick={close}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-sm"
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          Back
        </button>
        <div className="flex-1 flex items-center gap-2 text-foreground ml-2">
          <BookOpen className="w-4 h-4" aria-hidden="true" />
          <span className="text-sm font-semibold tracking-tight">Docs</span>
        </div>
        {canPrint && (
          <button
            type="button"
            onClick={() => triggerPrint(detailContent)}
            className="flex items-center justify-center w-7 h-7 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="Print this page"
            title="Print this page"
          >
            <Printer className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      <DocsPanelContent tabBarClassName="py-2.5 text-sm" scrollClassName="p-4" />

      {printContent && createPortal(<DocsPrintView content={printContent} />, getPrintRoot())}
    </div>
  );
}

/** Resizable side panel that hosts {@link DocsPanelContent} on desktop. */
export function DocsSidebar() {
  const { isOpen } = useDocsSidebar();
  const isMobile = useIsMobile();
  const searchRef = useRef<HTMLInputElement>(null);
  const [widthPct, setWidthPct] = usePanelWidth();
  const [hasBeenOpened, setHasBeenOpened] = useState(isOpen);
  // Holds the aside, whose width a drag writes inline and pointerup commits to
  // state. The inline width stays where the drag left it.
  const asideRef = useRef<HTMLElement>(null);
  const isDragging = useRef(false);

  useEffect(() => {
    if (isOpen) setHasBeenOpened(true);
  }, [isOpen]);

  // Publishes the panel's settled footprint; the separator's pointer-move
  // handler republishes it during a drag.
  useEffect(() => {
    publishInset(kDocsPanelInsetVar, !isMobile && isOpen ? `${widthPct}%` : "0%");
    return () => {
      withdrawInset(kDocsPanelInsetVar);
    };
  }, [isMobile, isOpen, widthPct]);

  // Move focus into the sidebar when it opens so the user can immediately
  // interact via keyboard. A short delay allows the slide-in transition to
  // start before we focus (some browsers ignore focus on off-screen elements).
  useEffect(() => {
    if (isOpen && searchRef.current) {
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  // -- Resize handle pointer drag -----------------------------------------
  const handleSeparatorPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
  }, []);

  // Clears the drag record and gives the pointer back if the separator still
  // holds it.
  const endSeparatorDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    isDragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleSeparatorPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const action = separatorMoveAction(isDragging.current, e.buttons);
      if (action === "ignore") return;
      if (action === "end") {
        endSeparatorDrag(e);
        return;
      }
      const newPct = panelWidthPctAtPointer(e.clientX, window.innerWidth);
      if (asideRef.current) {
        asideRef.current.style.width = `${newPct}%`;
      }
      publishInset(kDocsPanelInsetVar, `${newPct}%`);
    },
    [endSeparatorDrag]
  );

  // Serves pointerup, pointercancel and lostpointercapture; the first of them
  // to arrive settles the width and the rest find no drag recorded.
  const handleSeparatorDragEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging.current) return;
      endSeparatorDrag(e);
      const newPct = panelWidthPctAtPointer(e.clientX, window.innerWidth);
      if (asideRef.current) {
        asideRef.current.style.width = `${newPct}%`;
      }
      publishInset(kDocsPanelInsetVar, `${newPct}%`);
      setWidthPct(newPct);
    },
    [endSeparatorDrag, setWidthPct]
  );

  // -- Resize handle keyboard control -------------------------------------
  const handleSeparatorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setWidthPct(widthPct + KEYBOARD_STEP_PCT);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setWidthPct(widthPct - KEYBOARD_STEP_PCT);
      } else if (e.key === "Home") {
        e.preventDefault();
        setWidthPct(MAX_WIDTH_PCT);
      } else if (e.key === "End") {
        e.preventDefault();
        setWidthPct(MIN_WIDTH_PCT);
      }
    },
    [widthPct, setWidthPct]
  );

  if (isMobile) {
    return isOpen ? createPortal(<MobilePanel />, document.body) : null;
  }

  // Desktop: slide-out panel from the right edge.
  // Portal to document.body so the sidebar sits alongside dialog portals
  // in DOM order, allowing natural Tab flow between them.
  // z-60 ensures it renders above the brain editor dialog's z-50 overlay.
  return createPortal(
    <aside
      ref={asideRef}
      id="docs-sidebar"
      className="fixed right-0 inset-y-0 z-60 pointer-events-auto flex flex-col bg-background border-l border-border transition-transform duration-300 ease-in-out"
      style={{
        width: `${widthPct}%`,
        transform: isOpen ? "translateX(0)" : "translateX(100%)",
      }}
      aria-label="Documentation"
      // Prevent off-screen panel from participating in tab order
      inert={!isOpen || undefined}
    >
      {/* Resize handle -- ARIA splitter/separator pattern (APG). The role="separator"
          element here is intentionally interactive (focusable, keyboard-operable),
          which is the correct pattern for a window splitter. An <hr> cannot be used
          because child elements are needed for the visual affordance. */}
      {/* biome-ignore lint/a11y/useSemanticElements: interactive splitter requires focusable div, not void <hr> */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize docs panel"
        aria-valuenow={Math.round(widthPct)}
        aria-valuemin={MIN_WIDTH_PCT}
        aria-valuemax={MAX_WIDTH_PCT}
        aria-valuetext={`${Math.round(widthPct)}% wide`}
        tabIndex={0}
        className="absolute left-0 inset-y-0 w-3 flex items-center justify-center cursor-col-resize group z-10 focus:outline-none"
        onPointerDown={handleSeparatorPointerDown}
        onPointerMove={handleSeparatorPointerMove}
        onPointerUp={handleSeparatorDragEnd}
        onPointerCancel={handleSeparatorDragEnd}
        onLostPointerCapture={handleSeparatorDragEnd}
        onKeyDown={handleSeparatorKeyDown}
      >
        {/* Visual affordance: thin line + grip dots, highlighted on hover/focus */}
        <div className="w-px h-full bg-border group-hover:bg-muted-foreground group-focus-visible:bg-primary transition-colors" />
        <div className="absolute flex flex-col items-center gap-0.5 pointer-events-none">
          <GripVertical
            className="w-3 h-3 text-muted-foreground group-hover:text-foreground group-focus-visible:text-primary transition-colors"
            aria-hidden="true"
          />
        </div>
      </div>
      {/* Offset content to clear the handle */}
      <div className="flex flex-col flex-1 min-h-0 pl-3">{hasBeenOpened && <PanelContent searchRef={searchRef} />}</div>
    </aside>,
    document.body
  );
}
