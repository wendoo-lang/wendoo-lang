/**
 * Corpus case `placed-falsy-values-pass`. Actuator calls whose anonymous
 * values are placed expressions evaluating to falsy values, read off
 * variables no rule assigns -- each holding its type's starting value -- and
 * off the not-a-number sensor:
 *
 * ```
 * DO [emit zero]
 * DO [emit flag off]
 * DO [emit text blank]
 * DO [emit [not a number]]
 * ```
 *
 * A placed value gates its call only when it evaluates to nothing. `0`,
 * `false`, the empty string, and not-a-number are values, so every call
 * dispatches. The trace pins each dispatch carrying its value.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, Op } from "@wendoo/core/runtime";
import { appendDo, booleanVariable, conformanceTiles, newBrain, numberVariable, stringVariable } from "../authoring";
import {
  assertCaseIsStable,
  assertCompiledOps,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "placed-falsy-values-pass";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendDo(firstRule, tiles.emit, numberVariable(brainDef, "zero"));
  appendDo(page.appendNewRule()!, tiles.emitFlag, booleanVariable(brainDef, "off"));
  appendDo(page.appendNewRule()!, tiles.emitText, stringVariable(brainDef, "blank"));
  appendDo(page.appendNewRule()!, tiles.emit, tiles.notANumber);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotEqualToNumberNil },
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotEqualToBooleanNil },
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotEqualToStringNil },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const flagEvent = `action ${ConformanceHostActions.EmitFlag.actionId.toString(16)}`;
  const textEvent = `action ${ConformanceHostActions.EmitText.actionId.toString(16)}`;
  const notANumberEvent = `action ${ConformanceHostActions.NotANumber.actionId.toString(16)}`;
  // Every call dispatches on every think.
  const think = [emitEvent, flagEvent, textEvent, notANumberEvent, emitEvent];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), [think, think]);

    const notANumber = numberToken(Number.NaN, variant.precision);
    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.deepEqual(
      emits.map((line) => line.slice(line.indexOf(" args "))),
      [
        ` args 1 ${numberToken(0, variant.precision)} result void`,
        ` args 1 ${notANumber} result void`,
        ` args 1 ${numberToken(0, variant.precision)} result void`,
        ` args 1 ${notANumber} result void`,
      ]
    );
    for (const line of traceLines(variant.trace, `${flagEvent} `)) {
      assert.ok(line.endsWith("args 1 bool 0 result bool 0"), `unexpected emit flag line: ${line}`);
    }
    for (const line of traceLines(variant.trace, `${textEvent} `)) {
      assert.ok(line.endsWith('args 1 string "" result string ""'), `unexpected emit text line: ${line}`);
    }
  }
});
