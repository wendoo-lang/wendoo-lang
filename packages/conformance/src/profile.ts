import type {
  AsyncHandle,
  CreateHostActuatorOptions,
  CreateHostSensorOptions,
  ExecutionContext,
  ReadonlyList,
  Value,
  WendooModule,
  WendooModuleApi,
} from "@wendoo/core/app";
import {
  BitSet,
  BrainTileLiteralDef,
  bag,
  CoreCapabilityBits,
  CoreParameterId,
  CoreTypeIds,
  createHostActuator,
  createHostSensor,
  Dict,
  getCallSiteState,
  getSlotId,
  isNumberValue,
  List,
  mkCallDef,
  mkClosedStructValueByName,
  mkNativeStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  NIL_VALUE,
  param,
  repeated,
  type StructTypeDef,
  type StructValue,
  setCallSiteState,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  TilePlacement,
  TypeUtils,
  VOID_VALUE,
} from "@wendoo/core/app";
import { BrainTileOperatorDef } from "@wendoo/core/brain/tiles";
import { ErrorCode, safeNumBinary, TARGET_TYPE_ATOM_BASE } from "@wendoo/core/runtime";

/**
 * Numeric device-profile id written into the binary program envelope of every
 * corpus artifact, and into the `profile` line of every rendered trace.
 */
export const CONFORMANCE_PROFILE_ID = 1000;

/** Module id the conformance host profile installs under. */
export const CONFORMANCE_MODULE_ID = "wendoo.conformance";

/**
 * Per-fiber instruction budget and fiber cap the corpus is minted under. Every
 * VM replaying the corpus schedules with these values.
 */
export const CONFORMANCE_SCHEDULER_CONFIG = {
  defaultBudget: 1000,
  hookBudget: 10000,
  maxFibers: 100,
  maxStackSize: 256,
  maxLocalsSize: 256,
  maxFrameDepth: 64,
  maxHandlers: 16,
  maxHandles: 8,
} as const;

/** Type name of the conformance profile's struct type; its typeId derives from it. */
const POINT_TYPE_NAME = "Point";

/** TypeId of the conformance `Point` struct type. */
export const CONFORMANCE_POINT_TYPE_ID = mkTypeId(NativeType.Struct, POINT_TYPE_NAME);

/** Type name of the profile's aliasing-pinned native struct type. */
const ANCHOR_TYPE_NAME = "Anchor";

/** TypeId of the conformance `Anchor` native-backed struct type. */
export const CONFORMANCE_ANCHOR_TYPE_ID = mkTypeId(NativeType.Struct, ANCHOR_TYPE_NAME);

/** Type name of the profile's snapshot-pinned native struct type. */
const TARGET_TYPE_NAME = "Target";

/** TypeId of the conformance `Target` native-backed struct type. */
export const CONFORMANCE_TARGET_TYPE_ID = mkTypeId(NativeType.Struct, TARGET_TYPE_NAME);

/** Type name of the profile's program-local enum type; its typeId derives from it. */
const MODE_TYPE_NAME = "Mode";

/** TypeId of the conformance `Mode` enum type. */
export const CONFORMANCE_MODE_TYPE_ID = mkTypeId(NativeType.Enum, MODE_TYPE_NAME);

/**
 * Symbol keys of the `Mode` enum, in ordinal order. Enum constants serialize
 * as ordinals into this list, so it is append-only: never reorder or remove a
 * key. Every symbol's value is its own key, so the enum is string-valued.
 */
export const CONFORMANCE_MODE_SYMBOL_KEYS = ["idle", "seek", "flee"] as const;

/** Symbol key carried by the `Mode` literal tile the profile registers. */
export const CONFORMANCE_MODE_LITERAL_KEY = "seek";

/**
 * Field values of the `waypoint` Point literal tile the profile registers.
 * Both are exactly representable at f32, and distinct from every reading the
 * profile's sensors produce.
 */
export const CONFORMANCE_POINT_CONSTANT = { x: 3.5, y: -4.25 } as const;

/** Value label (and tile-id basis) of the `waypoint` Point literal tile. */
export const CONFORMANCE_POINT_LITERAL_LABEL = "waypoint";

/**
 * Stable type-atom ids of the conformance profile's nominal types, dense from
 * core's `TARGET_TYPE_ATOM_BASE`. Serialized programs record these verbatim:
 * append new records at the next free id and never renumber or reuse one.
 */
export const ConformanceTypeAtomIds = {
  Point: TARGET_TYPE_ATOM_BASE,
  Anchor: TARGET_TYPE_ATOM_BASE + 1,
  Target: TARGET_TYPE_ATOM_BASE + 2,
} as const;

/** Field ids (also storage slots) of the `Point` struct. Wire-stable; never renumber. */
export const ConformancePointField = {
  X: 0,
  Y: 1,
} as const;

/** Field ids of the `Anchor` native struct type. Wire-stable; never renumber. */
export const ConformanceAnchorField = {
  X: 0,
  Y: 1,
} as const;

/** Field ids of the `Target` native struct type. Wire-stable; never renumber. */
export const ConformanceTargetField = {
  Value: 0,
} as const;

/**
 * Field values of every settled `defer point` reading. Both are exactly
 * representable at f32, so the reading's fields render identically-valued bit
 * patterns at either precision.
 */
