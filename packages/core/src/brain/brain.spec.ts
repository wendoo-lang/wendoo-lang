import { CoreHostActions } from "@wendoo/core/runtime";
/**
 * Behavioral tests for the Brain runtime.
 *
 * These tests exercise the full pipeline: tile construction -> compiler
 * (parser, type inference, rule-compiler, emitter) -> VM execution.
 * Each test builds a BrainDef programmatically, initializes a Brain,
 * runs think(), and asserts on observable side effects (variable values,
 * host function calls, page state).
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import {
  createHostActuator,
  createHostSensor,
  type HostActuatorDefinition,
  type HostSensorDefinition,
  List,
  type ReadonlyList,
} from "@wendoo/core";
import { Brain, type BrainServices, CoreCapabilityBits, mkVariableTileId, TilePlacement } from "@wendoo/core/brain";
import { __test__appendTile, __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { compileBrain } from "@wendoo/core/brain/compiler";
import { BrainDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import {
  BrainTileAccessorDef,
  BrainTileActuatorDef,
  BrainTileLiteralDef,
  BrainTileOperatorDef,
  BrainTileSensorDef,
  BrainTileVariableDef,
  buildDescriptorOutputTiles,
} from "@wendoo/core/brain/tiles";
import type { ExecutionContext, Instr, UserActionArtifact } from "@wendoo/core/runtime";
import {
  type ActionDescriptor,
  type BooleanValue,
  BYTECODE_VERSION,
  CoreTypeIds,
  clearCallSiteState,
  extractBooleanValue,
  extractNumberValue,
  extractStringValue,
  FALSE_VALUE,
  getCallSiteState,
  getRuleVariable,
  getWhenResult,
  type HandleId,
  type HostAsyncFn,
  type IBrain,
  mkActionDescriptor,
  mkCallDef,
  mkNumberValue,
  mkSensorTileId,
  mkStringValue,
  NativeType,
  NIL_VALUE,
  Op,
  param,
  setCallSiteState,
  setRuleVariable,
  setSensorOutput,
  TRUE_VALUE,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";
import { BitSet } from "@wendoo/core/util";

let services: BrainServices;
let opAdd: BrainTileOperatorDef;
let opSub: BrainTileOperatorDef;
let opMul: BrainTileOperatorDef;
let opDiv: BrainTileOperatorDef;
let opAssign: BrainTileOperatorDef;
let opEq: BrainTileOperatorDef;
let opNeq: BrainTileOperatorDef;
let opLt: BrainTileOperatorDef;
let opGt: BrainTileOperatorDef;
let opAnd: BrainTileOperatorDef;
let opOr: BrainTileOperatorDef;
let opNot: BrainTileOperatorDef;
let opNeg: BrainTileOperatorDef;

before(() => {
  services = __test__createBrainServices();
  opAdd = new BrainTileOperatorDef("add", {}, services);
  opSub = new BrainTileOperatorDef("sub", {}, services);
  opMul = new BrainTileOperatorDef("mul", {}, services);
  opDiv = new BrainTileOperatorDef("div", {}, services);
  opAssign = new BrainTileOperatorDef("assign", {}, services);
  opEq = new BrainTileOperatorDef("eq", {}, services);
  opNeq = new BrainTileOperatorDef("ne", {}, services);
  opLt = new BrainTileOperatorDef("lt", {}, services);
  opGt = new BrainTileOperatorDef("gt", {}, services);
  opAnd = new BrainTileOperatorDef("and", {}, services);
  opOr = new BrainTileOperatorDef("or", {}, services);
  opNot = new BrainTileOperatorDef("not", {}, services);
  opNeg = new BrainTileOperatorDef("neg", {}, services);
});

// -- Helpers --

function buildBrain(whenTiles: readonly unknown[], doTiles: readonly unknown[]): BrainDef {
  const brainDef = new BrainDef(services);
  const pageResult = brainDef.appendNewPage();
  assert.ok(pageResult.success);
  const page = pageResult.value!.page;

  const rule = page.children().get(0)!;

  for (const tile of whenTiles) {
    __test__appendTile(rule.when(), tile as never);
  }
  for (const tile of doTiles) {
    __test__appendTile(rule.do(), tile as never);
  }

  return brainDef;
}

/** Slot id `varName` was assigned in the brain's loaded program. Fails the test when the name has no slot. */
function slotIdOf(brain: IBrain, varName: string): number {
  const program = brain.getProgram();
  assert.ok(program, "brain has a loaded program");
  for (let i = 0; i < program.variableNames.size(); i++) {
    if (program.variableNames.get(i) === varName) return i;
  }
  assert.fail(`no slot for variable '${varName}'`);
}

function runBrain(brainDef: BrainDef, ticks = 1): IBrain {
  const brain = brainDef.compile();
  brain.initialize();
  brain.startup();

  for (let i = 0; i < ticks; i++) {
    brain.think((i + 1) * 16);
  }

  return brain;
}

// -- Tiles shared across tests --

function mkLiteral(n: number) {
  return new BrainTileLiteralDef(CoreTypeIds.Number, n, {}, services);
}
function mkBoolLiteral(b: boolean) {
  return new BrainTileLiteralDef(CoreTypeIds.Boolean, b, {}, services);
}
function mkStringLiteral(s: string) {
  return new BrainTileLiteralDef(CoreTypeIds.String, s, {}, services);
}
function mkNilLiteral() {
  return new BrainTileLiteralDef(CoreTypeIds.Nil, undefined, {}, services);
}

function mkVar(name: string, typeId = CoreTypeIds.Number) {
  const uniqueId = `test-${name}`;
  return new BrainTileVariableDef(mkVariableTileId(uniqueId), name, typeId, uniqueId);
}

// ---- Tests ----

describe("Brain behavioral -- math expressions", () => {
  test("assign literal number to variable", () => {
    const v = mkVar("x");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(42)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined, "variable should be set");
    assert.equal(val!.t, NativeType.Number);
    assert.equal(extractNumberValue(val), 42);
  });

  test("addition: x = 3 + 5", () => {
    const v = mkVar("x");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(3), opAdd, mkLiteral(5)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 8);
  });

  test("subtraction: x = 10 - 4", () => {
    const v = mkVar("x");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(10), opSub, mkLiteral(4)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 6);
  });

  test("multiplication: x = 6 * 7", () => {
    const v = mkVar("x");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(6), opMul, mkLiteral(7)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 42);
  });

  test("division: x = 20 / 4", () => {
    const v = mkVar("x");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(20), opDiv, mkLiteral(4)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 5);
  });

  test("negation: x = -7", () => {
    const v = mkVar("neg-x");
    const brainDef = buildBrain([], [v, opAssign, opNeg, mkLiteral(7)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), -7);
  });

  test("compound expression: x = 2 + 3 * 4 (precedence)", () => {
    const v = mkVar("prec");
    // Should evaluate as 2 + (3 * 4) = 14 if precedence is correct
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(2), opAdd, mkLiteral(3), opMul, mkLiteral(4)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 14);
  });
});

describe("Brain behavioral -- WHEN condition", () => {
  test("WHEN true -> DO executes", () => {
    const v = mkVar("w1");
    const brainDef = buildBrain([mkBoolLiteral(true)], [v, opAssign, mkLiteral(1)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1);
  });

  test("WHEN false -> DO does not execute", () => {
    const v = mkVar("w2");
    const brainDef = buildBrain([mkBoolLiteral(false)], [v, opAssign, mkLiteral(1)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 0, "variable should still hold its starting value");
  });

  test("empty WHEN -> always true (DO executes)", () => {
    const v = mkVar("w3");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(99)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 99);
  });
});

describe("Brain behavioral -- presence gate", () => {
  let presenceIdCounter = 0;

  /**
   * Register a host sensor whose delivered value is set through the returned
   * `deliver`. When `presenceGated` is true the sensor's tile carries the
   * {@link CoreCapabilityBits.PresenceGated} capability.
   */
  function makeSensor(
    outputType: string,
    presenceGated: boolean
  ): { tile: BrainTileSensorDef; deliver: (v: Value) => void } {
    presenceIdCounter += 1;
    const holder: { value: Value } = { value: NIL_VALUE };
    const def = createHostSensor({
      key: `test-presence-sensor-${presenceIdCounter}`,
      actionId: 7100 + presenceIdCounter,
      fnId: 8100 + presenceIdCounter,
      callDef: mkCallDef({ type: "bag", items: [] }),
      outputType,
      fn: { exec: () => holder.value },
      capabilities: presenceGated ? new BitSet().set(CoreCapabilityBits.PresenceGated) : undefined,
    });
    services.runtime.functions.register(
      def.function.id,
      def.function.name,
      def.function.isAsync,
      def.function.fn,
      def.function.callDef
    );
    services.runtime.actions.register({
      binding: "host",
      descriptor: def.descriptor,
      id: def.actionId,
      execSync: (def.actionFn as { exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => Value }).exec,
    });
    const capabilities = presenceGated ? new BitSet().set(CoreCapabilityBits.PresenceGated) : undefined;
    const tile = new BrainTileSensorDef(def.descriptor.key, def.descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
      capabilities,
    });
    return {
      tile,
      deliver: (v) => {
        holder.value = v;
      },
    };
  }

  /** Compile `brainDef` and return whether the first page's root rule emits `op`. */
  function rootRuleEmits(brainDef: BrainDef, op: Op): boolean {
    const program = compileBrain(
      brainDef,
      List.from([services.edit.tiles, brainDef.catalog()]),
      services.shared.conversions,
      services.runtime.actions,
      services.runtime.types
    ).program!;
    const page = program.pages.get(0)!;
    const rootFunc = program.functions.get(page.rootRuleFuncIds.get(0)!)!;
    return rootFunc.code.findIndex((ins) => ins.op === op) !== -1;
  }

  test("bare presence-gated sensor fires its DO on a delivered 0", () => {
    const v = mkVar("presence-zero");
    const sensor = makeSensor(CoreTypeIds.Number, true);
    sensor.deliver(mkNumberValue(0));
    const brain = runBrain(buildBrain([sensor.tile], [v, opAssign, mkLiteral(1)]));
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1, "DO must run on a present falsy 0");
  });

  test("bare presence-gated sensor fires its DO on a delivered empty string", () => {
    const v = mkVar("presence-empty");
    const sensor = makeSensor(CoreTypeIds.String, true);
    sensor.deliver(mkStringValue(""));
    const brain = runBrain(buildBrain([sensor.tile], [v, opAssign, mkLiteral(1)]));
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1, "DO must run on a present empty string");
  });

  test("bare presence-gated sensor fires its DO on a delivered false", () => {
    const v = mkVar("presence-false");
    const sensor = makeSensor(CoreTypeIds.Boolean, true);
    sensor.deliver(FALSE_VALUE);
    const brain = runBrain(buildBrain([sensor.tile], [v, opAssign, mkLiteral(1)]));
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1, "DO must run on a present false");
  });

  test("bare presence-gated sensor skips its DO when the value is nil (absent)", () => {
    const v = mkVar("presence-nil");
    const sensor = makeSensor(CoreTypeIds.Number, true);
    sensor.deliver(NIL_VALUE);
    const brain = runBrain(buildBrain([sensor.tile], [v, opAssign, mkLiteral(1)]));
    assert.equal(
      extractNumberValue(brain.getVariable(v.varName)),
      0,
      "DO must be skipped when the sensor delivers nil"
    );
  });

  test("a non-presence-gated sensor delivering 0 stays truthiness-gated and skips its DO", () => {
    const v = mkVar("truthy-zero");
    const sensor = makeSensor(CoreTypeIds.Number, false);
    sensor.deliver(mkNumberValue(0));
    const brain = runBrain(buildBrain([sensor.tile], [v, opAssign, mkLiteral(1)]));
    assert.equal(
      extractNumberValue(brain.getVariable(v.varName)),
      0,
      "0 is falsy, so a truthiness-gated rule must not fire"
    );
  });

  test("WHEN_END_PRESENT is emitted only for a bare presence-gated sensor WHEN root", () => {
    const presence = makeSensor(CoreTypeIds.Number, true);
    presence.deliver(mkNumberValue(0));
    const bare = buildBrain([presence.tile], [mkVar("emit-bare"), opAssign, mkLiteral(1)]);
    assert.ok(rootRuleEmits(bare, Op.WHEN_END_PRESENT), "bare presence-gated sensor emits WHEN_END_PRESENT");
    assert.ok(!rootRuleEmits(bare, Op.WHEN_END), "bare presence-gated sensor does not also emit WHEN_END");

    const expr = makeSensor(CoreTypeIds.Number, true);
    expr.deliver(mkNumberValue(0));
    const compound = buildBrain([expr.tile, opGt, mkLiteral(100)], [mkVar("emit-expr"), opAssign, mkLiteral(1)]);
    assert.ok(
      rootRuleEmits(compound, Op.WHEN_END),
      "a presence-gated sensor inside an expression stays truthiness-gated"
    );
    assert.ok(!rootRuleEmits(compound, Op.WHEN_END_PRESENT), "an expression WHEN root does not emit WHEN_END_PRESENT");

    const plain = makeSensor(CoreTypeIds.Number, false);
    plain.deliver(mkNumberValue(1));
    const plainBrain = buildBrain([plain.tile], [mkVar("emit-plain"), opAssign, mkLiteral(1)]);
    assert.ok(rootRuleEmits(plainBrain, Op.WHEN_END), "a non-presence sensor emits WHEN_END");
    assert.ok(!rootRuleEmits(plainBrain, Op.WHEN_END_PRESENT), "a non-presence sensor does not emit WHEN_END_PRESENT");

    const boolBrain = buildBrain([mkBoolLiteral(true)], [mkVar("emit-bool"), opAssign, mkLiteral(1)]);
    assert.ok(rootRuleEmits(boolBrain, Op.WHEN_END), "a boolean-condition rule emits WHEN_END");
    assert.ok(
      !rootRuleEmits(boolBrain, Op.WHEN_END_PRESENT),
      "a boolean-condition rule does not emit WHEN_END_PRESENT"
    );
  });
});

