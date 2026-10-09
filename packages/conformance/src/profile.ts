import type {
  AsyncHandle,
  CreateHostActuatorOptions,
  CreateHostSensorOptions,
  ExecutionContext,
  IRngServices,
  ReadonlyList,
  Value,
  WendooModule,
  WendooModuleApi,
} from "@wendoo/core/app";
import {
  BitSet,
  BrainTileLiteralDef,
  bag,
  buildDescriptorOutputTiles,
  CoreCapabilityBits,
  CoreParameterId,
  CoreTypeIds,
  createHostActuator,
  createHostSensor,
  Dict,
  getCallSiteState,
  getSlotId,
  isNumberValue,
  isStructValue,
  List,
  mkCallDef,
  mkClosedStructValue,
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
  setSensorOutput,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  TilePlacement,
  TRUE_VALUE,
  TypeUtils,
  VOID_VALUE,
} from "@wendoo/core/app";
import { BrainTileOperatorDef } from "@wendoo/core/brain/tiles";
import {
  CoreOpId,
  ErrorCode,
  FALSE_VALUE,
  mkBooleanValue,
  safeNumBinary,
  TARGET_TYPE_ATOM_BASE,
} from "@wendoo/core/runtime";

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

/** Type name of the profile's existence-hooked native struct type. */
const MARKER_TYPE_NAME = "Marker";

/** TypeId of the conformance `Marker` native-backed struct type. */
export const CONFORMANCE_MARKER_TYPE_ID = mkTypeId(NativeType.Struct, MARKER_TYPE_NAME);

/** Type name of the profile's program-local container struct type. */
const RIG_TYPE_NAME = "Rig";

/** TypeId of the conformance `Rig` struct type. */
export const CONFORMANCE_RIG_TYPE_ID = mkTypeId(NativeType.Struct, RIG_TYPE_NAME);

/** Type name of the profile's storage-backed struct type whose writable field routes through its field setter. */
const GAUGE_TYPE_NAME = "Gauge";

/** TypeId of the conformance `Gauge` struct type. */
export const CONFORMANCE_GAUGE_TYPE_ID = mkTypeId(NativeType.Struct, GAUGE_TYPE_NAME);

/** Type name of the profile's program-local struct type declaring a starting value. */
const SPOT_TYPE_NAME = "Spot";

/** TypeId of the conformance `Spot` struct type. */
export const CONFORMANCE_SPOT_TYPE_ID = mkTypeId(NativeType.Struct, SPOT_TYPE_NAME);

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

/** Value label (and tile-id basis) of the `bare rig` Rig literal tile, whose `anchor` field holds nil. */
export const CONFORMANCE_RIG_LITERAL_LABEL = "bare rig";

/** Value label (and tile-id basis) of the `gauge one` Gauge literal tile, naming the gauge of index 1. */
export const CONFORMANCE_GAUGE_LITERAL_LABEL = "gauge one";

/**
 * Field values of the `Spot` type's starting value, which every `Spot`
 * variable holds a fresh copy of until a rule writes it. Both are exactly
 * representable at f32.
 */
export const CONFORMANCE_SPOT_ZERO = { x: 0, y: -2.5 } as const;

/**
 * Value label (and tile-id basis) of the `home` Spot literal tile, holding
 * the same field values as the type's starting value.
 */
export const CONFORMANCE_SPOT_LITERAL_LABEL = "home";

/** Index the `gauge one` literal names; exactly representable at f32. */
export const CONFORMANCE_GAUGE_ONE_INDEX = 1;

/** Level every gauge of a world holds until a write sets it; exactly representable at f32. */
export const CONFORMANCE_GAUGE_START_LEVEL = 0;

/**
 * Stable type-atom ids of the conformance profile's nominal types, dense from
 * core's `TARGET_TYPE_ATOM_BASE`. Serialized programs record these verbatim:
 * append new records at the next free id and never renumber or reuse one.
 */
