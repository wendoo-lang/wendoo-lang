/**
 * Corpus case `boolean-logic`. Seven rules over the `true` and `false` literal
 * tiles, gating an emit on each core boolean operator:
 *
 * - `WHEN [true and false] DO [emit 1]` -- the right operand decides; skips
 * - `WHEN [false and true] DO [emit 2]` -- the left operand decides; skips
 * - `WHEN [true or false] DO [emit 3]` -- the left operand decides; fires
 * - `WHEN [false or true] DO [emit 4]` -- the right operand decides; fires
 * - `WHEN [not false] DO [emit 5]` -- fires
 * - `WHEN [true == true] DO [emit 6]` -- fires
 * - `WHEN [true != false] DO [emit 7]` -- fires
 *
 * `and` and `or` compile to a branch over a duplicated left operand rather
 * than to a host call, so the four rules that use them pin `DUP`, `POP`,
 * `JMP_IF_FALSE` and `JMP_IF_TRUE`, and both the taken and the untaken side of
 * each branch. `not` and the two boolean equality operators are host calls.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  booleanLiteral,
  conformanceTiles,
  newBrain,
  numberLiteral,
  operatorTile,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, compiledInstructions, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "boolean-logic";

/** Emits of a think: the five rules whose WHEN section evaluates truthy. */
const EMITS_PER_TICK = 5;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);
  const operator = (opId: string) => operatorTile(environment, opId);
  const yes = booleanLiteral(environment, true);
  const no = booleanLiteral(environment, false);

  const gates: readonly [ReturnType<typeof booleanLiteral>, string, ReturnType<typeof booleanLiteral>][] = [
    [yes, CoreOpId.And, no],
    [no, CoreOpId.And, yes],
    [yes, CoreOpId.Or, no],
    [no, CoreOpId.Or, yes],
  ];

  let rule = firstRule;
  for (const [index, [lhs, opId, rhs]] of gates.entries()) {
    appendWhen(rule, lhs, operator(opId), rhs);
    appendDo(rule, tiles.emit, literal(index + 1));
    rule = page.appendNewRule()!;
  }

  appendWhen(rule, operator(CoreOpId.Not), no);
  appendDo(rule, tiles.emit, literal(gates.length + 1));

  const equal = page.appendNewRule()!;
  appendWhen(equal, yes, operator(CoreOpId.EqualTo), yes);
  appendDo(equal, tiles.emit, literal(gates.length + 2));

  const notEqual = page.appendNewRule()!;
  appendWhen(notEqual, yes, operator(CoreOpId.NotEqualTo), no);
  appendDo(notEqual, tiles.emit, literal(gates.length + 3));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.DUP },
    { op: Op.POP },
    { op: Op.JMP_IF_FALSE },
    { op: Op.JMP_IF_TRUE },
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotBoolean },
    { op: Op.HOST_CALL, a: CoreFuncId.OpEqualToBoolean },
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotEqualToBoolean },
  ]);

  for (const instruction of compiledInstructions(minted.program)) {
    assert.ok(
      instruction.op !== Op.HOST_CALL ||
        (instruction.a !== CoreFuncId.OpAndBoolean && instruction.a !== CoreFuncId.OpOrBoolean),
      "`and` and `or` must compile to branches, never to their host functions"
    );
  }

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, emitEvent).length, EMITS_PER_TICK * minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
  }
});
