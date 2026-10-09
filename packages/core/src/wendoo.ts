import { Brain, installCoreBrainComponents } from "./brain";
import { type BrainBuildResult, isBrainBuildError, runBrainLinkPipeline } from "./brain/compiler";
import type {
  BrainTileDefCreateOptions,
  IBrainActionTileDef,
  IBrainDef,
  IBrainTileDef,
  ITileCatalog,
  ITileLanguageMetadata,
  ITileMetadata,
} from "./brain/interfaces";
import { TilePlacement } from "./brain/interfaces";
import type { BrainJson } from "./brain/model";
import { BrainDef, deserializePersistedBrainJson } from "./brain/model";
import type { BrainServices } from "./brain/services";
import { createAppServices, createBrainServices } from "./brain/services-factory";
import { registerAccessorTileDef } from "./brain/tiles/accessors";
import { BrainTileActuatorDef } from "./brain/tiles/actuators";
import { TileCatalog } from "./brain/tiles/catalog";
import { BrainTileModifierDef } from "./brain/tiles/modifiers";
import { BrainTileParameterDef } from "./brain/tiles/parameters";
import { BrainTileSensorDef } from "./brain/tiles/sensors";
import { registerVariableFactoryTileDef } from "./brain/tiles/variables";
import type { Localizer } from "./localization/localizer";
import { Dict } from "./platform/dict";
import { Error } from "./platform/error";
import { List, type ReadonlyList } from "./platform/list";
import { TypeUtils } from "./platform/types";
import type {
  ActionDescriptor,
  ActionOutputSpec,
  AppServices,
  BrainActionCallDef,
  BrainActionResolver,
  BrainLinkEnvironment,
  Conversion,
  EnumTypeDef,
  EnumTypeShape,
  FunctionTypeDef,
  FunctionTypeShape,
  HostAsyncFn,
  HostFn,
  HostSyncFn,
  IBrain,
  IRngServices,
  ListTypeDef,
  ListTypeShape,
  MapTypeDef,
  MapTypeShape,
  NullableTypeDef,
  NullableTypeShape,
  OpSpec,
  ProfileNumerics,
  ResolvedAction,
  StructTypeDef,
  StructTypeShape,
  TypeDef,
  TypeId,
  UnionTypeDef,
  UnionTypeShape,
  UserActionArtifact,
  VmEvents,
} from "./runtime";
import { NativeType } from "./runtime";
import type { ExecutionContext, HostActionBinding } from "./runtime/context";
import type { AsyncHandle, Value } from "./runtime/value";

/** Tile definition value. Alias for {@link IBrainTileDef}. */
export type TileDefinitionInput = IBrainTileDef;

/** Definition of a value-conversion overload, including its author-assigned stable funcId. */
export type ConversionDefinition = Conversion;

type TypeDefInput = Omit<TypeDef, "codec">;

interface StructDefineOptions {
  /**
   * Registers an accessor tile for every field (`true`) or for the named
   * fields. Each tile is read-only when its field is; a writable field of a
   * type registering a `fieldSetter` gets a routed tile.
   */
  accessors?: boolean | string[];
  variableFactory?: boolean;
}

/**
 * Type definition accepted by {@link WendooModuleApi.defineType}. The shape
 * fields determine the type's category (struct, enum, list, etc.).
 */
export type WendooTypeDefinition =
  | TypeDefInput
  | (TypeDefInput & StructTypeShape & StructDefineOptions)
  | (TypeDefInput & EnumTypeShape)
  | (TypeDefInput & ListTypeShape)
  | (TypeDefInput & MapTypeShape)
  | (TypeDefInput & NullableTypeShape)
  | (TypeDefInput & UnionTypeShape)
  | (TypeDefInput & Partial<FunctionTypeShape>);
/** Compiled user-tile artifact. Alias for {@link UserActionArtifact}. */
export type CompiledActionArtifact = UserActionArtifact;

/** A host-implemented function registered with a brain's function registry. */
export interface HostFunctionDefinition {
  /**
   * Author-assigned stable funcId. Once assigned, never changed or reused.
   */
  readonly id: number;
  readonly name: string;
  readonly isAsync: boolean;
  readonly fn: HostFn;
  readonly callDef: BrainActionCallDef;
}

/** A host-implemented sensor: descriptor + function + action exec + sensor tile. Build with {@link createHostSensor}. */
export interface HostSensorDefinition {
  readonly descriptor: ActionDescriptor;
  /**
   * Author-assigned stable host-action id. Once assigned, never changed or
   * reused.
   */
  readonly actionId: number;
  readonly function: HostFunctionDefinition;
  readonly actionFn: SyncHostActionFn | AsyncHostActionFn;
  readonly tile: IBrainActionTileDef;
}

/** A host-implemented actuator: descriptor + function + action exec + actuator tile. Build with {@link createHostActuator}. */
export interface HostActuatorDefinition {
  readonly descriptor: ActionDescriptor;
  /**
   * Author-assigned stable host-action id. Once assigned, never changed or
   * reused.
   */
  readonly actionId: number;
  readonly function: HostFunctionDefinition;
  readonly actionFn: SyncHostActionFn | AsyncHostActionFn;
  readonly tile: IBrainActionTileDef;
}

/** Sync action exec shape used by sensors and actuators registered through {@link createHostSensor}. */
export type SyncHostActionFn = {
  onInitialized?: (ctx: ExecutionContext) => void;
  onPageEntered?: (ctx: ExecutionContext) => void;
  onPageExited?: (ctx: ExecutionContext) => void;
  exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => Value;
};

/** Async action exec shape; see {@link SyncHostActionFn}. */
export type AsyncHostActionFn = {
  onInitialized?: (ctx: ExecutionContext) => void;
  onPageEntered?: (ctx: ExecutionContext) => void;
  onPageExited?: (ctx: ExecutionContext) => void;
  exec: (ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle) => void;
};

type HostActionOptionsBase = {
  readonly key: string;
  /**
   * Author-assigned stable host-action id. Once assigned, never changed or
   * reused.
   */
  readonly actionId: number;
  /**
   * Author-assigned stable funcId for the action's host function. Once
   * assigned, never changed or reused.
   */
  readonly fnId: number;
  readonly callDef: BrainActionCallDef;
  readonly metadata?: ITileMetadata;
  readonly capabilities?: BrainTileDefCreateOptions["capabilities"];
  /**
   * Declares that this action's tile requires the rule's WHEN result, set to the
   * expected `TypeId`. The editor offers the tile only where a WHEN result of that
   * type is available.
   */
  readonly consumesWhenResult?: BrainTileDefCreateOptions["consumesWhenResult"];
};