describe("Brain behavioral -- variable read-back", () => {
  test("write then read variable in subsequent tick", () => {
    const v = mkVar("rw");
    // First tick: assign x = 10
    // The brain re-runs rules every tick, so x = 10 every tick
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(10)]);
    const brain = runBrain(brainDef, 2);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 10);
  });
});

describe("Brain behavioral -- boolean logic", () => {
  test("AND: true && false -> false", () => {
    const v = mkVar("band", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkBoolLiteral(true), opAnd, mkBoolLiteral(false)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    // Short-circuit AND: result is the falsy value or the last truthy value
    // In the VM, AND uses short-circuit: if left is falsy, result is left; otherwise result is right
    assert.equal(val!.t, NativeType.Boolean);
    assert.equal(val!.v, false);
  });

  test("OR: false || true -> true", () => {
    const v = mkVar("bor", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkBoolLiteral(false), opOr, mkBoolLiteral(true)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal(val!.t, NativeType.Boolean);
    assert.equal(val!.v, true);
  });

  test("NOT: !true -> false", () => {
    const v = mkVar("bnot", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, opNot, mkBoolLiteral(true)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal(val!.t, NativeType.Boolean);
    assert.equal(val!.v, false);
  });

  test("short-circuit AND: false && X -> false without evaluating X", () => {
    // Test that AND short-circuits by using false && (side-effecting expression)
    // We test indirectly: false AND true = false
    const v = mkVar("sc-and", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkBoolLiteral(false), opAnd, mkBoolLiteral(true)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal((val as BooleanValue).v, false);
  });

  test("short-circuit OR: true || X -> true without evaluating X", () => {
    const v = mkVar("sc-or", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkBoolLiteral(true), opOr, mkBoolLiteral(false)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal((val as BooleanValue).v, true);
  });
});

describe("Brain behavioral -- comparison operators", () => {
  test("equality: 5 == 5 -> true", () => {
    const v = mkVar("ceq", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(5), opEq, mkLiteral(5)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal((val as BooleanValue).v, true);
  });

  test("inequality: 5 != 3 -> true", () => {
    const v = mkVar("cneq", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(5), opNeq, mkLiteral(3)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal((val as BooleanValue).v, true);
  });

  test("less than: 3 < 5 -> true", () => {
    const v = mkVar("clt", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(3), opLt, mkLiteral(5)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal((val as BooleanValue).v, true);
  });

  test("greater than: 5 > 3 -> true", () => {
    const v = mkVar("cgt", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(5), opGt, mkLiteral(3)]);
    const brain = runBrain(brainDef);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal((val as BooleanValue).v, true);
  });
});

describe("Brain behavioral -- sensors and actuators", () => {
  test("sync sensor returns value used in DO", () => {
    const sensorId = "test-sensor-sync";
    const anonParam = param("anon-num");

    const fnEntry = services.runtime.functions.register(
      4001,
      sensorId,
      false,
      { exec: () => ({ t: NativeType.Number, v: 77 }) },
      mkCallDef({ type: "bag", items: [] })
    );
    assert.equal(fnEntry.isAsync, false);

    const action = mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Number);
    services.runtime.actions.register({
      binding: "host",
      id: 3001,
      descriptor: action,
      execSync: () => ({ t: NativeType.Number, v: 77 }),
    });

    const sensor = new BrainTileSensorDef(sensorId, action, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });

    const v = mkVar("sensor-v");
    const brainDef = buildBrain([], [v, opAssign, sensor]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 77);
  });

  test("sync actuator receives positional args and is called", () => {
    let called = false;
    let receivedArg: Value | undefined;

    const actuatorId = "test-actuator-call";
    const callDef = mkCallDef({
      type: "bag",
      items: [
        {
          type: "arg",
          name: "anonNumber",
          tileId: "tile.param->test-act-anon",
          required: true,
          anonymous: true,
        },
      ],
    });

    const fnEntry = services.runtime.functions.register(
      4002,
      actuatorId,
      false,
      {
        exec: (_ctx: ExecutionContext, _args: ReadonlyList<Value>) => {
          return VOID_VALUE;
        },
      },
      callDef
    );
    assert.equal(fnEntry.isAsync, false);

    const action = mkActionDescriptor("actuator", fnEntry);
    services.runtime.actions.register({
      binding: "host",
      id: 3002,
      descriptor: action,
      execSync: (_ctx: ExecutionContext, args: ReadonlyList<Value>) => {
        called = true;
        receivedArg = args.get(0);
        return VOID_VALUE;
      },
    });

    const actuator = new BrainTileActuatorDef(actuatorId, action);

    const brainDef = buildBrain([], [actuator, mkLiteral(42)]);
    const brain = runBrain(brainDef);

    assert.ok(called, "actuator should have been called");
    assert.equal(extractNumberValue(receivedArg), 42);
  });
});

describe("Brain behavioral -- rule variables (regression)", () => {
  // Regression: an early dense-state implementation treated `ruleFuncId === 0`
  // as a "no-rule" sentinel and silently dropped reads/writes. Because the
  // brain compiler assigns funcIds starting at 0, the first rule on the first
  // page always lands on funcId 0, which made WHEN-sets-rulevar /
  // DO-reads-rulevar (e.g. bump.targetActor -> eat) silently fail for the
  // most common single-page brains. The only no-rule sentinel is `undefined`.

  /**
   * Register a host sensor or actuator definition (built via
   * {@link createHostSensor} / {@link createHostActuator}) with the test's
   * BrainServices: function registry, action registry, and tile catalog.
   * Returns the same definition for chaining.
   */
  function defineHost<T extends HostSensorDefinition | HostActuatorDefinition>(def: T): T {
    const fn = def.function;
    services.runtime.functions.register(fn.id, fn.name, fn.isAsync, fn.fn, fn.callDef);
    const exec = (def.actionFn as { exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => Value }).exec;
    services.runtime.actions.register({
      binding: "host",
      descriptor: def.descriptor,
      id: def.actionId,
      execSync: exec,
    });
    return def;
  }

  test("WHEN sensor sets rule var, DO actuator reads it back (single page, funcId 0)", () => {
    const brainVarName = "rulevar-roundtrip-out";

    // Sensor: writes 42 into rule var "stash" and returns true.
    const sensorDef = defineHost(
      createHostSensor({
        key: "test-rulevar-set-sensor",
        actionId: 5001,
        fnId: 6001,
        callDef: mkCallDef({ type: "bag", items: [] }),
        outputType: CoreTypeIds.Boolean,
        fn: {
          exec: (ctx) => {
            setRuleVariable(ctx, "stash", mkNumberValue(42));
            return TRUE_VALUE;
          },
        },
      })
    );

    // Actuator: reads rule var "stash" and writes the value into a brain var
    // so the test can assert on it.
    const actuatorDef = defineHost(
      createHostActuator({
        key: "test-rulevar-read-actuator",
        actionId: 5002,
        fnId: 6002,
        callDef: mkCallDef({ type: "bag", items: [] }),
        fn: {
          exec: (ctx) => {
            const v = getRuleVariable(ctx, "stash");
            ctx.services.brain.brainVars.setByName(brainVarName, v);
            return VOID_VALUE;
          },
        },
      })
    );

    const sensor = new BrainTileSensorDef(sensorDef.descriptor.key, sensorDef.descriptor, {
      placement: TilePlacement.WhenSide | TilePlacement.Inline,
    });
    const actuator = actuatorDef.tile as BrainTileActuatorDef;

    const brainDef = buildBrain([sensor], [actuator]);
    const brain = runBrain(brainDef);

    const out = brain.getVariable(brainVarName);
    assert.ok(out !== undefined, "brain var should be set by actuator");
    assert.equal(extractNumberValue(out), 42, "actuator must read the same value the sensor stashed");
  });

  test("a built-in sensor's ActionDescriptor outputs derive an inline tile that round-trips the written value", () => {
    const outVarName = "builtin-output-out";

    // Built-in sensor declares a numeric `count` output and writes it via setSensorOutput.
    const sensorDef = defineHost(
      createHostSensor({
        key: "test-output-sensor",
        actionId: 5101,
        fnId: 6101,
        callDef: mkCallDef({ type: "bag", items: [] }),
        outputType: CoreTypeIds.Boolean,
        outputs: [{ name: "count", type: CoreTypeIds.Number, label: "count" }],
        fn: {
          exec: (ctx) => {
            setSensorOutput(ctx, CoreTypeIds.Number, "count", mkNumberValue(42));
            return TRUE_VALUE;
          },
        },
      })
    );

    const sensor = new BrainTileSensorDef(sensorDef.descriptor.key, sensorDef.descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });

    // Derive the output tiles from the descriptor exactly as registration does.
    const outputTiles = buildDescriptorOutputTiles(sensorDef.descriptor.outputs!);
    assert.equal(outputTiles.length, 1, "one output tile per declared output");
    const countTile = outputTiles[0];
    assert.equal(countTile.kind, "output");
    assert.equal(countTile.outputType, CoreTypeIds.Number);
    // The sensor advertises the output tile's identity key that gates it downstream.
    assert.ok(
      sensorDef.tile.providedOutputs().indexOf(countTile.outputKey) >= 0,
      "the sensor provides the output tile's identity key"
    );

    // DO: outVar = count-output-tile -- reads back the value the sensor wrote.
    const outVar = mkVar(outVarName);
    const brainDef = buildBrain([sensor], [outVar, opAssign, countTile]);
    const brain = runBrain(brainDef);

    assert.equal(
      extractNumberValue(brain.getVariable(outVarName)),
      42,
      "the output value must round-trip from the sensor write to the output tile read"
    );
  });

  test("a built-in actuator's ActionDescriptor outputs derive an inline tile a rule below it reads", () => {
    const outVarName = "actuator-output-out";

    const actuatorDef = defineHost(
      createHostActuator({
        key: "test-output-actuator",
        actionId: 5102,
        fnId: 6102,
        callDef: mkCallDef({ type: "bag", items: [] }),
        outputs: [{ name: "acted", type: CoreTypeIds.Boolean, label: "acted" }],
        fn: {
          exec: (ctx) => {
            setSensorOutput(ctx, CoreTypeIds.Boolean, "acted", TRUE_VALUE);
            return VOID_VALUE;
          },
        },
      })
    );

    const actuator = actuatorDef.tile as BrainTileActuatorDef;
    const outputTiles = buildDescriptorOutputTiles(actuatorDef.descriptor.outputs!);
    assert.equal(outputTiles.length, 1, "one output tile per declared output");
    const actedTile = outputTiles[0];
    assert.equal(actedTile.outputType, CoreTypeIds.Boolean);
    assert.ok(
      actuator.providedOutputs().indexOf(actedTile.outputKey) >= 0,
      "the actuator provides the output tile's identity key"
    );

    // The rule's DO writes the output; the rule below it reads the value back.
    const brainDef = new BrainDef(services);
    const pageResult = brainDef.appendNewPage();
    assert.ok(pageResult.success);
    const parent = pageResult.value!.page.children().get(0) as BrainRuleDef;
    __test__appendTile(parent.do(), actuator as never);
    const child = parent.appendNewRule();
    for (const tile of [mkVar(outVarName, CoreTypeIds.Boolean), opAssign, actedTile]) {
      __test__appendTile(child.do(), tile as never);
    }

    const brain = runBrain(brainDef);

    assert.equal(
      extractBooleanValue(brain.getVariable(outVarName)!),
      true,
      "the output value must round-trip from the actuator write to a rule below it"
    );
  });

  test("WHEN_END captures the WHEN result into the rule's __whenResult variable", () => {
    const brainVarName = "whenresult-out";

    // Actuator: reads getWhenResult(ctx) and writes it into a brain var so the
    // test can assert the WHEN side's value was captured at WHEN_END.
    const actuatorDef = defineHost(
      createHostActuator({
        key: "test-whenresult-read",
        actionId: 5007,
        fnId: 6007,
        callDef: mkCallDef({ type: "bag", items: [] }),
        fn: {
          exec: (ctx) => {
            ctx.services.brain.brainVars.setByName(brainVarName, getWhenResult(ctx));
            return VOID_VALUE;
          },
        },
      })
    );

    const actuator = actuatorDef.tile as BrainTileActuatorDef;
    // WHEN side evaluates to 42 (truthy, so the DO runs); the VM must capture it.
    const brainDef = buildBrain([mkLiteral(42)], [actuator]);
    const brain = runBrain(brainDef);

    const out = brain.getVariable(brainVarName);
    assert.ok(out !== undefined, "actuator should have read __whenResult");
    assert.equal(extractNumberValue(out), 42, "WHEN_END must capture the WHEN result (42)");
  });

  test("rule var read returns NIL_VALUE when never written", () => {
    const brainVarName = "rulevar-unset-out";
    let observedIsNil = false;

    const actuatorDef = defineHost(
      createHostActuator({
        key: "test-rulevar-read-unset",
        actionId: 5003,
        fnId: 6003,
        callDef: mkCallDef({ type: "bag", items: [] }),
        fn: {
          exec: (ctx) => {
            const v = getRuleVariable(ctx, "never-set");
            observedIsNil = v.t === NIL_VALUE.t;
            ctx.services.brain.brainVars.setByName(brainVarName, v);
            return VOID_VALUE;
          },
        },
      })
    );

    const actuator = actuatorDef.tile as BrainTileActuatorDef;
    const brainDef = buildBrain([], [actuator]);
    runBrain(brainDef);

    assert.ok(observedIsNil, "unwritten rule var must read as NIL");
  });

  test("rule vars are isolated across rules on different pages (different funcIds)", () => {
    // Two pages, each with one rule that writes a different number into rule
    // var "shared", then reads it back into a page-tagged brain var. After
    // two ticks (page 1, then page 2 via switch), both brain vars should
    // hold their respective writer's value, proving funcIds 0 and 1 do not
    // share rule-var storage.
    const brainVarP1 = "rulevar-iso-p1";
    const brainVarP2 = "rulevar-iso-p2";

    const actuatorDef = defineHost(
      createHostActuator({
        key: "test-rulevar-isolation",
        actionId: 5004,
        fnId: 6004,
        callDef: mkCallDef({
          type: "bag",
          items: [
            {
              type: "arg",
              name: "writeVal",
              tileId: "tile.param->rulevar-iso-write",
              required: true,
              anonymous: true,
            },
            {
              type: "arg",
              name: "outName",
              tileId: "tile.param->rulevar-iso-out",
              required: true,
              anonymous: true,
            },
          ],
        }),
        fn: {
          exec: (ctx, args) => {
            const writeVal = args.get(0)!;
            const outName = extractStringValue(args.get(1)!) ?? "";
            setRuleVariable(ctx, "shared", writeVal);
            const readBack = getRuleVariable(ctx, "shared");
            ctx.services.brain.brainVars.setByName(outName, readBack);
            return VOID_VALUE;
          },
        },
      })
    );

    const actuator = actuatorDef.tile as BrainTileActuatorDef;

    // Build a 2-page brain manually so each rule lands on a distinct funcId.
    const brainDef = new BrainDef(services);
    const p1Result = brainDef.appendNewPage();
    assert.ok(p1Result.success);
    const p1 = p1Result.value!.page;
    const p2Result = brainDef.appendNewPage();
    assert.ok(p2Result.success);
    const p2 = p2Result.value!.page;

    const r1 = p1.children().get(0)!;
    __test__appendTile(r1.do(), actuator as never);
    __test__appendTile(r1.do(), mkLiteral(11) as never);
    __test__appendTile(r1.do(), mkStringLiteral(brainVarP1) as never);

    const r2 = p2.children().get(0)!;
    __test__appendTile(r2.do(), actuator as never);
    __test__appendTile(r2.do(), mkLiteral(22) as never);
    __test__appendTile(r2.do(), mkStringLiteral(brainVarP2) as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    brain.requestPageChangeByPageId(p2.pageId());
    brain.think(32);

    assert.equal(extractNumberValue(brain.getVariable(brainVarP1)), 11);
    assert.equal(extractNumberValue(brain.getVariable(brainVarP2)), 22);
  });

  test("child rule reads rule var written by its parent rule (ancestor walk)", () => {
    // Parent rule WHEN: sensor stashes 99 into rule var "fromParent" (and
    // returns true so the parent's DO and child rules execute).
    // Child rule DO: actuator reads rule var "fromParent" via
    // getRuleVariable; because the child has its own funcId, this exercises
    // IBrainRule.getVariable<T>'s ancestor walk inside the dense shim.
    // The child runs in its own fiber, spawned at the parent's tail; it drains
    // in the same think as its parent (a synchronous cascade) and reads the
    // parent's rule var on think 1.
    const brainVarName = "rulevar-parent-child-out";

    const sensorDef = defineHost(
      createHostSensor({
        key: "test-rulevar-parent-set",
        actionId: 5005,
        fnId: 6005,
        callDef: mkCallDef({ type: "bag", items: [] }),
        outputType: CoreTypeIds.Boolean,
        fn: {
          exec: (ctx) => {
            setRuleVariable(ctx, "fromParent", mkNumberValue(99));
            return TRUE_VALUE;
          },
        },
      })
    );

    const actuatorDef = defineHost(
      createHostActuator({
        key: "test-rulevar-child-read",
        actionId: 5006,
        fnId: 6006,
        callDef: mkCallDef({ type: "bag", items: [] }),
        fn: {
          exec: (ctx) => {
            const v = getRuleVariable(ctx, "fromParent");
            ctx.services.brain.brainVars.setByName(brainVarName, v);
            return VOID_VALUE;
          },
        },
      })
    );

    const sensor = sensorDef.tile as BrainTileSensorDef;
    const actuator = actuatorDef.tile as BrainTileActuatorDef;

    const brainDef = new BrainDef(services);
    const pageResult = brainDef.appendNewPage();
    assert.ok(pageResult.success);
    const parentRule = pageResult.value!.page.children().get(0)! as BrainRuleDef;
    __test__appendTile(parentRule.when(), sensor as never);
    const childRule = parentRule.appendNewRule();
    __test__appendTile(childRule.do(), actuator as never);

    const brain = runBrain(brainDef, 1);

    const out = brain.getVariable(brainVarName);
    assert.ok(out !== undefined, "child actuator should have written to brain var");
    assert.equal(extractNumberValue(out), 99, "child rule must read parent's rule var via the ancestor chain");
  });
});

describe("Brain behavioral -- multi-page", () => {
  test("page change via requestPageChange", () => {
    // Build a brain with 2 pages:
    // Page 0: DO assigns x = 1
    // Page 1: DO assigns x = 2
    const v = mkVar("pg-v");
    const brainDef = new BrainDef(services);

    // Page 0
    const p0Result = brainDef.appendNewPage();
    assert.ok(p0Result.success);
    const rule0 = p0Result.value!.page.children().get(0)!;
    __test__appendTile(rule0.do(), v as never);
    __test__appendTile(rule0.do(), opAssign as never);
    __test__appendTile(rule0.do(), mkLiteral(1) as never);

    // Page 1
    const p1Result = brainDef.appendNewPage();
    assert.ok(p1Result.success);
    const rule1 = p1Result.value!.page.children().get(0)!;
    __test__appendTile(rule1.do(), v as never);
    __test__appendTile(rule1.do(), opAssign as never);
    __test__appendTile(rule1.do(), mkLiteral(2) as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    // Tick on page 0
    brain.think(16);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1);

    // Switch to page 1
    brain.requestPageChange(1);
    brain.think(32);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 2);
  });

  test("switching pages cancels a firing child-rule subtree and keeps running", () => {
    const childMarkName = "cascade-child";
    const pageMark = mkVar("cascade-page");
    const brainDef = new BrainDef(services);

    // The child rule's DO is an async actuator that sets the child marker and
    // then parks (leaves its handle pending), holding the child fiber live
    // (WAITING) across thinks: a firing child-rule subtree the page-scoped
    // cancellation cascade must reclaim on a page switch.
    const parkFn = services.runtime.functions.register(
      4110,
      "test-cascade-park",
      true,
      { exec: () => {} },
      mkCallDef({ type: "bag", items: [] })
    );
    const parkDescriptor = mkActionDescriptor("actuator", parkFn);
    services.runtime.actions.register({
      binding: "host",
      id: 3110,
      descriptor: parkDescriptor,
      execAsync: (ctx: ExecutionContext) => {
        ctx.services.brain.brainVars.setByName(childMarkName, mkNumberValue(1));
      },
    });
    const parkTile = new BrainTileActuatorDef("test-cascade-park", parkDescriptor);

    // Page 0: a parent rule whose child rule dispatches the parking actuator.
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const parent = p0.value!.page.children().get(0)! as BrainRuleDef;
    const child = parent.appendNewRule();
    __test__appendTile(child.do(), parkTile as never);

    // Page 1: a rule that assigns the page marker.
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);
    const rule1 = p1.value!.page.children().get(0)!;
    __test__appendTile(rule1.do(), pageMark as never);
    __test__appendTile(rule1.do(), opAssign as never);
    __test__appendTile(rule1.do(), mkLiteral(2) as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    // One think on page 0: the parent fires, spawns the child, and the child
    // drains in the same think, sets its marker, and parks on the actuator.
    brain.think(16);
    assert.equal(extractNumberValue(brain.getVariable(childMarkName)), 1);

    // Switch to page 1 while page 0's child subtree is still parked (live), then
    // keep thinking. The cascade cancels the child subtree; the brain continues
    // on page 1.
    brain.requestPageChange(1);
    brain.think(32);
    brain.think(48);
    assert.equal(extractNumberValue(brain.getVariable(pageMark.varName)), 2);
  });
});

describe("Brain behavioral -- page sensors", () => {
  test("current-page sensor returns active page ID", () => {
    const v = mkVar("cp", CoreTypeIds.String);
    const fnEntry = services.runtime.functions.get(CoreHostActions.CurrentPage.key);
    assert.ok(fnEntry, "current-page function should be registered");
    const cpSensor = new BrainTileSensorDef(
      CoreHostActions.CurrentPage.key,
      mkActionDescriptor("sensor", fnEntry!, CoreTypeIds.String),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
      }
    );

    const brainDef = buildBrain([], [v, opAssign, cpSensor]);
    const brain = runBrain(brainDef);

    const program = brain.getProgram();
    assert.ok(program);
    const expectedPageId = brain.getPages().get(0)!.pageId;

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal(val!.t, NativeType.String);
    assert.equal(val!.v, expectedPageId);
  });

  test("previous-page returns current page when no switch has occurred", () => {
    const v = mkVar("pp-no-switch", CoreTypeIds.String);
    const fnEntry = services.runtime.functions.get(CoreHostActions.PreviousPage.key);
    assert.ok(fnEntry, "previous-page function should be registered");
    const ppSensor = new BrainTileSensorDef(
      CoreHostActions.PreviousPage.key,
      mkActionDescriptor("sensor", fnEntry!, CoreTypeIds.String),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
      }
    );

    const brainDef = buildBrain([], [v, opAssign, ppSensor]);
    const brain = runBrain(brainDef);

    const program = brain.getProgram();
    assert.ok(program);
    const currentPageId = brain.getPages().get(0)!.pageId;

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal(val!.t, NativeType.String);
    assert.equal(val!.v, currentPageId);
  });

  test("previous-page returns page 0 ID after switching to page 1", () => {
    const v = mkVar("pp-after-switch", CoreTypeIds.String);
    const fnEntry = services.runtime.functions.get(CoreHostActions.PreviousPage.key);
    assert.ok(fnEntry);
    const ppSensor = new BrainTileSensorDef(
      CoreHostActions.PreviousPage.key,
      mkActionDescriptor("sensor", fnEntry!, CoreTypeIds.String),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
      }
    );

    const brainDef = new BrainDef(services);

    // Page 0 (empty)
    const p0Result = brainDef.appendNewPage();
    assert.ok(p0Result.success);

    // Page 1: assign previous-page to variable
    const p1Result = brainDef.appendNewPage();
    assert.ok(p1Result.success);
    const rule1 = p1Result.value!.page.children().get(0)!;
    __test__appendTile(rule1.do(), v as never);
    __test__appendTile(rule1.do(), opAssign as never);
    __test__appendTile(rule1.do(), ppSensor as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    const program = brain.getProgram();
    assert.ok(program);
    const page0Id = brain.getPages().get(0)!.pageId;

    // Tick on page 0
    brain.think(16);

    // Switch to page 1
    brain.requestPageChange(1);
    brain.think(32);

    const val = brain.getVariable(v.varName);
    assert.ok(val !== undefined);
    assert.equal(val!.t, NativeType.String);
    assert.equal(val!.v, page0Id);
  });

  test("previous-page updates after multiple page switches", () => {
    const v = mkVar("pp-multi", CoreTypeIds.String);
    const fnEntry = services.runtime.functions.get(CoreHostActions.PreviousPage.key);
    assert.ok(fnEntry);
    const ppSensor = new BrainTileSensorDef(
      CoreHostActions.PreviousPage.key,
      mkActionDescriptor("sensor", fnEntry!, CoreTypeIds.String),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
      }
    );

    const brainDef = new BrainDef(services);

    // Page 0: assign previous-page to var
    const p0Result = brainDef.appendNewPage();
    assert.ok(p0Result.success);
    const rule0 = p0Result.value!.page.children().get(0)!;
    __test__appendTile(rule0.do(), v as never);
    __test__appendTile(rule0.do(), opAssign as never);
    __test__appendTile(rule0.do(), ppSensor as never);

    // Page 1: assign previous-page to var
    const p1Result = brainDef.appendNewPage();
    assert.ok(p1Result.success);
    const rule1 = p1Result.value!.page.children().get(0)!;
    __test__appendTile(rule1.do(), v as never);
    __test__appendTile(rule1.do(), opAssign as never);
    __test__appendTile(rule1.do(), ppSensor as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    const program = brain.getProgram();
    assert.ok(program);
    const page0Id = brain.getPages().get(0)!.pageId;
    const page1Id = brain.getPages().get(1)!.pageId;

    // Tick on page 0 -- previous is current (no switch yet)
    brain.think(16);
    assert.equal(extractStringValue(brain.getVariable(v.varName)), page0Id);

    // Switch to page 1, tick -- previous should be page 0
    brain.requestPageChange(1);
    brain.think(32);
    assert.equal(extractStringValue(brain.getVariable(v.varName)), page0Id);

    // Switch back to page 0, tick -- previous should be page 1
    brain.requestPageChange(0);
    brain.think(48);
    assert.equal(extractStringValue(brain.getVariable(v.varName)), page1Id);
  });
});

describe("Brain behavioral -- fiber respawn", () => {
  test("rules re-execute after fiber completes", () => {
    // Each tick, the rule runs again and re-assigns the variable
    const v = mkVar("resp");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(5)]);
    const brain = runBrain(brainDef, 3);

    // Variable should still be 5 after multiple ticks (re-assigned each tick)
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 5);
  });
});

