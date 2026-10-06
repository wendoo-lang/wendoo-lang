import {
  type BitSet,
  BrainTileAccessorDef,
  BrainTileActuatorDef,
  BrainTileLiteralDef,
  BrainTileModifierDef,
  BrainTileOutputDef,
  BrainTileParameterDef,
  BrainTileSensorDef,
  BrainTileVariableDef,
  Dict,
  type IBrainTileDef,
  List,
  type WendooEnvironment,
} from "@wendoo/core/app";

/**
 * Plain, comparable form of a registered artifact. Every snapshot this module
 * produces is built from machine identifiers only -- ids, numeric ids, type
 * ids, and structure. Labels, sentence language forms, icon urls, and literal
 * value labels are display chrome and are never included.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A registered artifact set keyed by its machine identifier. */
export type SnapshotMap = Map<string, JsonValue>;

interface ListLike {
  toArray(): unknown[];
}

interface StructFieldLike {
  name: string;
  typeId: string;
  fieldIndex: number;
  readOnly?: boolean;
  optional?: boolean;
}

interface StructMethodLike {
  name: string;
  params: ListLike;
  returnTypeId: string;
  isAsync?: boolean;
}

interface MethodParamLike {
  name: string;
  typeId: string;
  optional?: boolean;
}

interface EnumSymbolLike {
  key: string;
  value: string | number;
  deprecated?: boolean;
}

interface TypeDefLike {
  coreType: number;
  typeId: string;
  name: string;
  nullable?: boolean;
  autoInstantiated?: boolean;
  atomId?: number;
  nominal?: boolean;
  fields?: ListLike;
  fieldIndexByName?: Dict<string, number>;
  methods?: ListLike;
  symbols?: ListLike;
  defaultKey?: string;
  elementTypeId?: string;
  keyTypeId?: string;
  valueTypeId?: string;
  baseTypeId?: string;
  memberTypeIds?: ListLike;
  paramTypeIds?: ListLike;
  returnTypeId?: string;
  fieldGetter?: unknown;
  fieldSetter?: unknown;
  snapshotNative?: unknown;
}

interface ConversionLike {
  fromType: string;
  toType: string;
  cost: number;
  id?: number;
  binding?: string;
}

interface ArgSpecLike {
  tileId: string;
  name?: string;
  required?: boolean;
  anonymous?: boolean;
}

interface ArgSlotLike {
  slotId: number;
  argSpec: ArgSpecLike;
  choiceGroup?: number;
  repeated?: boolean;
}

interface ActionDescriptorLike {
  key: string;
  kind: string;
  isAsync: boolean;
  outputType?: string;
  outputs?: readonly { name: string; type: string }[];
  callDef: { callSpec: unknown; argSlots: ListLike };
}

interface ResolvedActionLike {
  binding: string;
  id?: number;
  descriptor: ActionDescriptorLike;
}

/**
 * Converts `value` into a {@link JsonValue}: `List` and `Dict` collapse to
 * arrays and key-sorted objects, functions collapse to the marker
 * `"<function>"`, and `undefined` properties are dropped so an absent key and
 * an explicitly-undefined key compare equal.
 *
 * @param value - Any registry-owned value.
 * @returns The comparable form of `value`.
 */
export function plainify(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "function") return "<function>";
  if (Array.isArray(value)) return value.map((item) => plainify(item));
  if (value instanceof List) return value.toArray().map((item) => plainify(item));
  if (value instanceof Dict) {
    const out: { [key: string]: JsonValue } = {};
    for (const key of value.keys().toArray().sort()) {
      out[String(key)] = plainify(value.get(key));
    }
    return out;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: { [key: string]: JsonValue } = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      out[key] = plainify(record[key]);
    }
    return out;
  }
  return String(value);
}

function bits(set: { toArray(): number[] } | undefined): JsonValue {
  return set === undefined ? [] : set.toArray().map((bit) => (Number.isFinite(bit) ? bit : String(bit)));
}

function listOf<T>(list: ListLike | undefined): T[] {
  return list === undefined ? [] : (list.toArray() as T[]);
}

/**
 * Renumbers the choice-group ids of one call definition into their order of
 * first appearance. Raw group ids come from a process-wide counter, so two
 * modules registered in the same process never share them even when their
 * grammars are identical; the renumbering compares grouping, not the counter.
 */
function normalizeChoiceGroups(slots: readonly ArgSlotLike[]): (number | null)[] {
  const seen = new Map<number, number>();
  return slots.map((slot) => {
    if (slot.choiceGroup === undefined) return null;
    let normalized = seen.get(slot.choiceGroup);
    if (normalized === undefined) {
      normalized = seen.size;
      seen.set(slot.choiceGroup, normalized);
    }
    return normalized;
  });
}

/**
 * Snapshots one tile definition: its id, kind, placement and flag bits, its
 * capability and requirement bitsets, and the kind-specific machine fields
 * (parameter data type, literal value type, sensor output type, accessor
 * struct field). Tile metadata is excluded.
 *
 * @param tile - A tile definition from a registered catalog.
 * @returns The tile's comparable form.
 */
