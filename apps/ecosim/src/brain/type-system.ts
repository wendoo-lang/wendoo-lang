import {
  ContextTypeIds,
  CoreTypeIds,
  Dict,
  type ExecutionContext,
  extractNumberValue,
  getClosedStructFieldByName,
  List,
  mkCallDef,
  mkClosedStructValueByName,
  mkNativeStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  type NumberValue,
  type ReadonlyList,
  type StructTypeDef,
  type StructValue,
  TypeUtils,
  type Value,
  Vector2,
  VOID_VALUE,
  type WendooModuleApi,
} from "@wendoo/core/app";
import { EcosimFuncId, EcosimTypeAtomId } from "./abi-ids";
import type { Actor } from "./actor";
import { getSelf } from "./execution-context-types";

export const EcosimTypeNames = {
  ActorRef: "ActorRef",
  Vector2: "Vector2",
};

export const EcosimTypeIds = {
  ActorRef: mkTypeId(NativeType.Struct, EcosimTypeNames.ActorRef),
  Vector2: mkTypeId(NativeType.Struct, EcosimTypeNames.Vector2),
};

/** Field ids (also storage slots) for the `Vector2` struct. */
enum Vector2Field {
  X = 0,
  Y = 1,
}

/**
 * Field ids (also storage slots) for the `ActorRef` struct. Single source for
 * both the registered `fieldIndex` and the getter/setter dispatch.
 */
enum ActorRefField {
  Id = 0,
  Position = 1,
  Rotation = 2,
  EnergyPct = 3,
  Forward = 4,
}

/**
 * Field id of the `self` field this app adds to the core `Context` struct. Core
 * owns Context ids 0-5; app extensions start at 6.
 */
const CONTEXT_SELF_FIELD_ID = 6;

const Vector2Fields = List.from([
  { name: "x", typeId: CoreTypeIds.Number, fieldIndex: Vector2Field.X },
  { name: "y", typeId: CoreTypeIds.Number, fieldIndex: Vector2Field.Y },
]);

/** The `Vector2` struct definition registered in the environment `ctx` executes in. */
function vector2TypeDefOf(ctx: ExecutionContext): StructTypeDef | undefined {
  return ctx.services.runtime.types.get(EcosimTypeIds.Vector2) as StructTypeDef | undefined;
}

// -------------------------------------------------------
// Vector2 helpers
// -------------------------------------------------------

/**
 * Build a `Vector2` struct value in the environment `ctx` executes in. Throws
 * when that environment has not registered the `Vector2` type.
 */
export function mkVector2Value(ctx: ExecutionContext, v: Vector2) {
  const typeDef = vector2TypeDefOf(ctx);
  if (!typeDef) {
    throw new Error("Vector2 type is not registered");
  }
  return mkClosedStructValueByName(
    typeDef,
    new Dict([
      ["x", mkNumberValue(v.X)],
      ["y", mkNumberValue(v.Y)],
    ])
  );
}

/**
 * Read a `Vector2` struct value as a vector, resolving its fields through the
 * environment `ctx` executes in. Returns `undefined` when `value` is not a
 * `Vector2`, when that environment has not registered the type, or when either
 * field is missing.
 */
export function extractVector2(ctx: ExecutionContext, value: StructValue): Vector2 | undefined {
  if (value.t !== NativeType.Struct || value.typeId !== EcosimTypeIds.Vector2) {
    return undefined;
  }
  const typeDef = vector2TypeDefOf(ctx);
  if (!typeDef) {
    return undefined;
  }
  const xField = getClosedStructFieldByName(typeDef, value, "x") as NumberValue | undefined;
  const yField = getClosedStructFieldByName(typeDef, value, "y") as NumberValue | undefined;
  if (xField && yField && xField.t === NativeType.Number && yField.t === NativeType.Number) {
    return new Vector2(xField.v, yField.v);
  }
  return undefined;
}

// -------------------------------------------------------
// ActorRef helpers
// -------------------------------------------------------

/**
 * Resolve the live Actor from a native-backed actorRef StructValue.
 * The `native` field is either a resolver function `(ctx) => Actor | undefined`
 * or a direct `Actor` reference.
 *
 * Returns undefined when the handle is empty, when a resolver finds no actor,
 * and when the actor is dying (the engine has killed it): a killed actor
 * resolves as no actor.
 */