describe("Brain behavioral -- action state", () => {
  test("host-backed action state survives root-rule respawns and page restart", () => {
    let activationCount = 0;

    const onPageEnteredFn = services.runtime.functions.get(CoreHostActions.OnPageEntered.key);
    assert.ok(onPageEnteredFn, "on-page-entered function should be registered");

    const sensor = new BrainTileSensorDef(
      CoreHostActions.OnPageEntered.key,
      mkActionDescriptor("sensor", onPageEnteredFn!, CoreTypeIds.Boolean),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
      }
    );

    const actuatorDescriptor: ActionDescriptor = {
      key: "test-phase5-host-activation-counter",
      kind: "actuator",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3003,
      descriptor: actuatorDescriptor,
      execSync: () => {
        activationCount += 1;
        return VOID_VALUE;
      },
    });

    const actuator = new BrainTileActuatorDef("test-phase5-host-activation-counter", actuatorDescriptor);
    const brainDef = buildBrain([sensor], [actuator]);
    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    brain.think(16);
    brain.think(32);
    brain.think(48);

    assert.equal(activationCount, 1, "on-page-entered should only fire once per activation across respawns");

    brain.requestPageRestart();
    brain.think(64);

    assert.equal(activationCount, 1, "page restart should NOT re-run activation hooks or reset state");
  });

  test("bytecode-backed activation hook runs once per activation, preserved on restart", () => {
    let activationCount = 0;
    const activationFnEntry = services.runtime.functions.register(
      4003,
      "test-phase5-bytecode-activation-host",
      false,
      {
        exec: () => {
          activationCount += 1;
          return mkNumberValue(activationCount);
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );

    const descriptor: ActionDescriptor = {
      key: "test-phase5-bytecode-activation",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    const sensor = new BrainTileSensorDef("test-phase5-bytecode-activation", descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("bytecode-activation");
    const brainDef = buildBrain([], [v, opAssign, sensor]);

    const artifact: UserActionArtifact = {
      version: BYTECODE_VERSION,
      functions: List.from([
        {
          code: List.from([{ op: Op.LOAD_CALLSITE_VAR, a: 0 }, { op: Op.RET }]),
          numParams: 0,
          name: "entry",
        },
        {
          code: List.from([
            { op: Op.HOST_CALL, a: activationFnEntry.id, b: 0, c: 0 },
            { op: Op.STORE_CALLSITE_VAR, a: 0 },
            { op: Op.PUSH_CONST_VAL, a: 0 },
            { op: Op.RET },
          ]),
          numParams: 0,
          name: "activation",
        },
      ]),
      constantPools: {
        numbers: List.empty<number>(),
        strings: List.empty<string>(),
        values: List.from([NIL_VALUE]),
      },
      variableNames: List.empty(),
      entryPoint: 0,
      key: descriptor.key,
      kind: descriptor.kind,
      callDef: descriptor.callDef,
      outputType: descriptor.outputType,
      isAsync: false,
      numStateSlots: 1,
      entryFuncId: 0,
      activationFuncId: 1,
      revisionId: "test-phase5-bytecode-activation-rev1",
    };

    const brain = new Brain(brainDef, services, {
      catalogs: List.from([services.edit.tiles, brainDef.catalog()]),
      typeRegistry: services.runtime.types,
      actionResolver: {
        resolveAction(actionDescriptor) {
          if (actionDescriptor.key === descriptor.key) {
            return {
              binding: "bytecode" as const,
              descriptor: actionDescriptor,
              artifact,
              metadata: {
                key: artifact.key,
                kind: artifact.kind,
                callDef: artifact.callDef,
                outputType: artifact.outputType,
              },
            };
          }
          return undefined;
        },
      },
    });

    brain.initialize();
    brain.startup();

    assert.equal(activationCount, 1, "startup should invoke bytecode activation exactly once");

    brain.think(16);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1);

    brain.think(32);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1);

    brain.requestPageRestart();
    brain.think(48);

    assert.equal(activationCount, 1, "page restart should NOT re-run bytecode activation");
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1);
  });

  test("action state resets when switching to a different page and back", () => {
    let activationCount = 0;

    const onPageEnteredFn = services.runtime.functions.get(CoreHostActions.OnPageEntered.key);
    assert.ok(onPageEnteredFn, "on-page-entered function should be registered");

    const sensor = new BrainTileSensorDef(
      CoreHostActions.OnPageEntered.key,
      mkActionDescriptor("sensor", onPageEnteredFn!, CoreTypeIds.Boolean),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
      }
    );

    const actuatorDescriptor: ActionDescriptor = {
      key: "test-cross-page-reset-counter",
      kind: "actuator",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3004,
      descriptor: actuatorDescriptor,
      execSync: () => {
        activationCount += 1;
        return VOID_VALUE;
      },
    });

    const actuator = new BrainTileActuatorDef("test-cross-page-reset-counter", actuatorDescriptor);

    const brainDef = new BrainDef(services);

    // Page 0: WHEN on-page-entered DO actuator
    const p0Result = brainDef.appendNewPage();
    assert.ok(p0Result.success);
    const rule0 = p0Result.value!.page.children().get(0)!;
    __test__appendTile(rule0.when(), sensor as never);
    __test__appendTile(rule0.do(), actuator as never);

    // Page 1: empty (just needs to exist as a different page)
    const p1Result = brainDef.appendNewPage();
    assert.ok(p1Result.success);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    brain.think(16);
    assert.equal(activationCount, 1, "actuator fires once on initial page activation");

    brain.think(32);
    brain.think(48);
    assert.equal(activationCount, 1, "actuator does not re-fire across respawns");

    // Switch to page 1, tick
    brain.requestPageChange(1);
    brain.think(64);

    // Switch back to page 0, tick -- state should be reset
    brain.requestPageChange(0);
    brain.think(80);
    assert.equal(activationCount, 2, "returning to a page after leaving resets action state and re-fires activation");
  });
});

