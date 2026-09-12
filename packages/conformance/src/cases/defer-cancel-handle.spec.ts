/**
 * Corpus case `defer-cancel-handle`. A rule parked on an asynchronous action
 * whose handle is cancelled, beside a root rule that keeps running:
 *
 * ```
 * DO [defer cancel ticks 2]
 *   DO [emit 1]
 * DO [emit 2]
 * ```
 *
 * The handle is cancelled two ticks after the dispatch. The parked fiber
 * resumes with a `Cancelled` throw at its await point, so it faults there and
 * its child rule never spawns. The fault kills the fiber, not the rule: it
 * respawns and dispatches again on the next think, and the sibling root rule
 * emits throughout. The trace pins the fault code as `Cancelled`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { ErrorCode, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "defer-cancel-handle";

/** Ticks between a `defer cancel` dispatch and its handle being cancelled. */
const DEFER_TICKS = 2;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendDo(firstRule, tiles.deferCancel, tiles.ticks, literal(DEFER_TICKS));

  const afterAwait = firstRule.appendNewRule();
  appendDo(afterAwait, tiles.emit, literal(1));

  const heartbeat = page.appendNewRule()!;
  appendDo(heartbeat, tiles.emit, literal(2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferCancel.actionId },
  ]);

  const emitPrefix = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    const faults = traceLines(variant.trace, "fault ");
    assert.equal(faults.length, 1, "the handle is cancelled once within the schedule");
    assert.ok(
      faults[0]!.endsWith(` ${ErrorCode.Cancelled.toString(16)}`),
      "a cancelled handle throws Cancelled in the fiber awaiting it"
    );

    // Only the heartbeat emits: the rule beneath the await is never reached.
    const emitted = traceLines(variant.trace, emitPrefix).map((line) => line.split(" ").slice(6, 8).join(" "));
    assert.equal(emitted.length, minted.entry.schedule.length);
    assert.equal(new Set(emitted).size, 1);
  }
});
