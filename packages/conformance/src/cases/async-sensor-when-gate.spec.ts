/**
 * Corpus case `async-sensor-when-gate`. Two root rules whose WHEN root is an
 * asynchronous sensor, one resolving truthy and one resolving falsy:
 *
 * ```
 * WHEN [defer read 1 ticks 1] DO [emit 1]
 * WHEN [defer read 0 ticks 1] DO [emit 2]
 * ```
 *
 * Each rule dispatches its sensor and parks inside its WHEN section, before
 * the gate has run. One think later the handles settle and both fibers resume
 * at the same point, each carrying its resolved reading into the gate: the
 * rule that read `1` runs its DO in that think, and the rule that read `0`
 * skips it. Both rules complete and respawn, so the dispatch and the resume
 * alternate across the schedule. The trace pins the parked dispatch, the think
 * the resumed gate lands on, and that only the truthy reading reaches an emit.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "async-sensor-when-gate";

/** Ticks between a `defer read` dispatch and its handle resolving. */
const DEFER_TICKS = 1;

/** Reading that resolves truthy, so the rule reading it runs its DO. */
const TRUTHY_READING = 1;

/** Reading that resolves falsy, so the rule reading it skips its DO. */
const FALSY_READING = 0;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendWhen(firstRule, tiles.deferRead, literal(TRUTHY_READING), tiles.ticks, literal(DEFER_TICKS));
  appendDo(firstRule, tiles.emit, literal(1));

  const skipping = page.appendNewRule()!;
  appendWhen(skipping, tiles.deferRead, literal(FALSY_READING), tiles.ticks, literal(DEFER_TICKS));
  appendDo(skipping, tiles.emit, literal(2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferRead.actionId },
    { op: Op.AWAIT },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferRead.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // Both rules dispatch and park on the odd thinks; on the even thinks they
  // resume at the gate, where only the truthy reading reaches a DO.
  const perThink = [[readEvent, readEvent], [emitEvent], [readEvent, readEvent], [emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(
      traceLines(variant.trace, `${readEvent} `).every((line) => line.endsWith(" async")),
      "an asynchronous sensor read renders no result"
    );
    // The falsy reading never reaches its rule's DO, so every emit in the trace
    // is the same call site passing the same value.
    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.equal(new Set(emits).size, 1, "only the rule whose reading resolved truthy emits");
  }
});