type SyncHostActionOptions = HostActionOptionsBase & {
  readonly fn: SyncHostActionFn;
  readonly isAsync?: false;
};

type AsyncHostActionOptions = HostActionOptionsBase & {
  readonly fn: AsyncHostActionFn;
  readonly isAsync: true;
};

function adaptSyncActionFn(fn: SyncHostActionFn): HostSyncFn {
  return {
    onInitialized: fn.onInitialized,
    onPageEntered: fn.onPageEntered,
    onPageExited: fn.onPageExited,
    exec: fn.exec,
  };
}

function adaptAsyncActionFn(fn: AsyncHostActionFn): HostAsyncFn {
  return {
    onInitialized: fn.onInitialized,
    onPageEntered: fn.onPageEntered,
    onPageExited: fn.onPageExited,
    exec: fn.exec,
  };
}

/** Options for {@link createHostSensor}. Sensors return a value of `outputType` and may expose named `outputs`. */
export type CreateHostSensorOptions = (SyncHostActionOptions | AsyncHostActionOptions) & {
  readonly outputType: TypeId;
  /** Named, typed outputs this sensor exposes as inline output value-tiles. */
  readonly outputs?: readonly ActionOutputSpec[];
  /** When true, the sensor's returned value is a writable l-value; a field write on its result is permitted. Defaults to false. */
  readonly writableResult?: boolean;
  /**
   * When true, the sensor tile parses inline in a value expression, so operators
   * and accessors can follow its result (for example `[light level] [>] [50]`).
   * An inline sensor takes no arguments; combining `inline: true` with a non-empty
   * `callDef` throws. Defaults to false, placing the tile on the WHEN side only.
   */
  readonly inline?: boolean;
};

/** Options for {@link createHostActuator}. Actuators do not return a value, and may expose named `outputs`. */
export type CreateHostActuatorOptions = (SyncHostActionOptions | AsyncHostActionOptions) & {
  /** Named, typed outputs this actuator exposes as inline output value-tiles. */
  readonly outputs?: readonly ActionOutputSpec[];
};

/** Build a {@link HostSensorDefinition} from `options`. */
export function createHostSensor(options: CreateHostSensorOptions): HostSensorDefinition {
  const isAsync = options.isAsync ?? false;
  if (options.inline && options.callDef.argSlots.size() > 0) {
    throw new Error(`Inline sensor '${options.key}' takes no arguments; remove the args or 'inline: true'`);
  }
  const descriptor: ActionDescriptor = {
    key: options.key,
    kind: "sensor",
    callDef: options.callDef,
    isAsync,
    outputType: options.outputType,
    outputs: options.outputs,
  };
  const hostFn: HostFn = options.isAsync
    ? adaptAsyncActionFn(options.fn)
    : adaptSyncActionFn(options.fn as SyncHostActionFn);
  return {
    descriptor,
    actionId: options.actionId,
    function: { id: options.fnId, name: options.key, isAsync, fn: hostFn, callDef: options.callDef },
    actionFn: options.fn,
    tile: new BrainTileSensorDef(options.key, descriptor, {
      metadata: options.metadata,
      capabilities: options.capabilities,
      consumesWhenResult: options.consumesWhenResult,
      writableResult: options.writableResult,
      placement: options.inline ? TilePlacement.EitherSide | TilePlacement.Inline : undefined,
    }),
  };
}

/** Build a {@link HostActuatorDefinition} from `options`. */
export function createHostActuator(options: CreateHostActuatorOptions): HostActuatorDefinition {
  const isAsync = options.isAsync ?? false;
  const descriptor: ActionDescriptor = {
    key: options.key,
    kind: "actuator",
    callDef: options.callDef,
    isAsync,
    outputs: options.outputs,
  };
  const hostFn: HostFn = options.isAsync
    ? adaptAsyncActionFn(options.fn)
    : adaptSyncActionFn(options.fn as SyncHostActionFn);
  return {
    descriptor,
    actionId: options.actionId,
    function: { id: options.fnId, name: options.key, isAsync, fn: hostFn, callDef: options.callDef },
    actionFn: options.fn,
    tile: new BrainTileActuatorDef(options.key, descriptor, {
      metadata: options.metadata,
      capabilities: options.capabilities,
      consumesWhenResult: options.consumesWhenResult,
    }),
  };
}

/** A single overload of an operator: argument types, result type, and the implementing host function. */
export interface OperatorOverloadDefinition {
  readonly argTypes: readonly TypeId[];
  readonly resultType: TypeId;
  /**
   * Author-assigned stable funcId of the implementing host function. Once
   * assigned, never changed or reused.
   */
  readonly fnId: number;
  readonly fn: HostFn;
  readonly isAsync?: boolean;
}

/** A registerable operator: its `OpSpec` plus zero or more overloads. */
export interface OperatorDefinition {
  readonly spec: OpSpec;
  readonly overloads?: readonly OperatorOverloadDefinition[];
}

/** A catalog of tile definitions. Brains are matched against catalogs to enumerate available tiles. */
export interface WendooCatalog {
  has(tileId: string): boolean;
  get(tileId: string): TileDefinitionInput | undefined;
  getAll(): readonly TileDefinitionInput[];
  registerTile(def: TileDefinitionInput): string;
  delete(tileId: string): boolean;
}

/** Options for {@link WendooEnvironment.createBrain}. */
export interface CreateBrainOptions {
  /** Opaque value forwarded to the brain's runtime context. */
  context?: unknown;
  /** Catalogs the brain should consult when resolving tiles. */
  catalogs?: readonly WendooCatalog[];
  /** Optional lifecycle observers attached to the underlying VM instance. */
  vmEvents?: VmEvents;
}

/** A brain instance produced by {@link WendooEnvironment.createBrain}. */
export interface WendooBrain extends IBrain {
  readonly definition: IBrainDef;
  readonly status: "active" | "invalidated" | "disposed";
  /** Recompile and rebuild this brain against the current environment. */
  rebuild(): void;
  /** Dispose this brain, releasing its runtime state. */
  dispose(): void;
}

