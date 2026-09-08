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
  BrainTileLiteralDef,
  bag,
  CoreParameterId,
  CoreTypeIds,
  createHostActuator,
  createHostSensor,
  FALSE_VALUE,
  getSlotId,
  isNilValue,
  mkCallDef,
  mkLiteralFactoryTileId,
  mkNumberValue,
  mod,
  optional,
  param,
  setSensorOutput,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  TRUE_VALUE,
  VOID_VALUE,
} from "@wendoo/core/app";
import { mintDocumentId } from "@wendoo/core/brain/model";
import { BrainTileFactoryDef } from "@wendoo/core/brain/tiles";
import type { HandleId } from "@wendoo/core/runtime";
import type { OperationEndingReport } from "../kit/index.js";
import { DispatchOutcome } from "../target/adapter.js";

/** Tile ids the fake target's arguments are addressed by. */
export const FakeTileIds = {
  /** Modifier making an emit loud. */
  Loudly: "modifier:fake.loudly",
  /** Parameter carrying how hard to emit. */
  Strength: "parameter:fake.strength",
  /** Modifier making a ring take the bell from whatever holds it. */
  Immediately: "modifier:fake.immediately",
  /** Modifier making a ring return at once, leaving the bell ringing behind it. */
  InBackground: "modifier:fake.in-background",
} as const;

/** Action keys the fake target's brains dispatch. */
export const FakeActionKeys = {
  Signal: "sensor.fake.signal",
  Emit: "actuator.fake.emit",
  /** The asynchronous actuator that settles at dispatch. */
  Chime: "actuator.fake.chime",
  /** The asynchronous actuator that leases the world's one bell. */
  Ring: "actuator.fake.ring",
} as const;

/** Name of the output the fake target's emit reports back. */
export const FAKE_EMIT_OUTPUT = "emitted";

/** The `actuator.fake.ring` call holding the world's one bell while it rings. */
export interface FakeBell {
  /** Handle the ringing call was dispatched on. */
  readonly handleId: HandleId;
  /** `true` when the ringer did not park on the bell and its handle is already settled. */
  readonly inBackground: boolean;
  /** Settle the ringing call's handle, releasing whatever rule is parked on it. */
  settle(): void;
}

/** The world state the fake target's actions read and write. */
export interface FakeWorldState {
  /** What `sensor.fake.signal` reports on the current think. */
  signal: boolean;
  /** Whether the next `actuator.fake.emit` call reports that it emitted. */
  emits?: boolean;
  /** The ring holding the bell, absent while the bell is free. */
  bell?: FakeBell;
  /** Operation endings the world has yet to publish, in the order they happened. */
  endings?: OperationEndingReport[];
}

const Loudly = mod(FakeTileIds.Loudly);
const Immediately = mod(FakeTileIds.Immediately);
const InBackground = mod(FakeTileIds.InBackground);
/** Strength an emit carrying no strength emits at. */
const DEFAULT_STRENGTH = 1;

/** Weakest and strongest strength an emit emits at. */
const MIN_STRENGTH = 0;
const MAX_STRENGTH = 1;

/** Highest count a chime takes. */
const MAX_CHIMES = 4;

/** A unit longer than the catalog's cap, for the rendering that cuts it. */
export const FAKE_LONG_UNIT = "fraction-of-full-power";

const Strength = param(FakeTileIds.Strength, {
  unit: FAKE_LONG_UNIT,
  default: mkNumberValue(DEFAULT_STRENGTH),
  range: { min: MIN_STRENGTH, max: MAX_STRENGTH, onExceed: "clamp" },
});
const AnonNumber = param(CoreParameterId.AnonymousNumber, {
  anonymous: true,
  name: "count",
  derived: true,
  range: { min: 0, max: MAX_CHIMES, onExceed: "drop" },
});

const signalCallDef = mkCallDef(bag());
const emitCallDef = mkCallDef(bag(optional(Loudly), optional(Strength)));
const chimeCallDef = mkCallDef(bag(optional(AnonNumber)));
/** A slot the grammar reads out under the `value` fallback, declaring no name. */
const UnnamedAmount = param(CoreParameterId.AnonymousNumber, { anonymous: true });

const ringCallDef = mkCallDef(bag(optional(UnnamedAmount), optional(Immediately), optional(InBackground)));

const kRingImmediatelySlotId = getSlotId(ringCallDef, Immediately);
const kRingInBackgroundSlotId = getSlotId(ringCallDef, InBackground);

/** True when the modifier arg at `slotId` is present, so its tile is attached. */
function hasModifier(args: ReadonlyList<Value>, slotId: number): boolean {
  const value = args.get(slotId);
  return value !== undefined && !isNilValue(value);
}

/** Report the signal the world staged for this think. */
function execSignal(ctx: ExecutionContext): Value {
  return (ctx.data as FakeWorldState | undefined)?.signal ? TRUE_VALUE : FALSE_VALUE;
}

/** Emit, reporting whether the world let the emit out. */
function execEmit(ctx: ExecutionContext): Value {
  const emitted = (ctx.data as FakeWorldState | undefined)?.emits ?? true;
  const verdict = emitted ? TRUE_VALUE : FALSE_VALUE;
  setSensorOutput(ctx, CoreTypeIds.Boolean, FAKE_EMIT_OUTPUT, verdict);
  return verdict;
}

/** Resolve the handle at dispatch, so the issuing rule does not park on the chime. */
function execChime(_ctx: ExecutionContext, _args: ReadonlyList<Value>, handle: AsyncHandle): void {
  handle.resolve(VOID_VALUE);
}

