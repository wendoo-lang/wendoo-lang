import type { IBrainTileDef, ITileCatalog, RuleSide } from "@wendoo/core/brain";
import { isLiteralFactoryTileId } from "@wendoo/core/brain";
import type { BrainCommandHistory, BrainRuleDef } from "@wendoo/core/brain/model";
import { EditLiteralCommand, ReplaceTileCommand } from "@wendoo/core/brain/model";
import type { BrainTileFactoryDef, BrainTileLiteralDef } from "@wendoo/core/brain/tiles";
import { manufactureLiteralTile } from "@wendoo/core/brain/tiles";
import { CoreTypeIds } from "@wendoo/core/runtime";
import { type CustomLiteralType, type DialogLiteralType, dialogLiteralType } from "./BrainEditorContext";

/** Keys naming the entries a placed tile's menu can offer. */
export const TileMenuEntryKeys = {
  /** Edits how a number literal's value is displayed. */
  Format: "format",
  /** Edits a literal's value in the editor its type's host supplied. */
  Value: "value",
  /** Forks a literal into a new one of its own, seeded from its value. */
  Duplicate: "duplicate",
  /** Renames a variable tile. */
  Rename: "rename",
  /** Opens the tile's documentation. */
  Docs: "docs",
} as const;

/** One thing the menu offers to do to the tile it stands on. */
export interface TileMenuEntry {
  /** Identifies the entry among the ones the tile offers; one of {@link TileMenuEntryKeys}. */
  readonly key: string;
  /** How the entry reads. */
  readonly label: string;
  /** What choosing it does. */
  readonly run: () => void;
}

/** What each menu entry runs when it is chosen. */
export interface TileMenuActions {
  /** Opens the display-format editor. */
  editFormat: () => void;
  /** Opens the value editor. */
  editValue: () => void;
  /** Opens the value editor seeded for a fork of the literal. */
  duplicateValue: () => void;
  /** Opens the rename form. */
  renameVariable: () => void;
  /** Opens the tile's documentation, and is left out where the host wires none up. */
  openDocs?: () => void;
}

/** What editing a placed literal's value runs through. */
export interface LiteralValueEditor {
  /** The literal tile standing in the rule. */
  readonly literalDef: BrainTileLiteralDef;
  /** The host's editor for that literal's value type, which renders and parses the input fields. */
  readonly customType: DialogLiteralType;
  /** The literal factory producing that type, which mints a literal of a submitted value. */
  readonly factory: BrainTileFactoryDef;
  /**
   * True when the brain's own catalog holds this literal, so a new value may be
   * put on it. A literal an environment catalog provides is read-only, and takes
   * a fork of its value instead.
   */
  readonly editable: boolean;
}

/**
 * The value editor `tileDef` offers, and undefined when it offers none: the
 * tile is not a literal, `customLiteralTypes` holds no entry carrying the
 * dialog members for its value type, or `tiles` holds no literal factory
 * producing that type to mint through.
 *
 * @param tileDef the placed tile the menu stands on
 * @param customLiteralTypes the custom literal editors the host supplied
 * @param tiles the edit-time tile catalog literal factories are registered in
 * @param documentCatalog the brain's own catalog, which decides
 * {@link LiteralValueEditor.editable}; a literal is read-only without it
 */
export function literalValueEditor(
  tileDef: IBrainTileDef,
  customLiteralTypes: ReadonlyArray<CustomLiteralType>,
  tiles: ITileCatalog | undefined,
  documentCatalog?: ITileCatalog
): LiteralValueEditor | undefined {
  if (tileDef.kind !== "literal" || !tiles) return undefined;
  const literalDef = tileDef as BrainTileLiteralDef;
  const customType = dialogLiteralType(literalDef.valueType, customLiteralTypes);
  if (!customType) return undefined;
  const factory = tiles.find(
    (candidate) =>
      candidate.kind === "factory" &&
      isLiteralFactoryTileId(candidate.tileId) &&
      (candidate as BrainTileFactoryDef).producedDataType === literalDef.valueType
  ) as BrainTileFactoryDef | undefined;
  if (!factory) return undefined;
  return { literalDef, customType, factory, editable: documentCatalog?.get(literalDef.tileId) === literalDef };
}

