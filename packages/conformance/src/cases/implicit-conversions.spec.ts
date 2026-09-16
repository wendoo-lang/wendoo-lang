/**
 * Corpus case `implicit-conversions`. Eleven rules with empty WHEN sections,
 * each firing every think, pulling every core conversion host function through
 * a compiler-inserted `HOST_CALL`:
 *
 * - `DO [emit "5"]` -- string into the Number slot: `ConvStringToNumber`
 * - `DO [emit true]` -- boolean into the Number slot: `ConvBooleanToNumber`
 * - `DO [emit text 7]` -- number into the String slot: `ConvNumberToString`
 * - `DO [emit text false]` -- boolean into the String slot: `ConvBooleanToString`
 * - `DO [emit flag 5]` and `DO [emit flag 0]` -- numbers into the Boolean
 *   slot, one truthy and one falsy: `ConvNumberToBoolean`
 * - `DO [emit flag "x"]` and `DO [emit flag " "]` -- strings into the Boolean
 *   slot: `ConvStringToBoolean`, whose whitespace-only operand trims to empty
 *   and converts false
 * - `DO [emit text "a" + 7]` -- the operand route: the number operand converts
 *   so the string overload of `+` applies, emitting `"a7"`
 * - `DO [count = "7"]` then `DO [emit count]` -- the assignment route: the
 *   string converts into the Number-typed variable, and the emit reads back 7
 *
 * Number-to-string conversions use integer values only, whose decimal
 * rendering is identical on every host and at both precisions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  booleanLiteral,
  conformanceTiles,
  newBrain,
  numberLiteral,
  numberVariable,
  operatorTile,
  stringLiteral,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "implicit-conversions";

/** The values the emit rules deliver each think, in rule order, post-conversion. */
const EMIT_VALUES = [5, 1, 7] as const;

/** The rendered string token of each emit-text rule, in rule order, post-conversion. */
const TEXT_TOKENS = ['string "7"', 'string "false"', 'string "a7"'] as const;

/** The rendered bool token of each emit-flag rule, in rule order, post-conversion. */
const FLAG_TOKENS = ["bool 1", "bool 0", "bool 1", "bool 0"] as const;

/** The `number <bits>` token of `value` at `precision`, as the trace renders it. */
function numberToken(value: number, precision: NumberPrecision): string {
  if (precision === "f32") {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    return `number ${view.getUint32(0).toString(16).padStart(8, "0")}`;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return `number ${view.getUint32(0).toString(16).padStart(8, "0")}${view.getUint32(4).toString(16).padStart(8, "0")}`;
}

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);
  const text = (value: string) => stringLiteral(environment, brainDef, value);

  appendDo(firstRule, tiles.emit, text("5"));

  const boolToNumber = page.appendNewRule()!;
  appendDo(boolToNumber, tiles.emit, booleanLiteral(environment, true));

  const numberToString = page.appendNewRule()!;
  appendDo(numberToString, tiles.emitText, literal(7));

  const boolToString = page.appendNewRule()!;
  appendDo(boolToString, tiles.emitText, booleanLiteral(environment, false));

  const truthyNumber = page.appendNewRule()!;
  appendDo(truthyNumber, tiles.emitFlag, literal(5));

  const falsyNumber = page.appendNewRule()!;
  appendDo(falsyNumber, tiles.emitFlag, literal(0));

  const truthyString = page.appendNewRule()!;
  appendDo(truthyString, tiles.emitFlag, text("x"));

  const whitespaceString = page.appendNewRule()!;
  appendDo(whitespaceString, tiles.emitFlag, text(" "));

  const operandRoute = page.appendNewRule()!;
  appendDo(operandRoute, tiles.emitText, text("a"), operatorTile(environment, CoreOpId.Add), literal(7));

  const count = numberVariable(brainDef, "count");
  const assignmentRoute = page.appendNewRule()!;
  appendDo(assignmentRoute, count, operatorTile(environment, CoreOpId.Assign), text("7"));

  const report = page.appendNewRule()!;
  appendDo(report, tiles.emit, count);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_CALL, a: CoreFuncId.ConvNumberToString },
    { op: Op.HOST_CALL, a: CoreFuncId.ConvStringToNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.ConvNumberToBoolean },
    { op: Op.HOST_CALL, a: CoreFuncId.ConvBooleanToNumber },
    { op: Op.HOST_CALL, a: CoreFuncId.ConvStringToBoolean },
    { op: Op.HOST_CALL, a: CoreFuncId.ConvBooleanToString },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  const emitTextEvent = `action ${ConformanceHostActions.EmitText.actionId.toString(16)} `;
  const emitFlagEvent = `action ${ConformanceHostActions.EmitFlag.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);

    const emitLines = traceLines(variant.trace, emitEvent);
    assert.equal(emitLines.length, EMIT_VALUES.length * minted.entry.schedule.length);
    for (const [index, line] of emitLines.entries()) {
      const token = numberToken(EMIT_VALUES[index % EMIT_VALUES.length], variant.precision);
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }

    const textLines = traceLines(variant.trace, emitTextEvent);
    assert.equal(textLines.length, TEXT_TOKENS.length * minted.entry.schedule.length);
    for (const [index, line] of textLines.entries()) {
      const token = TEXT_TOKENS[index % TEXT_TOKENS.length];
      assert.ok(line.endsWith(`args 1 ${token} result ${token}`), `unexpected emit-text line: ${line}`);
    }

    const flagLines = traceLines(variant.trace, emitFlagEvent);
    assert.equal(flagLines.length, FLAG_TOKENS.length * minted.entry.schedule.length);
    for (const [index, line] of flagLines.entries()) {
      const token = FLAG_TOKENS[index % FLAG_TOKENS.length];
      assert.ok(line.endsWith(`args 1 ${token} result ${token}`), `unexpected emit-flag line: ${line}`);
    }
  }
});
