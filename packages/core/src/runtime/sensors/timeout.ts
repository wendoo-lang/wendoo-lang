import type { ReadonlyList } from "../../platform/list";
import { MathOps } from "../../platform/math";
import { CoreHostActions } from "../abi-ids";
import { bag, optional, param } from "../call-spec";
import type { ExecutionContext, HostActionBinding } from "../context";
import { getCallSiteState, setCallSiteState } from "../context";
import { CoreTypeIds } from "../core-types";
import { type ActionDescriptor, type BrainActionCallDef, getSlotId, mkCallDef } from "../function-defs";
import { CoreParameterId, mkSensorTileId } from "../tile-ids";
import { FALSE_VALUE, isNilValue, isNumberValue, mkNumberValue, TRUE_VALUE, type Value } from "../value";

/** Seconds between firings when the slot is empty. */
const DEFAULT_DELAY_SECONDS = 1;

const AnonNumber = param(CoreParameterId.AnonymousNumber, {
  name: "seconds",
  anonymous: true,
  unit: "seconds",
  default: mkNumberValue(DEFAULT_DELAY_SECONDS),
});

const callDef: BrainActionCallDef = mkCallDef(bag(optional(AnonNumber)));

const descriptor: ActionDescriptor = {
  key: CoreHostActions.Timeout.key,
  kind: "sensor",
  callDef,
  isAsync: false,
  outputType: CoreTypeIds.Boolean,
};

const kAnonymousNumberSlotId = getSlotId(callDef, AnonNumber);

type TimeoutState = {
  fireTime: number;
  lastTick: number;
};

function onPageEntered(ctx: ExecutionContext) {
  const state: TimeoutState = {
    fireTime: 0,
    // -2 ensures the first tick (0) triggers the skip-reset branch
    // (0 !== -2 + 1), which initializes fireTime to ctx.time + delay
    // instead of firing immediately.
    lastTick: -2,
  };
  setCallSiteState(ctx, state);
}

function execTimeout(ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  let delay = DEFAULT_DELAY_SECONDS;
  const anonNumberValue = args.get(kAnonymousNumberSlotId);
  if (anonNumberValue !== undefined && !isNilValue(anonNumberValue)) {
    // An empty slot arrives as nil and runs the default delay.
    if (!isNumberValue(anonNumberValue) || MathOps.isNaN(anonNumberValue.v)) {
      return FALSE_VALUE;
    }
    delay = anonNumberValue.v;
  }

  let state = getCallSiteState<TimeoutState>(ctx);
  if (!state) {
    state = {
      fireTime: 0,
      // -2 ensures the first tick (0) triggers the skip-reset branch
      // (0 !== -2 + 1), which initializes fireTime to ctx.time + delay
      // instead of firing immediately.
      lastTick: -2,
    };
    setCallSiteState(ctx, state);
  }

  let shouldFire = false;

  if (ctx.currentTick !== state.lastTick + 1) {
    // Ticks were skipped -- reset the timer
    state.fireTime = ctx.time + delay * 1000;
  }

  if (ctx.time >= state.fireTime) {
    shouldFire = true;
    state.fireTime = ctx.time + delay * 1000;
  }

  state.lastTick = ctx.currentTick;

  return shouldFire ? TRUE_VALUE : FALSE_VALUE;
}

const binding: HostActionBinding = {
  binding: "host",
  descriptor,
  id: CoreHostActions.Timeout.actionId,
  onPageEntered,
  execSync: execTimeout,
};

export default {
  key: CoreHostActions.Timeout.key,
  tileId: mkSensorTileId(CoreHostActions.Timeout.key),
  isAsync: false,
  descriptor,
  binding,
  fn: {
    onPageEntered,
    exec: execTimeout,
  },
  callDef,
};