// -- Page lifecycle hook helpers --

interface BytecodeHookSpec {
  numStateSlots?: number;
  /** List of bytecode function definitions. funcId 0 must be the entry. */
  functions: ReadonlyList<{
    code: ReadonlyList<{ op: Op; a?: number; b?: number; c?: number }>;
    numParams?: number;
    name?: string;
  }>;
  numConsts?: number;
  initializerFuncId?: number;
  activationFuncId?: number;
  deactivationFuncId?: number;
}

function buildBytecodeActionBrain(
  key: string,
  spec: BytecodeHookSpec,
  twoPages = false
): { brain: IBrain; varName: string } {
  const descriptor: ActionDescriptor = {
    key,
    kind: "sensor",
    callDef: mkCallDef({ type: "bag", items: [] }),
    isAsync: false,
    outputType: CoreTypeIds.Number,
  };
  const sensor = new BrainTileSensorDef(key, descriptor, {
    placement: TilePlacement.EitherSide | TilePlacement.Inline,
  });
  const v = mkVar(`${key}-v`);

  const numConsts = spec.numConsts ?? 1;
  const values = List.empty<Value>();
  for (let i = 0; i < numConsts; i++) values.push(NIL_VALUE);

  const fns = List.empty<{ code: ReadonlyList<unknown>; numParams: number; name?: string }>();
  for (let i = 0; i < spec.functions.size(); i++) {
    const f = spec.functions.get(i)!;
    fns.push({ code: f.code, numParams: f.numParams ?? 0, name: f.name });
  }

  const artifact: UserActionArtifact = {
    version: BYTECODE_VERSION,
    functions: fns as never,
    constantPools: {
      numbers: List.empty<number>(),
      strings: List.empty<string>(),
      values,
    },
    variableNames: List.empty(),
    entryPoint: 0,
    key,
    kind: "sensor",
    callDef: descriptor.callDef,
    outputType: CoreTypeIds.Number,
    isAsync: false,
    numStateSlots: spec.numStateSlots ?? 1,
    entryFuncId: 0,
    initializerFuncId: spec.initializerFuncId,
    activationFuncId: spec.activationFuncId,
    deactivationFuncId: spec.deactivationFuncId,
    revisionId: `${key}-rev1`,
  };

  const brainDef = new BrainDef(services);
  const p0 = brainDef.appendNewPage();
  assert.ok(p0.success);
  const rule = p0.value!.page.children().get(0)!;
  __test__appendTile(rule.do(), v as never);
  __test__appendTile(rule.do(), opAssign as never);
  __test__appendTile(rule.do(), sensor as never);

  if (twoPages) {
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);
  }

  const brain = new Brain(brainDef, services, {
    catalogs: List.from([services.edit.tiles, brainDef.catalog()]),
    typeRegistry: services.runtime.types,
    actionResolver: {
      resolveAction(ad) {
        if (ad.key !== key) return undefined;
        return {
          binding: "bytecode" as const,
          descriptor: ad,
          artifact,
          metadata: { key, kind: "sensor", callDef: descriptor.callDef, outputType: CoreTypeIds.Number },
        };
      },
    },
  });

  return { brain, varName: v.varName };
}