export function resolveActor(source: StructValue, ctx: ExecutionContext): Actor | undefined {
  const raw = source.native;
  if (raw === undefined || raw === null) return undefined;
  const actor = TypeUtils.isFunction(raw) ? (raw as (ctx: ExecutionContext) => Actor | undefined)(ctx) : (raw as Actor);
  return actor?.isDying ? undefined : actor;
}

/**
 * Snapshot the native handle for actorRef during deep-copy (assignment).
 * If the native handle is a resolver function, call it to get the current Actor
 * and store the direct reference. This ensures that `$target = [it]` captures
 * the specific actor at assignment time rather than re-resolving lazily later.
 */
function actorRefSnapshotNative(source: StructValue, ctx: ExecutionContext): unknown {
  const raw = source.native;
  if (raw === undefined || raw === null) return raw;
  if (TypeUtils.isFunction(raw)) {
    // Resolve the function to get the concrete Actor
    const actor = (raw as (ctx: ExecutionContext) => Actor | undefined)(ctx);
    return actor ?? undefined;
  }
  // Already a direct Actor reference -- return as-is
  return raw;
}

/**
 * Existence hook for the actorRef native struct type: whether the value
 * resolves to an actor the engine has not killed.
 */
function actorRefExists(source: StructValue, ctx: ExecutionContext): boolean {
  return resolveActor(source, ctx) !== undefined;
}

/**
 * Field getter for the actorRef native struct type.
 */
function actorRefFieldGetter(source: StructValue, fieldId: number, ctx: ExecutionContext): Value | undefined {
  const actor = resolveActor(source, ctx);
  if (!actor) return undefined;
  switch (fieldId) {
    case ActorRefField.Id:
      return mkNumberValue(actor.actorId);
    case ActorRefField.Position:
      return mkVector2Value(ctx, new Vector2(actor.sprite.x, actor.sprite.y));
    case ActorRefField.Rotation:
      return mkNumberValue(actor.sprite.rotation);
    case ActorRefField.EnergyPct:
      return mkNumberValue(actor.energy / actor.maxEnergy);
    case ActorRefField.Forward:
      return mkVector2Value(ctx, new Vector2(Math.cos(actor.sprite.rotation), Math.sin(actor.sprite.rotation)));
    default:
      return undefined;
  }
}

function actorRefFieldSetter(source: StructValue, fieldId: number, value: Value, ctx: ExecutionContext): boolean {
  const actor = resolveActor(source, ctx);
  if (!actor) return false;
  switch (fieldId) {
    case ActorRefField.Position: {
      const vec = extractVector2(ctx, value as StructValue);
      if (!vec) return false;
      actor.sprite.setPosition(vec.X, vec.Y);
      return true;
    }
    case ActorRefField.Rotation: {
      const angle = extractNumberValue(value);
      if (angle === undefined) return false;
      actor.sprite.setRotation(angle);
      return true;
    }
    default:
      return false;
  }
}

/**
 * Create an actorRef value backed by a resolver function.
 * The resolver is called with the ExecutionContext at field-access time,
 * so the value is always current and identity-correct across brain copies.
 *
 * Example: `mkActorRefResolver(getSelf)` for the [me] tile.
 */
export function mkActorRefResolver(resolver: (ctx: ExecutionContext) => Actor | undefined): StructValue {
  return mkNativeStructValue(EcosimTypeIds.ActorRef, resolver);
}

/**
 * Create an actorRef value backed by a direct Actor reference.
 * Use this for literal actor tiles where the user picked a specific actor.
 */
export function mkActorRefDirect(actor: Actor): StructValue {
  return mkNativeStructValue(EcosimTypeIds.ActorRef, actor);
}

