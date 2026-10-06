import { assertUnreachable, List } from "@wendoo/core";
import {
  type BrainServices,
  CoreCapabilityBits,
  type IBrainTileDef,
  type ITileMetadata,
  TilePlacement,
} from "@wendoo/core/brain";
import {
  BrainTileActuatorDef,
  BrainTileModifierDef,
  BrainTileOutputDef,
  BrainTileParameterDef,
  BrainTileSensorDef,
  createAccessorTileDef,
  createVariableFactoryTileDef,
} from "@wendoo/core/brain/tiles";
import {
  type ActionDescriptor,
  mkAnonParameterId,
  mkModifierTileId,
  mkParameterTileId,
  type NamespacedTypeName,
  splitNamespacedTypeName,
  type TypeId,
  type UserArgIdentity,
} from "@wendoo/core/runtime";
import { BitSet } from "@wendoo/core/util";
import { collectModifiers, collectParams } from "../compiler/arg-spec-utils.js";
import { parseQualifiedClassName, privateArgTileId } from "../compiler/symbol-keys.js";
import type { ExtractedModifier, ExtractedParam, UserAuthoredProgram, UserTileDefinition } from "../compiler/types.js";

/** Resolve a parameter type name to a runtime `TypeId`, or `undefined` when the type is not registered. */
export type UserTileTypeResolver = (typeName: string) => TypeId | undefined;

/** A tile surface a bundle registers: a compiled program or a program-less tile definition. */
export type UserTileSurface = UserAuthoredProgram | UserTileDefinition;

/** One struct-derived tile paired with the namespace of the library declaring the struct. */
export interface OwnedStructTypeTile {
  tile: IBrainTileDef;
  /** Namespace segment of the struct's cross-module identity: the library or host project declaring it. */
  namespace: string;
}

/**
 * Accessor tiles and variable-factory tiles derived from a program's declared
 * or imported struct types: one accessor per field for `accessors: true`
 * declarations, one variable factory for `variables: true` declarations. Each
 * tile is paired with the namespace of the struct's declaring root, taken from
 * the struct's cross-module identity, so an importing program derives the same
 * tile under the same owner. Tile ids derive from the struct's registered type
 * id, so every program collecting one declared type derives the identical tile
 * set (register-if-absent by tile id). Throws when a struct's identity is not a
 * `<namespace>:<file>::<binding>` name.
 */
export function buildStructTypeTiles(
  program: UserAuthoredProgram,
  services: BrainServices
): readonly OwnedStructTypeTile[] {
  const tiles: OwnedStructTypeTile[] = [];
  for (const structType of program.structTypes ?? []) {
    const parsed = parseQualifiedClassName(structType.identity);
    if (!parsed) {
      throw new Error(
        `Struct type "${structType.name}" has identity "${structType.identity}", which is not a <namespace>:<file>::<binding> name`
      );
    }
    const namespace = parsed.namespace;
    if (structType.accessors) {
      for (const field of structType.fields) {
        tiles.push({ tile: createAccessorTileDef(structType.typeId, field.name, field.typeId), namespace });
      }
    }
    if (structType.variables) {
      tiles.push({
        tile: createVariableFactoryTileDef(
          structType.typeId,
          structType.typeId,
          { metadata: { label: structType.name } },
          services
        ),
        namespace,
      });
    }
  }
  return tiles;
}

/** Output of {@link buildUserTileMetadata}: the tile metadata pieces a brain needs to register a user tile. */
export interface BuiltUserTileMetadata {
  actionDescriptor: ActionDescriptor;
  actionTile: BrainTileActuatorDef | BrainTileSensorDef;
  parameterTiles: readonly BrainTileParameterDef[];
  /** Modifier tiles the tile's call spec places: private ones keyed `<namespace>:user.<id>.<modifier>`, shared ones by their unscoped `modifier.` id. */
  modifierTiles: readonly BrainTileModifierDef[];
  /** Inline output value-tiles derived from a sensor's `outputs` (empty for actuators or sensors without outputs). */
  outputTiles: readonly BrainTileOutputDef[];
}

function buildActionDescriptor(program: UserTileSurface): ActionDescriptor {
  return {
    key: program.key,
    kind: program.kind,
    callDef: program.callDef,
    isAsync: program.isAsync,
    outputType: program.outputType,
  };
}

function getParameterId(program: UserTileSurface, param: ExtractedParam): string {
  if (param.anonymous) return mkAnonParameterId(param.type);
  if (param.name.startsWith("parameter.")) return param.name;
  return privateArgTileId(program.projectNamespace, program.id, param.name);
}

/** Identity components of a parameter tile, matching {@link getParameterId}'s three id forms. */
function getParameterIdentity(
  program: UserTileSurface,
  param: ExtractedParam
): { userArg?: UserArgIdentity; anonType?: NamespacedTypeName } {
  if (param.anonymous) {
    const split = splitNamespacedTypeName(param.type);
    return { anonType: split ?? { localName: param.type } };
  }
  if (param.name.startsWith("parameter.")) return {};
  return { userArg: { namespace: program.projectNamespace, actionId: program.id, argName: param.name } };
}

/** Resolve a modifier's tile id: shared `modifier.` ids stay unscoped; private ids are scoped by the stable action id under the project namespace. */
function getModifierId(program: UserTileSurface, modifier: ExtractedModifier): string {
  if (modifier.id.startsWith("modifier.")) return modifier.id;
  return privateArgTileId(program.projectNamespace, program.id, modifier.id);
}

