/**
 * Corpus case `string-operators`. Four rules over String literal tiles, each
 * gating an emit on a string operator:
 *
 * - `WHEN ["ab" == "ab"] DO [emit 1]` -- fires
 * - `WHEN ["ab" != "cd"] DO [emit 2]` -- fires
 * - `WHEN ["a" + "b" == "ab"] DO [emit 3]` -- fires
 * - `WHEN ["ab" == "cd"] DO [emit 4]` -- skips
 *
 * Every operand comes from the program's string constant pool, so the case
 * also pins `PUSH_CONST_STR`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  numberLiteral,
  operatorTile,
  stringLiteral,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "string-operators";

/** Emits of a think: the three rules whose string comparison holds. */
const EMITS_PER_TICK = 3;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);
  const text = (value: string) => stringLiteral(environment, brainDef, value);
  const operator = (opId: string) => operatorTile(environment, opId);

  appendWhen(firstRule, text("ab"), operator(CoreOpId.EqualTo), text("ab"));
  appendDo(firstRule, tiles.emit, literal(1));

  const notEqual = page.appendNewRule()!;
  appendWhen(notEqual, text("ab"), operator(CoreOpId.NotEqualTo), text("cd"));
  appendDo(notEqual, tiles.emit, literal(2));

  // `+` binds tighter than `==`, so the concatenation is the left comparand.
  const concatenated = page.appendNewRule()!;
  appendWhen(concatenated, text("a"), operator(CoreOpId.Add), text("b"), operator(CoreOpId.EqualTo), text("ab"));
  appendDo(concatenated, tiles.emit, literal(3));

  const unequal = page.appendNewRule()!;
  appendWhen(unequal, text("ab"), operator(CoreOpId.EqualTo), text("cd"));
  appendDo(unequal, tiles.emit, literal(4));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.PUSH_CONST_STR },
    { op: Op.HOST_CALL, a: CoreFuncId.OpAddString },
    { op: Op.HOST_CALL, a: CoreFuncId.OpEqualToString },
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotEqualToString },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, emitEvent).length, EMITS_PER_TICK * minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
  }
});
