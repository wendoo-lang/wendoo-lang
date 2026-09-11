/**
 * Corpus case `defer-fail-reject`. A rule that parks on an asynchronous action
 * whose handle rejects, beside a root rule that keeps running:
 *
 * ```
 * DO [defer fail ticks 1]
 *   DO [emit 1]
 * DO [emit 2]
 * ```
 *
 * The rejection throws in the parked fiber, so the rule faults with
 * `HostError` and its child rule never spawns. The rule respawns on the next
 * think and dispatches again; the sibling root rule emits every think.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { ErrorCode, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "defer-fail-reject";

/** Ticks between a `defer fail` dispatch and its handle rejecting. */
const DEFER_TICKS = 1;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendDo(firstRule, tiles.deferFail, tiles.ticks, numberLiteral(environment, brainDef, DEFER_TICKS));

  const afterAwait = firstRule.appendNewRule();
  appendDo(afterAwait, tiles.emit, numberLiteral(environment, brainDef, 1));

  const heartbeat = page.appendNewRule()!;
  appendDo(heartbeat, tiles.emit, numberLiteral(environment, brainDef, 2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferFail.actionId },
    { op: Op.AWAIT },
  ]);

  const emitPrefix = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    const faults = traceLines(variant.trace, "fault ");
    assert.ok(faults.length > 0, "the rejected handle must fault its awaiting fiber");
    for (const line of faults) {
      assert.ok(line.endsWith(` ${ErrorCode.HostError.toString(16)}`), "a rejected handle faults with HostError");
    }
    // Only the heartbeat emits: the faulted rule never reaches its child.
    assert.equal(traceLines(variant.trace, emitPrefix).length, minted.entry.schedule.length);
  }
});