/** Function that mutates an in-memory `BrainJson` to upgrade it from an older module schema. */
export type BrainJsonMigration = (json: unknown) => void;

/** A unit of installable functionality (types, host functions, tiles, operators) for a {@link WendooEnvironment}. */
export interface WendooModule {
  readonly id: string;
  install(api: WendooModuleApi): void;
  migrateBrainJson?: BrainJsonMigration;
}

/** API exposed to {@link WendooModule.install} for registering types, tiles, functions, operators, and conversions. */
export interface WendooModuleApi {
  readonly brainServices: BrainServices;
  defineType(def: WendooTypeDefinition): string;
  registerHostSensor(def: HostSensorDefinition): void;
  registerHostActuator(def: HostActuatorDefinition): void;
  registerFunction(def: HostFunctionDefinition): void;
  registerTile(def: TileDefinitionInput): string;
  registerModifiers(defs: readonly ModifierTileInput[]): void;
  registerParameters(defs: readonly ParameterTileInput[]): void;
  registerOperator(def: OperatorDefinition): void;
  registerConversion(def: ConversionDefinition): void;
}

/** Definition of a modifier tile. */
export interface ModifierTileInput {
  readonly id: string;
  readonly label: string;
  readonly iconUrl?: string;
  /**
   * Words the sentence projection reads this tile with. Omit for a tile whose
   * sentence word is its label.
   */
  readonly language?: ITileLanguageMetadata;
}

/** Definition of a parameter tile. */
export interface ParameterTileInput {
  readonly id: string;
  readonly dataType: TypeId;
  readonly label?: string;
  readonly iconUrl?: string;
  /** When true, the tile is excluded from default catalog listings. */
  readonly hidden?: boolean;
}

/** Snapshot of tile metadata applied via {@link WendooEnvironment.hydrateTileMetadata}. */
export interface HydratedTileMetadataSnapshot {
  readonly revision: string;
  readonly tiles: readonly TileDefinitionInput[];
}

/** One compilation root of a {@link CompiledActionBundle}. */
export interface CompiledRoot {
  /** The root's namespace: a library's `<owner>/<repo>` coordinate or the host project's namespace. */
  readonly namespace: string;
  /** Namespaces of the root's transitive dependencies present in the bundle, sorted; empty when it has none. */
  readonly closure: readonly string[];
}

/**
 * A bundle of compiled user actions and the tiles they back. Apply with
 * {@link WendooEnvironment.replaceActionBundle}.
 */
export interface CompiledActionBundle {
  readonly revision: string;
  readonly tiles: readonly TileDefinitionInput[];
  readonly actions: Dict<string, CompiledActionArtifact>;
  /** One entry per compilation root that built the bundle, sorted by namespace. A root contributing no tiles still has an entry. */
  readonly roots: readonly CompiledRoot[];
}

/** Result of {@link WendooEnvironment.replaceActionBundle}: which actions changed and which brains were invalidated. */
export interface ActionBundleUpdate {
  readonly changedActionKeys: readonly string[];
  readonly invalidatedBrains: readonly WendooBrain[];
}

/** Event payload for {@link WendooEnvironment.onBrainsInvalidated}. */
export interface BrainInvalidationEvent extends ActionBundleUpdate {}

/**
 * Top-level Wendoo environment: hosts brain services, manages catalogs and
 * action bundles, and creates {@link WendooBrain} instances. Build with
 * {@link createWendooEnvironment}.
 */
export interface WendooEnvironment {
  readonly brainServices: BrainServices;
  /**
   * Host-supplied app services (currently just the RNG) shared by every brain
   * in this environment. Identical to `brainServices.app`.
   */
  readonly appServices: AppServices;
  withServices<T>(callback: (services: BrainServices) => T): T;
  createCatalog(): WendooCatalog;
  /**
   * Deserialize in-memory brain JSON whose identifiers are already fully
   * qualified runtime ids (the shape produced by `IBrainDef.toJson`).
   */
  deserializeBrainJson(json: BrainJson): IBrainDef;
  /**
   * Deserialize the raw `JSON.parse` output of persisted brain JSON for the
   * project identified by `projectNamespace`. Runs registered brain JSON
   * migrations, then decodes structured identifier references: the loading
   * project's namespace qualifies refs whose namespace field is absent.
   */
  deserializeBrainJsonFromPlain(plain: unknown, projectNamespace: string): IBrainDef;
  /**
   * Replace the bundle catalog's tiles with `snapshot`'s, leaving the applied
   * bundle's revision and roots untouched. A hydrated tile that omits
   * `provenance` reads as first-party to the catalog.
   */
  hydrateTileMetadata(snapshot: HydratedTileMetadataSnapshot): void;
  createBrain(definition: IBrainDef, options?: CreateBrainOptions): WendooBrain;
  /** Compiles and links a brain definition into a {@link BrainBuildResult}. */
  linkBrain(definition: IBrainDef): BrainBuildResult;
  /**
   * Apply `bundle` as the environment's compiled-action bundle. Every tile in
   * `bundle.tiles` must carry `provenance`; throws on one that does not.
   */
  replaceActionBundle(bundle: CompiledActionBundle): ActionBundleUpdate;
  /**
   * The action bundle this environment currently holds, as a fresh
   * {@link CompiledActionBundle} another environment can apply with
   * {@link replaceActionBundle}. `undefined` until a bundle has been applied.
   * The tiles are the ones the bundle registered; the actions are the compiled
   * artifacts backing them, in the environment's own key order.
   */
  appliedActionBundle(): CompiledActionBundle | undefined;
  onBrainsInvalidated(listener: (event: BrainInvalidationEvent) => void): () => void;
  rebuildInvalidatedBrains(brains?: readonly WendooBrain[]): void;
  tileCatalogs(): readonly ITileCatalog[];
}

type CreateWendooEnvironmentOptions = {
  readonly modules?: readonly WendooModule[];
  /**
   * Random-number stream shared with every brain created by this environment.
   * Defaults to {@link createDefaultRng} when omitted.
   */
  readonly rng?: IRngServices;
  /**
   * Brain-observable numeric semantics for the environment's device profile.
   * Captured by the core operator, conversion, and math-builtin exec bodies
   * at module installation. Defaults to the f64 (native double-precision)
   * implementation when omitted.
   */
  readonly numerics?: ProfileNumerics;
  /**
   * Display-time translation service shared with every brain and editor
   * surface this environment feeds. Defaults to
   * {@link createDefaultLocalizer} when omitted.
   */
  readonly localizer?: Localizer;
};