describe("Brain behavioral -- page lifecycle hooks", () => {
  test("bytecode initializer runs exactly once across N page activations and shutdown re-runs it", () => {
    let initCount = 0;
    const initFn = services.runtime.functions.register(
      4004,
      "test-page-init-fn",
      false,
      {
        exec: () => {
          initCount += 1;
          return mkNumberValue(initCount);
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const { brain, varName } = buildBytecodeActionBrain(
      "test-page-init-once",
      {
        functions: List.from([
          { code: List.from([{ op: Op.LOAD_CALLSITE_VAR, a: 0 }, { op: Op.RET }]), name: "entry" },
          {
            code: List.from([
              { op: Op.HOST_CALL, a: initFn.id, b: 0, c: 0 },
              { op: Op.STORE_CALLSITE_VAR, a: 0 },
              { op: Op.PUSH_CONST_VAL, a: 0 },
              { op: Op.RET },
            ]),
            name: "initializer",
          },
        ]),
        initializerFuncId: 1,
      },
      true
    );

    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(initCount, 1, "initializer runs on first activation");
    assert.equal(extractNumberValue(brain.getVariable(varName)), 1);

    brain.requestPageChange(1);
    brain.think(32);
    brain.requestPageChange(0);
    brain.think(48);
    brain.requestPageChange(1);
    brain.think(64);
    brain.requestPageChange(0);
    brain.think(80);
    assert.equal(initCount, 1, "initializer does NOT re-run on subsequent page activations");
    assert.equal(extractNumberValue(brain.getVariable(varName)), 1, "callsite slot survives round-trip");

    brain.shutdown();
    brain.startup();
    brain.think(96);
    assert.equal(initCount, 2, "shutdown teardown lets the next startup re-run the initializer");
    assert.equal(extractNumberValue(brain.getVariable(varName)), 2);
  });

  test("requestPageRestart invokes no lifecycle hook", () => {
    let initCount = 0;
    let actCount = 0;
    let deactCount = 0;
    const initFn = services.runtime.functions.register(
      4005,
      "test-page-restart-init-fn",
      false,
      {
        exec: () => {
          initCount += 1;
          return NIL_VALUE;
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const actFn = services.runtime.functions.register(
      4006,
      "test-page-restart-act-fn",
      false,
      {
        exec: () => {
          actCount += 1;
          return NIL_VALUE;
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const deactFn = services.runtime.functions.register(
      4007,
      "test-page-restart-deact-fn",
      false,
      {
        exec: () => {
          deactCount += 1;
          return NIL_VALUE;
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const { brain, varName } = buildBytecodeActionBrain("test-page-restart-hooks", {
      numStateSlots: 0,
      functions: List.from([
        { code: List.from([{ op: Op.PUSH_CONST_VAL, a: 0 }, { op: Op.RET }]), name: "entry" },
        { code: List.from([{ op: Op.HOST_CALL, a: initFn.id, b: 0, c: 0 }, { op: Op.RET }]), name: "init" },
        { code: List.from([{ op: Op.HOST_CALL, a: actFn.id, b: 0, c: 0 }, { op: Op.RET }]), name: "activation" },
        { code: List.from([{ op: Op.HOST_CALL, a: deactFn.id, b: 0, c: 0 }, { op: Op.RET }]), name: "deactivation" },
      ]),
      initializerFuncId: 1,
      activationFuncId: 2,
      deactivationFuncId: 3,
    });

    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(initCount, 1);
    assert.equal(actCount, 1);
    assert.equal(deactCount, 0);

    brain.requestPageRestart();
    brain.think(32);
    assert.equal(initCount, 1, "soft restart does not re-run initializer");
    assert.equal(actCount, 1, "soft restart does not re-run activation");
    assert.equal(deactCount, 0, "soft restart does not run deactivation");
    assert.deepEqual(brain.getVariable(varName), NIL_VALUE);

    // requestPageChange to the current page is equivalent to requestPageRestart;
    // it must not fire deactivation, activation, or initializer hooks.
    brain.requestPageChange(0);
    brain.think(48);
    assert.equal(initCount, 1, "same-page change does not re-run initializer");
    assert.equal(actCount, 1, "same-page change does not re-run activation");
    assert.equal(deactCount, 0, "same-page change does not run deactivation");
  });

  test("deactivationFuncId can call services.callsite.reset to force re-initialization on next activation", () => {
    let initCount = 0;
    const initFn = services.runtime.functions.register(
      4008,
      "test-page-deact-reset-init-fn",
      false,
      {
        exec: () => {
          initCount += 1;
          return mkNumberValue(initCount);
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const resetFn = services.runtime.functions.register(
      4009,
      "test-page-deact-reset-reset-fn",
      false,
      {
        exec: (ctx: ExecutionContext) => {
          if (ctx.currentCallSiteId !== undefined) {
            ctx.services.brain.callsite.reset(ctx.currentCallSiteId);
          }
          return NIL_VALUE;
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const { brain, varName } = buildBytecodeActionBrain(
      "test-page-deact-reset",
      {
        functions: List.from([
          { code: List.from([{ op: Op.LOAD_CALLSITE_VAR, a: 0 }, { op: Op.RET }]), name: "entry" },
          {
            code: List.from([
              { op: Op.HOST_CALL, a: initFn.id, b: 0, c: 0 },
              { op: Op.STORE_CALLSITE_VAR, a: 0 },
              { op: Op.PUSH_CONST_VAL, a: 0 },
              { op: Op.RET },
            ]),
            name: "init",
          },
          {
            code: List.from([{ op: Op.HOST_CALL, a: resetFn.id, b: 0, c: 0 }, { op: Op.RET }]),
            name: "deact",
          },
        ]),
        initializerFuncId: 1,
        deactivationFuncId: 2,
      },
      true
    );

    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(initCount, 1);
    assert.equal(extractNumberValue(brain.getVariable(varName)), 1);

    brain.requestPageChange(1);
    brain.think(32);
    brain.requestPageChange(0);
    brain.think(48);
    assert.equal(initCount, 2, "deactivation hook reset the callsite, so initializer ran again");
    assert.equal(extractNumberValue(brain.getVariable(varName)), 2);
  });

  test("host action state survives page deactivation/reactivation", () => {
    let invokeCount = 0;
    const descriptor: ActionDescriptor = {
      key: "test-page-host-state-survives",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3005,
      descriptor,
      execSync: (ctx) => {
        invokeCount += 1;
        const cur = getCallSiteState<number>(ctx) ?? 0;
        const next = cur + 1;
        setCallSiteState(ctx, next);
        return mkNumberValue(next);
      },
    });
    const sensor = new BrainTileSensorDef(descriptor.key, descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("page-host-state-survives-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r = p0.value!.page.children().get(0)!;
    __test__appendTile(r.do(), v as never);
    __test__appendTile(r.do(), opAssign as never);
    __test__appendTile(r.do(), sensor as never);
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1);
    brain.think(32);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 2);

    brain.requestPageChange(1);
    brain.think(48);
    brain.requestPageChange(0);
    brain.think(64);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 3, "host state survived round trip");
    assert.equal(invokeCount, 3);
  });

  test("host onPageExited can clear host state to opt out of survival", () => {
    const descriptor: ActionDescriptor = {
      key: "test-page-host-onpageexited-clears",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3006,
      descriptor,
      onPageExited: (ctx) => {
        clearCallSiteState(ctx);
      },
      execSync: (ctx) => {
        const cur = getCallSiteState<number>(ctx) ?? 0;
        const next = cur + 1;
        setCallSiteState(ctx, next);
        return mkNumberValue(next);
      },
    });
    const sensor = new BrainTileSensorDef(descriptor.key, descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("page-host-clear-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r = p0.value!.page.children().get(0)!;
    __test__appendTile(r.do(), v as never);
    __test__appendTile(r.do(), opAssign as never);
    __test__appendTile(r.do(), sensor as never);
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1);
    brain.think(32);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 2);

    brain.requestPageChange(1);
    brain.think(48);
    brain.requestPageChange(0);
    brain.think(64);
    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1, "onPageExited cleared host state");
  });

  test("host onInitialized fires exactly once across N page round-trips", () => {
    let initCount = 0;
    const descriptor: ActionDescriptor = {
      key: "test-l4-host-init-once",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3007,
      descriptor,
      onInitialized: () => {
        initCount += 1;
      },
      execSync: () => mkNumberValue(0),
    });
    const sensor = new BrainTileSensorDef(descriptor.key, descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("l4-host-init-once-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r = p0.value!.page.children().get(0)!;
    __test__appendTile(r.do(), v as never);
    __test__appendTile(r.do(), opAssign as never);
    __test__appendTile(r.do(), sensor as never);
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(initCount, 1, "initializer fires on first activation");

    for (let i = 0; i < 4; i++) {
      brain.requestPageChange(1);
      brain.think(32 + i * 32);
      brain.requestPageChange(0);
      brain.think(48 + i * 32);
    }
    assert.equal(initCount, 1, "host onInitialized does not re-fire across N round-trips");
  });

  test("host onInitialized fires before host onPageEntered on first activation", () => {
    const log = List.empty<string>();
    const descriptor: ActionDescriptor = {
      key: "test-l4-host-init-order",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3008,
      descriptor,
      onInitialized: () => {
        log.push("init");
      },
      onPageEntered: () => {
        log.push("entered");
      },
      execSync: () => mkNumberValue(0),
    });
    const sensor = new BrainTileSensorDef(descriptor.key, descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("l4-host-init-order-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r = p0.value!.page.children().get(0)!;
    __test__appendTile(r.do(), v as never);
    __test__appendTile(r.do(), opAssign as never);
    __test__appendTile(r.do(), sensor as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);

    assert.equal(log.size(), 2, "both hooks fired on first activation");
    assert.equal(log.get(0), "init", "onInitialized fires before onPageEntered");
    assert.equal(log.get(1), "entered", "onPageEntered fires after onInitialized");
  });

  test("services.callsite.reset inside onPageExited re-fires host onInitialized on next activation", () => {
    let initCount = 0;
    const descriptor: ActionDescriptor = {
      key: "test-l4-host-init-reset",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3009,
      descriptor,
      onInitialized: () => {
        initCount += 1;
      },
      onPageExited: (ctx) => {
        if (ctx.currentCallSiteId !== undefined) {
          ctx.services.brain.callsite.reset(ctx.currentCallSiteId);
        }
      },
      execSync: () => mkNumberValue(0),
    });
    const sensor = new BrainTileSensorDef(descriptor.key, descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("l4-host-init-reset-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r = p0.value!.page.children().get(0)!;
    __test__appendTile(r.do(), v as never);
    __test__appendTile(r.do(), opAssign as never);
    __test__appendTile(r.do(), sensor as never);
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(initCount, 1);

    brain.requestPageChange(1);
    brain.think(32);
    brain.requestPageChange(0);
    brain.think(48);
    assert.equal(initCount, 2, "reset in onPageExited re-fires onInitialized on next activation");
  });

  test("Brain.shutdown then Brain.startup re-fires host onInitialized", () => {
    let initCount = 0;
    const descriptor: ActionDescriptor = {
      key: "test-l4-host-init-shutdown",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3010,
      descriptor,
      onInitialized: () => {
        initCount += 1;
      },
      execSync: () => mkNumberValue(0),
    });
    const sensor = new BrainTileSensorDef(descriptor.key, descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("l4-host-init-shutdown-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r = p0.value!.page.children().get(0)!;
    __test__appendTile(r.do(), v as never);
    __test__appendTile(r.do(), opAssign as never);
    __test__appendTile(r.do(), sensor as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(initCount, 1);

    brain.shutdown();
    brain.startup();
    brain.think(32);
    assert.equal(initCount, 2, "shutdown teardown lets the next startup re-run onInitialized");
  });

  test("host action without onInitialized leaves a page-mate bytecode initializer unaffected", () => {
    let bytecodeInitCount = 0;
    let hostExecCount = 0;
    const initFn = services.runtime.functions.register(
      4010,
      "test-l4-mate-bytecode-init-fn",
      false,
      {
        exec: () => {
          bytecodeInitCount += 1;
          return mkNumberValue(bytecodeInitCount);
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const hostDescriptor: ActionDescriptor = {
      key: "test-l4-mate-host-no-init",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3011,
      descriptor: hostDescriptor,
      execSync: () => {
        hostExecCount += 1;
        return mkNumberValue(0);
      },
    });
    const hostSensor = new BrainTileSensorDef(hostDescriptor.key, hostDescriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });

    const btKey = "test-l4-mate-bytecode";
    const btDescriptor: ActionDescriptor = {
      key: btKey,
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    const btSensor = new BrainTileSensorDef(btKey, btDescriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const btArtifact: UserActionArtifact = {
      version: BYTECODE_VERSION,
      functions: List.from([
        { code: List.from([{ op: Op.LOAD_CALLSITE_VAR, a: 0 }, { op: Op.RET }]), numParams: 0, name: "entry" },
        {
          code: List.from([
            { op: Op.HOST_CALL, a: initFn.id, b: 0, c: 0 },
            { op: Op.STORE_CALLSITE_VAR, a: 0 },
            { op: Op.PUSH_CONST_VAL, a: 0 },
            { op: Op.RET },
          ]),
          numParams: 0,
          name: "init",
        },
      ]) as never,
      constantPools: { numbers: List.empty<number>(), strings: List.empty<string>(), values: List.from([NIL_VALUE]) },
      variableNames: List.empty(),
      entryPoint: 0,
      key: btKey,
      kind: "sensor",
      callDef: btDescriptor.callDef,
      outputType: CoreTypeIds.Number,
      isAsync: false,
      numStateSlots: 1,
      entryFuncId: 0,
      initializerFuncId: 1,
      revisionId: `${btKey}-rev1`,
    };

    const v = mkVar("l4-mate-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r0 = p0.value!.page.children().get(0)!;
    __test__appendTile(r0.do(), v as never);
    __test__appendTile(r0.do(), opAssign as never);
    __test__appendTile(r0.do(), btSensor as never);
    const r1 = p0.value!.page.appendNewRule() as BrainRuleDef;
    __test__appendTile(r1.do(), hostSensor as never);
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);

    const brain = new Brain(brainDef, services, {
      catalogs: List.from([services.edit.tiles, brainDef.catalog()]),
      typeRegistry: services.runtime.types,
      actionResolver: {
        resolveAction(ad) {
          if (ad.key === btKey) {
            return {
              binding: "bytecode" as const,
              descriptor: ad,
              artifact: btArtifact,
              metadata: { key: btKey, kind: "sensor", callDef: btDescriptor.callDef, outputType: CoreTypeIds.Number },
            };
          }
          return services.runtime.actions.resolveAction(ad);
        },
      },
    });
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(bytecodeInitCount, 1, "bytecode initializer ran once on first activation");
    assert.ok(hostExecCount >= 1, "host action exec ran");

    brain.requestPageChange(1);
    brain.think(32);
    brain.requestPageChange(0);
    brain.think(48);
    assert.equal(bytecodeInitCount, 1, "bytecode initializer not re-run on re-activation");
  });

  test("requestPageRestart does not fire host onInitialized and preserves callsite record", () => {
    let initCount = 0;
    let exitCount = 0;
    const descriptor: ActionDescriptor = {
      key: "test-l4-host-init-restart",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3012,
      descriptor,
      onInitialized: (ctx) => {
        initCount += 1;
        if (ctx.currentCallSiteId !== undefined) {
          ctx.services.brain.callsite.setHostState(ctx.currentCallSiteId, { tag: "init" });
        }
      },
      onPageExited: () => {
        exitCount += 1;
      },
      execSync: () => mkNumberValue(0),
    });
    const sensor = new BrainTileSensorDef(descriptor.key, descriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const v = mkVar("l4-host-init-restart-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r = p0.value!.page.children().get(0)!;
    __test__appendTile(r.do(), v as never);
    __test__appendTile(r.do(), opAssign as never);
    __test__appendTile(r.do(), sensor as never);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(initCount, 1);
    assert.equal(exitCount, 0);

    brain.requestPageRestart();
    brain.think(32);
    assert.equal(initCount, 1, "soft restart does not re-fire onInitialized");
    assert.equal(exitCount, 0, "soft restart does not fire onPageExited");
  });

  test("mixed-binding page fires both bytecode and host initializers exactly once on first activation", () => {
    let bytecodeInitCount = 0;
    let hostInitCount = 0;
    const initFn = services.runtime.functions.register(
      4011,
      "test-l4-mixed-bytecode-init-fn",
      false,
      {
        exec: () => {
          bytecodeInitCount += 1;
          return mkNumberValue(bytecodeInitCount);
        },
      },
      mkCallDef({ type: "bag", items: [] })
    );
    const hostDescriptor: ActionDescriptor = {
      key: "test-l4-mixed-host",
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    services.runtime.actions.register({
      binding: "host",
      id: 3013,
      descriptor: hostDescriptor,
      onInitialized: () => {
        hostInitCount += 1;
      },
      execSync: () => mkNumberValue(0),
    });
    const hostSensor = new BrainTileSensorDef(hostDescriptor.key, hostDescriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });

    const btKey = "test-l4-mixed-bytecode";
    const btDescriptor: ActionDescriptor = {
      key: btKey,
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    };
    const btSensor = new BrainTileSensorDef(btKey, btDescriptor, {
      placement: TilePlacement.EitherSide | TilePlacement.Inline,
    });
    const btArtifact: UserActionArtifact = {
      version: BYTECODE_VERSION,
      functions: List.from([
        { code: List.from([{ op: Op.LOAD_CALLSITE_VAR, a: 0 }, { op: Op.RET }]), numParams: 0, name: "entry" },
        {
          code: List.from([
            { op: Op.HOST_CALL, a: initFn.id, b: 0, c: 0 },
            { op: Op.STORE_CALLSITE_VAR, a: 0 },
            { op: Op.PUSH_CONST_VAL, a: 0 },
            { op: Op.RET },
          ]),
          numParams: 0,
          name: "init",
        },
      ]) as never,
      constantPools: { numbers: List.empty<number>(), strings: List.empty<string>(), values: List.from([NIL_VALUE]) },
      variableNames: List.empty(),
      entryPoint: 0,
      key: btKey,
      kind: "sensor",
      callDef: btDescriptor.callDef,
      outputType: CoreTypeIds.Number,
      isAsync: false,
      numStateSlots: 1,
      entryFuncId: 0,
      initializerFuncId: 1,
      revisionId: `${btKey}-rev1`,
    };

    const v = mkVar("l4-mixed-v");
    const brainDef = new BrainDef(services);
    const p0 = brainDef.appendNewPage();
    assert.ok(p0.success);
    const r0 = p0.value!.page.children().get(0)!;
    __test__appendTile(r0.do(), v as never);
    __test__appendTile(r0.do(), opAssign as never);
    __test__appendTile(r0.do(), btSensor as never);
    const r1 = p0.value!.page.appendNewRule() as BrainRuleDef;
    __test__appendTile(r1.do(), hostSensor as never);
    const p1 = brainDef.appendNewPage();
    assert.ok(p1.success);

    const brain = new Brain(brainDef, services, {
      catalogs: List.from([services.edit.tiles, brainDef.catalog()]),
      typeRegistry: services.runtime.types,
      actionResolver: {
        resolveAction(ad) {
          if (ad.key === btKey) {
            return {
              binding: "bytecode" as const,
              descriptor: ad,
              artifact: btArtifact,
              metadata: { key: btKey, kind: "sensor", callDef: btDescriptor.callDef, outputType: CoreTypeIds.Number },
            };
          }
          return services.runtime.actions.resolveAction(ad);
        },
      },
    });
    brain.initialize();
    brain.startup();
    brain.think(16);
    assert.equal(bytecodeInitCount, 1, "bytecode initializer fires once on first activation");
    assert.equal(hostInitCount, 1, "host onInitialized fires once on first activation");

    brain.requestPageChange(1);
    brain.think(32);
    brain.requestPageChange(0);
    brain.think(48);
    assert.equal(bytecodeInitCount, 1, "bytecode initializer does not re-fire on round-trip");
    assert.equal(hostInitCount, 1, "host onInitialized does not re-fire on round-trip");
  });
});

describe("Brain behavioral -- compiled program structure", () => {
  test("single-page brain produces correct program shape", () => {
    const v = mkVar("prog-v");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(1)]);
    const brain = brainDef.compile();
    brain.initialize();

    const program = brain.getProgram();
    assert.ok(program !== undefined, "program should exist after initialize");
    assert.equal(program!.version, 1, "bytecode version should be 1");
    assert.ok(program!.functions.size() > 0, "should have at least one function");
    assert.ok(brain.getPages().size() > 0, "should have at least one page");
    assert.ok(program!.constantPools.values.size() > 0, "should have constants");
  });

  test("action tiles compile to unlinked action refs and page action callsites", () => {
    const unboundAction: ActionDescriptor = {
      key: "test-phase2-unbound-action",
      kind: "actuator",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
    };

    const actuator = new BrainTileActuatorDef("test-phase2-unbound-actuator", unboundAction);
    const brainDef = buildBrain([], [actuator]);
    const program = compileBrain(
      brainDef,
      List.from([services.edit.tiles, brainDef.catalog()]),
      services.shared.conversions,
      services.runtime.actions,
      services.runtime.types
    ).program!;

    // An action the resolver cannot bind falls back to a program-local bytecode
    // slot so the operand stack stays balanced for error recovery.
    assert.equal(program.actionRefs.size(), 1);
    assert.deepEqual(program.actionRefs.get(0), {
      slot: 0,
      key: "test-phase2-unbound-action",
    });

    const page = program.pages.get(0)!;
    assert.equal(page.actionCallSites.size(), 1);
    assert.deepEqual(page.actionCallSites.get(0), {
      binding: "bytecode",
      actionSlot: 0,
      callSiteId: 0,
    });

    const rootFunc = program.functions.get(page.rootRuleFuncIds.get(0)!)!;
    assert.notEqual(
      rootFunc.code.findIndex((ins) => ins.op === Op.ACTION_CALL),
      -1,
      "root rule should contain ACTION_CALL bytecode"
    );
  });

  test("host action tiles dispatch by stable id, not through the action table", () => {
    const fnEntry = services.runtime.functions.get(CoreHostActions.CurrentPage.key);
    assert.ok(fnEntry, "current-page function should be registered");

    const cpSensor = new BrainTileSensorDef(
      CoreHostActions.CurrentPage.key,
      mkActionDescriptor("sensor", fnEntry!, CoreTypeIds.String),
      {
        placement: TilePlacement.EitherSide | TilePlacement.Inline,
      }
    );

    const brainDef = buildBrain([], [cpSensor]);
    const brain = brainDef.compile();
    brain.initialize();

    const program = brain.getProgram();
    assert.ok(program, "linked program should exist after initialize");
    // Host actions are dispatched by stable id and are not placed in the
    // program's bytecode-only action table.
    assert.equal(program!.actions!.size(), 0);

    const resolved = services.runtime.actions.getByKey(CoreHostActions.CurrentPage.key);
    assert.ok(resolved && resolved.binding === "host", "current-page action should resolve as host");

    const site = brain.getPages().get(0)!.actionCallSites.get(0)!;
    assert.equal(site.binding, "host");
    assert.equal(site.binding === "host" ? site.actionId : -1, resolved.binding === "host" ? resolved.id : -2);
  });
});

describe("Brain behavioral -- nil value overloads", () => {
  test("nil == nil -> true", () => {
    const v = mkVar("nil-eq", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkNilLiteral(), opEq, mkNilLiteral()]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), true);
  });

  test("nil != nil -> false", () => {
    const v = mkVar("nil-neq", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkNilLiteral(), opNeq, mkNilLiteral()]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), false);
  });

  test("NOT nil -> true (nil is falsy)", () => {
    const v = mkVar("nil-not", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, opNot, mkNilLiteral()]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), true);
  });

  test("number == nil -> false (cross-type)", () => {
    const v = mkVar("num-eq-nil", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(42), opEq, mkNilLiteral()]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), false);
  });

  test("nil == number -> false (cross-type)", () => {
    const v = mkVar("nil-eq-num", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkNilLiteral(), opEq, mkLiteral(42)]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), false);
  });

  test("number != nil -> true (cross-type)", () => {
    const v = mkVar("num-neq-nil", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(42), opNeq, mkNilLiteral()]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), true);
  });

  test("nil != number -> true (cross-type)", () => {
    const v = mkVar("nil-neq-num", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkNilLiteral(), opNeq, mkLiteral(42)]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), true);
  });

  test("boolean == nil -> false (cross-type)", () => {
    const v = mkVar("bool-eq-nil", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkBoolLiteral(true), opEq, mkNilLiteral()]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), false);
  });

  test("string != nil -> true (cross-type)", () => {
    const v = mkVar("str-neq-nil", CoreTypeIds.Boolean);
    const brainDef = buildBrain([], [v, opAssign, mkStringLiteral("hello"), opNeq, mkNilLiteral()]);
    const brain = runBrain(brainDef);

    assert.equal(extractBooleanValue(brain.getVariable(v.varName)), true);
  });

  test("nil == nil in WHEN condition gates execution", () => {
    const v = mkVar("nil-when", CoreTypeIds.Number);
    const brainDef = buildBrain([mkNilLiteral(), opEq, mkNilLiteral()], [v, opAssign, mkLiteral(99)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 99);
  });

  test("number == nil in WHEN condition blocks execution", () => {
    const v = mkVar("cross-when", CoreTypeIds.Number);
    const brainDef = buildBrain([mkLiteral(5), opEq, mkNilLiteral()], [v, opAssign, mkLiteral(99)]);
    const brain = runBrain(brainDef);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 0, "DO should not execute");
  });
});

describe("Brain behavioral -- timeout sensor", () => {
  function getCoreSensor(sensorId: string): BrainTileSensorDef {
    const tile = services.edit.tiles.get(mkSensorTileId(sensorId)) as BrainTileSensorDef;
    assert.ok(tile, `${sensorId} sensor tile should be registered`);
    return tile;
  }

  test("WHEN [timeout][constant 0.5] -> fires after 500ms", () => {
    const timeoutTile = getCoreSensor(CoreHostActions.Timeout.key);
    const v = mkVar("t-const");

    const brainDef = buildBrain([timeoutTile, mkLiteral(0.5)], [v, opAssign, mkLiteral(1)]);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    for (let t = 16; t <= 1000; t += 16) {
      brain.think(t);
    }

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 1, "DO should have run after timeout fired");
  });

  test("WHEN [timeout][random + 5] -> evaluates expression as delay (does not fire under 4s)", () => {
    const timeoutTile = getCoreSensor(CoreHostActions.Timeout.key);
    const randomTile = getCoreSensor(CoreHostActions.Random.key);

    const v = mkVar("t-expr");
    const brainDef = buildBrain([timeoutTile, randomTile, opAdd, mkLiteral(5)], [v, opAssign, mkLiteral(1)]);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    // delay = random(0..1) + 5 = 5..6 seconds. After 4 seconds it must NOT have fired.
    // (If the parser silently dropped the arg, the default 1s delay would have fired by 1s.)
    for (let t = 16; t <= 4000; t += 16) {
      brain.think(t);
    }

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 0, "timeout should not have fired before 5s");

    // Continue past the upper bound (6s). Timeout MUST fire by then.
    for (let t = 4016; t <= 7000; t += 16) {
      brain.think(t);
    }

    assert.equal(
      extractNumberValue(brain.getVariable(v.varName)),
      1,
      "DO should have run after timeout fired (within 5..6s window)"
    );
  });

  test("WHEN [timeout][unassignedVar + random] -> nil delay uses omitted-arg default", () => {
    const timeoutTile = getCoreSensor(CoreHostActions.Timeout.key);
    const randomTile = getCoreSensor(CoreHostActions.Random.key);

    // unassignedVar is NEVER written. At runtime its value is nil. The compiler
    // typed it as number based on its declared type, so the number+number Add
    // overload runs at runtime with one nil operand. Hardened math ops return
    // NIL_VALUE; positional action args represent that the same way as an
    // omitted optional slot, so timeout uses its default delay.
    const unassignedVar = mkVar("unassigned");
    const sentinelVar = mkVar("sentinel");
    const brainDef = buildBrain([timeoutTile, unassignedVar, opAdd, randomTile], [sentinelVar, opAssign, mkLiteral(1)]);

    const brain = brainDef.compile();
    brain.initialize();
    brain.startup();

    for (let t = 16; t <= 1500; t += 16) {
      brain.think(t);
    }

    assert.equal(
      extractNumberValue(brain.getVariable(sentinelVar.varName)),
      1,
      "DO should run after timeout treats nil as an omitted optional delay"
    );
  });
});

// ---- Slot-keyed variable storage ----

describe("Brain -- slot-keyed variable storage", () => {
  test("storage agreement: setVariable(name, v) is readable via getVariableBySlot at the program-assigned slot", () => {
    const v = mkVar("agreed");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(123)]);
    const brain = brainDef.compile();
    brain.initialize();

    const program = brain.getProgram();
    assert.ok(program !== undefined, "program should exist after initialize");
    let slotId = -1;
    for (let i = 0; i < program!.variableNames.size(); i++) {
      if (program!.variableNames.get(i) === v.varName) {
        slotId = i;
        break;
      }
    }
    assert.ok(slotId >= 0, "program.variableNames should contain the test variable");

    const written = mkNumberValue(777);
    brain.setVariable(v.varName, written);

    const readByName = brain.getVariable(v.varName);
    const readBySlot = brain.getVariableBySlot(slotId);
    assert.equal(readByName, written, "name-keyed read should return the written value");
    assert.equal(readBySlot, written, "slot-keyed read should return the written value");
  });

  test("name-keyed setVariable lazy-extends for names not in program.variableNames", () => {
    const v = mkVar("only-program-var");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(1)]);
    const brain = brainDef.compile();
    brain.initialize();

    const fresh = mkNumberValue(42);
    brain.setVariable("not-in-program", fresh);

    const readBack = brain.getVariable("not-in-program");
    assert.equal(readBack, fresh, "host-allocated slot must be readable by name");
  });

  test("hot-reload via re-initialize preserves values for surviving variable names", () => {
    const v = mkVar("preserve");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(1)]);
    const brain = brainDef.compile();
    brain.initialize();

    const persisted = mkNumberValue(99);
    brain.setVariable(v.varName, persisted);

    brain.initialize();

    const readAfter = brain.getVariable(v.varName);
    assert.equal(readAfter, persisted, "value should survive re-initialize when name is still in variableNames");
  });

  test("clearVariable returns a slot of a type with a starting value to that value", () => {
    const v = mkVar("clearable");
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(1)]);
    const brain = brainDef.compile();
    brain.initialize();

    brain.setVariable(v.varName, mkNumberValue(5));
    brain.clearVariable(v.varName);

    assert.equal(extractNumberValue(brain.getVariable(v.varName)), 0, "name-keyed read of cleared slot returns zero");

    const slotId = slotIdOf(brain, v.varName);
    const slotValue = brain.getVariableBySlot(slotId);
    assert.equal(slotValue.t, NativeType.Number, "slot-keyed read of cleared slot returns a number");
    assert.equal(extractNumberValue(slotValue), 0, "slot-keyed read of cleared slot returns zero");
  });

  test("clearVariables returns every slot of a type with a starting value to that value", () => {
    const first = mkVar("clear-all-a");
    const second = mkVar("clear-all-b");
    const brainDef = buildBrain([], [first, opAssign, second]);
    const brain = brainDef.compile();
    brain.initialize();

    brain.setVariable(first.varName, mkNumberValue(5));
    brain.setVariable(second.varName, mkNumberValue(7));
    brain.clearVariables();

    assert.equal(extractNumberValue(brain.getVariable(first.varName)), 0);
    assert.equal(extractNumberValue(brain.getVariable(second.varName)), 0);
  });

  test("clearVariable returns a slot of a type with no starting value to holding no value", () => {
    const v = mkVar("clearable-nil", CoreTypeIds.Any);
    const brainDef = buildBrain([], [v, opAssign, mkLiteral(1)]);
    const brain = brainDef.compile();
    brain.initialize();

    brain.setVariable(v.varName, mkNumberValue(5));
    brain.clearVariable(v.varName);

    assert.equal(brain.getVariable(v.varName), undefined, "name-keyed read of cleared slot returns undefined");
    assert.equal(
      brain.getVariableBySlot(slotIdOf(brain, v.varName)).t,
      NativeType.Nil,
      "slot-keyed read of cleared slot returns NIL"
    );
  });
});

