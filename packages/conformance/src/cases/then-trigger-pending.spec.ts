/**
 * Corpus case `then-trigger-pending`. A subject rule whose cluster is still in
 * flight when its `then` sibling arms:
 *
 * ```
 * WHEN [echo 1] DO [defer echo 5 ticks 2]
 * THEN          DO [emit 1]
 * ```
 *
 * The subject dispatches an asynchronous action and parks, so the `then`
 * rule's arming read finds a live subtree: its handle stays pending in the
 * subject's watcher slot and the rule waits across thinks. When the subject's
 * handle resolves and its last fiber reaches a terminal state, the settle walk
 * resolves the parked trigger handle, and the woken rule fires on the
 * following think. The trace pins the arming dispatch, the thinks that carry
 * no effect while the rule waits, and the think the wake lands on.
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

const CASE_ID = "then-trigger-pending";

/** Ticks between the subject's `defer echo` dispatch and its handle resolving. */
const DEFER_TICKS = 2;

/** Value the subject's deferred handle resolves to. */
const DEFERRED_VALUE = 5;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.echo, numberLiteral(environment, brainDef, 1));
  appendDo(
    firstRule,
    tiles.deferEcho,
    numberLiteral(environment, brainDef, DEFERRED_VALUE),
    tiles.ticks,
    numberLiteral(environment, brainDef, DEFER_TICKS)
  );

  const follower = page.appendNewRule()!;
  follower.setTrigger(RuleTriggerMode.Then);
  appendDo(follower, tiles.emit, numberLiteral(environment, brainDef, 1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: CoreHostActions.RuleTrigger.actionId },
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferEcho.actionId },
  ]);

  const triggerEvent = `action ${CoreHostActions.RuleTrigger.actionId.toString(16)}`;
  const echoEvent = `action ${ConformanceHostActions.Echo.actionId.toString(16)}`;
  const deferEvent = `action ${ConformanceHostActions.DeferEcho.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // One full cycle of the wait: the subject dispatches and the follower arms
  // and parks (1); the wait carries no effect (2); the subject's handle settles
  // and its fiber completes, resolving the parked trigger (3); the woken
  // follower fires one round later, beside the subject's respawned dispatch
  // (4); the follower re-arms and parks on the new firing (5); the subject
  // settles again (6).
  const perThink = [
    [echoEvent, deferEvent, triggerEvent],
    [],
    [],
    [emitEvent, echoEvent, deferEvent],
    [triggerEvent],
    [],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    assert.deepEqual(ticks.map(eventKinds), perThink);
    assert.ok(
      traceLines(variant.trace, `${triggerEvent} `).every((line) => line.endsWith(" async")),
      "an arming read that parks renders no result"
    );
  }
});
