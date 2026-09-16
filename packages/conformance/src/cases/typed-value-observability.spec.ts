/**
 * Corpus case `typed-value-observability`. Five rules with empty WHEN sections,
 * each firing every think, carrying string and boolean values through the
 * typed argument slots so both token kinds land in the trace's argument and
 * result positions:
 *
 * - `DO [emit text "corpus"]` -- a plain ASCII string
 * - `DO [emit text "gruess"]` (with u-umlaut and sharp-s) -- multi-byte UTF-8
 *   content, rendering as `\xNN` byte escapes
 * - `DO [emit text "a"b\c"]` -- the two escaped bytes of the string token
 *   grammar, `\"` and `\\`
 * - `DO [emit flag true]`
 * - `DO [emit flag false]`
 *
 * Every value matches its slot's declared type, so no conversion host call
 * compiles: the strings and booleans reach the bindings as authored.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, Op } from "@wendoo/core/runtime";
import { appendDo, booleanLiteral, conformanceTiles, newBrain, stringLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, compiledInstructions, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "typed-value-observability";

/** The string values the case authors, in rule order. */
const TEXT_VALUES = ["corpus", "gr\u00fc\u00df", 'a"b\\c'] as const;

/** The rendered string token of each authored value, in rule order. */
const TEXT_TOKENS = ['string "corpus"', 'string "gr\\xc3\\xbc\\xc3\\x9f"', 'string "a\\"b\\\\c"'] as const;

/** The rendered bool token of each authored flag value, in rule order. */
const FLAG_TOKENS = ["bool 1", "bool 0"] as const;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const text = (value: string) => stringLiteral(environment, brainDef, value);

  appendDo(firstRule, tiles.emitText, text(TEXT_VALUES[0]));

  const utf8 = page.appendNewRule()!;
  appendDo(utf8, tiles.emitText, text(TEXT_VALUES[1]));

  const escaped = page.appendNewRule()!;
  appendDo(escaped, tiles.emitText, text(TEXT_VALUES[2]));

  const flagTrue = page.appendNewRule()!;
  appendDo(flagTrue, tiles.emitFlag, booleanLiteral(environment, true));

  const flagFalse = page.appendNewRule()!;
  appendDo(flagFalse, tiles.emitFlag, booleanLiteral(environment, false));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.PUSH_CONST_STR }]);

  // The values match their slots' declared types, so nothing may convert them.
  const conversionFnIds: number[] = [
    CoreFuncId.ConvNumberToString,
    CoreFuncId.ConvStringToNumber,
    CoreFuncId.ConvNumberToBoolean,
    CoreFuncId.ConvBooleanToNumber,
    CoreFuncId.ConvStringToBoolean,
    CoreFuncId.ConvBooleanToString,
  ];
  for (const instruction of compiledInstructions(minted.program)) {
    assert.ok(
      instruction.op !== Op.HOST_CALL || !conversionFnIds.includes(instruction.a ?? -1),
      "a value matching its slot's declared type must compile without a conversion host call"
    );
  }

  const emitTextEvent = `action ${ConformanceHostActions.EmitText.actionId.toString(16)} `;
  const emitFlagEvent = `action ${ConformanceHostActions.EmitFlag.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);

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