function buildHostActionBinding(
  descriptor: ActionDescriptor,
  actionId: number,
  actionFn: SyncHostActionFn | AsyncHostActionFn
): HostActionBinding {
  const binding: HostActionBinding = {
    binding: "host",
    descriptor,
    id: actionId,
    onInitialized: actionFn.onInitialized,
    onPageEntered: actionFn.onPageEntered,
    onPageExited: actionFn.onPageExited,
  };

  if (descriptor.isAsync) {
    binding.execAsync = (actionFn as AsyncHostActionFn).exec;
  } else {
    binding.execSync = (actionFn as SyncHostActionFn).exec;
  }

  return binding;
}

function ensureFunctionRegistered(services: BrainServices, definition: HostFunctionDefinition): void {
  if (services.runtime.functions.get(definition.name)) {
    return;
  }

  services.runtime.functions.register(
    definition.id,
    definition.name,
    definition.isAsync,
    definition.fn,
    definition.callDef
  );
}

function assertRegisteredTypeId(actual: string, expected: string, name: string): string {
  if (actual !== expected) {
    throw new Error(`Type '${name}' registered as '${actual}' instead of expected '${expected}'`);
  }
  return actual;
}

function rejectStructuralAtomId(definition: WendooTypeDefinition): void {
  if (definition.atomId !== undefined) {
    throw new Error(`Structural type '${definition.name}' must not declare an atomId (got ${definition.atomId})`);
  }
}

function registerWendooTypeDefinition(services: BrainServices, definition: WendooTypeDefinition): string {
  const nullableDef = definition as NullableTypeDef;
  if (definition.nullable && nullableDef.baseTypeId !== undefined) {
    rejectStructuralAtomId(definition);
    return assertRegisteredTypeId(
      services.runtime.types.addNullableType(nullableDef.baseTypeId),
      nullableDef.typeId,
      nullableDef.name
    );
  }

  let registeredTypeId: string;

  switch (definition.coreType) {
    case NativeType.Void:
      return assertRegisteredTypeId(
        services.runtime.types.addVoidType(definition.name, definition.atomId),
        definition.typeId,
        definition.name
      );
    case NativeType.Nil:
      return assertRegisteredTypeId(
        services.runtime.types.addNilType(definition.name, definition.atomId),
        definition.typeId,
        definition.name
      );
    case NativeType.Boolean:
      return assertRegisteredTypeId(
        services.runtime.types.addBooleanType(definition.name, definition.atomId),
        definition.typeId,
        definition.name
      );
    case NativeType.Number:
      return assertRegisteredTypeId(
        services.runtime.types.addNumberType(definition.name, definition.atomId),
        definition.typeId,
        definition.name
      );
    case NativeType.String:
      return assertRegisteredTypeId(
        services.runtime.types.addStringType(definition.name, definition.atomId),
        definition.typeId,
        definition.name
      );
    case NativeType.Enum: {
      const enumDef = definition as EnumTypeDef;
      registeredTypeId = assertRegisteredTypeId(
        services.runtime.types.addEnumType(enumDef.name, {
          symbols: enumDef.symbols,
          defaultKey: enumDef.defaultKey,
          atomId: enumDef.atomId,
        }),
        enumDef.typeId,
        enumDef.name
      );
      break;
    }
    case NativeType.List: {
      const listDef = definition as ListTypeDef;
      registeredTypeId = assertRegisteredTypeId(
        services.runtime.types.addListType(listDef.name, {
          elementTypeId: listDef.elementTypeId,
          atomId: listDef.atomId,
        }),
        listDef.typeId,
        listDef.name
      );
      break;
    }
    case NativeType.Map: {
      const mapDef = definition as MapTypeDef;
      registeredTypeId = assertRegisteredTypeId(
        services.runtime.types.addMapType(mapDef.name, {
          keyTypeId: mapDef.keyTypeId,
          valueTypeId: mapDef.valueTypeId,
          atomId: mapDef.atomId,
        }),
        mapDef.typeId,
        mapDef.name
      );
      break;
    }
    case NativeType.Struct: {
      const structDef = definition as StructTypeDef & StructDefineOptions;
      registeredTypeId = assertRegisteredTypeId(
        services.runtime.types.addStructType(structDef.name, {
          fields: structDef.fields,
          nominal: structDef.nominal,
          fieldGetter: structDef.fieldGetter,
          fieldSetter: structDef.fieldSetter,
          snapshotNative: structDef.snapshotNative,
          exists: structDef.exists,
          methods: structDef.methods,
          atomId: structDef.atomId,
          zero: structDef.zero,
        }),
        structDef.typeId,
        structDef.name
      );
      if (structDef.accessors) {
        const subset = TypeUtils.isArray(structDef.accessors) ? structDef.accessors : undefined;
        for (let i = 0; i < structDef.fields.size(); i++) {
          const field = structDef.fields.get(i);
          if (subset && subset.indexOf(field.name) === -1) continue;
          let accessorOpts: { readOnly?: boolean; routed?: boolean } | undefined;
          if (field.readOnly) {
            accessorOpts = { readOnly: field.readOnly };
          } else if (structDef.fieldSetter) {
            accessorOpts = { routed: true };
          }
          registerAccessorTileDef(registeredTypeId, field.name, field.typeId, accessorOpts, services);
        }
      }
      if (structDef.variableFactory) {
        registerVariableFactoryTileDef(
          registeredTypeId,
          registeredTypeId,
          { metadata: { label: structDef.name } },
          services
        );
      }
      break;
    }
    case NativeType.Any:
      return assertRegisteredTypeId(
        services.runtime.types.addAnyType(definition.name, definition.atomId),
        definition.typeId,
        definition.name
      );
    case NativeType.Function: {
      const functionDef = definition as FunctionTypeDef;
      if (functionDef.paramTypeIds !== undefined && functionDef.returnTypeId !== undefined) {
        rejectStructuralAtomId(definition);
        return assertRegisteredTypeId(
          services.runtime.types.getOrCreateFunctionType({
            paramTypeIds: functionDef.paramTypeIds,
            returnTypeId: functionDef.returnTypeId,
          }),
          functionDef.typeId,
          functionDef.name
        );
      }
      return assertRegisteredTypeId(
        services.runtime.types.addFunctionType(definition.name, definition.atomId),
        definition.typeId,
        definition.name
      );
    }
    case NativeType.Union: {
      const unionDef = definition as UnionTypeDef;
      rejectStructuralAtomId(definition);
      return assertRegisteredTypeId(
        services.runtime.types.getOrCreateUnionType(unionDef.memberTypeIds),
        unionDef.typeId,
        unionDef.name
      );
    }
    default:
      throw new Error(`Unsupported wendoo type '${definition.name}' (coreType: ${definition.coreType})`);
  }

  return registeredTypeId;
}

