// ---------------------------------------------------------------------------
// Core documentation manifest -- locale-independent metadata for all core
// tile and concept docs. Content strings are loaded separately per locale.
//
// Each entry's `contentKey` matches the filename stem under
// content/{locale}/tiles/ or content/{locale}/concepts/.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tile doc metadata
// ---------------------------------------------------------------------------

export interface CoreTileDocMeta {
  /** Full tile ID as registered in the brain services (e.g., "tile.op->and"). */
  tileId: string;
  /** Search/filter tags. */
  tags: string[];
  /** Display category for sidebar grouping. */
  category: string;
  /** Key into the locale content map (matches filename stem). */
  contentKey: string;
}

/** Documentation manifest for built-in core tiles. Pair each entry with the markdown content keyed by `contentKey`. */
export const coreTileDocs: readonly CoreTileDocMeta[] = [
  // -- Operators: logic ------------------------------------------------------
  { tileId: "tile.op->and", tags: ["logic", "boolean", "operators"], category: "Operators", contentKey: "op-and" },
  { tileId: "tile.op->or", tags: ["logic", "boolean", "operators"], category: "Operators", contentKey: "op-or" },
  { tileId: "tile.op->not", tags: ["logic", "boolean", "operators"], category: "Operators", contentKey: "op-not" },

  // -- Operators: arithmetic -------------------------------------------------
  { tileId: "tile.op->add", tags: ["math", "arithmetic", "operators"], category: "Operators", contentKey: "op-add" },
  {
    tileId: "tile.op->sub",
    tags: ["math", "arithmetic", "operators"],
    category: "Operators",
    contentKey: "op-subtract",
  },
  {
    tileId: "tile.op->mul",
    tags: ["math", "arithmetic", "operators"],
    category: "Operators",
    contentKey: "op-multiply",
  },
  {
    tileId: "tile.op->div",
    tags: ["math", "arithmetic", "operators"],
    category: "Operators",
    contentKey: "op-divide",
  },
  {
    tileId: "tile.op->neg",
    tags: ["math", "arithmetic", "operators"],
    category: "Operators",
    contentKey: "op-negate",
  },

  // -- Operators: comparison -------------------------------------------------
  {
    tileId: "tile.op->eq",
    tags: ["comparison", "boolean", "operators"],
    category: "Operators",
    contentKey: "op-equal",
  },
  {
    tileId: "tile.op->ne",
    tags: ["comparison", "boolean", "operators"],
    category: "Operators",
    contentKey: "op-not-equal",
  },
  {
    tileId: "tile.op->lt",
    tags: ["comparison", "boolean", "operators"],
    category: "Operators",
    contentKey: "op-less-than",
  },
  {
    tileId: "tile.op->le",
    tags: ["comparison", "boolean", "operators"],
    category: "Operators",
    contentKey: "op-less-equal",
  },
  {
    tileId: "tile.op->gt",
    tags: ["comparison", "boolean", "operators"],
    category: "Operators",
    contentKey: "op-greater-than",
  },
  {
    tileId: "tile.op->ge",
    tags: ["comparison", "boolean", "operators"],
    category: "Operators",
    contentKey: "op-greater-equal",
  },

  // -- Operators: assignment -------------------------------------------------
  {
    tileId: "tile.op->assign",
    tags: ["assignment", "variables", "operators"],
    category: "Operators",
    contentKey: "op-assign",
  },

  // -- Control flow ----------------------------------------------------------
  {
    tileId: "tile.actuator->switch-page",
    tags: ["pages", "navigation", "control flow"],
    category: "Control Flow",
    contentKey: "cf-switch-page",
  },

  // -- Core sensors ----------------------------------------------------------
  {
    tileId: "tile.sensor->on-page-entered",
    tags: ["pages", "events", "sensors"],
    category: "Sensors",
    contentKey: "sensor-on-page-entered",
  },
  {
    tileId: "tile.sensor->sensor.timeout",
    tags: ["time", "delay", "timer", "sensors"],
    category: "Sensors",
    contentKey: "sensor-timeout",
  },

  // -- Functions (inline sensors) --------------------------------------------
  {
    tileId: "tile.sensor->random",
    tags: ["random", "numbers", "functions"],
    category: "Functions",
    contentKey: "sensor-random",
  },
  {
    tileId: "tile.sensor->current-page",
    tags: ["pages", "navigation", "functions"],
    category: "Functions",
    contentKey: "sensor-current-page",
  },
  {
    tileId: "tile.sensor->previous-page",
    tags: ["pages", "navigation", "functions"],
    category: "Functions",
    contentKey: "sensor-previous-page",
  },

  // -- Variable factories ----------------------------------------------------
  {
    tileId: "tile.var.factory->boolean",
    tags: ["variables", "boolean", "factory"],
    category: "Variables",
    contentKey: "var-factory-boolean",
  },
  {
    tileId: "tile.var.factory->number",
    tags: ["variables", "number", "factory"],
    category: "Variables",
    contentKey: "var-factory-number",
  },
  {
    tileId: "tile.var.factory->string",
    tags: ["variables", "string", "text", "factory"],
    category: "Variables",
    contentKey: "var-factory-string",
  },

  // -- Literal factories -----------------------------------------------------
  {
    tileId: "tile.lit.factory->number",
    tags: ["literals", "number", "factory"],
    category: "Literals",
    contentKey: "lit-factory-number",
  },
  {
    tileId: "tile.lit.factory->string",
    tags: ["literals", "string", "text", "factory"],
    category: "Literals",
    contentKey: "lit-factory-string",
  },
] as const;

// ---------------------------------------------------------------------------
// Concept doc metadata
// ---------------------------------------------------------------------------

export interface CoreConceptDocMeta {
  /** Unique concept identifier. */
  id: string;
  /** Display title. */
  title: string;
  /** Search/filter tags. */
  tags: string[];
  /** Key into the locale content map (matches filename stem). */
  contentKey: string;
}

/** Documentation manifest for core conceptual articles (not tied to a specific tile). */
export const coreConceptDocs: readonly CoreConceptDocMeta[] = [
  {
    id: "rule-evaluation",
    title: "How Rules Work",
    tags: ["rules", "execution", "fundamentals"],
    contentKey: "rule-evaluation",
  },
  {
    id: "trigger-modes",
    title: "What Starts a Rule",
    tags: ["rules", "triggers", "else", "then", "sequencing", "fundamentals"],
    contentKey: "trigger-modes",
  },
  {
    id: "sequencing",
    title: "Putting Steps in Order",
    tags: ["rules", "sequencing", "children", "nesting", "then", "fundamentals"],
    contentKey: "sequencing",
  },
  {
    id: "pages",
    title: "Pages and Navigation",
    tags: ["pages", "navigation", "control flow", "fundamentals"],
    contentKey: "pages",
  },
  {
    id: "data-types",
    title: "Data Types",
    tags: ["types", "variables", "literals", "fundamentals"],
    contentKey: "data-types",
  },
  {
    id: "variables",
    title: "Variables",
    tags: ["variables", "state", "storage", "fundamentals"],
    contentKey: "variables",
  },
  {
    id: "literals",
    title: "Literals",
    tags: ["literals", "values", "numbers", "fundamentals"],
    contentKey: "literals",
  },
  {
    id: "nothing",
    title: "When There Is No Value",
    tags: ["nil", "nothing", "values", "parameters", "fundamentals"],
    contentKey: "nothing",
  },
] as const;
