/**
 * Agreement between a warning-severity build diagnostic and the program the
 * build emits. The warning-severity parse diagnostics,
 * `CompilationDiagCode.UncompilableExpressionDropped`, and the warning-severity
 * type diagnostics each report a recovery, and the build still produces a
 * program; these tests pin that the program the VM receives honours that claim
 * -- it runs without faulting and the rules the recovery did not touch still
 * act.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  coreModule,
  createHostActuator,
  createHostSensor,
  createWendooEnvironment,
  List,
  type ReadonlyList,
  type WendooEnvironment,
  type WendooModule,
} from "@wendoo/core";
import type { IBrainDef, IBrainTileDef } from "@wendoo/core/brain";
import {
  CoreControlFlowId,
  mkAccessorTileId,
  mkControlFlowTileId,
  mkOperatorTileId,
  RuleSide,
} from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import type { BrainBuildDiagnostic, DiagCode } from "@wendoo/core/brain/compiler";
import { CompilationDiagCode, ParseDiagCode, TypeDiagCode } from "@wendoo/core/brain/compiler";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, BrainTileModifierDef, BrainTileParameterDef } from "@wendoo/core/brain/tiles";
import {
  bag,
  CoreOpId,
  CoreTypeIds,
  type ErrorValue,
  getSlotId,
  mkCallDef,
  mkTypeId,
  mod,
  NativeType,
  optional,
  param,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";

const kSteerKey = "droppedspec.steer";
const kMarkKey = "droppedspec.mark";
const kVoidSensorKey = "droppedspec.nothing";
const kSteadyModifierId = "droppedspec-steady";
const kFastModifierId = "droppedspec-fast";
const kAmountParameterId = "droppedspec-amount";
const kPosTypeId = mkTypeId(NativeType.Struct, "DroppedSpecPos");
const kBodyTypeId = mkTypeId(NativeType.Struct, "DroppedSpecBody");

/**
 * Native type tag of each positional argument one `steer` call received, in
 * slot order. `NativeType.Nil` marks a slot the call left unsupplied.
 */
type SteerArgTags = Value["t"][];

/** Tiles and observations the fixture module contributes to a test environment. */
interface Fixture {
  readonly module: WendooModule;
  /** Actuator with two modifier slots and a trailing named number-parameter slot. */
  readonly steerTile: IBrainTileDef;
  /** No-argument actuator, used to observe that a rule ran. */
  readonly markTile: IBrainTileDef;
  /** Inline sensor whose result type is `Void`, which no operator overload accepts. */
  readonly voidSensorTile: IBrainTileDef;
  /** Modifier tile of the `steer` call's second modifier slot. */
  readonly fastTile: IBrainTileDef;
  /** Named parameter tile of the `steer` call's number slot. */
  readonly amountTile: IBrainTileDef;
  /** Slot id the `fast` modifier fills. */
  readonly fastSlotId: number;
  /** Slot id the `amount` parameter fills. */
  readonly amountSlotId: number;
  /** One entry per `steer` dispatch, in dispatch order. */
  readonly steerCalls: SteerArgTags[];
  /** Number of `mark` dispatches. */
  markCalls(): number;
}

