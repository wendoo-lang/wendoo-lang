import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  coreModule,
  createHostActuator,
  createHostSensor,
  createWendooEnvironment,
  type WendooEnvironment,
  type WendooModule,
} from "@wendoo/core";
import type { IBrainActionTileDef } from "@wendoo/core/brain";
import { mkOperatorTileId, RuleSide } from "@wendoo/core/brain";
import type { BrainBuildDiagnostic, DiagCode, ParseDiag, TypeInfoDiag } from "@wendoo/core/brain/compiler";
import {
  CompilationDiagCode,
  diagnosticSeverity,
  LinkDiagCode,
  ParseDiagCode,
  TypeDiagCode,
} from "@wendoo/core/brain/compiler";
import { BrainDef, type BrainPageDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainTileActuatorDef } from "@wendoo/core/brain/tiles";
import {
  bag,
  CoreOpId,
  CoreParameterId,
  CoreTypeIds,
  mkCallDef,
  param,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  TRUE_VALUE,
  VOID_VALUE,
} from "@wendoo/core/runtime";

const kSensorKey = "diagspec.hungry";
const kSensorLabel = "Hungry";
const kActuatorKey = "diagspec.eat";
const kActuatorLabel = "Eat";
const kNumberActuatorKey = "diagspec.nudge";
const kUnboundActuatorKey = "diagspec.unbound";
const kVoidSensorKey = "diagspec.nothing";

/** The action tiles the fixture module puts into the environment's catalog. */
interface Fixture {
  readonly module: WendooModule;
  /** Inline boolean sensor, placeable on either side. */
  readonly sensorTile: IBrainActionTileDef;
  /** No-argument actuator; placement is the DO side only. */
  readonly actuatorTile: IBrainActionTileDef;
  /** Actuator taking one anonymous number argument; placement is the DO side only. */
  readonly numberActuatorTile: IBrainActionTileDef;
  /** Inline sensor whose result type is `Void`, which no operator overload accepts. */
  readonly voidSensorTile: IBrainActionTileDef;
}

/** A host module carrying the sensor and actuators these tests place into rules. */
function createFixture(): Fixture {
  const sensor = createHostSensor({
    key: kSensorKey,
    actionId: TARGET_ACTION_ID_BASE,
    fnId: TARGET_FUNC_ID_BASE,
    callDef: mkCallDef({ type: "bag", items: [] }),
    outputType: CoreTypeIds.Boolean,
    inline: true,
    metadata: { label: kSensorLabel },
    fn: { exec: () => TRUE_VALUE },
  });

  const actuator = createHostActuator({
    key: kActuatorKey,
    actionId: TARGET_ACTION_ID_BASE + 1,
    fnId: TARGET_FUNC_ID_BASE + 1,
    callDef: mkCallDef({ type: "bag", items: [] }),
    metadata: { label: kActuatorLabel },
    fn: { exec: () => VOID_VALUE },
  });

  const numberActuator = createHostActuator({
    key: kNumberActuatorKey,
    actionId: TARGET_ACTION_ID_BASE + 2,
    fnId: TARGET_FUNC_ID_BASE + 2,
    callDef: mkCallDef(bag(param(CoreParameterId.AnonymousNumber, { anonymous: true }))),
    fn: { exec: () => VOID_VALUE },
  });

  const voidSensor = createHostSensor({
    key: kVoidSensorKey,
    actionId: TARGET_ACTION_ID_BASE + 3,
    fnId: TARGET_FUNC_ID_BASE + 3,
    callDef: mkCallDef({ type: "bag", items: [] }),
    outputType: CoreTypeIds.Void,
    inline: true,
    fn: { exec: () => VOID_VALUE },
  });

  return {
    sensorTile: sensor.tile,
    actuatorTile: actuator.tile,
    numberActuatorTile: numberActuator.tile,
    voidSensorTile: voidSensor.tile,
    module: {
      id: "diagnostics-spec-host",
      install(api): void {
        api.registerHostSensor(sensor);
        api.registerHostActuator(actuator);
        api.registerHostActuator(numberActuator);
        api.registerHostSensor(voidSensor);
      },
    },
  };
}

