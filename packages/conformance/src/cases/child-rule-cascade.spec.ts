/**
 * Corpus case `child-rule-cascade`. A parent rule with two synchronous child
 * rules, followed by a second root rule:
 *
 * ```
 * WHEN [echo 1] DO [emit 1]
 *   DO [emit 2]
 *   DO [emit 3]
 * DO [emit 4]
 * ```
 *
 * The trace pins the spawn order of the children, that they drain inside the
 * parent's think, and that the second root rule runs after the whole subtree.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "child-rule-cascade";

/** Emits per think: the parent, its two children, and the second root rule. */
const EMITS_PER_TICK = 4;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.echo, numberLiteral(environment, brainDef, 1));
  appendDo(firstRule, tiles.emit, numberLiteral(environment, brainDef, 1));

  const firstChild = firstRule.appendNewRule();
  appendDo(firstChild, tiles.emit, numberLiteral(environment, brainDef, 2));

  const secondChild = firstRule.appendNewRule();
  appendDo(secondChild, tiles.emit, numberLiteral(environment, brainDef, 3));

  const secondRoot = page.appendNewRule()!;
  appendDo(secondRoot, tiles.emit, numberLiteral(environment, brainDef, 4));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.SPAWN_RULE }]);

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(
      traceLines(variant.trace, `action ${ConformanceHostActions.Emit.actionId.toString(16)} `).length,
      EMITS_PER_TICK * minted.entry.schedule.length
    );
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
  }
});
