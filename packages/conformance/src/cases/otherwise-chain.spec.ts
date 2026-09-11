/**
 * Corpus case `otherwise-chain`. Two WHEN rules, each followed by an
 * `otherwise` sibling:
 *
 * ```
 * WHEN [echo 0] DO [emit 1]
 * OTHERWISE     DO [emit 2]
 * WHEN [echo 1] DO [emit 3]
 * OTHERWISE     DO [emit 4]
 * ```
 *
 * The first subject never fires, so its `otherwise` does; the second subject
 * fires, so its `otherwise` does not. The trace pins the chain value each gate
 * writes and the emits it admits.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { RuleTriggerMode } from "@wendoo/core/brain";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "otherwise-chain";

/** Emits per think: the first rule's `otherwise`, then the second rule itself. */
const EMITS_PER_TICK = 2;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.echo, numberLiteral(environment, brainDef, 0));
  appendDo(firstRule, tiles.emit, numberLiteral(environment, brainDef, 1));

  const firstElse = page.appendNewRule()!;
  firstElse.setTrigger(RuleTriggerMode.Otherwise);
  appendDo(firstElse, tiles.emit, numberLiteral(environment, brainDef, 2));

  const firing = page.appendNewRule()!;
  appendWhen(firing, tiles.echo, numberLiteral(environment, brainDef, 1));
  appendDo(firing, tiles.emit, numberLiteral(environment, brainDef, 3));

  const secondElse = page.appendNewRule()!;
  secondElse.setTrigger(RuleTriggerMode.Otherwise);
  appendDo(secondElse, tiles.emit, numberLiteral(environment, brainDef, 4));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.WHEN_END_CHAIN },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Echo.actionId },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
  ]);

  const emitPrefix = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.equal(traceLines(variant.trace, emitPrefix).length, EMITS_PER_TICK * minted.entry.schedule.length);
  }
});