function registerOperatorDefinition(services: BrainServices, definition: OperatorDefinition): void {
  services.runtime.operatorTable.add(definition.spec);
  const overloads = definition.overloads;
  if (!overloads) {
    return;
  }

  const overloadList = List.from(overloads);
  for (let i = 0; i < overloadList.size(); i++) {
    const overload = overloadList.get(i)!;
    const argTypes = List.from(overload.argTypes);
    if (argTypes.size() === 1) {
      services.edit.operatorOverloads.unary(
        definition.spec.id,
        argTypes.get(0)!,
        overload.resultType,
        overload.fnId,
        overload.fn,
        overload.isAsync ?? false
      );
      continue;
    }

    if (argTypes.size() === 2) {
      services.edit.operatorOverloads.binary(
        definition.spec.id,
        argTypes.get(0)!,
        argTypes.get(1)!,
        overload.resultType,
        overload.fnId,
        overload.fn,
        overload.isAsync ?? false
      );
      continue;
    }

    throw new Error(`Operator '${definition.spec.id}' supports only unary or binary overloads`);
  }
}

function copyActionArtifacts(actions: Dict<string, CompiledActionArtifact>): Dict<string, CompiledActionArtifact> {
  const copy = new Dict<string, CompiledActionArtifact>();
  const entries = actions.entries();
  for (let i = 0; i < entries.size(); i++) {
    const entry = entries.get(i)!;
    copy.set(entry[0], entry[1]);
  }
  return copy;
}

function descriptorFromArtifact(artifact: CompiledActionArtifact): ActionDescriptor {
  return {
    key: artifact.key,
    kind: artifact.kind,
    callDef: artifact.callDef,
    isAsync: artifact.isAsync,
    outputType: artifact.outputType,
  };
}

function collectChangedActionKeys(
  previous: Dict<string, CompiledActionArtifact>,
  nextActions: Dict<string, CompiledActionArtifact>
): readonly string[] {
  const changed = new Dict<string, boolean>();
  const previousKeys = previous.keys();
  for (let i = 0; i < previousKeys.size(); i++) {
    const key = previousKeys.get(i)!;
    const prevArtifact = previous.get(key)!;
    const nextArtifact = nextActions.get(key);
    if (!nextArtifact || nextArtifact.revisionId !== prevArtifact.revisionId) {
      changed.set(key, true);
    }
  }

  const nextKeys = nextActions.keys();
  for (let i = 0; i < nextKeys.size(); i++) {
    const key = nextKeys.get(i)!;
    const prevArtifact = previous.get(key);
    const nextArtifact = nextActions.get(key)!;
    if (!prevArtifact || prevArtifact.revisionId !== nextArtifact.revisionId) {
      changed.set(key, true);
    }
  }

  return changed.keys().toArray();
}

function toActionKeySet(keys: readonly string[]): Dict<string, boolean> {
  const set = new Dict<string, boolean>();
  const keyList = List.from(keys);
  for (let i = 0; i < keyList.size(); i++) {
    set.set(keyList.get(i)!, true);
  }
  return set;
}

class WendooCatalogImpl implements WendooCatalog {
  constructor(private readonly catalog: TileCatalog = new TileCatalog()) {}

  rawCatalog(): TileCatalog {
    return this.catalog;
  }

  has(tileId: string): boolean {
    return this.catalog.has(tileId);
  }

  get(tileId: string): TileDefinitionInput | undefined {
    return this.catalog.get(tileId);
  }

  getAll(): readonly TileDefinitionInput[] {
    return this.catalog.getAll().toArray();
  }

  registerTile(def: TileDefinitionInput): string {
    this.catalog.registerTileDef(def);
    return def.tileId;
  }

  delete(tileId: string): boolean {
    return this.catalog.delete(tileId);
  }
}

function unwrapCatalog(catalog: WendooCatalog): ITileCatalog {
  if (catalog instanceof WendooCatalogImpl) {
    return catalog.rawCatalog();
  }

  const clone = new TileCatalog();
  const tiles = List.from(catalog.getAll());
  for (let i = 0; i < tiles.size(); i++) {
    clone.registerTileDef(tiles.get(i)!);
  }
  return clone;
}

class EnvironmentModuleApi implements WendooModuleApi {
  readonly brainServices: BrainServices;

  constructor(services: BrainServices) {
    this.brainServices = services;
  }

  defineType(def: WendooTypeDefinition): string {
    return registerWendooTypeDefinition(this.brainServices, def);
  }

  registerHostSensor(def: HostSensorDefinition): void {
    if (def.descriptor.kind !== "sensor" || def.tile.kind !== "sensor") {
      throw new Error(`Host sensor registration requires a sensor descriptor and sensor tile`);
    }

    ensureFunctionRegistered(this.brainServices, def.function);
    this.brainServices.runtime.actions.register(buildHostActionBinding(def.descriptor, def.actionId, def.actionFn));
    this.brainServices.edit.tiles.registerTileDef(def.tile);
  }

  registerHostActuator(def: HostActuatorDefinition): void {
    if (def.descriptor.kind !== "actuator" || def.tile.kind !== "actuator") {
      throw new Error(`Host actuator registration requires an actuator descriptor and actuator tile`);
    }

    ensureFunctionRegistered(this.brainServices, def.function);
    this.brainServices.runtime.actions.register(buildHostActionBinding(def.descriptor, def.actionId, def.actionFn));
    this.brainServices.edit.tiles.registerTileDef(def.tile);
  }

  registerFunction(def: HostFunctionDefinition): void {
    ensureFunctionRegistered(this.brainServices, def);
  }

  registerTile(def: TileDefinitionInput): string {
    this.brainServices.edit.tiles.registerTileDef(def);
    return def.tileId;
  }