export const CONFORMANCE_POINT_READING = { x: 1.5, y: 2.25 } as const;

/**
 * Starting field values of the world's one `Anchor` host object. Both are
 * exactly representable at f32.
 */
export const CONFORMANCE_ANCHOR_READING = { x: 1.5, y: 2.25 } as const;

/**
 * `value` fields of the world's two `Target` host objects: `first` is the
 * object the first resolution returns, `second` the object every later
 * resolution returns. Both are exactly representable at f32.
 */
export const CONFORMANCE_TARGET_READING = { first: 1.5, second: 8.5 } as const;

/** The mutable host object behind every `Anchor` value of one world. */
export interface ConformanceAnchorObject {
  x: number;
  y: number;
}

/** One host object a `Target` resolution returns. */
export interface ConformanceTargetObject {
  readonly value: number;
}

/**
 * Lazy `native` handle of an unassigned `Target` value: resolves to the host
 * object the value currently designates. `snapshotNative` materializes it to
 * a concrete {@link ConformanceTargetObject} at assignment.
 */
export type ConformanceTargetResolver = (ctx: ExecutionContext) => ConformanceTargetObject | undefined;

/** Parameter tile ids the conformance host actions address their named arguments by. */
export const ConformanceParameterId = {
  /** Number of whole ticks a deferred call settles after. */
  Ticks: "conformance.ticks",
  /** Whole-tick interval between two deliveries of a value-bearing sensor. */
  Period: "conformance.period",
  /** One value of any kind filling `emit all`'s repeated value slot. */
  Value: "conformance.value",
} as const;

/**
 * Action keys of the conformance host profile. The key is the authoring
 * identity: registry key, host-function name, and tile-id basis.
 */
export const ConformanceActionKeys = {
  Echo: "sensor.conformance.echo",
  Emit: "actuator.conformance.emit",
  DeferEcho: "actuator.conformance.defer-echo",
  DeferFail: "actuator.conformance.defer-fail",
  Fault: "actuator.conformance.fault",
  Signal: "sensor.conformance.signal",
  Counter: "sensor.conformance.counter",
  DeferCancel: "actuator.conformance.defer-cancel",
  DeferRead: "sensor.conformance.defer-read",
  EmitText: "actuator.conformance.emit-text",
  EmitFlag: "actuator.conformance.emit-flag",
  DeferPoint: "sensor.conformance.defer-point",
  DeferAnchor: "sensor.conformance.defer-anchor",
  DeferTarget: "sensor.conformance.defer-target",
  EmitAll: "actuator.conformance.emit-all",
} as const;

/**
 * Stable ids of the conformance host actions, allocated from the target
 * partitions core reserves (`TARGET_ACTION_ID_BASE` / `TARGET_FUNC_ID_BASE`).
 * Serialized programs record these verbatim: append new records at the next
 * free offset and never renumber or reuse one.
 */
export const ConformanceHostActions = {
  Echo: { key: ConformanceActionKeys.Echo, actionId: TARGET_ACTION_ID_BASE, fnId: TARGET_FUNC_ID_BASE },
  Emit: { key: ConformanceActionKeys.Emit, actionId: TARGET_ACTION_ID_BASE + 1, fnId: TARGET_FUNC_ID_BASE + 1 },
  DeferEcho: {
    key: ConformanceActionKeys.DeferEcho,
    actionId: TARGET_ACTION_ID_BASE + 2,
    fnId: TARGET_FUNC_ID_BASE + 2,
  },
  DeferFail: {
    key: ConformanceActionKeys.DeferFail,
    actionId: TARGET_ACTION_ID_BASE + 3,
    fnId: TARGET_FUNC_ID_BASE + 3,
  },
  Fault: { key: ConformanceActionKeys.Fault, actionId: TARGET_ACTION_ID_BASE + 4, fnId: TARGET_FUNC_ID_BASE + 4 },
  Signal: { key: ConformanceActionKeys.Signal, actionId: TARGET_ACTION_ID_BASE + 5, fnId: TARGET_FUNC_ID_BASE + 5 },
  Counter: {
    key: ConformanceActionKeys.Counter,
    actionId: TARGET_ACTION_ID_BASE + 6,
    fnId: TARGET_FUNC_ID_BASE + 6,
  },
  DeferCancel: {
    key: ConformanceActionKeys.DeferCancel,
    actionId: TARGET_ACTION_ID_BASE + 7,
    fnId: TARGET_FUNC_ID_BASE + 7,
  },
  DeferRead: {
    key: ConformanceActionKeys.DeferRead,
    actionId: TARGET_ACTION_ID_BASE + 8,
    fnId: TARGET_FUNC_ID_BASE + 8,
  },
  EmitText: {
    key: ConformanceActionKeys.EmitText,
    actionId: TARGET_ACTION_ID_BASE + 9,
    fnId: TARGET_FUNC_ID_BASE + 10,
  },
  EmitFlag: {
    key: ConformanceActionKeys.EmitFlag,
    actionId: TARGET_ACTION_ID_BASE + 10,
    fnId: TARGET_FUNC_ID_BASE + 11,
  },
  DeferPoint: {
    key: ConformanceActionKeys.DeferPoint,
    actionId: TARGET_ACTION_ID_BASE + 11,
    fnId: TARGET_FUNC_ID_BASE + 12,
  },
  DeferAnchor: {
    key: ConformanceActionKeys.DeferAnchor,
    actionId: TARGET_ACTION_ID_BASE + 12,
    fnId: TARGET_FUNC_ID_BASE + 13,
  },
  DeferTarget: {
    key: ConformanceActionKeys.DeferTarget,
    actionId: TARGET_ACTION_ID_BASE + 13,
    fnId: TARGET_FUNC_ID_BASE + 14,
  },
  EmitAll: {
    key: ConformanceActionKeys.EmitAll,
    actionId: TARGET_ACTION_ID_BASE + 14,
    fnId: TARGET_FUNC_ID_BASE + 15,
  },
} as const;