/** A host module carrying the actuators, the modifier, and the parameter these tests place into rules. */
function createFixture(): Fixture {
  const steadyTile = new BrainTileModifierDef(kSteadyModifierId);
  const fastTile = new BrainTileModifierDef(kFastModifierId);
  const amountTile = new BrainTileParameterDef(kAmountParameterId, CoreTypeIds.Number);
  const steerCallDef = mkCallDef(
    bag(optional(mod(kSteadyModifierId)), optional(mod(kFastModifierId)), optional(param(kAmountParameterId)))
  );

  const steerCalls: SteerArgTags[] = [];
  let markCalls = 0;

  const steer = createHostActuator({
    key: kSteerKey,
    actionId: TARGET_ACTION_ID_BASE,
    fnId: TARGET_FUNC_ID_BASE,
    callDef: steerCallDef,
    fn: {
      exec: (_ctx, args: ReadonlyList<Value>): Value => {
        const tags: SteerArgTags = [];
        for (let i = 0; i < args.size(); i++) {
          tags.push(args.get(i).t);
        }
        steerCalls.push(tags);
        return VOID_VALUE;
      },
    },
  });

  const mark = createHostActuator({
    key: kMarkKey,
    actionId: TARGET_ACTION_ID_BASE + 1,
    fnId: TARGET_FUNC_ID_BASE + 1,
    callDef: mkCallDef({ type: "bag", items: [] }),
    fn: {
      exec: (): Value => {
        markCalls++;
        return VOID_VALUE;
      },
    },
  });

  const voidSensor = createHostSensor({
    key: kVoidSensorKey,
    actionId: TARGET_ACTION_ID_BASE + 2,
    fnId: TARGET_FUNC_ID_BASE + 2,
    callDef: mkCallDef({ type: "bag", items: [] }),
    outputType: CoreTypeIds.Void,
    inline: true,
    fn: { exec: (): Value => VOID_VALUE },
  });

  return {
    steerTile: steer.tile,
    markTile: mark.tile,
    voidSensorTile: voidSensor.tile,
    fastTile,
    amountTile,
    fastSlotId: getSlotId(steerCallDef, fastTile.tileId),
    amountSlotId: getSlotId(steerCallDef, amountTile.tileId),
    steerCalls,
    markCalls: () => markCalls,
    module: {
      id: "dropped-expression-spec-host",
      install(api): void {
        api.defineType({
          coreType: NativeType.Struct,
          typeId: kPosTypeId,
          name: "DroppedSpecPos",
          atomId: 1024,
          fields: List.from([{ name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
          accessors: true,
        });
        api.defineType({
          coreType: NativeType.Struct,
          typeId: kBodyTypeId,
          name: "DroppedSpecBody",
          atomId: 1025,
          fields: List.from([{ name: "pos", typeId: kPosTypeId, fieldIndex: 0 }]),
          accessors: true,
        });
        api.registerHostActuator(steer);
        api.registerHostActuator(mark);
        api.registerHostSensor(voidSensor);
        api.registerTile(steadyTile);
        api.registerTile(fastTile);
        api.registerTile(amountTile);
      },
    },
  };
}

/** An environment carrying `fixture`, and an empty single-rule brain in it. */
function newBrain(fixture: Fixture): {
  environment: WendooEnvironment;
  brainDef: BrainDef;
  page: BrainPageDef;
  rule: BrainRuleDef;
} {
  const environment = createWendooEnvironment({ modules: [coreModule(), fixture.module] });
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Dropped Expression Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  return { environment, brainDef, page, rule: page.children().get(0) as BrainRuleDef };
}

/** What a build-and-run of one brain observed. */
interface RunOutcome {
  /** Every diagnostic the build reported. */
  readonly diagnostics: BrainBuildDiagnostic[];
  /** True when the build produced a linked program. */
  readonly linked: boolean;
  /** Every fault the VM raised while the brain ran. */
  readonly faults: ErrorValue[];
  /** Firing outcome of each rule that reached its WHEN gate, keyed by rule function id. */
  readonly gates: Map<number, boolean>;
}

/** Links `def`, then runs `thinks` think steps of it, collecting diagnostics, faults, and WHEN gates. */
function buildAndRun(environment: WendooEnvironment, def: IBrainDef, thinks = 2): RunOutcome {
  const build = environment.linkBrain(def);
  const faults: ErrorValue[] = [];
  const gates = new Map<number, boolean>();

  const brain = environment.createBrain(def, {
    vmEvents: {
      onFiberFault: ({ err }) => {
        faults.push(err);
      },
      onRuleWhenGate: ({ ruleFuncId, fired }) => {
        if (ruleFuncId !== undefined) gates.set(ruleFuncId, fired);
      },
    },
  });
  brain.startup();
  for (let i = 0; i < thinks; i++) {
    brain.think(16);
  }

  return { diagnostics: build.diagnostics.toArray(), linked: build.program !== undefined, faults, gates };
}

/** Diagnostics of `outcome` whose code is the dropped-expression warning. */
function droppedDiags(outcome: RunOutcome): BrainBuildDiagnostic[] {
  return outcome.diagnostics.filter((d) => d.code === CompilationDiagCode.UncompilableExpressionDropped);
}

/** Diagnostics of `outcome` carrying `code`. */
function diagsWithCode(outcome: RunOutcome, code: DiagCode): BrainBuildDiagnostic[] {
  return outcome.diagnostics.filter((d) => d.code === code);
}

/** Error-severity diagnostics of `outcome`. */
function errorDiags(outcome: RunOutcome): BrainBuildDiagnostic[] {
  return outcome.diagnostics.filter((d) => d.severity === "error");
}

/** Asserts `outcome` links, reports no error, and ran without a VM fault. */
function assertRecovered(outcome: RunOutcome): void {
  assert.deepEqual(errorDiags(outcome), [], "a dropped expression must not block the build");
  assert.ok(outcome.linked, "the build must still produce a program");
  assert.deepEqual(
    outcome.faults.map((f) => f.code),
    [],
    `the emitted program must run without faulting: ${outcome.faults.map((f) => f.message).join(" | ")}`
  );
}

describe("a dropped expression leaves a program the VM runs", () => {
  test("a value-less named parameter drops only its value and keeps the call", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    __test__appendTile(rule.do(), fixture.steerTile);
    __test__appendTile(rule.do(), fixture.fastTile);
    __test__appendTile(rule.do(), fixture.amountTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRecovered(outcome);
    const dropped = droppedDiags(outcome);
    assert.equal(dropped.length, 1, "the parameter's missing value is reported once");
    assert.equal(dropped[0]!.params?.side, RuleSide.Do);

    assert.ok(fixture.steerCalls.length > 0, "the call the drop happened inside still dispatched");
    const tags = fixture.steerCalls[0]!;
    assert.notEqual(tags[fixture.fastSlotId], NativeType.Nil, "the supplied modifier slot still arrives");
    assert.equal(tags[fixture.amountSlotId], NativeType.Nil, "the dropped value leaves its slot unsupplied");
  });

  test("a dropped DO side leaves the sibling rule running", () => {
    const fixture = createFixture();
    const { environment, brainDef, page, rule } = newBrain(fixture);

    // A parameter tile alone is not an expression: the whole DO side drops.
    __test__appendTile(rule.do(), fixture.amountTile);
    __test__appendTile(page.appendNewRule()!.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRecovered(outcome);
    assert.equal(droppedDiags(outcome).length, 1);
    assert.equal(droppedDiags(outcome)[0]!.params?.side, RuleSide.Do);
    assert.ok(fixture.markCalls() > 0, "the sibling rule still acts");
    assert.equal(fixture.steerCalls.length, 0);
  });

  test("a dropped WHEN side gates its rule off instead of faulting", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    __test__appendTile(rule.when(), fixture.amountTile);
    __test__appendTile(rule.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRecovered(outcome);
    assert.equal(droppedDiags(outcome).length, 1);
    assert.equal(droppedDiags(outcome)[0]!.params?.side, RuleSide.When);
    assert.deepEqual([...outcome.gates.values()], [false], "the rule reached its gate and did not fire");
    assert.equal(fixture.markCalls(), 0, "a rule whose WHEN dropped does not run its DO");
  });

  test("an invalid assignment target drops the assignment and keeps the sibling rule", () => {
    const fixture = createFixture();
    const { environment, brainDef, page, rule } = newBrain(fixture);
    const services = environment.brainServices;
    const assign = services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign))!;

    __test__appendTile(rule.do(), new BrainTileLiteralDef(CoreTypeIds.Number, 1, {}, services));
    __test__appendTile(rule.do(), assign);
    __test__appendTile(rule.do(), new BrainTileLiteralDef(CoreTypeIds.Number, 2, {}, services));
    __test__appendTile(page.appendNewRule()!.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRecovered(outcome);
    assert.equal(droppedDiags(outcome).length, 1);
    assert.ok(fixture.markCalls() > 0, "the sibling rule still acts");
  });

  test("an expression after the side's first expression drops without disturbing the first", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    __test__appendTile(rule.do(), fixture.markTile);
    __test__appendTile(rule.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef, 1);

    assertRecovered(outcome);
    assert.equal(droppedDiags(outcome).length, 1);
    assert.equal(fixture.markCalls(), 1, "only the surviving first expression ran");
  });

  test("a binary operator with no overload gates its rule off instead of faulting", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);
    const services = environment.brainServices;

    // Void reaches no overload of `add` and converts to nothing.
    __test__appendTile(rule.when(), fixture.voidSensorTile);
    __test__appendTile(rule.when(), services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add))!);
    __test__appendTile(rule.when(), new BrainTileLiteralDef(CoreTypeIds.Number, 1, {}, services));
    __test__appendTile(rule.do(), fixture.markTile);
    rule.typecheck();

    const typeDiags = rule.when().typecheckResult()!.typeInfo.diags.toArray();
    assert.ok(
      typeDiags.some((d) => d.code === TypeDiagCode.NoOverloadForBinaryOp),
      "the operand types must reach no overload"
    );

    const outcome = buildAndRun(environment, brainDef);

    assertRecovered(outcome);
    assert.deepEqual(droppedDiags(outcome), [], "an unmatched overload is not an expression drop");
    assert.deepEqual([...outcome.gates.values()], [false], "the rule reached its gate and did not fire");
    assert.equal(fixture.markCalls(), 0);
  });

  test("a recovered base under two accessors reads nil, gating its rule off instead of faulting", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);
    const tiles = environment.brainServices.edit.tiles;

    // An empty group stands NIL in for the base of `[pos] [x]`.
    __test__appendTile(rule.when(), tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!);
    __test__appendTile(rule.when(), tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!);
    __test__appendTile(rule.when(), tiles.get(mkAccessorTileId(kBodyTypeId, "pos"))!);
    __test__appendTile(rule.when(), tiles.get(mkAccessorTileId(kPosTypeId, "x"))!);
    __test__appendTile(rule.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRecovered(outcome);
    assert.ok(droppedDiags(outcome).length > 0, "the empty group is reported as a drop");
    assert.deepEqual([...outcome.gates.values()], [false], "the rule reached its gate and did not fire");
    assert.equal(fixture.markCalls(), 0);
  });

  test("a brain with no dropped expression reports none and runs", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    __test__appendTile(rule.do(), fixture.steerTile);
    __test__appendTile(rule.do(), fixture.fastTile);

    const outcome = buildAndRun(environment, brainDef, 1);

    assertRecovered(outcome);
    assert.deepEqual(droppedDiags(outcome), []);
    assert.equal(fixture.steerCalls.length, 1);
  });
});