export function registerTypes(api: WendooModuleApi) {
  api.defineType({
    coreType: NativeType.Struct,
    typeId: EcosimTypeIds.Vector2,
    name: EcosimTypeNames.Vector2,
    atomId: EcosimTypeAtomId.Vector2,
    fields: Vector2Fields,
    accessors: true,
    variableFactory: true,
  });
  if (!api.brainServices.runtime.types.get(EcosimTypeIds.Vector2)) {
    throw new Error("Vector2 type registration failed");
  }

  api.defineType({
    coreType: NativeType.Struct,
    typeId: EcosimTypeIds.ActorRef,
    name: EcosimTypeNames.ActorRef,
    atomId: EcosimTypeAtomId.ActorRef,
    fields: List.from([
      { name: "id", typeId: CoreTypeIds.Number, readOnly: true, fieldIndex: ActorRefField.Id },
      { name: "position", typeId: EcosimTypeIds.Vector2, fieldIndex: ActorRefField.Position },
      { name: "rotation", typeId: CoreTypeIds.Number, fieldIndex: ActorRefField.Rotation },
      { name: "energy pct", typeId: CoreTypeIds.Number, readOnly: true, fieldIndex: ActorRefField.EnergyPct },
      { name: "forward", typeId: EcosimTypeIds.Vector2, readOnly: true, fieldIndex: ActorRefField.Forward },
    ]),
    fieldGetter: actorRefFieldGetter,
    fieldSetter: actorRefFieldSetter,
    snapshotNative: actorRefSnapshotNative,
    exists: actorRefExists,
    accessors: ["id", "energy pct", "position"],
    variableFactory: true,
  });

  api.registerConversion({
    id: EcosimFuncId.ConvActorRefToNumber,
    fromType: EcosimTypeIds.ActorRef,
    toType: CoreTypeIds.Number,
    cost: 2,
    fn: {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const value = args.get(0) as StructValue;
        const actor = resolveActor(value, ctx);
        return mkNumberValue(actor ? actor.actorId : 0);
      },
    },
  });
  api.registerConversion({
    id: EcosimFuncId.ConvActorRefToVector2,
    fromType: EcosimTypeIds.ActorRef,
    toType: EcosimTypeIds.Vector2,
    cost: 2,
    fn: {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const value = args.get(0) as StructValue;
        const actor = resolveActor(value, ctx);
        if (actor) {
          return mkVector2Value(ctx, new Vector2(actor.sprite.x, actor.sprite.y));
        }
        return mkVector2Value(ctx, new Vector2(0, 0));
      },
    },
  });
  api.registerConversion({
    id: EcosimFuncId.ConvVector2ToString,
    fromType: EcosimTypeIds.Vector2,
    toType: CoreTypeIds.String,
    cost: 3,
    fn: {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        const value = args.get(0) as StructValue;
        const vec = extractVector2(ctx, value);
        return {
          t: NativeType.String,
          v: vec ? `(${vec.X.toFixed(2)}, ${vec.Y.toFixed(2)})` : "(invalid)",
        };
      },
    },
  });

  // -------------------------------------------------------
  // Vector2 methods
  // -------------------------------------------------------

  const { types, functions } = api.brainServices.runtime;
  const emptyCallDef = mkCallDef({ type: "bag", items: [] });

  types.addStructMethods(
    EcosimTypeIds.Vector2,
    List.from([
      {
        name: "add",
        params: List.from([{ name: "other", typeId: EcosimTypeIds.Vector2 }]),
        returnTypeId: EcosimTypeIds.Vector2,
      },
      {
        name: "sub",
        params: List.from([{ name: "other", typeId: EcosimTypeIds.Vector2 }]),
        returnTypeId: EcosimTypeIds.Vector2,
      },
      {
        name: "mul",
        params: List.from([{ name: "scalar", typeId: CoreTypeIds.Number }]),
        returnTypeId: EcosimTypeIds.Vector2,
      },
      {
        name: "div",
        params: List.from([{ name: "scalar", typeId: CoreTypeIds.Number }]),
        returnTypeId: EcosimTypeIds.Vector2,
      },
      {
        name: "dot",
        params: List.from([{ name: "other", typeId: EcosimTypeIds.Vector2 }]),
        returnTypeId: CoreTypeIds.Number,
      },
      {
        name: "cross",
        params: List.from([{ name: "other", typeId: EcosimTypeIds.Vector2 }]),
        returnTypeId: CoreTypeIds.Number,
      },
      {
        name: "magnitude",
        params: List.empty(),
        returnTypeId: CoreTypeIds.Number,
      },
      {
        name: "normalize",
        params: List.empty(),
        returnTypeId: EcosimTypeIds.Vector2,
      },
      {
        name: "distance",
        params: List.from([{ name: "other", typeId: EcosimTypeIds.Vector2 }]),
        returnTypeId: CoreTypeIds.Number,
      },
      {
        name: "lerp",
        params: List.from([
          { name: "goal", typeId: EcosimTypeIds.Vector2 },
          { name: "alpha", typeId: CoreTypeIds.Number },
        ]),
        returnTypeId: EcosimTypeIds.Vector2,
      },
      {
        name: "angle",
        params: List.from([{ name: "other", typeId: EcosimTypeIds.Vector2 }]),
        returnTypeId: CoreTypeIds.Number,
      },
      {
        name: "rotate",
        params: List.from([{ name: "angle", typeId: CoreTypeIds.Number }]),
        returnTypeId: EcosimTypeIds.Vector2,
      },
    ])
  );

  functions.register(
    EcosimFuncId.Vector2Add,
    "Vector2.add",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const other = extractVector2(ctx, args.get(1) as StructValue);
        if (!self || !other) return VOID_VALUE;
        return mkVector2Value(ctx, self.add(other));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Sub,
    "Vector2.sub",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const other = extractVector2(ctx, args.get(1) as StructValue);
        if (!self || !other) return VOID_VALUE;
        return mkVector2Value(ctx, self.sub(other));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Mul,
    "Vector2.mul",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const scalar = extractNumberValue(args.at(1));
        if (!self || scalar === undefined) return VOID_VALUE;
        return mkVector2Value(ctx, self.mul(scalar));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Div,
    "Vector2.div",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const scalar = extractNumberValue(args.at(1));
        if (!self || scalar === undefined) return VOID_VALUE;
        return mkVector2Value(ctx, self.div(scalar));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Dot,
    "Vector2.dot",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const other = extractVector2(ctx, args.get(1) as StructValue);
        if (!self || !other) return VOID_VALUE;
        return mkNumberValue(self.Dot(other));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Cross,
    "Vector2.cross",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const other = extractVector2(ctx, args.get(1) as StructValue);
        if (!self || !other) return VOID_VALUE;
        return mkNumberValue(self.Cross(other));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Magnitude,
    "Vector2.magnitude",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        if (!self) return VOID_VALUE;
        return mkNumberValue(self.Magnitude);
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Normalize,
    "Vector2.normalize",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        if (!self) return VOID_VALUE;
        return mkVector2Value(ctx, self.Unit);
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Distance,
    "Vector2.distance",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const other = extractVector2(ctx, args.get(1) as StructValue);
        if (!self || !other) return VOID_VALUE;
        return mkNumberValue(self.sub(other).Magnitude);
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Lerp,
    "Vector2.lerp",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const goal = extractVector2(ctx, args.get(1) as StructValue);
        const alpha = extractNumberValue(args.at(2));
        if (!self || !goal || alpha === undefined) return VOID_VALUE;
        return mkVector2Value(ctx, self.Lerp(goal, alpha));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Angle,
    "Vector2.angle",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const other = extractVector2(ctx, args.get(1) as StructValue);
        if (!self || !other) return VOID_VALUE;
        return mkNumberValue(self.Angle(other));
      },
    },
    emptyCallDef
  );

  functions.register(
    EcosimFuncId.Vector2Rotate,
    "Vector2.rotate",
    false,
    {
      exec: (ctx: ExecutionContext, args: ReadonlyList<Value>): Value => {
        const self = extractVector2(ctx, args.get(0) as StructValue);
        const angle = extractNumberValue(args.at(1));
        if (!self || angle === undefined) return VOID_VALUE;
        return mkVector2Value(ctx, self.rotate(angle));
      },
    },
    emptyCallDef
  );

  // -------------------------------------------------------
  // Context.self field (ActorRef backed by executing actor)
  // -------------------------------------------------------

  types.addStructFields(
    ContextTypeIds.Context,
    List.from([{ name: "self", typeId: EcosimTypeIds.ActorRef, fieldIndex: CONTEXT_SELF_FIELD_ID }]),
    (source: StructValue, fieldId: number, ctx: ExecutionContext) => {
      if (fieldId !== CONTEXT_SELF_FIELD_ID) return undefined;
      const actor = getSelf(ctx);
      if (!actor) return undefined;
      return mkNativeStructValue(EcosimTypeIds.ActorRef, actor);
    }
  );
}