/**
 * Operators the conformance host profile registers, each with the operator id
 * its tile is built from and the stable funcId of its one overload. The funcIds
 * continue the target partition offsets {@link ConformanceHostActions} uses, and
 * serialized programs record them verbatim: append new records at the next free
 * offset and never renumber or reuse one.
 */
export const ConformanceOperators = {
  DeferAdd: { opId: "conformance.defer-add", fnId: TARGET_FUNC_ID_BASE + 9 },
} as const;

const AnonValue = param(CoreParameterId.AnonymousNumber, { name: "value", anonymous: true });
const AnonText = param(CoreParameterId.AnonymousString, { name: "value", anonymous: true });
const AnonFlag = param(CoreParameterId.AnonymousBoolean, { name: "value", anonymous: true });
const AnonAny = param(ConformanceParameterId.Value, { name: "value", anonymous: true });
const Ticks = param(ConformanceParameterId.Ticks, { name: "ticks", default: mkNumberValue(1) });
const Period = param(ConformanceParameterId.Period, { name: "period", default: mkNumberValue(1) });

const echoCallDef = mkCallDef(bag(AnonValue));
const emitCallDef = mkCallDef(bag(AnonValue));
const deferEchoCallDef = mkCallDef(bag(AnonValue, Ticks));
const deferFailCallDef = mkCallDef(bag(Ticks));
const faultCallDef = mkCallDef(bag());
const signalCallDef = mkCallDef(bag(Period));
const counterCallDef = mkCallDef(bag());
const deferCancelCallDef = mkCallDef(bag(Ticks));
const deferReadCallDef = mkCallDef(bag(AnonValue, Ticks));
const emitTextCallDef = mkCallDef(bag(AnonText));
const emitFlagCallDef = mkCallDef(bag(AnonFlag));
const deferPointCallDef = mkCallDef(bag());
const deferAnchorCallDef = mkCallDef(bag());
const deferTargetCallDef = mkCallDef(bag());
const emitAllCallDef = mkCallDef(bag(repeated(AnonAny, { min: 0 })));

const kEchoValueSlotId = getSlotId(echoCallDef, AnonValue);
const kDeferEchoValueSlotId = getSlotId(deferEchoCallDef, AnonValue);
const kDeferEchoTicksSlotId = getSlotId(deferEchoCallDef, Ticks);
const kDeferFailTicksSlotId = getSlotId(deferFailCallDef, Ticks);
const kSignalPeriodSlotId = getSlotId(signalCallDef, Period);
const kDeferCancelTicksSlotId = getSlotId(deferCancelCallDef, Ticks);
const kDeferReadValueSlotId = getSlotId(deferReadCallDef, AnonValue);
const kDeferReadTicksSlotId = getSlotId(deferReadCallDef, Ticks);
const kEmitTextValueSlotId = getSlotId(emitTextCallDef, AnonText);
const kEmitFlagValueSlotId = getSlotId(emitFlagCallDef, AnonFlag);

/** Whole-tick count a deferred call waits, or a signal's period, when the argument carries none. */
const DEFAULT_WHOLE_TICKS = 1;

/** Value `signal` delivers on a tick it is present: falsy, so only a presence gate fires on it. */
const SIGNAL_VALUE = mkNumberValue(0);

/** Error code `deferFail` rejects its handle with. */
const DEFER_FAIL_CODE = ErrorCode.HostError;

/** Count `counter` holds at a call site the activation hook has just reset; its first read returns one more. */
const COUNTER_START = 0;

/** Binding strength `defer plus` parses at. */
const DEFER_ADD_PRECEDENCE = 120;

/** One deferred settlement the world owes, held until its due tick. */
interface PendingSettlement {
  /** Tick ordinal at which the settlement is due. */
  readonly dueTick: number;
  /** Settles the handle the deferred call was dispatched on. */
  settle(): void;
}

/**
 * Deterministic world the conformance host actions run against: the pending
 * deferred settlements and nothing else. It owns no clock and no random
 * stream, so two runs of one program over one schedule observe the same world.
 *
 * Attach an instance as the brain runtime's context data, and call
 * {@link ConformanceWorld.settleDue} with the ordinal of the think that is
 * about to run, before running it.
 */
export class ConformanceWorld {
  private pending: PendingSettlement[] = [];

  private readonly anchorObject: ConformanceAnchorObject = {
    x: CONFORMANCE_ANCHOR_READING.x,
    y: CONFORMANCE_ANCHOR_READING.y,
  };

