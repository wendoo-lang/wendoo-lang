/**
 * Corpus case `defer-echo-resolve`. A rule that parks on an asynchronous
 * action, beside a root rule that keeps running:
 *
 * ```
 * DO [defer echo 7 ticks 2]
 *   DO [emit 1]
 * DO [emit 2]
 * ```
 *
 * The deferring rule dispatches on tick 1 and parks. Its handle resolves two
 * ticks later, so its child rule -- spawned at the parent's tail, after the
 * await -- emits on tick 3, and the rule dispatches again on tick 4. The
 * sibling root rule emits every think throughout.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "defer-echo-resolve";

/** Ticks between a `defer echo` dispatch and its handle resolving. */
const DEFER_TICKS = 2;

/** Value the deferred handle resolves to. */
const DEFERRED_VALUE = 7;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendDo(
    firstRule,
    tiles.deferEcho,
    numberLiteral(environment, brainDef, DEFERRED_VALUE),
    tiles.ticks,
    numberLiteral(environment, brainDef, DEFER_TICKS)
  );

  const afterAwait = firstRule.appendNewRule();
  appendDo(afterAwait, tiles.emit, numberLiteral(environment, brainDef, 1));

  const heartbeat = page.appendNewRule()!;
  appendDo(heartbeat, tiles.emit, numberLiteral(environment, brainDef, 2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferEcho.actionId }]);

  const asyncPrefix = `action ${ConformanceHostActions.DeferEcho.actionId.toString(16)} `;
  const emitPrefix = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const dispatches = traceLines(variant.trace, asyncPrefix);
    assert.ok(dispatches.length > 0, "the deferring rule must dispatch at least once");
    for (const line of dispatches) {
      assert.ok(line.endsWith(" async"), "an asynchronous dispatch renders no result");
    }
    // The heartbeat emits every think; the parked rule's child emits only on
    // the think its handle resolved into.
    assert.equal(traceLines(variant.trace, emitPrefix).length, minted.entry.schedule.length + 1);
  }
});
