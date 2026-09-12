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
  bag,
  CoreCapabilityBits,
  CoreParameterId,
  CoreTypeIds,
  createHostActuator,
  createHostSensor,
  getCallSiteState,
  getSlotId,
  isNumberValue,
  mkCallDef,
  mkNumberValue,
  NIL_VALUE,
  param,
  setCallSiteState,
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
  /** Whole-tick interval between two deliveries of a value-bearing sensor. */
  Period: "conformance.period",
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
} as const;

const AnonValue = param(CoreParameterId.AnonymousNumber, { name: "value", anonymous: true });
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

const kEchoValueSlotId = getSlotId(echoCallDef, AnonValue);
const kDeferEchoValueSlotId = getSlotId(deferEchoCallDef, AnonValue);
const kDeferEchoTicksSlotId = getSlotId(deferEchoCallDef, Ticks);
const kDeferFailTicksSlotId = getSlotId(deferFailCallDef, Ticks);
const kSignalPeriodSlotId = getSlotId(signalCallDef, Period);
const kDeferCancelTicksSlotId = getSlotId(deferCancelCallDef, Ticks);

/** Whole-tick count a deferred call waits, or a signal's period, when the argument carries none. */
const DEFAULT_WHOLE_TICKS = 1;

/** Value `signal` delivers on a tick it is present: falsy, so only a presence gate fires on it. */
const SIGNAL_VALUE = mkNumberValue(0);

/** Error code `deferFail` rejects its handle with. */
const DEFER_FAIL_CODE = ErrorCode.HostError;

/** Count `counter` holds at a call site the activation hook has just reset; its first read returns one more. */
const COUNTER_START = 0;

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
 *
 * Nothing here reads a clock, a random stream, or any state outside the
 * {@link ConformanceWorld} attached to the runtime, the think ordinal on the
 * execution context, and the per-callsite host state of `counter`.
 */
export function conformanceModule(): WendooModule {
  return {
    id: CONFORMANCE_MODULE_ID,
    install(api: WendooModuleApi): void {
      api.registerParameters([
        { id: ConformanceParameterId.Ticks, dataType: CoreTypeIds.Number, label: "ticks" },
        { id: ConformanceParameterId.Period, dataType: CoreTypeIds.Number, label: "period" },
      ]);
      api.registerHostSensor(createHostSensor(echoSensor));
      api.registerHostActuator(createHostActuator(emitActuator));
      api.registerHostActuator(createHostActuator(deferEchoActuator));
      api.registerHostActuator(createHostActuator(deferFailActuator));
      api.registerHostActuator(createHostActuator(faultActuator));
      api.registerHostSensor(createHostSensor(signalSensor));
      api.registerHostSensor(createHostSensor(counterSensor));
      api.registerHostActuator(createHostActuator(deferCancelActuator));
    },
  };
}