  private readonly firstTarget: ConformanceTargetObject = { value: CONFORMANCE_TARGET_READING.first };

  private readonly laterTarget: ConformanceTargetObject = { value: CONFORMANCE_TARGET_READING.second };

  private targetResolutions = 0;

  /** The world's one `Anchor` host object; every `defer anchor` reading is backed by it. */
  anchor(): ConformanceAnchorObject {
    return this.anchorObject;
  }

  /**
   * Resolve the current `Target` host object, counting the call: the first
   * resolution of the run returns the `first` object, every later one the
   * `second`.
   */
  resolveTarget(): ConformanceTargetObject {
    this.targetResolutions += 1;
    return this.targetResolutions === 1 ? this.firstTarget : this.laterTarget;
  }

  /**
   * Settle every deferred call due at or before `tick`, oldest dispatch first.
   * Call it immediately before the think of ordinal `tick`, so a fiber parked
   * on a settled handle resumes within that think.
   *
   * @param tick - 1-based ordinal of the think about to run.
   */
  settleDue(tick: number): void {
    const due = this.pending.filter((entry) => entry.dueTick <= tick);
    this.pending = this.pending.filter((entry) => entry.dueTick > tick);
    for (const entry of due) {
      entry.settle();
    }
  }

  /**
   * Record a settlement due `ticks` thinks after the think of ordinal
   * `dispatchTick`.
   *
   * @param dispatchTick - Ordinal of the think the deferred call was dispatched on.
   * @param ticks - Whole ticks between the dispatch and the settlement.
   * @param settle - Settles the dispatched call's handle.
   */
  defer(dispatchTick: number, ticks: number, settle: () => void): void {
    this.pending.push({ dueTick: dispatchTick + ticks, settle });
  }
}

/** Whole-tick count carried by the argument at `slotId`, or the default when it carries none. */
function wholeTicksArg(args: ReadonlyList<Value>, slotId: number): number {
  const value = args.get(slotId);
  if (value === undefined || !isNumberValue(value)) {
    return DEFAULT_WHOLE_TICKS;
  }
  return value.v;
}

/** The world attached to `ctx`, or `undefined` when the runtime carries none. */
function worldOf(ctx: ExecutionContext): ConformanceWorld | undefined {
  return ctx.data instanceof ConformanceWorld ? ctx.data : undefined;
}

function execEcho(_ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  return args.get(kEchoValueSlotId);
}

function execEmit(): Value {
  return VOID_VALUE;
}

function execDeferEcho(ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const value = args.get(kDeferEchoValueSlotId);
  const world = worldOf(ctx);
  if (!world) {
    handle.resolve(value);
    return;
  }
  world.defer(ctx.currentTick, wholeTicksArg(args, kDeferEchoTicksSlotId), () => {
    handle.resolve(value);
  });
}

function execDeferFail(ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const world = worldOf(ctx);
  if (!world) {
    handle.reject(DEFER_FAIL_CODE);
    return;
  }
  world.defer(ctx.currentTick, wholeTicksArg(args, kDeferFailTicksSlotId), () => {
    handle.reject(DEFER_FAIL_CODE);
  });
}

function execFault(): Value {
  throw new Error("conformance fault");
}

function execSignal(ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  const period = wholeTicksArg(args, kSignalPeriodSlotId);
  return ctx.currentTick % period === 0 ? SIGNAL_VALUE : NIL_VALUE;
}

function counterPageEntered(ctx: ExecutionContext): void {
  setCallSiteState(ctx, COUNTER_START);
}

function execCounter(ctx: ExecutionContext): Value {
  const stored = getCallSiteState<number>(ctx);
  const next = (stored === undefined ? COUNTER_START : stored) + 1;
  setCallSiteState(ctx, next);
  return mkNumberValue(next);
}

function execDeferCancel(ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const world = worldOf(ctx);
  if (!world) {
    handle.cancel();
    return;
  }
  world.defer(ctx.currentTick, wholeTicksArg(args, kDeferCancelTicksSlotId), () => {
    handle.cancel();
  });
}

function execDeferRead(ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const value = args.get(kDeferReadValueSlotId);
  const world = worldOf(ctx);
  if (!world) {
    handle.resolve(value);
    return;
  }
  world.defer(ctx.currentTick, wholeTicksArg(args, kDeferReadTicksSlotId), () => {
    handle.resolve(value);
  });
}

/**
 * Builds one `Point` struct reading in the environment `ctx` executes in.
 * Throws when that environment has not registered the `Point` type.
 */
function mkPointReading(ctx: ExecutionContext): Value {
  const typeDef = ctx.services.runtime.types.get(CONFORMANCE_POINT_TYPE_ID) as StructTypeDef | undefined;
  if (!typeDef) {
    throw new Error("conformance Point type is not registered");
  }
  return mkClosedStructValueByName(
    typeDef,
    new Dict([
      ["x", mkNumberValue(CONFORMANCE_POINT_READING.x)],
      ["y", mkNumberValue(CONFORMANCE_POINT_READING.y)],
    ])
  );
}

