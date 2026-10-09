import type { TypeId } from "../../runtime/type-defs";
import { type BrainTileDefCreateOptions, mkAccessorTileId, TilePlacement } from "../interfaces";
import { BrainTileDefBase } from "../model/tiledef";
import type { BrainServices } from "../services";

/** Options for {@link BrainTileAccessorDef}. Adds the `readOnly` and `routed` flags to the standard tile options. */
export type BrainAccessorTileDefCreateOptions = BrainTileDefCreateOptions & {
  /** When true, the field is read-only and cannot appear as an assignment target. */
  readOnly?: boolean;
  /**
   * When true, a write to the field routes through its struct type's field
   * setter to the host state behind the value, never into the value's own
   * storage. Meaningful only on a writable field.
   */
  routed?: boolean;
};

/**
 * Tile definition for struct field accessors.
 *
 * An accessor tile appears immediately after an expression that produces a struct value
 * and selects a named field from it. In tile sequences, the syntax is:
 *
 *   [$my_position] [x]        ->  FieldAccessExpr(variable(my_position), "x")
 *   [$my_position] [x] [=] [10]  ->  Assignment(FieldAccess(variable(my_position), "x"), 10)
 *
 * The parser treats accessor tiles as LED (left denotation) tokens --
 * they bind to the left expression at maximum precedence, like postfix operators.
 *
 * When `readOnly` is true, the parser rejects assignments to this field and the
 * tile suggestion system suppresses the assignment operator after a field access
 * using this accessor. When `routed` is true, a write to the field reaches host
 * state through the struct type's field setter, which makes the field assignable
 * even on a literal value.
 */
export class BrainTileAccessorDef extends BrainTileDefBase {
  readonly kind = "accessor";
  readonly fieldName: string;
  readonly structTypeId: TypeId;
  readonly fieldTypeId: TypeId;
  readonly readOnly: boolean;
  /** Whether a write to the field routes through its struct type's field setter. */
  readonly routed: boolean;

  constructor(
    structTypeId: TypeId,
    fieldName: string,
    fieldTypeId: TypeId,
    opts: BrainAccessorTileDefCreateOptions = {}
  ) {
    if (opts.placement === undefined) opts.placement = TilePlacement.EitherSide;
    super(mkAccessorTileId(structTypeId, fieldName), opts);
    this.structTypeId = structTypeId;
    this.fieldName = fieldName;
    this.fieldTypeId = fieldTypeId;
    this.readOnly = opts.readOnly ?? false;
    this.routed = opts.routed ?? false;
  }
}

/** Build a {@link BrainTileAccessorDef} for `structTypeId.fieldName` of type `fieldTypeId`. */
export function createAccessorTileDef(
  structTypeId: TypeId,
  fieldName: string,
  fieldTypeId: TypeId,
  opts?: BrainAccessorTileDefCreateOptions
): BrainTileAccessorDef {
  return new BrainTileAccessorDef(structTypeId, fieldName, fieldTypeId, opts);
}

/** Type guard for {@link BrainTileAccessorDef}. */
export function isAccessorTileDef(tileDef: BrainTileDefBase): tileDef is BrainTileAccessorDef {
  return tileDef.kind === "accessor";
}

/** Build {@link createAccessorTileDef} and register it with `services`. */
export function registerAccessorTileDef(
  structTypeId: TypeId,
  fieldName: string,
  fieldTypeId: TypeId,
  opts: BrainAccessorTileDefCreateOptions | undefined,
  services: BrainServices
) {
  const tileDef = createAccessorTileDef(structTypeId, fieldName, fieldTypeId, opts);
  services.edit.tiles.registerTileDef(tileDef);
}
