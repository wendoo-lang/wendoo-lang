/**
 * Corpus case `then-trigger-abandoned`. A `then` rule whose subject's cluster
 * loses a fiber to a fault before it empties:
 *
 * ```
 * WHEN [echo 1] DO [defer echo 3 ticks 1]
 *                    DO [fault]
 * THEN          DO [emit 1]
 * ```
 *
 * The subject dispatches an asynchronous action and parks. One think later it
 * resumes, spawns the child rule at its tail, and completes; the child then
 * raises in its host body and faults. The settle walk at the child's terminal
 * transition marks the child and the subject as abandoned firings, so the
 * subject's cluster empties with an abandonment mark standing against a
 * `DidFire` record. The `then` rule's arming read answers false on that, and
 * the rule skips its DO.
 *
 * The two-think cycle reaches the arming read in both of its states, and the
 * trace pins each: on the first think of a cycle the subject is still in
 * flight, so the read parks in the subject's watcher slot and the settle walk
 * resolves it false a think later; when the `then` rule instead respawns into
 * the think the fault lands in, the read finds a settled subject and answers
 * false in place. Either way the trace carries no emit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { RuleTriggerMode } from "@wendoo/core/brain";
import { ErrorCode, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "then-trigger-abandoned";

/** Ticks between the subject's `defer echo` dispatch and its handle resolving. */
const DEFER_TICKS = 1;

/** Value the subject's deferred handle resolves to. */
const DEFERRED_VALUE = 3;

/** Event kind every fault line reduces to, with the faulted fiber's id dropped. */
const FAULT_EVENT = "fault";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendWhen(firstRule, tiles.echo, literal(1));
  appendDo(firstRule, tiles.deferEcho, literal(DEFERRED_VALUE), tiles.ticks, literal(DEFER_TICKS));

  const faulting = firstRule.appendNewRule();
  appendDo(faulting, tiles.fault);

  const follower = page.appendNewRule()!;
  follower.setTrigger(RuleTriggerMode.Then);
  appendDo(follower, tiles.emit, literal(1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: CoreHostActions.RuleTrigger.actionId },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Fault.actionId },
    { op: Op.SPAWN_RULE },
  ]);

  const echoEvent = `action ${ConformanceHostActions.Echo.actionId.toString(16)}`;
  const deferEvent = `action ${ConformanceHostActions.DeferEcho.actionId.toString(16)}`;
  const triggerEvent = `action ${CoreHostActions.RuleTrigger.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The subject dispatches and parks while the follower arms (1); the subject
  // resumes and its child faults, resolving the parked arming handle false (2);
  // the woken follower skips its DO and the subject dispatches again (3); the
  // follower respawns into the think the next fault lands in, so its read
  // answers false without parking (4); from there the cycle repeats (5, 6).
  const perThink = [
    [echoEvent, deferEvent, triggerEvent],
    [FAULT_EVENT],
    [echoEvent, deferEvent],
    [FAULT_EVENT, triggerEvent],
    [echoEvent, deferEvent, triggerEvent],
    [FAULT_EVENT],
  ];

  for (const variant of minted.variants) {
    const faults = traceLines(variant.trace, `${FAULT_EVENT} `);
    assert.ok(faults.length > 0, "the child rule must fault at least once");
    for (const line of faults) {
      assert.ok(line.endsWith(` ${ErrorCode.ScriptError.toString(16)}`), "a raising host body faults with ScriptError");
    }
    const ticks = traceEventsByTick(variant.trace).map((lines) =>
      eventKinds(lines).map((kind) => (kind.startsWith(FAULT_EVENT) ? FAULT_EVENT : kind))
    );
    assert.deepEqual(ticks, perThink);
    assert.ok(
      traceLines(variant.trace, `${triggerEvent} `).every((line) => line.endsWith(" async")),
      "the arming read is dispatched asynchronously whether it parks or answers in place"
    );
    assert.equal(
      traceLines(variant.trace, `${emitEvent} `).length,
      0,
      "an arming read answered false by an abandoned firing never reaches the rule's DO"
    );
  }
});