/**
 * The entries the menu of `tileDef` offers, in the order they are shown. A tile
 * whose kind offers nothing, standing where no documentation is wired up,
 * yields none.
 *
 * @param tileDef the placed tile the menu stands on
 * @param valueEditor the value editor that tile offers, from {@link literalValueEditor}
 * @param actions what each entry runs when it is chosen
 */
export function buildTileMenuEntries(
  tileDef: IBrainTileDef,
  valueEditor: LiteralValueEditor | undefined,
  actions: TileMenuActions
): TileMenuEntry[] {
  const entries: TileMenuEntry[] = [];
  if (tileDef.kind === "literal" && (tileDef as BrainTileLiteralDef).valueType === CoreTypeIds.Number) {
    entries.push({ key: TileMenuEntryKeys.Format, label: "Edit Format", run: actions.editFormat });
  }
  if (valueEditor?.editable) {
    entries.push({ key: TileMenuEntryKeys.Value, label: "Edit Value...", run: actions.editValue });
  }
  if (valueEditor) {
    entries.push({ key: TileMenuEntryKeys.Duplicate, label: "Duplicate...", run: actions.duplicateValue });
  }
  if (tileDef.kind === "variable") {
    entries.push({ key: TileMenuEntryKeys.Rename, label: "Rename...", run: actions.renameVariable });
  }
  if (actions.openDocs) {
    entries.push({ key: TileMenuEntryKeys.Docs, label: "Docs", run: actions.openDocs });
  }
  return entries;
}

/** What a literal-value submission acts on. */
export interface LiteralValueSubmitOptions {
  /** The rule holding the placed literal. */
  ruleDef: BrainRuleDef;
  /** The side of `ruleDef` holding it. */
  side: RuleSide;
  /** The tile's place among the tiles of that side, counting from zero. */
  tileIndex: number;
  /** The value editor the placed literal offers. */
  editor: LiteralValueEditor;
  /** The value submitted for the literal. */
  value: unknown;
  /** The word the literal reads by; left out, it reads by its value. */
  displayName?: string;
  /** History the edit is recorded on, which undo takes it back from. */
  commandHistory: BrainCommandHistory;
}

/**
 * Puts `value` and `displayName` on the placed literal.
 *
 * A literal carrying its own identity is edited in place: the brain's catalog
 * entry and every placement of it move to the edited literal under the same
 * tile id, and undo restores both the value and the name everywhere. A literal
 * whose id follows its content is replaced in the rule by a freshly minted
 * literal of that value, the placements of it elsewhere left as they stand.
 *
 * Returns the literal now standing at `tileIndex`, and undefined when the
 * factory mints nothing.
 */
export function editLiteralValue(options: LiteralValueSubmitOptions): IBrainTileDef | undefined {
  const { ruleDef, editor, value, displayName, commandHistory } = options;
  const literalDef = editor.literalDef;
  const brainDef = ruleDef.brain();
  if (literalDef.uniqueId === undefined || !brainDef) return duplicateLiteralValue(options);
  commandHistory.executeCommand(new EditLiteralCommand(brainDef, literalDef, { value, displayName }));
  return brainDef.catalog().get(literalDef.tileId);
}

/**
 * Puts a literal of `value` where the placed literal stands, minted through the
 * value type's factory so it carries the id any other minting of that content
 * produces. When the rule's brain catalog already holds a literal of that id,
 * that def is the one placed and no second copy is registered; an id the
 * catalog does not hold is registered as the minted literal. A `displayName`
 * names the literal placed, renaming the one the catalog already holds. Returns
 * the tile def placed, and undefined when the factory mints nothing.
 */
export function duplicateLiteralValue(options: LiteralValueSubmitOptions): IBrainTileDef | undefined {
  const { ruleDef, side, tileIndex, editor, value, displayName, commandHistory } = options;
  const newTileDef = manufactureLiteralTile(editor.factory, ruleDef.brain()?.catalog(), value, undefined, displayName);
  if (!newTileDef) return undefined;
  commandHistory.executeCommand(new ReplaceTileCommand(ruleDef, side, tileIndex, newTileDef));
  return newTileDef;
}