/** An environment carrying the fixture module, and an empty single-rule brain in it. */
function newBrain(fixture: Fixture): {
  environment: WendooEnvironment;
  brainDef: BrainDef;
  rule: BrainRuleDef;
} {
  const environment = createWendooEnvironment({ modules: [coreModule(), fixture.module] });
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Diagnostics Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  return { environment, brainDef, rule: page.children().get(0) as BrainRuleDef };
}

/** The rule's edit-time parse diagnostics, across both sides. */
function parseDiags(rule: BrainRuleDef): ParseDiag[] {
  const result = rule.when().typecheckResult();
  assert.ok(result, "expected the rule to hold a typecheck result");
  return result.parseResult.diags.toArray();
}

/** The rule's edit-time type-inference diagnostics. */
function typeDiags(rule: BrainRuleDef): TypeInfoDiag[] {
  const result = rule.when().typecheckResult();
  assert.ok(result, "expected the rule to hold a typecheck result");
  return result.typeInfo.diags.toArray();
}

/** The one diagnostic in `diags` carrying `code`. Fails when there is not exactly one. */
function only<T extends { code: DiagCode }>(diags: readonly T[], code: DiagCode): T {
  const matches = diags.filter((d) => d.code === code);
  assert.equal(matches.length, 1, `expected exactly one diagnostic with code ${code}`);
  return matches[0]!;
}

describe("diagnostic params", () => {
  test("a tile placed on a side its placement excludes names the tile and the side", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    rule.when().appendTile(fixture.actuatorTile);
    rule.typecheck();

    const diag = only(parseDiags(rule), ParseDiagCode.TilePlacementSideMismatch);
    assert.equal(diag.params?.tileId, fixture.actuatorTile.tileId);
    assert.equal(diag.params?.tileLabel, kActuatorLabel);
    assert.equal(diag.params?.side, RuleSide.When);

    // The build reports the same code with the same params.
    const build = environment.linkBrain(brainDef);
    const buildDiag = only(build.diagnostics.toArray(), ParseDiagCode.TilePlacementSideMismatch);
    assert.equal(buildDiag.params?.tileId, fixture.actuatorTile.tileId);
    assert.equal(buildDiag.params?.side, RuleSide.When);
  });

  test("an applied type conversion names the source type, the target type, and the cost", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    // The actuator's anonymous slot takes a number; the sensor produces a boolean.
    rule.do().appendTile(fixture.numberActuatorTile);
    rule.do().appendTile(fixture.sensorTile);
    rule.typecheck();

    const diag = only(typeDiags(rule), TypeDiagCode.DataTypeConverted);
    assert.deepEqual(diag.params?.actualTypeIds?.toArray(), [CoreTypeIds.Boolean]);
    assert.deepEqual(diag.params?.expectedTypeIds?.toArray(), [CoreTypeIds.Number]);
    assert.equal(diag.params?.conversionCost, 1);

    // The conversion is informational, so the same brain still produces a program.
    const build = environment.linkBrain(brainDef);
    assert.ok(build.program, "an applied conversion must not block the build");
  });

  test("an action with no binding in the environment names the action key", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    rule.do().appendTile(
      new BrainTileActuatorDef(kUnboundActuatorKey, {
        key: kUnboundActuatorKey,
        kind: "actuator",
        callDef: mkCallDef({ type: "bag", items: [] }),
        isAsync: false,
      })
    );

    const build = environment.linkBrain(brainDef);
    const diag = only(build.diagnostics.toArray(), LinkDiagCode.MissingActionBinding);
    assert.equal(diag.params?.actionKey, kUnboundActuatorKey);
    assert.equal(diag.severity, "error");
    assert.equal(build.program, undefined);
  });
});

