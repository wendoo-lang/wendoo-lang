/**
 * Corpus case `then-trigger-fires`. A subject rule that fires and completes
 * within one think, followed by a `then` sibling:
 *
 * ```
 * WHEN [echo 1] DO [emit 1]
 * THEN          DO [emit 2]
 * ```
 *
 * The subject's cluster is a single synchronous fiber, so it is already
 * terminal when the `then` rule's arming read runs. The rule-trigger host
 * action resolves its handle immediately, the `AWAIT` falls through without
 * suspending, and both rules fire in the same think. The trace pins the arming
 * dispatch, its placement before the `then` rule's own effect, and the order
 * the two rules fire in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { RuleTriggerMode } from "@wendoo/core/brain";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "then-trigger-fires";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.echo, numberLiteral(environment, brainDef, 1));
  appendDo(firstRule, tiles.emit, numberLiteral(environment, brainDef, 1));

  const follower = page.appendNewRule()!;
  follower.setTrigger(RuleTriggerMode.Then);
  appendDo(follower, tiles.emit, numberLiteral(environment, brainDef, 2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.HOST_ACTION_CALL_ASYNC, a: CoreHostActions.RuleTrigger.actionId }]);

  // The subject reads its sensor and emits, then the follower's arming read
  // resolves in place and it emits within the same think.
  const perThink = [
    `action ${ConformanceHostActions.Echo.actionId.toString(16)}`,
    `action ${ConformanceHostActions.Emit.actionId.toString(16)}`,
    `action ${CoreHostActions.RuleTrigger.actionId.toString(16)}`,
    `action ${ConformanceHostActions.Emit.actionId.toString(16)}`,
  ];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    for (const lines of ticks) {
      assert.deepEqual(eventKinds(lines), perThink);
    }
    assert.ok(
      traceLines(variant.trace, `action ${CoreHostActions.RuleTrigger.actionId.toString(16)} `).every((line) =>
        line.endsWith(" async")
      ),
      "the arming read is dispatched asynchronously even when it resolves in place"
    );
  }
});