function execDeferPoint(ctx: ExecutionContext, _args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const world = worldOf(ctx);
  if (!world) {
    handle.resolve(mkPointReading(ctx));
    return;
  }
  world.defer(ctx.currentTick, DEFAULT_WHOLE_TICKS, () => {
    handle.resolve(mkPointReading(ctx));
  });
}

/**
 * Field getter of the `Anchor` type: reads the field off the host object
 * behind `source`. A value carrying no host object, and a field id the type
 * does not declare, both read as absent.
 */
function anchorFieldGetter(source: StructValue, fieldId: number, _ctx: ExecutionContext): Value | undefined {
  const anchor = source.native as ConformanceAnchorObject | undefined;
  if (!anchor) {
    return undefined;
  }
  if (fieldId === ConformanceAnchorField.X) {
    return mkNumberValue(anchor.x);
  }
  if (fieldId === ConformanceAnchorField.Y) {
    return mkNumberValue(anchor.y);
  }
  return undefined;
}

/**
 * Field setter of the `Anchor` type: writes the field of the host object
 * behind `source`. Rejects a value carrying no host object, a non-number
 * value, and a field id the type does not declare.
 */
function anchorFieldSetter(source: StructValue, fieldId: number, value: Value, _ctx: ExecutionContext): boolean {
  const anchor = source.native as ConformanceAnchorObject | undefined;
  if (!anchor || !isNumberValue(value)) {
    return false;
  }
  if (fieldId === ConformanceAnchorField.X) {
    anchor.x = value.v;
    return true;
  }
  if (fieldId === ConformanceAnchorField.Y) {
    anchor.y = value.v;
    return true;
  }
  return false;
}

/**
 * The host object a `Target` value designates: a resolver native is called,
 * a direct object reference passes through.
 */
function resolveTargetObject(source: StructValue, ctx: ExecutionContext): ConformanceTargetObject | undefined {
  const raw = source.native;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (TypeUtils.isFunction(raw)) {
    return (raw as ConformanceTargetResolver)(ctx);
  }
  return raw as ConformanceTargetObject;
}

/**
 * Snapshot hook of the `Target` type, run when a deep copy (assignment)
 * materializes the `native` handle: a resolver native is resolved once and
 * the concrete host object stored, a direct object reference passes through.
 */
function targetSnapshotNative(source: StructValue, ctx: ExecutionContext): unknown {
  const raw = source.native;
  if (raw === undefined || raw === null) {
    return raw;
  }
  if (TypeUtils.isFunction(raw)) {
    const resolved = (raw as ConformanceTargetResolver)(ctx);
    return resolved ?? undefined;
  }
  return raw;
}

/**
 * Field getter of the `Target` type: reads the field off the host object the
 * value designates, resolving a resolver native on every read. A value that
 * designates no object, and a field id the type does not declare, both read
 * as absent.
 */
function targetFieldGetter(source: StructValue, fieldId: number, ctx: ExecutionContext): Value | undefined {
  const target = resolveTargetObject(source, ctx);
  if (!target) {
    return undefined;
  }
  if (fieldId === ConformanceTargetField.Value) {
    return mkNumberValue(target.value);
  }
  return undefined;
}

function execDeferAnchor(ctx: ExecutionContext, _args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const world = worldOf(ctx);
  if (!world) {
    handle.resolve(mkNativeStructValue(CONFORMANCE_ANCHOR_TYPE_ID, undefined));
    return;
  }
  world.defer(ctx.currentTick, DEFAULT_WHOLE_TICKS, () => {
    handle.resolve(mkNativeStructValue(CONFORMANCE_ANCHOR_TYPE_ID, world.anchor()));
  });
}

function execDeferTarget(ctx: ExecutionContext, _args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const world = worldOf(ctx);
  if (!world) {
    handle.resolve(mkNativeStructValue(CONFORMANCE_TARGET_TYPE_ID, undefined));
    return;
  }
  world.defer(ctx.currentTick, DEFAULT_WHOLE_TICKS, () => {
    const resolver: ConformanceTargetResolver = () => world.resolveTarget();
    handle.resolve(mkNativeStructValue(CONFORMANCE_TARGET_TYPE_ID, resolver));
  });
}

function execEmitText(_ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  return args.get(kEmitTextValueSlotId);
}

function execEmitFlag(_ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  return args.get(kEmitFlagValueSlotId);
}

function execDeferAdd(ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const numerics = ctx.services.app.numerics;
  const sum = safeNumBinary(args, (a, b) => numerics.round(a + b));
  const world = worldOf(ctx);
  if (!world) {
    handle.resolve(sum);
    return;
  }
  world.defer(ctx.currentTick, DEFAULT_WHOLE_TICKS, () => {
    handle.resolve(sum);
  });
}

const echoSensor = {
  key: ConformanceHostActions.Echo.key,
  actionId: ConformanceHostActions.Echo.actionId,
  fnId: ConformanceHostActions.Echo.fnId,
  callDef: echoCallDef,
  fn: { exec: execEcho },
  isAsync: false,
  outputType: CoreTypeIds.Number,
  metadata: { label: "echo" },
} satisfies CreateHostSensorOptions;

const emitActuator = {
  key: ConformanceHostActions.Emit.key,
  actionId: ConformanceHostActions.Emit.actionId,
  fnId: ConformanceHostActions.Emit.fnId,
  callDef: emitCallDef,
  fn: { exec: execEmit },
  isAsync: false,
  metadata: { label: "emit" },
} satisfies CreateHostActuatorOptions;