describe("edit-time severity classification", () => {
  test("a rule-level typecheck classifies its diagnostics without linking the brain", () => {
    const fixture = createFixture();
    const { rule } = newBrain(fixture);

    rule.when().appendTile(fixture.actuatorTile);
    rule.do().appendTile(fixture.numberActuatorTile);
    rule.do().appendTile(fixture.sensorTile);
    rule.typecheck();

    assert.equal(diagnosticSeverity(only(parseDiags(rule), ParseDiagCode.TilePlacementSideMismatch).code), "error");
    assert.equal(diagnosticSeverity(only(typeDiags(rule), TypeDiagCode.DataTypeConverted).code), "info");
  });

  test("every build diagnostic carries the severity the classifier assigns its code", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    // A placement error, an unparseable second expression, and an unbound action
    // together cover the error and warning branches of the classifier.
    rule.when().appendTile(fixture.actuatorTile);
    rule.when().appendTile(fixture.sensorTile);
    rule.when().appendTile(fixture.sensorTile);
    rule.do().appendTile(
      new BrainTileActuatorDef(kUnboundActuatorKey, {
        key: kUnboundActuatorKey,
        kind: "actuator",
        callDef: mkCallDef({ type: "bag", items: [] }),
        isAsync: false,
      })
    );

    const diagnostics: BrainBuildDiagnostic[] = environment.linkBrain(brainDef).diagnostics.toArray();
    assert.ok(diagnostics.length > 0, "expected the brain to produce diagnostics");
    for (const diag of diagnostics) {
      assert.equal(diag.severity, diagnosticSeverity(diag.code), `code ${diag.code} disagrees with its severity`);
    }
  });

  test("a recovered parse diagnostic reaches the build ahead of the drop it caused", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);

    rule.when().appendTile(fixture.sensorTile);
    rule.when().appendTile(fixture.sensorTile);
    rule.do().appendTile(fixture.actuatorTile);
    rule.typecheck();

    const diag = only(parseDiags(rule), ParseDiagCode.UnexpectedExpressionAfterExpression);
    assert.equal(diagnosticSeverity(diag.code), "warning");

    // Agreement: the build recovers the same way and still produces a program.
    const build = environment.linkBrain(brainDef);
    assert.ok(build.program, "a recovered parse error must not block the build");
    const buildDiags = build.diagnostics.toArray();
    assert.deepEqual(
      buildDiags.filter((d) => d.severity === "error"),
      []
    );

    const parsed = only(buildDiags, ParseDiagCode.UnexpectedExpressionAfterExpression);
    assert.equal(parsed.severity, "warning");
    assert.equal(parsed.params?.rulePath, "0/0");

    const dropped = only(buildDiags, CompilationDiagCode.UncompilableExpressionDropped);
    assert.equal(dropped.severity, "warning");
    assert.equal(dropped.params?.rulePath, "0/0");
    assert.equal(dropped.params?.side, RuleSide.When);
    assert.equal(dropped.params?.tileId, fixture.sensorTile.tileId);
    assert.ok(buildDiags.indexOf(parsed) < buildDiags.indexOf(dropped), "the cause is reported before the consequence");
  });
});

describe("a warning-severity type diagnostic reaches the build result without blocking it", () => {
  test("a binary operator with no overload is reported at warning severity and the brain still links", () => {
    const fixture = createFixture();
    const { environment, brainDef, rule } = newBrain(fixture);
    const addTile = environment.brainServices.edit.tiles.get(mkOperatorTileId(CoreOpId.Add));
    assert.ok(addTile, "expected the core add operator tile");

    rule.when().appendTile(fixture.voidSensorTile);
    rule.when().appendTile(addTile);
    rule.when().appendTile(fixture.sensorTile);
    rule.do().appendTile(fixture.actuatorTile);

    const build = environment.linkBrain(brainDef);
    const buildDiags = build.diagnostics.toArray();

    const noOverload = only(buildDiags, TypeDiagCode.NoOverloadForBinaryOp);
    assert.equal(noOverload.severity, "warning");
    assert.equal(noOverload.params?.rulePath, "0/0");
    assert.deepEqual(
      buildDiags.filter((d) => d.severity === "error"),
      []
    );
    assert.ok(build.program, "a warning-severity type diagnostic must not block the build");
  });
});