  registerModifiers(defs: readonly ModifierTileInput[]): void {
    for (const def of defs) {
      const metadata: ITileMetadata = { label: def.label, iconUrl: def.iconUrl, language: def.language };
      this.brainServices.edit.tiles.registerTileDef(new BrainTileModifierDef(def.id, { metadata }));
    }
  }

  registerParameters(defs: readonly ParameterTileInput[]): void {
    for (const def of defs) {
      const opts: BrainTileDefCreateOptions = { hidden: def.hidden };
      if (def.label) {
        opts.metadata = { label: def.label, iconUrl: def.iconUrl };
      }
      this.brainServices.edit.tiles.registerTileDef(new BrainTileParameterDef(def.id, def.dataType, opts));
    }
  }

  registerOperator(def: OperatorDefinition): void {
    registerOperatorDefinition(this.brainServices, def);
  }

  registerConversion(def: ConversionDefinition): void {
    this.brainServices.shared.conversions.register(def);
  }
}

class EnvironmentActionResolver implements BrainActionResolver {
  constructor(private readonly environment: WendooEnvironmentImpl) {}

  resolveAction(descriptor: ActionDescriptor): ResolvedAction | undefined {
    return this.environment.resolveAction(descriptor);
  }
}

class WendooEnvironmentImpl implements WendooEnvironment {
  readonly brainServices: BrainServices;
  readonly appServices: AppServices;
  private readonly bundleCatalog = new TileCatalog();
  private readonly bundleResolver = new Dict<string, CompiledActionArtifact>();
  /** Revision of the bundle last applied, or undefined while none has been. */
  private bundleRevision: string | undefined;
  /** Compilation roots of the bundle last applied; empty while none has been. */
  private bundleRoots: readonly CompiledRoot[] = [];
  /** `(fromType, toType)` pairs this environment registered from the active bundle's conversion artifacts. */
  private readonly bundleConversionPairs = new List<{ fromType: TypeId; toType: TypeId }>();
  private readonly trackedBrains = List.empty<ManagedWendooBrain>();
  private readonly invalidatedBrains = List.empty<ManagedWendooBrain>();
  private readonly invalidationListeners = List.empty<(event: BrainInvalidationEvent) => void>();
  private readonly actionResolver: BrainActionResolver;
  private readonly brainJsonMigrations_ = List.empty<BrainJsonMigration>();

  constructor(modules: readonly WendooModule[], rng?: IRngServices, numerics?: ProfileNumerics, localizer?: Localizer) {
    this.appServices = createAppServices(rng, numerics, localizer);
    this.brainServices = createBrainServices(this.appServices);
    this.actionResolver = new EnvironmentActionResolver(this);
    this.installModules(modules);
  }

  withServices<T>(callback: (services: BrainServices) => T): T {
    return withWendooEnvironmentServices(this, callback);
  }

  tileCatalogs(): readonly ITileCatalog[] {
    return [this.brainServices.edit.tiles, this.bundleCatalog];
  }

  createCatalog(): WendooCatalog {
    return new WendooCatalogImpl();
  }

  deserializeBrainJson(json: BrainJson): IBrainDef {
    return BrainDef.fromJson(json, this.brainServices, this.buildDeserializeCatalogs());
  }

  deserializeBrainJsonFromPlain(plain: unknown, projectNamespace: string): IBrainDef {
    for (let i = 0; i < this.brainJsonMigrations_.size(); i++) {
      this.brainJsonMigrations_.get(i)!(plain);
    }
    return deserializePersistedBrainJson(plain, projectNamespace, this.brainServices, this.buildDeserializeCatalogs());
  }

  hydrateTileMetadata(snapshot: HydratedTileMetadataSnapshot): void {
    this.replaceCatalogContents(this.bundleCatalog, List.from(snapshot.tiles));
  }

  createBrain(definition: IBrainDef, options?: CreateBrainOptions): WendooBrain {
    const overlayCatalogs = this.resolveOverlayCatalogs(options?.catalogs);
    const brain = new ManagedWendooBrain(this, definition, overlayCatalogs);
    this.trackBrain(brain);
    try {
      brain.initialize(options?.context, options?.vmEvents);
    } catch (err) {
      if (!isBrainBuildError(err)) {
        this.removeBrain(brain);
        throw err;
      }
      // The initial build failed (a required action is missing from the current
      // bundle). The brain retains its definition and enters the invalidated set
      // so the per-tick rebuild retries it once the action becomes available,
      // exactly as a brain whose later rebuild fails does.
      this.markBrainInvalidated(brain);
    }
    return brain;
  }

  linkBrain(definition: IBrainDef): BrainBuildResult {
    const result = runBrainLinkPipeline(
      definition,
      this.buildLinkEnvironment(definition, List.empty<ITileCatalog>()),
      this.brainServices.shared.conversions
    );
    return { program: result.program, diagnostics: result.diagnostics };
  }

  replaceActionBundle(bundle: CompiledActionBundle): ActionBundleUpdate {
    for (const tile of bundle.tiles) {
      if (!tile.provenance) {
        throw new Error(`replaceActionBundle: bundle tile "${tile.tileId}" carries no provenance`);
      }
    }
    const nextActions = copyActionArtifacts(bundle.actions);
    const changedActionKeys = collectChangedActionKeys(this.bundleResolver, nextActions);
    const changedActionKeySet = toActionKeySet(changedActionKeys);
    const hasChangedActions = !changedActionKeySet.isEmpty();

    this.replaceCatalogContents(this.bundleCatalog, List.from(bundle.tiles));
    this.bundleRevision = bundle.revision;
    this.bundleRoots = bundle.roots;

    this.bundleResolver.clear();
    const nextKeys = nextActions.keys();
    for (let i = 0; i < nextKeys.size(); i++) {
      const key = nextKeys.get(i)!;
      this.bundleResolver.set(key, nextActions.get(key)!);
    }

    this.replaceBundleConversions(nextActions);

    const invalidated = List.empty<WendooBrain>();
    if (hasChangedActions) {
      for (let i = 0; i < this.trackedBrains.size(); i++) {
        const brain = this.trackedBrains.get(i)!;
        if (brain.isDisposed()) {
          continue;
        }
        if (!brain.usesChangedBundleActions(changedActionKeySet)) {
          continue;
        }
        this.markBrainInvalidated(brain);
        invalidated.push(brain);
      }
    }

    const event: BrainInvalidationEvent = {
      changedActionKeys,
      invalidatedBrains: invalidated.toArray(),
    };

    if (!invalidated.isEmpty()) {
      this.emitInvalidation(event);
    }

    return event;
  }

