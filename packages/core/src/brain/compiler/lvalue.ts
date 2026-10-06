import type { IBrainTileDef } from "../interfaces";
import type { BrainTileOutputDef, BrainTileSensorDef } from "../tiles";
import type { Expr } from "./types";

/**
 * True when `expr` denotes a writable storage location that an assignment may
 * target. The check is recursive and base-aware:
 *
 * - a variable is always an l-value;
 * - a field access is an l-value only when its accessor is writable AND the
 *   object it reads from is itself an l-value (a writable field on a read-only
 *   base is not writable);
 * - a sensor result is an l-value only when the sensor declares
 *   `writableResult` (a live-reference result); a plain sensor result is a
 *   computed value with no storage to write to;
 * - an output's value is an l-value only when the output declares
 *   `writableResult`; a plain output's value is read-only;
 * - every other expression (literal, operator, computed) is not an l-value.
 *
 * The per-field `readOnly` flag and the per-sensor or per-output
 * `writableResult` flag are orthogonal: both must permit the write for a field
 * access to be assignable.
 */
export function isLValue(expr: Expr): boolean {
  switch (expr.kind) {
    case "variable":
      return true;
    case "fieldAccess":
      return !expr.accessor.readOnly && isLValue(expr.object);
    case "sensor":
      return expr.tileDef.writableResult === true;
    case "output":
      return expr.tileDef.writableResult === true;
    default:
      return false;
  }
}

/**
 * True when a tile, standing alone as an expression, denotes a writable
 * storage location: a variable tile, or a sensor or output tile whose value is
 * declared writable via `writableResult`. These are the leaf cases of
 * {@link isLValue} expressed at the tile-definition level.
 */
export function isLValueTile(tileDef: IBrainTileDef): boolean {
  switch (tileDef.kind) {
    case "variable":
      return true;
    case "sensor":
      return (tileDef as BrainTileSensorDef).writableResult === true;
    case "output":
      return (tileDef as BrainTileOutputDef).writableResult === true;
    default:
      return false;
  }
}
