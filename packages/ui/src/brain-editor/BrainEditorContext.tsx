import type { BrainServices, IBrainActionTileDef, IBrainTileDef, ITileCatalog } from "@wendoo/core/brain";
import type { BrainDef } from "@wendoo/core/brain/model";
import type { LocalizedValue, Localizer } from "@wendoo/core/localization";
import { createDefaultLocalizer } from "@wendoo/core/localization";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { PrintTransport } from "../print/standalone-print-document";
import type { EditorMode } from "./editor-mode";
import type { TileSourceLibrary } from "./tile-library-groups";
import type { TileVisual } from "./types";

/**
 * A literal type the host app supports beyond the core String/Number types.
 * It formats values for display in tiles, and may draw them in a placed
 * literal's value box. With the dialog members -- `isValid`, `parseValue`,
 * `toInputState` and `renderInputFields` -- it also supports creating and
 * editing values in CreateLiteralDialog; a type carrying none of them is
 * display-only, and the editor offers no value dialog for its literals.
 */
export interface CustomLiteralType {
  /** The type ID string (e.g. "struct:vector2"). */
  typeId: string;
  /** Human-readable description shown in the create-literal dialog. */
  description: string;
  /**
   * The word the default names of this type's literals are numbered from
   * ("image" yields "image 1", "image 2"). Left out, the type's entry in
   * {@link BrainEditorConfig.dataTypeNames} supplies the word, and a type named
   * by neither is numbered from a generic one.
   */
  nameBase?: string;
  /** Dialog member: returns true when the current input state is valid. */
  isValid?: (state: Record<string, string>) => boolean;
  /** Dialog member: parse the input state into the runtime value. */
  parseValue?: (state: Record<string, string>) => unknown;
  /**
   * Dialog member: the input state that renders `value` back into the fields,
   * which the create-literal dialog seeds itself with when it opens on an
   * existing literal. A value of another shape yields an empty state.
   */
  toInputState?: (value: unknown) => Record<string, string>;
  /** Dialog member: render the input fields for this literal type. */
  renderInputFields?: (
    state: Record<string, string>,
    onChange: (key: string, value: string) => void,
    onSubmit: () => void
  ) => ReactNode;
  /** Format a value for display in tiles. */
  formatValue: (value: unknown) => string;
  /**
   * Draws `value` in the value box of a placed literal of this type, in place
   * of its {@link CustomLiteralType.formatValue} text. Returning `undefined`,
   * as leaving the field out does, draws that text.
   */
  renderValue?: (value: unknown) => ReactNode;
}

/** A {@link CustomLiteralType} carrying every dialog member, so CreateLiteralDialog creates and edits its values. */
export type DialogLiteralType = CustomLiteralType &
  Required<Pick<CustomLiteralType, "isValid" | "parseValue" | "toInputState" | "renderInputFields">>;

/** Whether `customType` carries every dialog member, and so supports creating and editing values in a dialog. */
export function isDialogLiteralType(customType: CustomLiteralType): customType is DialogLiteralType {
  return (
    customType.isValid !== undefined &&
    customType.parseValue !== undefined &&
    customType.toInputState !== undefined &&
    customType.renderInputFields !== undefined
  );
}

/**
 * The entry of `customLiteralTypes` for `typeId` that supports creating and
 * editing values in a dialog, or `undefined` when none matches or the matching
 * entry is display-only.
 */
export function dialogLiteralType(
  typeId: string,
  customLiteralTypes: ReadonlyArray<CustomLiteralType>
): DialogLiteralType | undefined {
  const customType = customLiteralTypes.find((candidate) => candidate.typeId === typeId);
  return customType !== undefined && isDialogLiteralType(customType) ? customType : undefined;
}

/**
 * Configuration injected by the host app into the brain editor.
 *
 * This decouples the shared brain editor UI from app-specific concerns
 * like tile data type icons, variable factory detection, and custom types.
 */
