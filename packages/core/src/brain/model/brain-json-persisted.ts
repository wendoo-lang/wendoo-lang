import type { LiteralTileJson } from "../tiles/literals";
import type { MissingTileJson } from "../tiles/missing";
import type { PageTileJson } from "../tiles/pagetiles";
import type { VariableTileJson } from "../tiles/variables";
import type { BrainJson } from "./braindef";
import type { PageJson } from "./pagedef";
import type { RuleJson } from "./ruledef";

// Persisted brain JSON stores every identifier that can carry a project
// namespace as a small kind-discriminated value whose namespace is a field:
// absent for the owning project, present for a foreign one. Identifiers that
// cannot carry a namespace stay plain strings. A plain string never contains
// the owning namespace followed by `:`, nor the markers `:user.` or `:/`.
//
// A content-addressed literal's tile id, `tile.literal-><typeId>-><label>`
// with an optional `[<format>]` suffix, embeds the literal's label. It is
// stored as that plain string when its type ref is a plain string and the id
// contains none of the text above; otherwise it is stored as a `literal` ref
// holding the label verbatim in its `label` field. Both forms decode to the
// same tile id.

/** Persisted reference to a registered type. Plain string for types that carry no namespace. */
export type PersistedTypeRef =
  | string
  | { k: "named"; t: string; name: string; ns?: string }
  | { k: "nullable"; base: PersistedTypeRef }
  | { k: "list"; el: PersistedTypeRef }
  | { k: "map"; key: PersistedTypeRef; val: PersistedTypeRef }
  | { k: "union"; members: readonly PersistedTypeRef[] }
  | { k: "function"; params: readonly PersistedTypeRef[]; ret: PersistedTypeRef };

/**
 * Persisted reference to a tile. Plain string for tile ids that carry no
 * namespace. A `literal` ref re-mints a content-addressed literal's tile id
 * from its value type, its verbatim label, and its display format (absent for
 * the default format).
 */
export type PersistedTileRef =
  | string
  | { k: "action"; area: "sensor" | "actuator"; id: string; ns?: string }
  | { k: "arg"; area: "parameter" | "modifier"; action: string; name: string; ns?: string }
  | { k: "anon"; name: string; ns?: string }
  | { k: "accessor"; type: PersistedTypeRef; field: string }
  | { k: "out"; type: PersistedTypeRef; name: string; ns?: string }
  | { k: "literal"; type: PersistedTypeRef; label: string; format?: string };

/** A structured persisted reference, recordable against the runtime id it minted. */
export type PersistedIdRef = Exclude<PersistedTileRef, string> | Exclude<PersistedTypeRef, string>;

/** Persisted form of a literal catalog entry. The tile id is re-minted on load from the fields. */
export type PersistedLiteralTileJson = Omit<LiteralTileJson, "tileId" | "valueType"> & {
  valueType: PersistedTypeRef;
};

/** Persisted form of a variable catalog entry. The tile id is re-minted on load from `uniqueId`. */
export type PersistedVariableTileJson = Omit<VariableTileJson, "tileId" | "varType"> & {
  varType: PersistedTypeRef;
};

/** Persisted form of a page catalog entry. The tile id is re-minted on load from `pageId`. */
export type PersistedPageTileJson = Omit<PageTileJson, "tileId">;

/** Persisted form of a missing catalog entry, preserving the unresolved tile's identity. */
export type PersistedMissingTileJson = Omit<MissingTileJson, "tileId"> & {
  tileId: PersistedTileRef;
};

/** Discriminated union of persisted catalog entry shapes. */
export type PersistedCatalogTileJson =
  | PersistedLiteralTileJson
  | PersistedVariableTileJson
  | PersistedPageTileJson
  | PersistedMissingTileJson;

/** Persisted form of a rule: tile references in place of tile id strings. */
export type PersistedRuleJson = Omit<RuleJson, "when" | "do" | "children"> & {
  when: readonly PersistedTileRef[];
  do: readonly PersistedTileRef[];
  children: readonly PersistedRuleJson[];
};

/** Persisted form of a page. */
export type PersistedPageJson = Omit<PageJson, "rules"> & {
  rules: readonly PersistedRuleJson[];
};

/** Persisted form of a brain: the on-disk companion of {@link BrainJson}. */
export type PersistedBrainJson = Omit<BrainJson, "catalog" | "pages"> & {
  catalog: readonly PersistedCatalogTileJson[];
  pages: readonly PersistedPageJson[];
};