const deferEchoActuator = {
  key: ConformanceHostActions.DeferEcho.key,
  actionId: ConformanceHostActions.DeferEcho.actionId,
  fnId: ConformanceHostActions.DeferEcho.fnId,
  callDef: deferEchoCallDef,
  fn: { exec: execDeferEcho },
  isAsync: true,
  metadata: { label: "defer echo" },
} satisfies CreateHostActuatorOptions;

const deferFailActuator = {
  key: ConformanceHostActions.DeferFail.key,
  actionId: ConformanceHostActions.DeferFail.actionId,
  fnId: ConformanceHostActions.DeferFail.fnId,
  callDef: deferFailCallDef,
  fn: { exec: execDeferFail },
  isAsync: true,
  metadata: { label: "defer fail" },
} satisfies CreateHostActuatorOptions;

const faultActuator = {
  key: ConformanceHostActions.Fault.key,
  actionId: ConformanceHostActions.Fault.actionId,
  fnId: ConformanceHostActions.Fault.fnId,
  callDef: faultCallDef,
  fn: { exec: execFault },
  isAsync: false,
  metadata: { label: "fault" },
} satisfies CreateHostActuatorOptions;

const signalSensor = {
  key: ConformanceHostActions.Signal.key,
  actionId: ConformanceHostActions.Signal.actionId,
  fnId: ConformanceHostActions.Signal.fnId,
  callDef: signalCallDef,
  fn: { exec: execSignal },
  isAsync: false,
  outputType: CoreTypeIds.Number,
  capabilities: new BitSet().set(CoreCapabilityBits.PresenceGated),
  metadata: { label: "signal" },
} satisfies CreateHostSensorOptions;

const counterSensor = {
  key: ConformanceHostActions.Counter.key,
  actionId: ConformanceHostActions.Counter.actionId,
  fnId: ConformanceHostActions.Counter.fnId,
  callDef: counterCallDef,
  fn: { onPageEntered: counterPageEntered, exec: execCounter },
  isAsync: false,
  outputType: CoreTypeIds.Number,
  metadata: { label: "counter" },
} satisfies CreateHostSensorOptions;

const deferCancelActuator = {
  key: ConformanceHostActions.DeferCancel.key,
  actionId: ConformanceHostActions.DeferCancel.actionId,
  fnId: ConformanceHostActions.DeferCancel.fnId,
  callDef: deferCancelCallDef,
  fn: { exec: execDeferCancel },
  isAsync: true,
  metadata: { label: "defer cancel" },
} satisfies CreateHostActuatorOptions;

const deferReadSensor = {
  key: ConformanceHostActions.DeferRead.key,
  actionId: ConformanceHostActions.DeferRead.actionId,
  fnId: ConformanceHostActions.DeferRead.fnId,
  callDef: deferReadCallDef,
  fn: { exec: execDeferRead },
  isAsync: true,
  outputType: CoreTypeIds.Number,
  metadata: { label: "defer read" },
} satisfies CreateHostSensorOptions;

const emitTextActuator = {
  key: ConformanceHostActions.EmitText.key,
  actionId: ConformanceHostActions.EmitText.actionId,
  fnId: ConformanceHostActions.EmitText.fnId,
  callDef: emitTextCallDef,
  fn: { exec: execEmitText },
  isAsync: false,
  metadata: { label: "emit text" },
} satisfies CreateHostActuatorOptions;

const deferPointSensor = {
  key: ConformanceHostActions.DeferPoint.key,
  actionId: ConformanceHostActions.DeferPoint.actionId,
  fnId: ConformanceHostActions.DeferPoint.fnId,
  callDef: deferPointCallDef,
  fn: { exec: execDeferPoint },
  isAsync: true,
  outputType: CONFORMANCE_POINT_TYPE_ID,
  inline: true,
  metadata: { label: "defer point" },
} satisfies CreateHostSensorOptions;

const deferAnchorSensor = {
  key: ConformanceHostActions.DeferAnchor.key,
  actionId: ConformanceHostActions.DeferAnchor.actionId,
  fnId: ConformanceHostActions.DeferAnchor.fnId,
  callDef: deferAnchorCallDef,
  fn: { exec: execDeferAnchor },
  isAsync: true,
  outputType: CONFORMANCE_ANCHOR_TYPE_ID,
  inline: true,
  metadata: { label: "defer anchor" },
} satisfies CreateHostSensorOptions;

const deferTargetSensor = {
  key: ConformanceHostActions.DeferTarget.key,
  actionId: ConformanceHostActions.DeferTarget.actionId,
  fnId: ConformanceHostActions.DeferTarget.fnId,
  callDef: deferTargetCallDef,
  fn: { exec: execDeferTarget },
  isAsync: true,
  outputType: CONFORMANCE_TARGET_TYPE_ID,
  inline: true,
  metadata: { label: "defer target" },
} satisfies CreateHostSensorOptions;

