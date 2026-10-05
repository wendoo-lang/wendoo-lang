import { assertUnreachable } from "@wendoo/core";
import type { BrainTileKind, IBrainTileDef } from "@wendoo/core/brain";
import { LiteralDisplayFormats } from "@wendoo/core/brain";
import {
  applyDisplayFormat,
  type BrainTileAccessorDef,
  type BrainTileLiteralDef,
  type BrainTileOutputDef,
  type BrainTileVariableDef,
  getCatalogFallbackLabel,
} from "@wendoo/core/brain/tiles";
import { adjustColor, saturateColor } from "../lib/color";
import type { BrainEditorConfig } from "./BrainEditorContext";
import type { TileVisual } from "./types";

/** The hue a tile is read in when its visual names no color for the side it sits on. */
export const kDefaultTileHue = "#475569";

/** The edge color a tile's own fill yields: `baseColor` saturated and darkened. */
export function tileEdgeColor(baseColor: string): string {
  return adjustColor(saturateColor(baseColor, 0.5), -0.4);
}

/**
 * The border color a tile takes, as a CSS value: `--color-brain-tile-border`
 * where an app gives every tile one border color, and the tile's own
 * {@link tileEdgeColor} where it does not.
 */
export function tileBorderColor(baseColor: string): string {
  return `var(--color-brain-tile-border, ${tileEdgeColor(baseColor)})`;
}

/**
 * How a tile chip renders, derived from its kind:
 *
 * - "value" -- shows its value in a boxed value field (literal, variable, output)
 * - "accessor" -- an icon chip whose corner carries the silhouette of its result data type's icon (accessor)
 * - "action" -- an icon chip that may carry the async-completion badge (sensor, actuator)
 * - "parameter" -- an icon chip with a data-type badge (parameter)
 * - "factory" -- an icon chip drawn at reduced scale (factory)
 * - "generic" -- a plain icon chip (all other kinds)
 */
export type TileVisualCategory = "value" | "accessor" | "action" | "parameter" | "factory" | "generic";

/** Maps every {@link BrainTileKind} to the {@link TileVisualCategory} its chip renders as. */
export const tileVisualCategoryByKind: Record<BrainTileKind, TileVisualCategory> = {
  undefined: "generic",
  sensor: "action",
  actuator: "action",
  parameter: "parameter",
  operator: "generic",
  variable: "value",
  literal: "value",
  factory: "factory",
  controlFlow: "generic",
  modifier: "generic",
  accessor: "accessor",
  page: "generic",
  output: "value",
  missing: "generic",
};

/** The {@link TileVisualCategory} of a tile, keyed by its kind. */
export function tileVisualCategory(tileDef: IBrainTileDef): TileVisualCategory {
  return tileVisualCategoryByKind[tileDef.kind];
}

function defaultTileLabel(tileDef: IBrainTileDef): string {
  switch (tileDef.kind) {
    case "literal": {
      const literalDef = tileDef as BrainTileLiteralDef;
      const fmt = literalDef.displayFormat;
      return fmt && fmt !== LiteralDisplayFormats.Default && typeof literalDef.value === "number"
        ? applyDisplayFormat(literalDef.value, fmt)
        : literalDef.valueLabel || String(literalDef.value);
    }
    case "variable":
      return (tileDef as BrainTileVariableDef).varName;
    case "accessor":
      return (tileDef as BrainTileAccessorDef).fieldName;
    case "output":
      return (tileDef as BrainTileOutputDef).outputName;
    case "undefined":
    case "sensor":
    case "actuator":
    case "parameter":
    case "operator":
    case "factory":
    case "controlFlow":
    case "modifier":
    case "page":
    case "missing":
      return getCatalogFallbackLabel(tileDef);
    default:
      return assertUnreachable(tileDef.kind);
  }
}

/**
 * Resolve the visual (label, icon, colors) for a tile by merging the tile's
 * intrinsic metadata with `appResolver`'s reading of it, the app's reading
 * winning field by field. The label falls back to a kind-specific default
 * (literal value, variable name, accessor field name, output name) when neither
 * source provides a meaningful one. Pass `undefined` for `appResolver` where the
 * host supplies none, which resolves the tile from its own metadata alone.
 */
export function resolveTileVisualFrom(
  appResolver: ((tileDef: IBrainTileDef) => TileVisual | undefined) | undefined,
  tileDef: IBrainTileDef
): TileVisual {
  const intrinsicVisual = tileDef.metadata as TileVisual | undefined;
  const appVisual = appResolver?.(tileDef);
  const appLabel = appVisual?.label;
  const appResolvedLabel = appLabel && appLabel !== getCatalogFallbackLabel(tileDef) ? appLabel : undefined;
  const intrinsicLabel = intrinsicVisual?.label;
  const intrinsicResolvedLabel =
    intrinsicLabel && intrinsicLabel !== getCatalogFallbackLabel(tileDef) ? intrinsicLabel : undefined;

  return {
    ...(intrinsicVisual ?? {}),
    ...(appVisual ?? {}),
    label: appResolvedLabel ?? intrinsicResolvedLabel ?? defaultTileLabel(tileDef),
  };
}

/**
 * Resolve the visual (label, icon, colors) for a tile by merging its intrinsic
 * metadata with `config`'s own reading of it, the config's reading winning field
 * by field, and falling back to a kind-specific default label.
 */
export function resolveTileVisual(config: BrainEditorConfig, tileDef: IBrainTileDef): TileVisual {
  return resolveTileVisualFrom(config.resolveTileVisual, tileDef);
}

/** How a tile reads to assistive technology: the kind of tile it is, and the label it shows. */
export function tileAccessibleName(config: BrainEditorConfig, tileDef: IBrainTileDef): string {
  return `${tileDef.kind} tile: ${resolveTileVisual(config, tileDef).label}`;
}
