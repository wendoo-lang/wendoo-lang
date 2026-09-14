import type { CatalogTile } from "../tools/read-catalog.js";
import { sanitizeCatalogTile } from "./sanitize.js";

/** The catalog serialized for a model's context. */
export interface CatalogDigest {
  /** One JSON object per line, tiles in ascending tile-id order. */
  readonly text: string;
  /** Tiles the text carries a line for. */
  readonly tileCount: number;
  /** Fingerprint of {@link text} as eight lowercase hex digits. Equal hashes mean equal text. */
  readonly hash: string;
}

/** Render the rules of the tile language that hold for every target, as catalog-facing prose. */
export function languageGrammarLegend(): string {
  return `These rules hold whatever the tiles are:
- Every rule carries a trigger mode -- \`when\`, \`otherwise\`, or \`then\`, shown on the rule as WHEN, ELSE, and THEN. The mode says what arms the rule; the WHEN side stays an ordinary sensor expression, possibly empty, that gates firing once armed. The first rule at a level is always \`when\`; the other two read the rule above them at the same level. An empty WHEN side always fires, so a bare \`when\` rule fires every think it is scheduled.
- A rule side holds exactly one statement; two actions on one trigger need two rules. Sequence them as siblings: give the second rule the \`then\` mode, and it runs once the rule above it completes as a cluster -- that rule's DO finished, and every rule its firing spawned finished with it. A run of \`then\` rules plays out one step after another.
- A child rule is not sequencing: it elaborates one firing of the rule it sits under, running each time that rule finishes its DO, and it carries its own modes among its own siblings.
- A flat run of \`otherwise\` rules is an if / else-if / else ladder: each fires on a think when no earlier rule of the run fired that think and its own expression holds. An empty expression is the plain \`else\`.
- \`THEN when <sensor>\` filters at the completion moment rather than waiting: the sensor is read the moment the rule above completes, and a miss skips that completion. To wait for something after the completion, use a flag variable: the \`then\` sets it, and a separate \`when\` rule fires on the flag plus the awaited condition and clears it -- a child rule nested under the \`then\` does not wait, it is read once at that same moment.
- A \`then\` that skips -- its subject never fired, or its own expression did not hold -- takes the rest of the chain with it, so every \`then\` below it skips too. An \`otherwise\` after a \`then\` is the while-waiting branch: it fires on the thinks the \`then\` did not, including the thinks it is still waiting on its subject.
- An action's anonymous slot, which reads as \`<name>:<type>\` and as \`value:<type>\` when the slot names none, takes no tile of its own: an empty one takes the next value expression placed, whatever its type, so fill it before placing anything else.
- A sensor with its modifiers and parameters stands alone as a rule's whole WHEN side; a further condition on it belongs in a child rule -- do not parenthesize a sensor to join it into an expression.
- A new variable already holds its type's empty value -- a number starts at 0, a yes/no at no, a text at "" -- so a rule may read one before anything has written to it.`;
}

/**
 * Every field {@link CatalogTile} declares, in the order a tile line writes
 * them. A field a tile carries that is not named here is written after all of
 * these, its fellow unnamed fields in ascending name order.
 */
const CATALOG_TILE_FIELDS = [
  "tileId",
  "label",
  "kind",
  "description",
  "assistant",
  "outputType",
  "args",
  "placement",
  "requires",
  "provides",
  "outputs",
  "consumesWhenResult",
  "hidden",
  "deprecated",
] as const satisfies readonly (keyof CatalogTile)[];

/** The names {@link CATALOG_TILE_FIELDS} holds, for telling a tile's other fields apart from them. */
const declaredFields: ReadonlySet<string> = new Set(CATALOG_TILE_FIELDS);

/**
 * Serialize `tile` as the JSON object one digest line holds, writing its fields
 * in the order {@link CATALOG_TILE_FIELDS} states and leaving out every field
 * holding `undefined`. The bytes do not depend on the order `tile` itself
 * spells its fields in.
 */
function tileLine(tile: CatalogTile): string {
  const carried = new Map<string, unknown>(Object.entries(tile));
  const unnamed = [...carried.keys()].filter((field) => !declaredFields.has(field)).sort();
  const ordered: Record<string, unknown> = {};
  for (const field of [...CATALOG_TILE_FIELDS, ...unnamed]) {
    const value = carried.get(field);
    if (value !== undefined) ordered[field] = value;
  }
  return JSON.stringify(ordered);
}

/** Fingerprint `text` as eight lowercase hex digits, the same in every runtime. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Serialize the catalog deterministically for the prompt prefix as JSON Lines:
 * one line per tile, each holding exactly the object `read_catalog` reports for
 * that tile once {@link sanitizeCatalogTile} has capped its author text, its
 * fields written as {@link CATALOG_TILE_FIELDS} orders them. Tiles the editor
 * hides from its pickers are omitted, and the rest are sorted by tile id, so
 * the same catalog always produces the same bytes whatever order its tiles and
 * their fields arrived in. Every character of a tile's text is carried,
 * JSON-encoded, including the fields of a tile richer than this build declares.
 */
export function catalogDigest(tiles: readonly CatalogTile[]): CatalogDigest {
  const listed = tiles
    .filter((tile) => !tile.hidden)
    .map(sanitizeCatalogTile)
    .sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));
  const text = listed.map(tileLine).join("\n");
  return { text, tileCount: listed.length, hash: fingerprint(text) };
}