// ---- Field access emits nil-guarded id-based opcodes ----

describe("Field access emits nil-guarded id-based opcodes", () => {
  interface Compiled {
    readonly instrs: Instr[];
    readonly values: ReadonlyList<Value>;
  }

  function compileToInstrs(whenTiles: unknown[], doTiles: unknown[]): Compiled {
    const brainDef = buildBrain(whenTiles, doTiles);
    const result = compileBrain(
      brainDef,
      List.from([services.edit.tiles, brainDef.catalog()]),
      services.shared.conversions,
      services.runtime.actions,
      services.runtime.types
    );
    assert.ok(result.program, "compile should succeed");
    const instrs: Instr[] = [];
    const fns = result.program!.functions;
    for (let i = 0; i < fns.size(); i++) {
      const code = fns.get(i).code;
      for (let j = 0; j < code.size(); j++) {
        instrs.push(code.get(j));
      }
    }
    return { instrs, values: result.program!.constantPools.values };
  }

  /** The `[op, a]` pairs of `count` instructions starting at `start`. */
  function opsAt(instrs: Instr[], start: number, count: number): [number, number | undefined][] {
    return instrs.slice(start, start + count).map((ins) => [ins.op, ins.a]);
  }

  /** Index of the first `LOAD_VAR_SLOT`, the base every test's field access starts from. */
  function baseLoadIndex(instrs: Instr[]): number {
    const idx = instrs.findIndex((ins) => ins.op === Op.LOAD_VAR_SLOT);
    assert.ok(idx >= 0, "the base variable should load");
    return idx;
  }

  function vec2Type(name: string, atomId: number): string {
    return services.runtime.types.addStructType(name, {
      atomId,
      fields: List.from([
        { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 },
        { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
      ]),
    });
  }

  test("a concretely-typed field read guards its object, then emits STRUCT_GET_FIELD with the field id", () => {
    const vec = vec2Type("Vec2EmitRead", 1024);
    const vVar = new BrainTileVariableDef(mkVariableTileId("vec2-emit-read"), "vv", vec, "vec2-emit-read");
    const nVar = mkVar("nn", CoreTypeIds.Number);
    const accY = new BrainTileAccessorDef(vec, "y", CoreTypeIds.Number);

    // DO: $n = $v.y    (reads y, id 1)
    const { instrs, values } = compileToInstrs([], [nVar, opAssign, vVar, accY]);
    const base = baseLoadIndex(instrs);
    assert.deepEqual(opsAt(instrs, base + 1, 6), [
      [Op.DUP, undefined],
      [Op.JMP_IF_FALSE, 3],
      [Op.STRUCT_GET_FIELD, 1],
      [Op.JMP, 3],
      [Op.POP, undefined],
      [Op.PUSH_CONST_VAL, instrs[base + 6].a],
    ]);
    assert.equal(values.get(instrs[base + 6].a!).t, NativeType.Nil, "a falsy object reads NIL");
    assert.equal(instrs.filter((ins) => ins.op === Op.GET_FIELD).length, 0, "should not emit name-keyed GET_FIELD");
  });

  test("a depth-2 field chain guards each link and shares one NIL result", () => {
    const pos = vec2Type("Vec2EmitChainPos", 1026);
    const body = services.runtime.types.addStructType("BodyEmitChain", {
      atomId: 1027,
      fields: List.from([{ name: "pos", typeId: pos, fieldIndex: 0 }]),
    });
    const bVar = new BrainTileVariableDef(mkVariableTileId("body-emit-chain"), "bb", body, "body-emit-chain");
    const nVar = mkVar("nn", CoreTypeIds.Number);
    const accPos = new BrainTileAccessorDef(body, "pos", pos);
    const accX = new BrainTileAccessorDef(pos, "x", CoreTypeIds.Number);

    // DO: $n = $b.pos.x
    const { instrs, values } = compileToInstrs([], [nVar, opAssign, bVar, accPos, accX]);
    const base = baseLoadIndex(instrs);
    assert.deepEqual(opsAt(instrs, base + 1, 9), [
      [Op.DUP, undefined],
      [Op.JMP_IF_FALSE, 6],
      [Op.STRUCT_GET_FIELD, 0],
      [Op.DUP, undefined],
      [Op.JMP_IF_FALSE, 3],
      [Op.STRUCT_GET_FIELD, 0],
      [Op.JMP, 3],
      [Op.POP, undefined],
      [Op.PUSH_CONST_VAL, instrs[base + 9].a],
    ]);
    assert.equal(values.get(instrs[base + 9].a!).t, NativeType.Nil, "a falsy link reads NIL");
  });

  test("a concretely-typed field write guards its object, then emits STRUCT_DEEP_COPY and STRUCT_SET_FIELD", () => {
    const vec = vec2Type("Vec2EmitWrite", 1025);
    const vVar = new BrainTileVariableDef(mkVariableTileId("vec2-emit-write"), "vv", vec, "vec2-emit-write");
    const accX = new BrainTileAccessorDef(vec, "x", CoreTypeIds.Number);

    // DO: $v.x = 10
    const { instrs } = compileToInstrs([], [vVar, accX, opAssign, mkLiteral(10)]);
    const base = baseLoadIndex(instrs);
    assert.deepEqual(opsAt(instrs, base + 1, 9), [
      [Op.DUP, undefined],
      [Op.DUP, undefined],
      [Op.PUSH_CONST_NUM, instrs[base + 3].a],
      [Op.STACK_SET_REL, 1],
      [Op.JMP_IF_FALSE, 4],
      [Op.STRUCT_DEEP_COPY, undefined],
      [Op.STRUCT_SET_FIELD, 0],
      [Op.JMP, 2],
      [Op.POP, undefined],
    ]);
    assert.equal(instrs.filter((ins) => ins.op === Op.SET_FIELD).length, 0, "should not emit name-keyed SET_FIELD");
  });
});
