// ---------------------------------------------------------------------------
// DocsRegistry -- content registry for the documentation sidebar.
//
// The registry holds three collections (tiles, patterns, concepts) and is
// populated at app startup. Core exports its own entries; the app adds
// game-specific entries; the sidebar renders whatever the registry contains.
// ---------------------------------------------------------------------------

/**
 * A single tile documentation entry. Keyed by `tileId`.
 * Label, icon, and category are resolved at render time from the tile
 * definition via the existing tile visual service -- do NOT store derived
 * metadata here.
 */
export interface DocsTileEntry {
  tileId: string;
  tags: string[];
  /**
   * Category the sidebar lists the entry under (e.g. "Sensors", "Operators").
   * Omit it to leave the entry unlisted: no list or search shows it, and it
   * still opens by its tile id -- from a `tile:` reference, a tile's docs
   * action, or its `/docs/tiles/<tileId>` page.
   */
  category?: string;
  /** Markdown content (may contain brain fences and tile: inline refs). */
  content: string;
}

/**
 * A named pattern -- a reusable brain snippet solving a common problem.
 */
export interface DocsPatternEntry {
  id: string;
  title: string;
  tags: string[];
  category: string;
  /** Markdown content including brain fence examples. */
  content: string;
}

/**
 * A concept -- a longer explanation of a mental-model topic.
 */
export interface DocsConceptEntry {
  id: string;
  title: string;
  tags: string[];
  /** Markdown content. */
  content: string;
}

/**
 * Combined documentation entries that a package or app can contribute.
 * Pass to `DocsRegistry.register()` or merge into the registry at startup.
 */
export interface DocsEntries {
  tiles?: DocsTileEntry[];
  patterns?: DocsPatternEntry[];
  concepts?: DocsConceptEntry[];
}

/**
 * Placeholder a tile doc's markdown may use to reference its own tile id, so
 * shared content such as brain fences need not repeat the id it is registered
 * under. Substituted with the entry's tile id at registration.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the literal text doc authors write
export const kTileIdPlaceholder = "${tileId}";

/**
 * The docs registry consumed by the sidebar. Holds all contributed entries
 * from core and the app. The sidebar never knows where an entry came from.
 */
export class DocsRegistry {
  private readonly _tiles = new Map<string, DocsTileEntry>();
  private readonly _patterns = new Map<string, DocsPatternEntry>();
  private readonly _concepts = new Map<string, DocsConceptEntry>();

  /** Register a batch of entries (additive, last-write-wins per key). */
  register(entries: DocsEntries): void {
    if (entries.tiles) {
      for (const t of entries.tiles) {
        const content = t.content.includes(kTileIdPlaceholder)
          ? t.content.split(kTileIdPlaceholder).join(t.tileId)
          : t.content;
        this._tiles.set(t.tileId, { ...t, content });
      }
    }
    if (entries.patterns) {
      for (const p of entries.patterns) {
        this._patterns.set(p.id, p);
      }
    }
    if (entries.concepts) {
      for (const c of entries.concepts) {
        this._concepts.set(c.id, c);
      }
    }
  }

  get tiles(): ReadonlyMap<string, DocsTileEntry> {
    return this._tiles;
  }

  get patterns(): ReadonlyMap<string, DocsPatternEntry> {
    return this._patterns;
  }

  get concepts(): ReadonlyMap<string, DocsConceptEntry> {
    return this._concepts;
  }

  /** All unique tile categories in registration order; unlisted entries carry none. */
  get tileCategories(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of this._tiles.values()) {
      if (entry.category !== undefined && !seen.has(entry.category)) {
        seen.add(entry.category);
        result.push(entry.category);
      }
    }
    return result;
  }

  /** All unique pattern categories in registration order. */
  get patternCategories(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of this._patterns.values()) {
      if (!seen.has(entry.category)) {
        seen.add(entry.category);
        result.push(entry.category);
      }
    }
    return result;
  }

  /** Tiles in a given category. */
  tilesByCategory(category: string): DocsTileEntry[] {
    const result: DocsTileEntry[] = [];
    for (const entry of this._tiles.values()) {
      if (entry.category === category) {
        result.push(entry);
      }
    }
    return result;
  }

  /** Patterns in a given category. */
  patternsByCategory(category: string): DocsPatternEntry[] {
    const result: DocsPatternEntry[] = [];
    for (const entry of this._patterns.values()) {
      if (entry.category === category) {
        result.push(entry);
      }
    }
    return result;
  }
}
