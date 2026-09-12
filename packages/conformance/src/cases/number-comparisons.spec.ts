/**
 * Corpus case `number-comparisons`. One rule per core number comparison, each
 * gating an emit on a comparison of two literals, plus one rule whose left
 * operand is a sensor reading that is absent on half the thinks:
 *
 * - `WHEN [1 < 2] DO [emit 1]` -- fires
 * - `WHEN [2 <= 2] DO [emit 2]` -- fires
 * - `WHEN [1 > 2] DO [emit 3]` -- skips
 * - `WHEN [3 >= 2] DO [emit 4]` -- fires
 * - `WHEN [2 == 2] DO [emit 5]` -- fires
 * - `WHEN [2 != 2] DO [emit 6]` -- skips
 * - `WHEN [(signal period 2) < 1] DO [emit 7]` -- fires on the even thinks
 *
 * The last rule's sensor delivers nil on the odd thinks, so the comparison
 * receives an operand that is not a number and evaluates false there, and
 * receives the number `0` on the even thinks and evaluates true.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, grouped, newBrain, numberLiteral, operatorTile } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "number-comparisons";

/** Rules comparing two literals whose comparison holds, and so emit on every think. */
const EMITS_PER_TICK = 4;

/** Thinks between two deliveries of the sensor the last rule compares against. */
const SIGNAL_PERIOD = 2;

/** The comparisons under test, each with the two literals it compares and the number its rule emits. */
const COMPARISONS: readonly { readonly opId: string; readonly lhs: number; readonly rhs: number }[] = [
  { opId: CoreOpId.LessThan, lhs: 1, rhs: 2 },
  { opId: CoreOpId.LessThanOrEqualTo, lhs: 2, rhs: 2 },
  { opId: CoreOpId.GreaterThan, lhs: 1, rhs: 2 },
  { opId: CoreOpId.GreaterThanOrEqualTo, lhs: 3, rhs: 2 },
  { opId: CoreOpId.EqualTo, lhs: 2, rhs: 2 },
  { opId: CoreOpId.NotEqualTo, lhs: 2, rhs: 2 },
];

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);
  const operator = (opId: string) => operatorTile(environment, opId);

  let rule = firstRule;
  for (const [index, comparison] of COMPARISONS.entries()) {
    appendWhen(rule, literal(comparison.lhs), operator(comparison.opId), literal(comparison.rhs));
    appendDo(rule, tiles.emit, literal(index + 1));
    rule = page.appendNewRule()!;
  }

  appendWhen(
    rule,
    ...grouped(environment, tiles.signal, tiles.period, literal(SIGNAL_PERIOD)),
    operator(CoreOpId.LessThan),
    literal(1)
  );
  appendDo(rule, tiles.emit, literal(COMPARISONS.length + 1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_CALL, a: CoreFuncId.OpLessThanNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpLessThanOrEqualToNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpGreaterThanNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpGreaterThanOrEqualToNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpEqualToNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotEqualToNumber },
    { op: Op.WHEN_END },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    for (const [index, lines] of ticks.entries()) {
      const delivered = (index + 1) % SIGNAL_PERIOD === 0 ? 1 : 0;
      assert.equal(lines.filter((line) => line.startsWith(emitEvent)).length, EMITS_PER_TICK + delivered);
    }
  }
});