const emitFlagActuator = {
  key: ConformanceHostActions.EmitFlag.key,
  actionId: ConformanceHostActions.EmitFlag.actionId,
  fnId: ConformanceHostActions.EmitFlag.fnId,
  callDef: emitFlagCallDef,
  fn: { exec: execEmitFlag },
  isAsync: false,
  metadata: { label: "emit flag" },
} satisfies CreateHostActuatorOptions;

const emitAllActuator = {
  key: ConformanceHostActions.EmitAll.key,
  actionId: ConformanceHostActions.EmitAll.actionId,
  fnId: ConformanceHostActions.EmitAll.fnId,
  callDef: emitAllCallDef,
  fn: { exec: execEmit },
  isAsync: false,
  metadata: { label: "emit all" },
} satisfies CreateHostActuatorOptions;

/**
 * The conformance host profile: the host surface every VM implements in its
 * test harness to replay the corpus.
 *
 * - `echo(value)` -- synchronous sensor returning its argument unchanged.
 * - `emit(value)` -- synchronous actuator returning void, the corpus's
 *   observable output channel.
 * - `defer echo(value, ticks)` -- asynchronous actuator whose handle resolves
 *   to `value` exactly `ticks` ticks after its dispatch.
 * - `defer fail(ticks)` -- asynchronous actuator whose handle rejects with
 *   `HostError` exactly `ticks` ticks after its dispatch.
 * - `fault()` -- synchronous actuator that faults the calling fiber with
 *   `ScriptError`.
 * - `signal(period)` -- synchronous presence-gated sensor delivering the
 *   number `0` on every think whose ordinal is a multiple of `period`, and
 *   nil on every other think.
 * - `counter()` -- synchronous sensor returning how many times it has been
 *   read at its own call site since that call site's page was last activated.
 *   The count lives in per-callsite host state and its page-activation hook
 *   resets it, so two call sites count independently and a page restart, which
 *   runs no activation hook, leaves the count standing.
 * - `defer cancel(ticks)` -- asynchronous actuator whose handle is cancelled
 *   exactly `ticks` ticks after its dispatch.
 * - `defer read(value, ticks)` -- asynchronous sensor whose handle resolves to
 *   `value` exactly `ticks` ticks after its dispatch, so a section reading it
 *   suspends until then.
 * - `emit text(value)` -- synchronous actuator whose argument slot is
 *   String-typed, returning its argument, so a string value lands in the
 *   trace's argument and result positions.
 * - `emit flag(value)` -- synchronous actuator whose argument slot is
 *   Boolean-typed, returning its argument, so a boolean value lands in the
 *   trace's argument and result positions.
 * - `lhs defer plus rhs` -- asynchronous infix operator whose handle resolves
 *   to the sum one tick after its dispatch, so the expression containing it
 *   suspends until then. An operand carrying no number, and a sum that is not
 *   a number, both resolve nil.
 * - `defer point()` -- asynchronous inline sensor whose handle resolves to a
 *   fresh `Point` struct reading `{x: 1.5, y: 2.25}` exactly one tick after
 *   its dispatch. The struct is constructed at settle time, immediately
 *   before the handle resolves. `Point` is the profile's closed struct type
 *   (atom id 1024, fields `x` and `y`, accessor tiles registered).
 * - `defer anchor()` -- asynchronous inline sensor whose handle resolves to a
 *   fresh `Anchor` value exactly one tick after its dispatch, constructed at
 *   settle time over the world's one anchor host object. `Anchor` (atom id
 *   1025, fields `x` and `y`) is native-backed: its registered field getter
 *   and setter read and write the host object behind the value, and a deep
 *   copy shares that object by reference, so every copy aliases one anchor.
 * - `defer target()` -- asynchronous inline sensor whose handle resolves to a
 *   fresh `Target` value exactly one tick after its dispatch, backed by a
 *   lazy resolver over the world's call-counting target resolution. `Target`
 *   (atom id 1026, field `value`) registers `snapshotNative`: an assignment
 *   materializes the resolver to the concrete host object it resolves to,
 *   while the field getter resolves on every read of an unassigned value.
 * - `emit all(value...)` -- synchronous actuator returning void, whose one
 *   argument slot is a repeated Any-typed value slot: compiled brain code
 *   gathers the tiles filling it, in source order, into one list value and
 *   passes the list in the dispatch's argument position.
 * - `seek` -- literal tile carrying the `Mode` enum constant `seek`. `Mode`
 *   is the profile's program-local enum type (symbols `idle`, `seek`, `flee`,
 *   each valued by its own key), registered under the dynamic owner so its
 *   symbols embed in each program's type table instead of referencing a type
 *   atom.
 * - `waypoint` -- literal tile carrying the closed `Point` struct constant
 *   `{x: 3.5, y: -4.25}`.
 *
 * Nothing here reads a clock, a random stream, or any state outside the
 * {@link ConformanceWorld} attached to the runtime, the think ordinal on the
 * execution context, and the per-callsite host state of `counter`.
 */