/**
 * Take the world's one bell and ring it, parking the issuing rule until the
 * world settles the ring. A ring made while the bell is held is dropped and
 * settles at once, unless it carries `immediately`, which takes the bell from
 * the holder and ends the holder's ring as preempted. A ring carrying
 * `in background` settles at once and leaves the bell ringing behind it.
 */
function execRing(ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle): void {
  const state = ctx.data as FakeWorldState | undefined;
  if (!state) {
    handle.resolve(VOID_VALUE);
    return;
  }
  const endings = state.endings ?? [];
  state.endings = endings;
  const held = state.bell;
  if (held !== undefined) {
    if (!hasModifier(args, kRingImmediatelySlotId)) {
      handle.resolve(VOID_VALUE);
      endings.push({ handleId: handle.id, ending: DispatchOutcome.Dropped });
      return;
    }
    state.bell = undefined;
    held.settle();
    endings.push({ handleId: held.handleId, ending: DispatchOutcome.Preempted });
  }
  const inBackground = hasModifier(args, kRingInBackgroundSlotId);
  state.bell = {
    handleId: handle.id,
    inBackground,
    settle: () => {
      handle.resolve(VOID_VALUE);
    },
  };
  if (inBackground) {
    handle.resolve(VOID_VALUE);
  }
}

const signalSensor = {
  key: FakeActionKeys.Signal,
  actionId: TARGET_ACTION_ID_BASE,
  fnId: TARGET_FUNC_ID_BASE,
  callDef: signalCallDef,
  fn: { exec: execSignal },
  isAsync: false,
  outputType: CoreTypeIds.Boolean,
  metadata: { label: "the signal is on" },
} satisfies CreateHostSensorOptions;

/** The named outputs the fake target's emit exposes. */
const emitOutputs = [{ name: FAKE_EMIT_OUTPUT, type: CoreTypeIds.Boolean, label: "it emitted" }] satisfies NonNullable<
  CreateHostActuatorOptions["outputs"]
>;

const emitActuator = {
  key: FakeActionKeys.Emit,
  actionId: TARGET_ACTION_ID_BASE + 1,
  fnId: TARGET_FUNC_ID_BASE + 1,
  callDef: emitCallDef,
  fn: { exec: execEmit },
  isAsync: false,
  outputs: emitOutputs,
  metadata: { label: "emit" },
} satisfies CreateHostActuatorOptions;

const chimeActuator = {
  key: FakeActionKeys.Chime,
  actionId: TARGET_ACTION_ID_BASE + 2,
  fnId: TARGET_FUNC_ID_BASE + 2,
  callDef: chimeCallDef,
  fn: { exec: execChime },
  isAsync: true,
  metadata: { label: "chime" },
} satisfies CreateHostActuatorOptions;

const ringActuator = {
  key: FakeActionKeys.Ring,
  actionId: TARGET_ACTION_ID_BASE + 3,
  fnId: TARGET_FUNC_ID_BASE + 3,
  callDef: ringCallDef,
  fn: { exec: execRing },
  isAsync: true,
  metadata: { label: "ring" },
} satisfies CreateHostActuatorOptions;

/** Factory id of the fake target's literal factory minting values of its own identity. */
export const FAKE_SWATCH_LITERAL_FACTORY_ID = "swatch";

/**
 * Registers the fake target's `swatch` literal factory: each manufacture mints a
 * literal carrying the submitted text under a freshly minted unique identity, as
 * a target's own value factories do, so two manufactures of identical text yield
 * distinct tiles. A manufacture whose `value` option is not text mints nothing
 * and returns `undefined`.
 */
function registerSwatchLiteralFactory(api: WendooModuleApi): void {
  const services = api.brainServices;
  api.registerTile(
    new BrainTileFactoryDef(
      mkLiteralFactoryTileId(FAKE_SWATCH_LITERAL_FACTORY_ID),
      FAKE_SWATCH_LITERAL_FACTORY_ID,
      (factoryTileDef, opts) => {
        if (typeof opts.value !== "string") return undefined;
        return new BrainTileLiteralDef(
          factoryTileDef.producedDataType,
          opts.value,
          { uniqueId: mintDocumentId(services.app.rng) },
          services
        );
      },
      CoreTypeIds.String,
      { metadata: { label: "create a swatch" } }
    )
  );
}

/**
 * The module the fake target installs: one boolean sensor reading the staged
 * signal, one synchronous actuator taking a modifier and a named parameter and
 * reporting a declared output, one asynchronous actuator taking an anonymous
 * number and settling at dispatch, one asynchronous actuator that leases the
 * world's one bell, and one literal factory minting values of their own
 * identity. A rehearsal over it observes gates, both dispatch kinds with their
 * arguments, a declared output's value, a call whose lifecycle spans thinks, and
 * every operation ending a world publishes.
 */
export function createFakeModule(): WendooModule {
  return {
    id: "wendoo.assistant-bridge.fake",
    install(api: WendooModuleApi): void {
      api.registerHostSensor(createHostSensor(signalSensor));
      api.registerHostActuator(createHostActuator(emitActuator));
      api.registerHostActuator(createHostActuator(chimeActuator));
      api.registerHostActuator(createHostActuator(ringActuator));
      registerSwatchLiteralFactory(api);
      api.registerModifiers([
        { id: FakeTileIds.Loudly, label: "loudly" },
        { id: FakeTileIds.Immediately, label: "immediately" },
        { id: FakeTileIds.InBackground, label: "in background" },
      ]);
      api.registerParameters([{ id: FakeTileIds.Strength, dataType: CoreTypeIds.Number, label: "strength" }]);
    },
  };
}