export function snapshotTile(tile: IBrainTileDef): JsonValue {
  const snapshot: { [key: string]: JsonValue } = {
    tileId: tile.tileId,
    kind: tile.kind,
    placement: tile.placement ?? null,
    deprecated: tile.deprecated === true,
    hidden: tile.hidden === true,
    persist: tile.persist === true,
    capabilities: bits(tile.capabilities() as BitSet),
    requirements: bits(tile.requirements() as BitSet),
    providedOutputs: plainify(tile.providedOutputs()),
    consumesWhenResult: tile.consumesWhenResult() ?? null,
  };

  if (tile instanceof BrainTileParameterDef) {
    snapshot.parameterId = tile.parameterId;
    snapshot.dataType = tile.dataType;
  } else if (tile instanceof BrainTileModifierDef) {
    snapshot.modifierId = tile.modifierId;
  } else if (tile instanceof BrainTileLiteralDef) {
    snapshot.valueType = tile.valueType;
    snapshot.displayFormat = tile.displayFormat;
    snapshot.value = plainify(tile.value);
  } else if (tile instanceof BrainTileSensorDef) {
    snapshot.sensorId = tile.sensorId;
    snapshot.outputType = tile.outputType;
    snapshot.writableResult = tile.writableResult;
  } else if (tile instanceof BrainTileActuatorDef) {
    snapshot.actuatorId = tile.actuatorId;
  } else if (tile instanceof BrainTileAccessorDef) {
    snapshot.structTypeId = tile.structTypeId;
    snapshot.fieldName = tile.fieldName;
    snapshot.fieldTypeId = tile.fieldTypeId;
    snapshot.readOnly = tile.readOnly;
  } else if (tile instanceof BrainTileVariableDef) {
    snapshot.varName = tile.varName;
    snapshot.varType = tile.varType;
    snapshot.uniqueId = tile.uniqueId;
  } else if (tile instanceof BrainTileOutputDef) {
    snapshot.outputKey = tile.outputKey;
    snapshot.outputName = tile.outputName;
    snapshot.outputType = tile.outputType;
    snapshot.namespace = tile.namespace ?? null;
    snapshot.writableResult = tile.writableResult;
  }

  return snapshot;
}

/**
 * Snapshots every tile catalog the environment exposes.
 *
 * @param env - A built Wendoo environment.
 * @returns One tile-id-keyed map per catalog, in `tileCatalogs()` order.
 */
export function snapshotTileCatalogs(env: WendooEnvironment): SnapshotMap[] {
  return env.tileCatalogs().map((catalog) => {
    const map: SnapshotMap = new Map();
    for (const tile of catalog.getAll().toArray()) {
      map.set(tile.tileId, snapshotTile(tile));
    }
    return map;
  });
}

/**
 * Snapshots one registered host action: the registry id it answers to, its
 * descriptor, its backing host function's stable funcId, and the resolved slot
 * layout of its call definition.
 *
 * @param env - A built Wendoo environment.
 * @param key - The action key, for example `"sensor.see"`.
 * @returns The action's comparable form, or `null` when nothing is registered
 *   under `key`.
 */
export function snapshotAction(env: WendooEnvironment, key: string): JsonValue {
  const registry = env.brainServices.runtime.actions;
  const resolved = registry.getByKey(key) as ResolvedActionLike | undefined;
  if (resolved === undefined) return null;

  const descriptor = resolved.descriptor;
  const slots = listOf<ArgSlotLike>(descriptor.callDef.argSlots);
  const choiceGroups = normalizeChoiceGroups(slots);
  const fnEntry = env.brainServices.runtime.functions.get(key);

  return {
    key: descriptor.key,
    kind: descriptor.kind,
    binding: resolved.binding,
    actionId: resolved.id ?? null,
    isAsync: descriptor.isAsync,
    outputType: descriptor.outputType ?? null,
    outputs: (descriptor.outputs ?? []).map((output) => ({ name: output.name, type: output.type })),
    fnId: fnEntry?.id ?? null,
    fnIsAsync: fnEntry?.isAsync ?? null,
    callSpec: plainify(descriptor.callDef.callSpec),
    argSlots: slots.map((slot, index) => ({
      slotId: slot.slotId,
      tileId: slot.argSpec.tileId,
      name: slot.argSpec.name ?? null,
      required: slot.argSpec.required === true,
      anonymous: slot.argSpec.anonymous === true,
      repeated: slot.repeated === true,
      choiceGroup: choiceGroups[index],
    })),
  };
}

/**
 * Snapshots the whole type registry: every registered type's id, name, native
 * type, stable atom id, and shape (struct fields and methods, enum symbol keys
 * and values, list/map/nullable/union/function members). Enum symbol labels
 * are excluded.
 *
 * @param env - A built Wendoo environment.
 * @returns Type-id-keyed snapshots.
 */