function buildParameterTiles(
  program: UserTileSurface,
  resolveTypeId: UserTileTypeResolver
): readonly BrainTileParameterDef[] | undefined {
  const parameterTiles = new Map<string, BrainTileParameterDef>();

  for (const param of collectParams(program.args)) {
    const parameterId = getParameterId(program, param);
    const tileId = mkParameterTileId(parameterId);
    if (parameterTiles.has(tileId)) {
      continue;
    }

    const typeId = resolveTypeId(param.type);
    if (!typeId) {
      return undefined;
    }

    parameterTiles.set(tileId, new BrainTileParameterDef(parameterId, typeId, getParameterIdentity(program, param)));
  }

  return Array.from(parameterTiles.values());
}

/**
 * Build the modifier tiles a user tile's call spec places. Materializes private
 * modifiers (keyed `<namespace>:user.<id>.<modifier>`) and shared modifiers declared with a
 * label (keyed by their unscoped `modifier.` id). A bare shared reference (a
 * `modifier.` id with no label) references a modifier declared or registered
 * elsewhere and materializes nothing.
 */
function buildModifierTiles(program: UserTileSurface): readonly BrainTileModifierDef[] {
  const modifierTiles = new Map<string, BrainTileModifierDef>();

  for (const modifier of collectModifiers(program.args)) {
    const isSharedReference = modifier.id.startsWith("modifier.") && modifier.label === "";
    if (isSharedReference) {
      continue;
    }
    const modifierId = getModifierId(program, modifier);
    const tileId = mkModifierTileId(modifierId);
    if (modifierTiles.has(tileId)) {
      continue;
    }
    const metadata: ITileMetadata = { label: modifier.label, iconUrl: modifier.icon };
    const userArg = modifier.id.startsWith("modifier.")
      ? undefined
      : { namespace: program.projectNamespace, actionId: program.id, argName: modifier.id };
    modifierTiles.set(tileId, new BrainTileModifierDef(modifierId, { metadata, userArg }));
  }

  return Array.from(modifierTiles.values());
}

/**
 * Build the inline output value-tiles for a sensor's declared outputs. Output
 * identity is the resolved type plus the output name scoped by the declaring
 * project's namespace; the tile's label stays the bare declared name. Returns
 * undefined when an output's type cannot be resolved.
 */
function buildOutputTiles(
  program: UserTileSurface,
  resolveTypeId: UserTileTypeResolver
): readonly BrainTileOutputDef[] | undefined {
  const outputTiles: BrainTileOutputDef[] = [];
  for (const output of program.outputs ?? []) {
    const typeId = resolveTypeId(output.type);
    if (!typeId) {
      return undefined;
    }
    const metadata: ITileMetadata = {
      label: output.label ?? output.name,
      iconUrl: output.icon,
      docsMarkdown: output.docs,
      tags: output.tags,
    };
    outputTiles.push(
      new BrainTileOutputDef(typeId, output.name, {
        metadata,
        namespace: program.projectNamespace,
        writableResult: output.writableResult,
      })
    );
  }
  return outputTiles;
}

/**
 * Build the action descriptor, action tile, parameter tiles, and output tiles for
 * a compiled user tile. Returns undefined when a parameter or output type cannot
 * be resolved.
 */
export function buildUserTileMetadata(
  program: UserTileSurface,
  resolveTypeId: UserTileTypeResolver
): BuiltUserTileMetadata | undefined {
  if (program.kind === "conversion") {
    throw new Error(`Conversion "${program.key}" has no tile metadata`);
  }
  const actionDescriptor = buildActionDescriptor(program);
  const parameterTiles = buildParameterTiles(program, resolveTypeId);
  if (!parameterTiles) {
    return undefined;
  }
  const modifierTiles = buildModifierTiles(program);

  const metadata: ITileMetadata = {
    label: program.label ?? program.name,
    iconUrl: program.iconUrl,
    docsMarkdown: program.docsMarkdown,
    tags: program.tags,
    language: program.language,
  };

  const userTileCaps = new BitSet().set(CoreCapabilityBits.UserTile);
  if (program.presenceGated) {
    userTileCaps.set(CoreCapabilityBits.PresenceGated);
  }

  let outputTiles: readonly BrainTileOutputDef[] = [];
  if (program.kind === "sensor") {
    const built = buildOutputTiles(program, resolveTypeId);
    if (!built) {
      return undefined;
    }
    outputTiles = built;
  }

  const providedOutputs = List.from(outputTiles.map((tile) => tile.outputKey));
  const userIdentity = { namespace: program.projectNamespace, actionId: program.id };
  let actionTile: BrainTileSensorDef | BrainTileActuatorDef;
  switch (program.kind) {
    case "sensor":
      actionTile = new BrainTileSensorDef(program.key, actionDescriptor, {
        metadata,
        capabilities: userTileCaps,
        providedOutputs,
        consumesWhenResult: program.consumesWhenResult,
        placement: program.inline ? TilePlacement.EitherSide | TilePlacement.Inline : undefined,
        userIdentity,
      });
      break;
    case "actuator":
      actionTile = new BrainTileActuatorDef(program.key, actionDescriptor, {
        metadata,
        capabilities: userTileCaps,
        consumesWhenResult: program.consumesWhenResult,
        userIdentity,
      });
      break;
    default:
      return assertUnreachable(program.kind);
  }

  return {
    actionDescriptor,
    actionTile,
    parameterTiles,
    modifierTiles,
    outputTiles,
  };
}
