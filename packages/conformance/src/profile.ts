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
  bag,
  CoreParameterId,
  CoreTypeIds,
  createHostActuator,
  createHostSensor,
  getSlotId,
  isNumberValue,
  mkCallDef,
  mkNumberValue,
  param,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  VOID_VALUE,
} from "@wendoo/core/app";
import { ErrorCode } from "@wendoo/core/runtime";

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

/** Parameter tile ids the conformance host actions address their named arguments by. */
export const ConformanceParameterId = {
  /** Number of whole ticks a deferred call settles after. */
  Ticks: "conformance.ticks",
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
} as const;

const AnonValue = param(CoreParameterId.AnonymousNumber, { name: "value", anonymous: true });
const Ticks = param(ConformanceParameterId.Ticks, { name: "ticks", default: mkNumberValue(1) });

const echoCallDef = mkCallDef(bag(AnonValue));
const emitCallDef = mkCallDef(bag(AnonValue));
const deferEchoCallDef = mkCallDef(bag(AnonValue, Ticks));
const deferFailCallDef = mkCallDef(bag(Ticks));
const faultCallDef = mkCallDef(bag());

const kEchoValueSlotId = getSlotId(echoCallDef, AnonValue);
const kDeferEchoValueSlotId = getSlotId(deferEchoCallDef, AnonValue);
const kDeferEchoTicksSlotId = getSlotId(deferEchoCallDef, Ticks);
const kDeferFailTicksSlotId = getSlotId(deferFailCallDef, Ticks);

/** Ticks a deferred call waits when its `ticks` argument is absent or not a number. */
const DEFAULT_DEFER_TICKS = 1;

/** Error code `deferFail` rejects its handle with. */
const DEFER_FAIL_CODE = ErrorCode.HostError;

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
function ticksArg(args: ReadonlyList<Value>, slotId: number): number {
  const value = args.get(slotId);
  if (value === undefined || !isNumberValue(value)) {
    return DEFAULT_DEFER_TICKS;
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
  world.defer(ctx.currentTick, ticksArg(args, kDeferEchoTicksSlotId), () => {
    handle.resolve(value);
  });
}

function execDeferFail(ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const world = worldOf(ctx);
  if (!world) {
    handle.reject(DEFER_FAIL_CODE);
    return;
  }
  world.defer(ctx.currentTick, ticksArg(args, kDeferFailTicksSlotId), () => {
    handle.reject(DEFER_FAIL_CODE);
  });
}

function execFault(): Value {
  throw new Error("conformance fault");
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
 *
 * Nothing here reads a clock, a random stream, or any state outside the
 * {@link ConformanceWorld} attached to the runtime.
 */
export function conformanceModule(): WendooModule {
  return {
    id: CONFORMANCE_MODULE_ID,
    install(api: WendooModuleApi): void {
      api.registerParameters([{ id: ConformanceParameterId.Ticks, dataType: CoreTypeIds.Number, label: "ticks" }]);
      api.registerHostSensor(createHostSensor(echoSensor));
      api.registerHostActuator(createHostActuator(emitActuator));
      api.registerHostActuator(createHostActuator(deferEchoActuator));
      api.registerHostActuator(createHostActuator(deferFailActuator));
      api.registerHostActuator(createHostActuator(faultActuator));
    },
  };
}