export function conformanceModule(): WendooModule {
  return {
    id: CONFORMANCE_MODULE_ID,
    install(api: WendooModuleApi): void {
      api.defineType({
        coreType: NativeType.Struct,
        typeId: CONFORMANCE_POINT_TYPE_ID,
        name: POINT_TYPE_NAME,
        atomId: ConformanceTypeAtomIds.Point,
        fields: List.from([
          { name: "x", typeId: CoreTypeIds.Number, fieldIndex: ConformancePointField.X },
          { name: "y", typeId: CoreTypeIds.Number, fieldIndex: ConformancePointField.Y },
        ]),
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: CONFORMANCE_ANCHOR_TYPE_ID,
        name: ANCHOR_TYPE_NAME,
        atomId: ConformanceTypeAtomIds.Anchor,
        fields: List.from([
          { name: "x", typeId: CoreTypeIds.Number, fieldIndex: ConformanceAnchorField.X },
          { name: "y", typeId: CoreTypeIds.Number, fieldIndex: ConformanceAnchorField.Y },
        ]),
        fieldGetter: anchorFieldGetter,
        fieldSetter: anchorFieldSetter,
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: CONFORMANCE_TARGET_TYPE_ID,
        name: TARGET_TYPE_NAME,
        atomId: ConformanceTypeAtomIds.Target,
        fields: List.from([
          { name: "value", typeId: CoreTypeIds.Number, readOnly: true, fieldIndex: ConformanceTargetField.Value },
        ]),
        fieldGetter: targetFieldGetter,
        snapshotNative: targetSnapshotNative,
        accessors: true,
      });
      // The dynamic owner makes `Mode` a program-local type: it compiles as a
      // type-table entry carrying its symbols, not as a type-atom reference.
      api.brainServices.runtime.types.withOwner("dynamic", () => {
        api.defineType({
          coreType: NativeType.Enum,
          typeId: CONFORMANCE_MODE_TYPE_ID,
          name: MODE_TYPE_NAME,
          symbols: List.from(CONFORMANCE_MODE_SYMBOL_KEYS.map((key) => ({ key, label: key, value: key }))),
          defaultKey: CONFORMANCE_MODE_SYMBOL_KEYS[0],
        });
      });
      api.registerTile(
        new BrainTileLiteralDef(
          CONFORMANCE_MODE_TYPE_ID,
          { t: NativeType.Enum, typeId: CONFORMANCE_MODE_TYPE_ID, v: CONFORMANCE_MODE_LITERAL_KEY } as Value,
          {
            valueLabel: CONFORMANCE_MODE_LITERAL_KEY,
            persist: false,
            metadata: { label: CONFORMANCE_MODE_LITERAL_KEY },
          },
          api.brainServices
        )
      );
      const pointTypeDef = api.brainServices.runtime.types.get(CONFORMANCE_POINT_TYPE_ID) as StructTypeDef;
      api.registerTile(
        new BrainTileLiteralDef(
          CONFORMANCE_POINT_TYPE_ID,
          mkClosedStructValueByName(
            pointTypeDef,
            new Dict([
              ["x", mkNumberValue(CONFORMANCE_POINT_CONSTANT.x)],
              ["y", mkNumberValue(CONFORMANCE_POINT_CONSTANT.y)],
            ])
          ),
          {
            valueLabel: CONFORMANCE_POINT_LITERAL_LABEL,
            persist: false,
            metadata: { label: CONFORMANCE_POINT_LITERAL_LABEL },
          },
          api.brainServices
        )
      );
      api.registerParameters([
        { id: ConformanceParameterId.Ticks, dataType: CoreTypeIds.Number, label: "ticks" },
        { id: ConformanceParameterId.Period, dataType: CoreTypeIds.Number, label: "period" },
        { id: ConformanceParameterId.Value, dataType: CoreTypeIds.Any, label: "value" },
      ]);
      api.registerHostSensor(createHostSensor(echoSensor));
      api.registerHostActuator(createHostActuator(emitActuator));
      api.registerHostActuator(createHostActuator(deferEchoActuator));
      api.registerHostActuator(createHostActuator(deferFailActuator));
      api.registerHostActuator(createHostActuator(faultActuator));
      api.registerHostSensor(createHostSensor(signalSensor));
      api.registerHostSensor(createHostSensor(counterSensor));
      api.registerHostActuator(createHostActuator(deferCancelActuator));
      api.registerHostSensor(createHostSensor(deferReadSensor));
      api.registerHostActuator(createHostActuator(emitTextActuator));
      api.registerHostActuator(createHostActuator(emitFlagActuator));
      api.registerHostSensor(createHostSensor(deferPointSensor));
      api.registerHostSensor(createHostSensor(deferAnchorSensor));
      api.registerHostSensor(createHostSensor(deferTargetSensor));
      api.registerHostActuator(createHostActuator(emitAllActuator));
      api.registerOperator({
        spec: {
          id: ConformanceOperators.DeferAdd.opId,
          parse: { fixity: "infix", precedence: DEFER_ADD_PRECEDENCE, assoc: "left" },
        },
        overloads: [
          {
            argTypes: [CoreTypeIds.Number, CoreTypeIds.Number],
            resultType: CoreTypeIds.Number,
            fnId: ConformanceOperators.DeferAdd.fnId,
            fn: { exec: execDeferAdd },
            isAsync: true,
          },
        ],
      });
      api.registerTile(
        new BrainTileOperatorDef(
          ConformanceOperators.DeferAdd.opId,
          { placement: TilePlacement.EitherSide, metadata: { label: "defer plus" } },
          api.brainServices
        )
      );
    },
  };
}
