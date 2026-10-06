import { type ActionOutputSpec, mkOutputTileId, mkOutputVarKey, mkScopedOutputName, type TypeId } from "../../runtime";
import { type BrainTileDefCreateOptions, TilePlacement } from "../interfaces";
import { BrainTileDefBase } from "../model/tiledef";

/**
 * Tile definition for an action output value-tile: an inline value exposed by
 * an action's declared output. The tile reads the backing rule variable keyed
 * by {@link mkOutputVarKey} (`__out.<outputType>.<name>`), which the action
 * writes via `setSensorOutput`.
 *
 * Identity is the `(outputType, name)` pair: two actions declaring the same
 * identity produce the same {@link mkOutputTileId tile id} and therefore one
 * shared tile. The tile is offered downstream only when an action listing its
 * {@link outputKey} in its `providedOutputs` is present in the rule hierarchy.
 */
export class BrainTileOutputDef extends BrainTileDefBase {
  readonly kind = "output";

  /** Bare output name as declared on the sensor. */
  readonly outputName: string;

  /** Value type the output produces, used for editor type compatibility. */
  readonly outputType: TypeId;

  /**
   * Namespace of the project declaring the output. Present exactly for
   * user-declared outputs, whose identity name is the declared name scoped by
   * this namespace. Absent for platform outputs.
   */
  readonly namespace?: string;

  /** Backing rule-variable key this tile reads, and the identity a providing sensor lists. */
  readonly outputKey: string;

  /**
   * When true, the output's value is a writable l-value: a field write through
   * this tile is permitted. Defaults to false, making the value read-only.
   */
  readonly writableResult: boolean;

  /**
   * @param outputType - the resolved {@link TypeId} of the output value
   * @param outputName - the bare output name declared on the sensor
   */
  constructor(outputType: TypeId, outputName: string, opts: BrainTileDefCreateOptions & { namespace?: string } = {}) {
    if (opts.placement === undefined) opts.placement = TilePlacement.EitherSide | TilePlacement.Inline;
    const identityName = opts.namespace !== undefined ? mkScopedOutputName(opts.namespace, outputName) : outputName;
    super(mkOutputTileId(outputType, identityName), opts);
    this.outputName = outputName;
    this.outputType = outputType;
    this.namespace = opts.namespace;
    this.outputKey = mkOutputVarKey(outputType, identityName);
    this.writableResult = opts.writableResult ?? false;
  }
}

/**
 * Build the inline output value-tiles for a built-in action's declared
 * {@link ActionOutputSpec} outputs. The declaring action exposes each tile's
 * {@link BrainTileOutputDef.outputKey} through its `providedOutputs`, which gates
 * the tile downstream; the action writes each output with `setSensorOutput` and
 * the tile reads the matching backing rule variable.
 */
export function buildDescriptorOutputTiles(outputs: readonly ActionOutputSpec[]): BrainTileOutputDef[] {
  const tiles: BrainTileOutputDef[] = [];
  for (const output of outputs) {
    tiles.push(
      new BrainTileOutputDef(output.type, output.name, {
        metadata: {
          label: output.label ?? output.name,
          iconUrl: output.iconUrl,
          docsMarkdown: output.docsMarkdown,
          tags: output.tags,
        },
        writableResult: output.writableResult,
      })
    );
  }
  return tiles;
}
