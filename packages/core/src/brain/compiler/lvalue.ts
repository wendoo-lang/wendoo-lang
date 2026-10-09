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
 * - a field access chain rooted at a literal is an l-value only when every
 *   link is writable AND its terminal accessor -- the field the assignment
 *   stores -- is routed;
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
      return !expr.accessor.readOnly && isAssignableBase(expr.object, expr.accessor.routed);
    case "sensor":
      return expr.tileDef.writableResult === true;
    case "output":
      return expr.tileDef.writableResult === true;
    default:
      return false;
  }
}

/**
 * True when `base`, the object of a field access chain whose terminal accessor
 * is routed exactly when `terminalRouted`, may carry an assignment: every
 * field link down to the chain's root is writable, and the root is an l-value,
 * or a literal under a routed terminal.
 */
function isAssignableBase(base: Expr, terminalRouted: boolean): boolean {
  if (base.kind === "fieldAccess") {
    return !base.accessor.readOnly && isAssignableBase(base.object, terminalRouted);
  }
  if (base.kind === "literal") {
    return terminalRouted;
  }
  return isLValue(base);
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