/**
 * Asserts `outcome` recovered and reports `code`, with every instance of it
 * naming `rulePath` at "warning" severity.
 */
function assertReportedAt(outcome: RunOutcome, code: DiagCode, rulePath: string): void {
  assertRecovered(outcome);
  const reported = diagsWithCode(outcome, code);
  assert.ok(reported.length > 0, `the build must report code ${code}`);
  for (const diag of reported) {
    assert.equal(diag.severity, "warning");
    assert.equal(diag.params?.rulePath, rulePath);
  }
}

describe("a recovered parse shape reaches the build result under its own code", () => {
  test("a sub-expression with no operand names the parse code, not only the drop", () => {
    const fixture = createFixture();
    const { environment, brainDef, page, rule } = newBrain(fixture);
    const services = environment.brainServices;

    // `1 +` with nothing to its right: the operand is a sub-expression the parser cannot read.
    __test__appendTile(rule.when(), new BrainTileLiteralDef(CoreTypeIds.Number, 1, {}, services));
    __test__appendTile(rule.when(), services.edit.tiles.get(mkOperatorTileId(CoreOpId.Add))!);
    __test__appendTile(page.appendNewRule()!.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef, 1);

    assertReportedAt(outcome, ParseDiagCode.ExpectedExpressionInSubExpr, "0/0");
    assert.ok(fixture.markCalls() > 0, "the sibling rule still acts");
  });

  test("a tile stranded after the side's expression names the parse code, not only the drop", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);
    const services = environment.brainServices;

    __test__appendTile(rule.do(), fixture.markTile);
    __test__appendTile(rule.do(), new BrainTileLiteralDef(CoreTypeIds.Number, 1, {}, services));

    const outcome = buildAndRun(environment, brainDef, 1);

    assertReportedAt(outcome, ParseDiagCode.UnexpectedExpressionAfterExpression, "0/0");
    assert.equal(fixture.markCalls(), 1, "only the surviving first expression ran");
  });

  test("an unclosed group names the parse code, and drops nothing", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);
    const services = environment.brainServices;

    __test__appendTile(rule.when(), services.edit.tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!);
    __test__appendTile(rule.when(), new BrainTileLiteralDef(CoreTypeIds.Boolean, true, {}, services));
    __test__appendTile(rule.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef, 1);

    assertReportedAt(outcome, ParseDiagCode.ExpectedClosingParen, "0/0");
    assert.deepEqual(droppedDiags(outcome), [], "the group's contents still compile");
    assert.ok(fixture.markCalls() > 0, "the rule the group gates still acts");
  });

  test("an invalid assignment target names the parse code, not only the drop", () => {
    const fixture = createFixture();
    const { environment, brainDef, page, rule } = newBrain(fixture);
    const services = environment.brainServices;

    __test__appendTile(rule.do(), new BrainTileLiteralDef(CoreTypeIds.Number, 1, {}, services));
    __test__appendTile(rule.do(), services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign))!);
    __test__appendTile(rule.do(), new BrainTileLiteralDef(CoreTypeIds.Number, 2, {}, services));
    __test__appendTile(page.appendNewRule()!.do(), fixture.markTile);

    const outcome = buildAndRun(environment, brainDef, 1);

    assertReportedAt(outcome, ParseDiagCode.InvalidAssignmentTarget, "0/0");
    assert.equal(droppedDiags(outcome).length, 1, "the drop it caused is reported alongside it");
    assert.ok(fixture.markCalls() > 0, "the sibling rule still acts");
  });
});