  appliedActionBundle(): CompiledActionBundle | undefined {
    if (this.bundleRevision === undefined) {
      return undefined;
    }
    return {
      revision: this.bundleRevision,
      tiles: this.bundleCatalog.getAll().toArray(),
      actions: copyActionArtifacts(this.bundleResolver),
      roots: this.bundleRoots,
    };
  }

  onBrainsInvalidated(listener: (event: BrainInvalidationEvent) => void): () => void {
    this.invalidationListeners.push(listener);
    return () => {
      const index = this.invalidationListeners.indexOf(listener);
      if (index >= 0) {
        this.invalidationListeners.remove(index);
      }
    };
  }

  rebuildInvalidatedBrains(brains?: readonly WendooBrain[]): void {
    const targets = brains ? List.from(brains) : List.from(this.invalidatedBrains.toArray());
    for (let i = 0; i < targets.size(); i++) {
      const candidate = targets.get(i);
      if (!(candidate instanceof ManagedWendooBrain)) {
        continue;
      }
      if (candidate.owner() !== this || candidate.isDisposed()) {
        continue;
      }
      try {
        candidate.rebuild();
      } catch (err) {
        if (!isBrainBuildError(err)) {
          throw err;
        }
        // The brain's content is invalid; it stays invalidated and is retried on
        // the next rebuild. Continue rebuilding the rest of the batch.
      }
    }
  }

  buildCatalogChain(definition: IBrainDef, overlays: List<ITileCatalog>): List<ITileCatalog> {
    const catalogs = List.empty<ITileCatalog>();
    catalogs.push(this.brainServices.edit.tiles);
    if (!this.bundleCatalog.getAll().isEmpty()) {
      catalogs.push(this.bundleCatalog);
    }
    for (let i = 0; i < overlays.size(); i++) {
      catalogs.push(overlays.get(i)!);
    }
    catalogs.push(definition.catalog());
    return catalogs;
  }

  buildLinkEnvironment(definition: IBrainDef, overlays: List<ITileCatalog>): BrainLinkEnvironment {
    return {
      catalogs: this.buildCatalogChain(definition, overlays),
      actionResolver: this.actionBindings(),
      typeRegistry: this.brainServices.runtime.types,
    };
  }

  buildDeserializeCatalogs(): List<ITileCatalog> {
    const catalogs = List.empty<ITileCatalog>();
    catalogs.push(this.brainServices.edit.tiles);
    if (!this.bundleCatalog.getAll().isEmpty()) {
      catalogs.push(this.bundleCatalog);
    }
    return catalogs;
  }

  actionBindings(): BrainActionResolver {
    return this.actionResolver;
  }

  getBundleActionRevision(key: string): string | undefined {
    return this.bundleResolver.get(key)?.revisionId;
  }

  resolveAction(descriptor: ActionDescriptor): ResolvedAction | undefined {
    const bundleArtifact = this.bundleResolver.get(descriptor.key);
    if (bundleArtifact && bundleArtifact.kind === descriptor.kind && bundleArtifact.isAsync === descriptor.isAsync) {
      return {
        binding: "bytecode",
        descriptor: descriptorFromArtifact(bundleArtifact),
        artifact: bundleArtifact,
        metadata: {
          key: bundleArtifact.key,
          kind: bundleArtifact.kind,
          callDef: bundleArtifact.callDef,
          outputType: bundleArtifact.outputType,
        },
      };
    }

    return this.brainServices.runtime.actions.resolveAction(descriptor);
  }

  removeBrain(brain: ManagedWendooBrain): void {
    const trackedIndex = this.trackedBrains.indexOf(brain);
    if (trackedIndex >= 0) {
      this.trackedBrains.remove(trackedIndex);
    }
    const invalidatedIndex = this.invalidatedBrains.indexOf(brain);
    if (invalidatedIndex >= 0) {
      this.invalidatedBrains.remove(invalidatedIndex);
    }
  }

  markBrainActive(brain: ManagedWendooBrain): void {
    brain.markActive();
    const invalidatedIndex = this.invalidatedBrains.indexOf(brain);
    if (invalidatedIndex >= 0) {
      this.invalidatedBrains.remove(invalidatedIndex);
    }
  }

  private emitInvalidation(event: BrainInvalidationEvent): void {
    for (let i = 0; i < this.invalidationListeners.size(); i++) {
      this.invalidationListeners.get(i)!(event);
    }
  }

  private installModules(modules: readonly WendooModule[]): void {
    const seen = new Dict<string, boolean>();
    const moduleList = List.from(modules);
    for (let i = 0; i < moduleList.size(); i++) {
      const module = moduleList.get(i)!;
      if (seen.has(module.id)) {
        throw new Error(`Wendoo module '${module.id}' is already installed`);
      }
      seen.set(module.id, true);

      const api = new EnvironmentModuleApi(this.brainServices);
      module.install(api);
      if (module.migrateBrainJson) {
        this.brainJsonMigrations_.push(module.migrateBrainJson);
      }
    }
  }

  private markBrainInvalidated(brain: ManagedWendooBrain): void {
    brain.markInvalidated();
    if (this.invalidatedBrains.indexOf(brain) === -1) {
      this.invalidatedBrains.push(brain);
    }
  }

  private replaceCatalogContents(catalog: TileCatalog, tiles: List<TileDefinitionInput>): void {
    catalog.clear();
    for (let i = 0; i < tiles.size(); i++) {
      catalog.add(tiles.get(i)!);
    }
  }

  /**
   * Sync the shared conversion registry to the bundle's conversion artifacts:
   * drop every pair the previous bundle registered, then register each
   * artifact carrying conversion metadata. Registration is if-absent -- a pair
   * already held by another registration (a host conversion or an earlier
   * artifact in key order) keeps it; the compiler reports the conflict.
   */
  private replaceBundleConversions(nextActions: Dict<string, CompiledActionArtifact>): void {
    const conversions = this.brainServices.shared.conversions;
    for (let i = 0; i < this.bundleConversionPairs.size(); i++) {
      const pair = this.bundleConversionPairs.get(i)!;
      conversions.remove(pair.fromType, pair.toType);
    }
    this.bundleConversionPairs.clear();

    const keys = nextActions.keys();
    for (let i = 0; i < keys.size(); i++) {
      const artifact = nextActions.get(keys.get(i)!)!;
      const info = artifact.conversion;
      if (!info) {
        continue;
      }
      if (conversions.get(info.fromType, info.toType)) {
        continue;
      }
      conversions.register({
        binding: "bytecode",
        fromType: info.fromType,
        toType: info.toType,
        cost: info.cost,
        descriptor: descriptorFromArtifact(artifact),
      });
      this.bundleConversionPairs.push({ fromType: info.fromType, toType: info.toType });
    }
  }

