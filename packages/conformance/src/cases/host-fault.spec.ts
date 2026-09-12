/**
 * Corpus case `host-fault`. A rule whose synchronous host body raises, beside
 * a root rule that keeps running:
 *
 * ```
 * DO [fault]
 *   DO [emit 1]
 * DO [emit 2]
 * ```
 *
 * The raise faults the calling fiber with `ScriptError` before the call
 * returns, so the dispatch renders no `action` line and the child rule never
 * spawns. The fault kills the fiber, not the rule: it respawns every think,
 * and the sibling root rule emits every think.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { ErrorCode, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "host-fault";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendDo(firstRule, tiles.fault);

  const afterFault = firstRule.appendNewRule();
  appendDo(afterFault, tiles.emit, numberLiteral(environment, brainDef, 1));

  const heartbeat = page.appendNewRule()!;
  appendDo(heartbeat, tiles.emit, numberLiteral(environment, brainDef, 2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Fault.actionId }]);

  const emitPrefix = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    const faults = traceLines(variant.trace, "fault ");
    assert.equal(faults.length, minted.entry.schedule.length, "the faulting rule respawns and faults every think");
    for (const line of faults) {
      assert.ok(line.endsWith(` ${ErrorCode.ScriptError.toString(16)}`), "a raising host body faults with ScriptError");
    }
    // Only the heartbeat emits: the faulted rule never reaches its child.
    assert.equal(traceLines(variant.trace, emitPrefix).length, minted.entry.schedule.length);
  }
});
