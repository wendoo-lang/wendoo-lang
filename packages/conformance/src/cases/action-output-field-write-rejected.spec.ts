/**
 * Corpus case `action-output-field-write-rejected`. A field assignment through
 * the tile of the `sealed` output, which `point outputs` does not declare
 * writable-result:
 *
 * ```
 * WHEN [point outputs] DO [sealed.x = 7.25]
 *   DO [emit sealed.x]
 * ```
 *
 * The compiler refuses the assignment (`ReadOnlyResultFieldAssignment`) and
 * drops it, so the rule's DO compiles to nothing and the program carries no
 * field store at all. On every think the sensor writes a fresh `Point`
 * `{x: 6.25, y: 0.75}` to `sealed`, the rule fires with an empty DO, and the
 * child rule reads `x` through the output: the value the sensor wrote.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CompilationDiagCode, ParseDiagCode } from "@wendoo/core/brain/compiler";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral, operatorTile } from "../authoring";
import { createConformanceEnvironment } from "../environment";
import {
  assertCaseIsStable,
  compiledInstructions,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { CONFORMANCE_POINT_OUTPUTS_READING, ConformanceHostActions } from "../profile";

const CASE_ID = "action-output-field-write-rejected";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.pointOutputs);
  appendDo(
    firstRule,
    tiles.pointSealed,
    tiles.pointX,
    operatorTile(environment, CoreOpId.Assign),
    numberLiteral(environment, brainDef, 7.25)
  );

  const child = firstRule.appendNewRule()!;
  appendDo(child, tiles.emit, tiles.pointSealed, tiles.pointX);

  return brainDef;
}

test(`${CASE_ID}: the compiler refuses the assignment and drops it`, () => {
  const environment = createConformanceEnvironment("f64");
  const built = environment.linkBrain(build(environment));
  const codes: number[] = [];
  for (let i = 0; i < built.diagnostics.size(); i++) {
    codes.push(built.diagnostics.get(i)!.code as number);
  }
  assert.ok(codes.includes(ParseDiagCode.ReadOnlyResultFieldAssignment), `diagnostics: ${codes.join(", ")}`);
  assert.ok(codes.includes(CompilationDiagCode.UncompilableExpressionDropped), `diagnostics: ${codes.join(", ")}`);
});

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assert.ok(
    !compiledInstructions(minted.program).some(
      (instr) => instr.op === Op.STRUCT_SET_FIELD || instr.op === Op.SET_FIELD
    ),
    "a refused assignment leaves no field store in the program"
  );

  const sensorEvent = `action ${ConformanceHostActions.PointOutputs.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const thinkEvents = [sensorEvent, emitEvent];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), [thinkEvents, thinkEvents]);
    const sealedX = numberToken(CONFORMANCE_POINT_OUTPUTS_READING.sealed.x, variant.precision);
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${sealedX} result void`), `unexpected emit line: ${line}`);
    }
  }
});