export interface BrainEditorConfig {
  /** Maps data type IDs to icon URLs (e.g. CoreTypeIds.Number -> "/assets/.../number.svg"). */
  dataTypeIcons: ReadonlyMap<string, string>;
  /** Maps data type IDs to human-readable names (e.g. CoreTypeIds.Number -> "number"). */
  dataTypeNames: ReadonlyMap<string, string>;
  /** Resolves app-owned tile presentation without mutating core semantic catalogs. */
  resolveTileVisual?: (tileDef: IBrainTileDef) => TileVisual | undefined;
  /** Returns true if the given tile ID is an app-specific variable factory tile. */
  isAppVariableFactoryTileId?: (tileId: string) => boolean;
  /**
   * Reports whether a rule action tile's underlying user-authored definition
   * failed to compile. When it returns true, the editor marks every instance of
   * that tile with a broken-tile error badge, overriding any per-rule
   * diagnostic badge on the tile. Host apps that do not compile user-authored
   * tiles leave this undefined, and no broken-tile badges are shown.
   */
  isBrokenTile?: (tile: IBrainActionTileDef) => boolean;
  /** Custom literal types beyond the core String/Number. */
  customLiteralTypes: ReadonlyArray<CustomLiteralType>;
  /** Optional callback to load a default brain (replaces the archetype-specific load). */
  getDefaultBrain?: () => BrainDef | undefined;
  /** Optional BrainServices instance for direct access to tiles, types, etc. */
  brainServices?: BrainServices;
  /**
   * Display-time translation service for the app's current locale. Swap it for
   * one built on another locale's catalog and the editor re-renders in that
   * locale. Omitted, the editor renders every source string as authored.
   */
  localizer?: Localizer;
  /** Namespace of the active project. Brain files save and load namespace-relative to it. */
  projectNamespace?: string;
  /** Tile catalogs from the host environment (core + user tile catalogs). */
  tileCatalogs?: readonly ITileCatalog[];
  /** Installed libraries of the active project; the tile picker subgroups tiles attributed to them. */
  libraries?: readonly TileSourceLibrary[];
  /** Optional callback invoked when the user opens a tile's documentation from the editor. */
  onTileDocs?: (tileDef: IBrainTileDef) => void;
  /** Optional docs sidebar integration for the brain editor dialog toolbar. */
  docsIntegration?: {
    isOpen: boolean;
    toggle: () => void;
    close: () => void;
    /**
     * Receives the context the editor's keyboard stands in each time it
     * changes, and `undefined` once no editor stands. Documentation that tracks
     * the live editor reads it; hosts that show none leave it out.
     */
    reportMode?: (mode: EditorMode | undefined) => void;
  };
  /**
   * Optional region the editor lays out beside its rules, holding content the
   * host supplies. The host owns whether it stands open; the editor's toolbar
   * stands the control that toggles it.
   */
  sidePanel?: {
    /** Whether the region stands open. */
    isOpen: boolean;
    /** Opens the region when it is closed, and closes it when it is open. */
    toggle: () => void;
    /** What the region holds. It is put in on the region's first open. */
    content: ReactNode;
    /**
     * What the host calls the region. The control that toggles it reads its
     * accessible name from this; a host that leaves it out gets a generic one.
     */
    label?: string;
  };
  /**
   * Sink for the printable document when the host cannot open the browser
   * print dialog. When set, the print action serializes the print view into a
   * self-contained HTML document and hands it to this transport; when absent,
   * printing calls `window.print()` directly.
   */
  printTransport?: PrintTransport;
}

const BrainEditorContext = createContext<BrainEditorConfig | null>(null);

/** Provider for the brain editor configuration. Wrap any subtree that uses brain editor components. */
export function BrainEditorProvider({ config, children }: { config: BrainEditorConfig; children?: ReactNode }) {
  return <BrainEditorContext.Provider value={config}>{children}</BrainEditorContext.Provider>;
}

/** Read the active {@link BrainEditorConfig}. Throws when used outside a {@link BrainEditorProvider}. */
export function useBrainEditorConfig(): BrainEditorConfig {
  const config = useContext(BrainEditorContext);
  if (!config) {
    throw new Error("useBrainEditorConfig must be used within a BrainEditorProvider");
  }
  return config;
}

/**
 * Read the active {@link BrainEditorConfig}, and `undefined` where no
 * {@link BrainEditorProvider} stands.
 */
export function useOptionalBrainEditorConfig(): BrainEditorConfig | undefined {
  return useContext(BrainEditorContext) ?? undefined;
}

/** The default localizer used when the host config supplies none. */
const fallbackLocalizer = createDefaultLocalizer();

/**
 * Read the active {@link Localizer}. Falls back to the default localizer when
 * the host config supplies none. Components re-render when the host swaps the
 * config's localizer for another locale.
 */
export function useLocalizer(): Localizer {
  return useBrainEditorConfig().localizer ?? fallbackLocalizer;
}

/**
 * Read the active localizer's `tr`, bound to the current locale. Call it with
 * the English source string, its named parameters, and an optional context
 * tag.
 */
export function useTr(): (source: string, params?: Record<string, LocalizedValue>, context?: string) => string {
  const localizer = useLocalizer();
  return useMemo(() => localizer.tr.bind(localizer), [localizer]);
}