  private resolveOverlayCatalogs(catalogs?: readonly WendooCatalog[]): List<ITileCatalog> {
    const resolved = List.empty<ITileCatalog>();
    if (!catalogs) {
      return resolved;
    }

    const catalogList = List.from(catalogs);
    for (let i = 0; i < catalogList.size(); i++) {
      resolved.push(unwrapCatalog(catalogList.get(i)!));
    }
    return resolved;
  }

  private trackBrain(brain: ManagedWendooBrain): void {
    this.trackedBrains.push(brain);
  }
}

class ManagedWendooBrain extends Brain implements WendooBrain {
  status: "active" | "invalidated" | "disposed" = "active";
  private readonly linkEnvironmentRef: BrainLinkEnvironment;
  private readonly linkedActionRevisions = new Dict<string, string>();
  private readonly overlayCatalogs: List<ITileCatalog>;
  private contextData: unknown;
  private vmEvents?: VmEvents;
  private started = false;

  constructor(
    private readonly environment: WendooEnvironmentImpl,
    public readonly definition: IBrainDef,
    overlayCatalogs: List<ITileCatalog>
  ) {
    const linkEnvironment = environment.buildLinkEnvironment(definition, overlayCatalogs);
    super(definition, environment.brainServices, linkEnvironment);
    this.linkEnvironmentRef = linkEnvironment;
    this.overlayCatalogs = overlayCatalogs;
  }

  owner(): WendooEnvironmentImpl {
    return this.environment;
  }

  override initialize(contextData?: unknown, vmEvents?: VmEvents): void {
    if (this.status === "disposed") {
      return;
    }

    const shouldRestart = this.started;
    if (this.isInitialized()) {
      super.shutdown();
      this.started = false;
    }

    this.contextData = contextData;
    this.vmEvents = vmEvents;
    this.refreshLinkEnvironment();
    super.initialize(contextData, vmEvents);
    this.refreshLinkedActionRevisions();
    this.status = "active";

    if (shouldRestart) {
      super.startup();
      this.started = true;
    }
  }

  override startup(): void {
    if (this.status === "disposed") {
      return;
    }
    super.startup();
    this.started = true;
  }

  override shutdown(): void {
    if (this.status === "disposed" && !this.isInitialized()) {
      return;
    }
    super.shutdown();
    this.started = false;
  }

  rebuild(): void {
    if (this.status === "disposed") {
      return;
    }

    const shouldRestart = this.started;
    if (this.isInitialized()) {
      super.shutdown();
      this.started = false;
    }

    this.refreshLinkEnvironment();
    super.initialize(this.contextData, this.vmEvents);
    this.refreshLinkedActionRevisions();

    if (shouldRestart) {
      super.startup();
      this.started = true;
    }

    this.environment.markBrainActive(this);
  }

  dispose(): void {
    if (this.status === "disposed") {
      return;
    }

    if (this.isInitialized()) {
      super.shutdown();
    }
    this.linkedActionRevisions.clear();
    this.started = false;
    this.status = "disposed";
    this.environment.removeBrain(this);
  }

  isDisposed(): boolean {
    return this.status === "disposed";
  }

  markActive(): void {
    if (this.status !== "disposed") {
      this.status = "active";
    }
  }

  markInvalidated(): void {
    if (this.status !== "disposed") {
      this.status = "invalidated";
    }
  }

  usesChangedBundleActions(changedActionKeys: Dict<string, boolean>): boolean {
    if (changedActionKeys.isEmpty() || this.linkedActionRevisions.isEmpty()) {
      return false;
    }

    const actionKeys = this.linkedActionRevisions.keys();
    for (let i = 0; i < actionKeys.size(); i++) {
      if (changedActionKeys.has(actionKeys.get(i)!)) {
        return true;
      }
    }

    return false;
  }

  private refreshLinkEnvironment(): void {
    const linkEnvironment = this.environment.buildLinkEnvironment(this.definition, this.overlayCatalogs);
    this.linkEnvironmentRef.catalogs = linkEnvironment.catalogs;
    this.linkEnvironmentRef.actionResolver = linkEnvironment.actionResolver;
  }

  private refreshLinkedActionRevisions(): void {
    this.linkedActionRevisions.clear();

    const program = this.getProgram();
    if (!program) {
      return;
    }

    const actions = program.actions;
    if (!actions) {
      return;
    }
    for (let i = 0; i < actions.size(); i++) {
      const action = actions.get(i)!;
      if (action.binding !== "bytecode") {
        continue;
      }

      const revisionId = this.environment.getBundleActionRevision(action.descriptor.key);
      if (!revisionId) {
        continue;
      }

      this.linkedActionRevisions.set(action.descriptor.key, revisionId);
    }
  }
}

/** Construct a {@link WendooEnvironment}, installing each module in `options.modules`. */
export function createWendooEnvironment(options: CreateWendooEnvironmentOptions = {}): WendooEnvironment {
  return new WendooEnvironmentImpl(options.modules ?? [], options.rng, options.numerics, options.localizer);
}

/** The built-in `wendoo.core` module: registers the core types, operators, and tile components every brain needs. */
export function coreModule(): WendooModule {
  return {
    id: "wendoo.core",
    install(api: WendooModuleApi): void {
      installCoreBrainComponents(api.brainServices);
    },
  };
}

/** Access the underlying {@link BrainServices} of a {@link WendooEnvironment}. Throws on foreign implementations. */
export function getWendooEnvironmentServices(environment: WendooEnvironment): BrainServices {
  if (!(environment instanceof WendooEnvironmentImpl)) {
    throw new Error("Unsupported WendooEnvironment implementation");
  }
  return environment.brainServices;
}

/** Run `callback` with the environment's {@link BrainServices} and return its result. */
export function withWendooEnvironmentServices<T>(
  environment: WendooEnvironment,
  callback: (services: BrainServices) => T
): T {
  return callback(environment.brainServices);
}