export function snapshotTypes(env: WendooEnvironment): SnapshotMap {
  const map: SnapshotMap = new Map();
  for (const [typeId, def] of env.brainServices.runtime.types.entries()) {
    const typeDef = def as unknown as TypeDefLike;
    const snapshot: { [key: string]: JsonValue } = {
      typeId,
      name: typeDef.name,
      coreType: typeDef.coreType,
      atomId: typeDef.atomId ?? null,
      nullable: typeDef.nullable === true,
      autoInstantiated: typeDef.autoInstantiated === true,
      nominal: typeDef.nominal === true,
      hasFieldGetter: typeDef.fieldGetter !== undefined,
      hasFieldSetter: typeDef.fieldSetter !== undefined,
      hasSnapshotNative: typeDef.snapshotNative !== undefined,
    };

    if (typeDef.fields !== undefined) {
      snapshot.fields = listOf<StructFieldLike>(typeDef.fields).map((field) => ({
        name: field.name,
        typeId: field.typeId,
        fieldIndex: field.fieldIndex,
        readOnly: field.readOnly === true,
        optional: field.optional === true,
      }));
    }
    if (typeDef.fieldIndexByName !== undefined) {
      snapshot.fieldIndexByName = plainify(typeDef.fieldIndexByName);
    }
    if (typeDef.methods !== undefined) {
      snapshot.methods = listOf<StructMethodLike>(typeDef.methods).map((method) => ({
        name: method.name,
        returnTypeId: method.returnTypeId,
        isAsync: method.isAsync === true,
        params: listOf<MethodParamLike>(method.params).map((param) => ({
          name: param.name,
          typeId: param.typeId,
          optional: param.optional === true,
        })),
      }));
    }
    if (typeDef.symbols !== undefined) {
      snapshot.symbols = listOf<EnumSymbolLike>(typeDef.symbols).map((symbol) => ({
        key: symbol.key,
        value: symbol.value,
        deprecated: symbol.deprecated === true,
      }));
      snapshot.defaultKey = typeDef.defaultKey ?? null;
    }
    for (const member of ["elementTypeId", "keyTypeId", "valueTypeId", "baseTypeId", "returnTypeId"] as const) {
      if (typeDef[member] !== undefined) snapshot[member] = typeDef[member];
    }
    for (const member of ["memberTypeIds", "paramTypeIds"] as const) {
      if (typeDef[member] !== undefined) snapshot[member] = plainify(typeDef[member]);
    }

    map.set(typeId, snapshot);
  }
  return map;
}

/**
 * Snapshots the host functions registered under `funcIds`.
 *
 * @param env - A built Wendoo environment.
 * @param funcIds - Stable funcIds to look up.
 * @returns Funcid-keyed snapshots; a funcId with no registration maps to
 *   `null`.
 */
export function snapshotFunctions(env: WendooEnvironment, funcIds: readonly number[]): SnapshotMap {
  const registry = env.brainServices.runtime.functions;
  const map: SnapshotMap = new Map();
  for (const funcId of funcIds) {
    const entry = registry.getSyncById(funcId) ?? registry.getAsyncById(funcId);
    map.set(String(funcId), entry === undefined ? null : { id: entry.id, name: entry.name, isAsync: entry.isAsync });
  }
  return map;
}

/**
 * Snapshots the operator table for `opIds`: each operator's parse metadata and
 * its registered overloads (argument types, result type, and the stable funcId
 * of the implementing host function).
 *
 * @param env - A built Wendoo environment.
 * @param opIds - Operator ids to look up.
 * @returns Opid-keyed snapshots; an unregistered operator maps to `null`.
 */
export function snapshotOperators(env: WendooEnvironment, opIds: readonly string[]): SnapshotMap {
  const table = env.brainServices.runtime.operatorTable;
  const map: SnapshotMap = new Map();
  for (const opId of opIds) {
    const op = table.get(opId);
    if (op === undefined) {
      map.set(opId, null);
      continue;
    }
    map.set(opId, {
      id: op.id,
      parse: plainify(op.parse),
      overloads: op
        .overloads()
        .toArray()
        .map((overload) => ({
          argTypes: plainify(overload.argTypes),
          resultType: overload.resultType,
          fnId: overload.fnEntry?.id ?? null,
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    });
  }
  return map;
}

/**
 * Snapshots the implicit-conversion registry.
 *
 * @param env - A built Wendoo environment.
 * @returns Snapshots keyed by `"<fromType> -> <toType>"`.
 */
export function snapshotConversions(env: WendooEnvironment): SnapshotMap {
  const map: SnapshotMap = new Map();
  env.brainServices.shared.conversions.forEach((conv) => {
    const conversion = conv as unknown as ConversionLike;
    map.set(`${conversion.fromType} -> ${conversion.toType}`, {
      fromType: conversion.fromType,
      toType: conversion.toType,
      cost: conversion.cost,
      id: conversion.id ?? null,
      binding: conversion.binding ?? "hostFn",
    });
  });
  return map;
}
