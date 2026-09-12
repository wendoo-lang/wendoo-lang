/**
 * Corpus case `arithmetic-operators`. Five rules with no WHEN section, one per
 * core number arithmetic operator beyond `+`, each emitting what the operator
 * evaluated to:
 *
 * - `DO [emit 7 - 3]`
 * - `DO [emit 6 * 7]`
 * - `DO [emit 9 / 2]`
 * - `DO [emit negative 5]`
 * - `DO [emit 1 / 0]` -- the divisor is zero, so the operator evaluates nil.
 *
 * Every operand is exactly representable at both profile precisions, so the
 * two precision variants differ only in the width of the rendered bit pattern.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, operatorTile } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "arithmetic-operators";

/** Emits of a think: one per rule, and every rule fires on every think. */
const EMITS_PER_TICK = 5;

/** The one emit of a think whose argument is the nil a zero divisor evaluates to. */
const NIL_EMITS_PER_TICK = 1;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);
  const operator = (opId: string) => operatorTile(environment, opId);

  appendDo(firstRule, tiles.emit, literal(7), operator(CoreOpId.Subtract), literal(3));

  const multiply = page.appendNewRule()!;
  appendDo(multiply, tiles.emit, literal(6), operator(CoreOpId.Multiply), literal(7));

  const divide = page.appendNewRule()!;
  appendDo(divide, tiles.emit, literal(9), operator(CoreOpId.Divide), literal(2));

  const negate = page.appendNewRule()!;
  appendDo(negate, tiles.emit, operator(CoreOpId.Negate), literal(5));

  const divideByZero = page.appendNewRule()!;
  appendDo(divideByZero, tiles.emit, literal(1), operator(CoreOpId.Divide), literal(0));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_CALL, a: CoreFuncId.OpSubtractNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpMultiplyNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpDivideNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpNegateNumber },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, emitEvent).length, EMITS_PER_TICK * minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const nilEmits = traceLines(variant.trace, emitEvent).filter((line) => line.endsWith("args 1 nil result void"));
    assert.equal(nilEmits.length, NIL_EMITS_PER_TICK * minted.entry.schedule.length);
  }
});