export const ConformanceTypeAtomIds = {
  Point: TARGET_TYPE_ATOM_BASE,
  Anchor: TARGET_TYPE_ATOM_BASE + 1,
  Target: TARGET_TYPE_ATOM_BASE + 2,
  Marker: TARGET_TYPE_ATOM_BASE + 3,
  Gauge: TARGET_TYPE_ATOM_BASE + 4,
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
  At: 2,
} as const;

/** Field ids of the `Target` native struct type. Wire-stable; never renumber. */
export const ConformanceTargetField = {
  Value: 0,
} as const;

/** Field ids of the `Marker` native struct type. Wire-stable; never renumber. */
export const ConformanceMarkerField = {
  X: 0,
} as const;

/** Field ids (also storage slots) of the program-local `Rig` struct. Wire-stable; never renumber. */
export const ConformanceRigField = {
  Anchor: 0,
} as const;

/** Field ids (also storage slots) of the program-local `Spot` struct. Wire-stable; never renumber. */
export const ConformanceSpotField = {
  X: 0,
  Y: 1,
} as const;

/** Field ids (also storage slots) of the `Gauge` struct. Wire-stable; never renumber. */
export const ConformanceGaugeField = {
  Index: 0,
  Level: 1,
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

/**
 * The numbers a conformance run's random stream yields, in order, starting
 * over from the first once the last has been drawn. Every draw lies in
 * `[0, 1)` and is exactly representable at f32, so it reads as the same
 * number at either precision.
 */
export const CONFORMANCE_RANDOM_DRAWS = [0.25, 0.875, 0, 0.5, 0.0625] as const;

/**
 * Names of the two `Point` outputs `point outputs` declares: `open`, declared
 * `writableResult`, and `sealed`, not. Each name, with the `Point` type,
 * forms the output's identity.
 */
export const ConformancePointOutputName = {
  Open: "open",
  Sealed: "sealed",
} as const;

/**
 * Field values of the fresh `Point` structs `point outputs` writes to its
 * outputs on every run. Every value is exactly representable at f32, and
 * distinct from every other reading the profile produces.
 */
export const CONFORMANCE_POINT_OUTPUTS_READING = {
  open: { x: 5.5, y: -1.5 },
  sealed: { x: 6.25, y: 0.75 },
} as const;

/**
 * The random stream every random read of a conformance run draws from: the
 * {@link CONFORMANCE_RANDOM_DRAWS} in order, cycling. A fresh instance starts
 * at the first draw, so give each run its own.
 */
export class ConformanceRandomStream implements IRngServices {
  private nextIndex = 0;

  /** Returns the next declared draw and advances the stream, wrapping after the last. */
  next(): number {
    const draw = CONFORMANCE_RANDOM_DRAWS[this.nextIndex];
    this.nextIndex = (this.nextIndex + 1) % CONFORMANCE_RANDOM_DRAWS.length;
    return draw;
  }
}

/** The mutable host object behind every `Anchor` value of one world. */
export interface ConformanceAnchorObject {
  x: number;
  y: number;
  /** True once the world has destroyed the object; a destroyed anchor designates nothing. */
  destroyed: boolean;
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
  DestroyAnchor: "actuator.conformance.destroy-anchor",
  NotANumber: "sensor.conformance.not-a-number",
  PointOutputs: "sensor.conformance.point-outputs",
  Marker: "sensor.conformance.marker",
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
  DestroyAnchor: {
    key: ConformanceActionKeys.DestroyAnchor,
    actionId: TARGET_ACTION_ID_BASE + 15,
    fnId: TARGET_FUNC_ID_BASE + 16,
  },
  NotANumber: {
    key: ConformanceActionKeys.NotANumber,
    actionId: TARGET_ACTION_ID_BASE + 16,
    fnId: TARGET_FUNC_ID_BASE + 18,
  },
  PointOutputs: {
    key: ConformanceActionKeys.PointOutputs,
    actionId: TARGET_ACTION_ID_BASE + 17,
    fnId: TARGET_FUNC_ID_BASE + 19,
  },
  Marker: {
    key: ConformanceActionKeys.Marker,
    actionId: TARGET_ACTION_ID_BASE + 18,
    fnId: TARGET_FUNC_ID_BASE + 21,
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
  PointAdd: { opId: "conformance.point-add", fnId: TARGET_FUNC_ID_BASE + 17 },
} as const;

/**
 * Overloads the conformance host profile adds to core operators, each with the
 * id of the core operator it extends and the stable funcId of its host
 * function. The funcIds continue the target partition offsets
 * {@link ConformanceHostActions} and {@link ConformanceOperators} use, and
 * serialized programs record them verbatim: append new records at the next
 * free offset and never renumber or reuse one.
 */
export const ConformanceOperatorOverloads = {
  PointEqual: { opId: CoreOpId.EqualTo, fnId: TARGET_FUNC_ID_BASE + 20 },
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
const destroyAnchorCallDef = mkCallDef(bag());
const notANumberCallDef = mkCallDef(bag());
const pointOutputsCallDef = mkCallDef(bag());
const markerCallDef = mkCallDef(bag());

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

/** Binding strength `point plus` parses at. */
const POINT_ADD_PRECEDENCE = 120;

/** Arg-buffer slot of the left operand of a binary operator overload. */
const kOperatorLhsSlotId = 0;

/** Arg-buffer slot of the right operand of a binary operator overload. */
const kOperatorRhsSlotId = 1;

/** One deferred settlement the world owes, held until its due tick. */
interface PendingSettlement {
  /** Tick ordinal at which the settlement is due. */
  readonly dueTick: number;
  /** Settles the handle the deferred call was dispatched on. */
  settle(): void;
}

/**
 * Deterministic world the conformance host actions run against: the pending
 * deferred settlements, the anchor host object, the call-counting target
 * resolution, and the gauge levels. It owns no clock and no random stream, so
 * two runs of one program over one schedule observe the same world.
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
    destroyed: false,
  };

  private readonly firstTarget: ConformanceTargetObject = { value: CONFORMANCE_TARGET_READING.first };

  private readonly laterTarget: ConformanceTargetObject = { value: CONFORMANCE_TARGET_READING.second };

  private targetResolutions = 0;

  private readonly gaugeLevels = new Map<number, number>();

  /** The world's one `Anchor` host object; every `defer anchor` reading is backed by it. */
  anchor(): ConformanceAnchorObject {
    return this.anchorObject;
  }

  /**
   * Destroy the world's one anchor host object. Every `Anchor` value already
   * handed out keeps fronting it, and every field hook of the type then
   * designates nothing; every `Marker` value over it reads as gone to its
   * type's existence hook. Destroying an already destroyed anchor changes
   * nothing.
   */
  destroyAnchor(): void {
    this.anchorObject.destroyed = true;
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
   * The level of the gauge of index `index`: the last level written to it,
   * or {@link CONFORMANCE_GAUGE_START_LEVEL} before any write.
   */
  gaugeLevel(index: number): number {
    return this.gaugeLevels.get(index) ?? CONFORMANCE_GAUGE_START_LEVEL;
  }

  /** Set the level of the gauge of index `index`. */
  setGaugeLevel(index: number, level: number): void {
    this.gaugeLevels.set(index, level);
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

/** A fresh `Spot` struct value holding the type's starting field values. */
function mkSpotZero(): Value {
  return mkClosedStructValue(
    CONFORMANCE_SPOT_TYPE_ID,
    List.from<Value>([mkNumberValue(CONFORMANCE_SPOT_ZERO.x), mkNumberValue(CONFORMANCE_SPOT_ZERO.y)])
  );
}

/**
 * Builds one closed `Point` struct value carrying `x` and `y`, in the
 * environment `ctx` executes in. Throws when that environment has not
 * registered the `Point` type.
 */
function mkPointValue(ctx: ExecutionContext, x: number, y: number): Value {
  const typeDef = ctx.services.runtime.types.get(CONFORMANCE_POINT_TYPE_ID) as StructTypeDef | undefined;
  if (!typeDef) {
    throw new Error("conformance Point type is not registered");
  }
  return mkClosedStructValueByName(
    typeDef,
    new Dict([
      ["x", mkNumberValue(x)],
      ["y", mkNumberValue(y)],
    ])
  );
}

/**
 * Builds one `Point` struct reading in the environment `ctx` executes in.
 * Throws when that environment has not registered the `Point` type.
 */
function mkPointReading(ctx: ExecutionContext): Value {
  return mkPointValue(ctx, CONFORMANCE_POINT_READING.x, CONFORMANCE_POINT_READING.y);
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
 * The host object an `Anchor` value designates: the object behind `source`,
 * or nothing when the value carries none or the world destroyed the object.
 */
function resolveAnchorObject(source: StructValue): ConformanceAnchorObject | undefined {
  const anchor = source.native as ConformanceAnchorObject | undefined;
  if (!anchor || anchor.destroyed) {
    return undefined;
  }
  return anchor;
}

/**
 * Field getter of the `Anchor` type: reads the field off the host object
 * `source` designates, `at` as a fresh `Point` snapshot of the object's `x`
 * and `y`. A value designating no host object, and a field id the type does
 * not declare, both read as absent.
 */
function anchorFieldGetter(source: StructValue, fieldId: number, ctx: ExecutionContext): Value | undefined {
  const anchor = resolveAnchorObject(source);
  if (!anchor) {
    return undefined;
  }
  if (fieldId === ConformanceAnchorField.X) {
    return mkNumberValue(anchor.x);
  }
  if (fieldId === ConformanceAnchorField.Y) {
    return mkNumberValue(anchor.y);
  }
  if (fieldId === ConformanceAnchorField.At) {
    return mkPointValue(ctx, anchor.x, anchor.y);
  }
  return undefined;
}

/**
 * Field setter of the `Anchor` type: writes the field of the host object
 * `source` designates, `at` by taking both fields of a `Point`. Rejects a
 * value designating no host object, a value of the wrong kind for the field,
 * and a field id the type does not declare.
 */
function anchorFieldSetter(source: StructValue, fieldId: number, value: Value, _ctx: ExecutionContext): boolean {
  const anchor = resolveAnchorObject(source);
  if (!anchor) {
    return false;
  }
  if (fieldId === ConformanceAnchorField.At) {
    const x = pointFieldNumber(value, ConformancePointField.X);
    const y = pointFieldNumber(value, ConformancePointField.Y);
    if (x === undefined || y === undefined) {
      return false;
    }
    anchor.x = x;
    anchor.y = y;
    return true;
  }
  if (!isNumberValue(value)) {
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

/** The index a `Gauge` value names, or undefined when its `index` field holds no number. */
function gaugeIndexOf(source: StructValue): number | undefined {
  const index = source.v?.at(ConformanceGaugeField.Index);
  return index !== undefined && isNumberValue(index) ? index.v : undefined;
}

/**
 * Field getter of the `Gauge` type: `index` reads the value's own storage,
 * and `level` reads the world's level of the gauge the value names. A value
 * naming no gauge, a run with no world, and a field id the type does not
 * declare all read as absent.
 */
function gaugeFieldGetter(source: StructValue, fieldId: number, ctx: ExecutionContext): Value | undefined {
  if (fieldId === ConformanceGaugeField.Index) {
    return source.v?.at(ConformanceGaugeField.Index);
  }
  const index = gaugeIndexOf(source);
  const world = worldOf(ctx);
  if (fieldId !== ConformanceGaugeField.Level || index === undefined || !world) {
    return undefined;
  }
  return mkNumberValue(world.gaugeLevel(index));
}

/**
 * Field setter of the `Gauge` type: a number written to `level` sets the
 * world's level of the gauge the value names, leaving the value's own storage
 * untouched. Rejects every other field, a non-number value, a value naming no
 * gauge, and a run with no world.
 */
function gaugeFieldSetter(source: StructValue, fieldId: number, value: Value, ctx: ExecutionContext): boolean {
  const index = gaugeIndexOf(source);
  const world = worldOf(ctx);
  if (fieldId !== ConformanceGaugeField.Level || index === undefined || !world || !isNumberValue(value)) {
    return false;
  }
  world.setGaugeLevel(index, value.v);
  return true;
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

/**
 * Field getter of the `Marker` type: reads the field off the anchor host
 * object behind `source` whether or not the world destroyed it, so only the
 * type's existence hook reports the destruction. A value carrying no host
 * object, and a field id the type does not declare, both read as absent.
 */
function markerFieldGetter(source: StructValue, fieldId: number, _ctx: ExecutionContext): Value | undefined {
  const anchor = source.native as ConformanceAnchorObject | undefined;
  if (!anchor || fieldId !== ConformanceMarkerField.X) {
    return undefined;
  }
  return mkNumberValue(anchor.x);
}

/** Existence hook of the `Marker` type: whether `source` carries an anchor host object the world has not destroyed. */
function markerExists(source: StructValue, _ctx: ExecutionContext): boolean {
  return resolveAnchorObject(source) !== undefined;
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

function execDestroyAnchor(ctx: ExecutionContext): Value {
  worldOf(ctx)?.destroyAnchor();
  return VOID_VALUE;
}

function execMarker(ctx: ExecutionContext): Value {
  return mkNativeStructValue(CONFORMANCE_MARKER_TYPE_ID, worldOf(ctx)?.anchor());
}

function execNotANumber(): Value {
  return mkNumberValue(Number.NaN);
}

function execPointOutputs(ctx: ExecutionContext): Value {
  const { open, sealed } = CONFORMANCE_POINT_OUTPUTS_READING;
  setSensorOutput(ctx, CONFORMANCE_POINT_TYPE_ID, ConformancePointOutputName.Open, mkPointValue(ctx, open.x, open.y));
  setSensorOutput(
    ctx,
    CONFORMANCE_POINT_TYPE_ID,
    ConformancePointOutputName.Sealed,
    mkPointValue(ctx, sealed.x, sealed.y)
  );
  return TRUE_VALUE;
}

/** The number in field `fieldId` of a closed `Point` operand, or undefined when it carries none. */
function pointFieldNumber(operand: Value | undefined, fieldId: number): number | undefined {
  if (!isStructValue(operand)) {
    return undefined;
  }
  const field = operand.v?.at(fieldId);
  return field !== undefined && isNumberValue(field) ? field.v : undefined;
}

function execPointAdd(ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  const lhs = args.get(kOperatorLhsSlotId);
  const rhs = args.get(kOperatorRhsSlotId);
  const lhsX = pointFieldNumber(lhs, ConformancePointField.X);
  const lhsY = pointFieldNumber(lhs, ConformancePointField.Y);
  const rhsX = pointFieldNumber(rhs, ConformancePointField.X);
  const rhsY = pointFieldNumber(rhs, ConformancePointField.Y);
  if (lhsX === undefined || lhsY === undefined || rhsX === undefined || rhsY === undefined) {
    return NIL_VALUE;
  }
  const numerics = ctx.services.app.numerics;
  return mkPointValue(ctx, numerics.round(lhsX + rhsX), numerics.round(lhsY + rhsY));
}

function execPointEqual(_ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  const lhs = args.get(kOperatorLhsSlotId);
  const rhs = args.get(kOperatorRhsSlotId);
  const lhsX = pointFieldNumber(lhs, ConformancePointField.X);
  const lhsY = pointFieldNumber(lhs, ConformancePointField.Y);
  const rhsX = pointFieldNumber(rhs, ConformancePointField.X);
  const rhsY = pointFieldNumber(rhs, ConformancePointField.Y);
  if (lhsX === undefined || lhsY === undefined || rhsX === undefined || rhsY === undefined) {
    return FALSE_VALUE;
  }
  return mkBooleanValue(lhsX === rhsX && lhsY === rhsY);
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

const destroyAnchorActuator = {
  key: ConformanceHostActions.DestroyAnchor.key,
  actionId: ConformanceHostActions.DestroyAnchor.actionId,
  fnId: ConformanceHostActions.DestroyAnchor.fnId,
  callDef: destroyAnchorCallDef,
  fn: { exec: execDestroyAnchor },
  isAsync: false,
  metadata: { label: "destroy anchor" },
} satisfies CreateHostActuatorOptions;

const notANumberSensor = {
  key: ConformanceHostActions.NotANumber.key,
  actionId: ConformanceHostActions.NotANumber.actionId,
  fnId: ConformanceHostActions.NotANumber.fnId,
  callDef: notANumberCallDef,
  fn: { exec: execNotANumber },
  isAsync: false,
  outputType: CoreTypeIds.Number,
  inline: true,
  metadata: { label: "not a number" },
} satisfies CreateHostSensorOptions;

const pointOutputsSensor = {
  key: ConformanceHostActions.PointOutputs.key,
  actionId: ConformanceHostActions.PointOutputs.actionId,
  fnId: ConformanceHostActions.PointOutputs.fnId,
  callDef: pointOutputsCallDef,
  fn: { exec: execPointOutputs },
  isAsync: false,
  outputType: CoreTypeIds.Boolean,
  outputs: [
    { name: ConformancePointOutputName.Open, type: CONFORMANCE_POINT_TYPE_ID, writableResult: true },
    { name: ConformancePointOutputName.Sealed, type: CONFORMANCE_POINT_TYPE_ID },
  ],
  metadata: { label: "point outputs" },
} satisfies CreateHostSensorOptions;

const markerSensor = {
  key: ConformanceHostActions.Marker.key,
  actionId: ConformanceHostActions.Marker.actionId,
  fnId: ConformanceHostActions.Marker.fnId,
  callDef: markerCallDef,
  fn: { exec: execMarker },
  isAsync: false,
  outputType: CONFORMANCE_MARKER_TYPE_ID,
  inline: true,
  metadata: { label: "marker" },
} satisfies CreateHostSensorOptions;

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
 * - `lhs point plus rhs` -- synchronous infix operator over two `Point`
 *   operands, evaluating to a fresh closed `Point` carrying the fieldwise sums
 *   at the profile's precision. An operand carrying no `Point` reading
 *   evaluates nil.
 * - `lhs == rhs` over two `Point` operands -- a synchronous overload the
 *   profile adds to the core `eq` operator, which keeps its own tile, so no
 *   tile of the profile's own stands for it. True exactly when both operands
 *   carry `Point` readings whose `x` fields are equal numbers and whose `y`
 *   fields are equal numbers; an operand carrying no `Point` reading, nil
 *   included, compares false.
 * - `defer point()` -- asynchronous inline sensor whose handle resolves to a
 *   fresh `Point` struct reading `{x: 1.5, y: 2.25}` exactly one tick after
 *   its dispatch. The struct is constructed at settle time, immediately
 *   before the handle resolves. `Point` is the profile's closed struct type
 *   (atom id 1024, fields `x` and `y`, accessor tiles registered).
 * - `defer anchor()` -- asynchronous inline sensor whose handle resolves to a
 *   fresh `Anchor` value exactly one tick after its dispatch, constructed at
 *   settle time over the world's one anchor host object. `Anchor` (atom id
 *   1025, fields `x`, `y` and `at`) is native-backed: its registered field
 *   getter and setter read and write the host object behind the value, and a
 *   deep copy shares that object by reference, so every copy aliases one
 *   anchor. `at` reads a fresh `Point` snapshot of the object's `x` and `y`,
 *   and a `Point` written to it sets both, so a field write through the
 *   snapshot reaches the object only by being written back.
 * - `destroy anchor()` -- synchronous actuator returning void, destroying the
 *   world's one anchor host object. Every `Anchor` value handed out before the
 *   call keeps fronting that object, and from then on the type's field hooks
 *   designate nothing: reads return absent, which the VM renders nil, and
 *   writes are rejected. Every `Marker` value over the object is falsy from
 *   then on.
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
 * - `not a number()` -- synchronous inline sensor returning the number
 *   not-a-number (NaN).
 * - `point outputs()` -- synchronous sensor returning `true`, which on every
 *   run first writes two fresh `Point` structs to its two declared `Point`
 *   outputs: `{x: 5.5, y: -1.5}` to `open`, declared `writableResult`, so a
 *   brain may write a field through its tile, and `{x: 6.25, y: 0.75}` to
 *   `sealed`, whose value is read-only. Each output's tile reads the struct in
 *   the sensor's rule and the rules below it.
 * - `marker()` -- synchronous inline sensor returning a fresh `Marker` value
 *   over the world's one anchor host object. `Marker` (atom id 1027, field
 *   `x`, read-only) is a second native-backed view of that object, and the
 *   profile's one type declaring an existence hook: the hook reports whether
 *   the world has destroyed the object, so after `destroy anchor` every
 *   `Marker` value is falsy. Its field getter reads `x` off the object whether
 *   or not it was destroyed, so a nil read of a `Marker` field can only come
 *   from the hook.
 * - `seek` -- literal tile carrying the `Mode` enum constant `seek`. `Mode`
 *   is the profile's program-local enum type (symbols `idle`, `seek`, `flee`,
 *   each valued by its own key), registered under the dynamic owner so its
 *   symbols embed in each program's type table instead of referencing a type
 *   atom.
 * - `waypoint` -- literal tile carrying the closed `Point` struct constant
 *   `{x: 3.5, y: -4.25}`.
 * - `bare rig` -- literal tile carrying a `Rig` struct constant whose
 *   `anchor` field holds nil. `Rig` (field `anchor`, an `Anchor`) is the
 *   profile's program-local plain container struct type, registered under the
 *   dynamic owner like `Mode`.
 * - `home` -- literal tile carrying a `Spot` struct constant `{x: 0, y:
 *   -2.5}`. `Spot` (fields `x` and `y`, accessor tiles registered) is the
 *   profile's program-local struct type declaring a starting value, the same
 *   `{x: 0, y: -2.5}`, so every `Spot` variable holds a fresh copy of it from
 *   program load; registered under the dynamic owner like `Mode`.
 * - `gauge one` -- literal tile carrying a `Gauge` struct constant whose
 *   `index` field holds 1. `Gauge` (atom id 1028, fields `index`, read-only,
 *   and `level`) keeps `index` in the value's own storage, and its field
 *   getter and setter route `level` to the world's level of the gauge the
 *   value names, every gauge starting at 0, so a write to `level` changes
 *   world state and never the value's storage.
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
          { name: "at", typeId: CONFORMANCE_POINT_TYPE_ID, fieldIndex: ConformanceAnchorField.At },
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
      api.defineType({
        coreType: NativeType.Struct,
        typeId: CONFORMANCE_MARKER_TYPE_ID,
        name: MARKER_TYPE_NAME,
        atomId: ConformanceTypeAtomIds.Marker,
        fields: List.from([
          { name: "x", typeId: CoreTypeIds.Number, readOnly: true, fieldIndex: ConformanceMarkerField.X },
        ]),
        fieldGetter: markerFieldGetter,
        exists: markerExists,
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: CONFORMANCE_GAUGE_TYPE_ID,
        name: GAUGE_TYPE_NAME,
        atomId: ConformanceTypeAtomIds.Gauge,
        fields: List.from([
          { name: "index", typeId: CoreTypeIds.Number, readOnly: true, fieldIndex: ConformanceGaugeField.Index },
          { name: "level", typeId: CoreTypeIds.Number, fieldIndex: ConformanceGaugeField.Level },
        ]),
        fieldGetter: gaugeFieldGetter,
        fieldSetter: gaugeFieldSetter,
        accessors: true,
      });
      // The dynamic owner makes `Mode`, `Rig` and `Spot` program-local types:
      // each compiles as a type-table entry carrying its symbols or fields.
      api.brainServices.runtime.types.withOwner("dynamic", () => {
        api.defineType({
          coreType: NativeType.Struct,
          typeId: CONFORMANCE_SPOT_TYPE_ID,
          name: SPOT_TYPE_NAME,
          fields: List.from([
            { name: "x", typeId: CoreTypeIds.Number, fieldIndex: ConformanceSpotField.X },
            { name: "y", typeId: CoreTypeIds.Number, fieldIndex: ConformanceSpotField.Y },
          ]),
          accessors: true,
          zero: mkSpotZero(),
        });
        api.defineType({
          coreType: NativeType.Struct,
          typeId: CONFORMANCE_RIG_TYPE_ID,
          name: RIG_TYPE_NAME,
          fields: List.from([
            { name: "anchor", typeId: CONFORMANCE_ANCHOR_TYPE_ID, fieldIndex: ConformanceRigField.Anchor },
          ]),
          accessors: true,
        });
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
      const rigTypeDef = api.brainServices.runtime.types.get(CONFORMANCE_RIG_TYPE_ID) as StructTypeDef;
      api.registerTile(
        new BrainTileLiteralDef(
          CONFORMANCE_RIG_TYPE_ID,
          mkClosedStructValueByName(rigTypeDef, new Dict([["anchor", NIL_VALUE]])),
          {
            valueLabel: CONFORMANCE_RIG_LITERAL_LABEL,
            persist: false,
            metadata: { label: CONFORMANCE_RIG_LITERAL_LABEL },
          },
          api.brainServices
        )
      );
      api.registerTile(
        new BrainTileLiteralDef(
          CONFORMANCE_SPOT_TYPE_ID,
          mkSpotZero(),
          {
            valueLabel: CONFORMANCE_SPOT_LITERAL_LABEL,
            persist: false,
            metadata: { label: CONFORMANCE_SPOT_LITERAL_LABEL },
          },
          api.brainServices
        )
      );
      const gaugeTypeDef = api.brainServices.runtime.types.get(CONFORMANCE_GAUGE_TYPE_ID) as StructTypeDef;
      api.registerTile(
        new BrainTileLiteralDef(
          CONFORMANCE_GAUGE_TYPE_ID,
          mkClosedStructValueByName(gaugeTypeDef, new Dict([["index", mkNumberValue(CONFORMANCE_GAUGE_ONE_INDEX)]])),
          {
            valueLabel: CONFORMANCE_GAUGE_LITERAL_LABEL,
            persist: false,
            metadata: { label: CONFORMANCE_GAUGE_LITERAL_LABEL },
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
      api.registerHostActuator(createHostActuator(destroyAnchorActuator));
      api.registerHostSensor(createHostSensor(notANumberSensor));
      const pointOutputs = createHostSensor(pointOutputsSensor);
      api.registerHostSensor(pointOutputs);
      for (const outputTile of buildDescriptorOutputTiles(pointOutputs.descriptor.outputs ?? [])) {
        api.registerTile(outputTile);
      }
      api.registerHostSensor(createHostSensor(markerSensor));
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
      api.registerOperator({
        spec: {
          id: ConformanceOperators.PointAdd.opId,
          parse: { fixity: "infix", precedence: POINT_ADD_PRECEDENCE, assoc: "left" },
        },
        overloads: [
          {
            argTypes: [CONFORMANCE_POINT_TYPE_ID, CONFORMANCE_POINT_TYPE_ID],
            resultType: CONFORMANCE_POINT_TYPE_ID,
            fnId: ConformanceOperators.PointAdd.fnId,
            fn: { exec: execPointAdd },
            isAsync: false,
          },
        ],
      });
      api.registerTile(
        new BrainTileOperatorDef(
          ConformanceOperators.PointAdd.opId,
          { placement: TilePlacement.EitherSide, metadata: { label: "point plus" } },
          api.brainServices
        )
      );
      api.brainServices.edit.operatorOverloads.binary(
        ConformanceOperatorOverloads.PointEqual.opId,
        CONFORMANCE_POINT_TYPE_ID,
        CONFORMANCE_POINT_TYPE_ID,
        CoreTypeIds.Boolean,
        ConformanceOperatorOverloads.PointEqual.fnId,
        { exec: execPointEqual },
        false
      );
    },
  };
}
