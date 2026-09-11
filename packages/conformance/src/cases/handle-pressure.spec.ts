/**
 * Corpus case `handle-pressure`. More independent asynchronous dispatches than
 * the profile's `maxHandles` cap admits, all wanting a handle in the same
 * think:
 *
 * ```
 * DO [defer echo 1 ticks 2]
 * DO [defer echo 2 ticks 2]
 * ... one root rule per value, DISPATCHER_COUNT of them
 * ```
 *
 * Each root rule dispatches once and parks. The first `maxHandles` dispatches
 * allocate; the rest find the handle table full, re-enqueue with their program
 * counter unchanged, and re-execute the identical dispatch on a later round.
 * Nothing faults and no dispatch is lost: the breadth spills across thinks in
 * waves bounded by the cap. The trace pins the per-think dispatch count against
 * the cap and the eventual settlement of every dispatcher.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceEventsByTick, traceLines } from "../mint";
import { CONFORMANCE_SCHEDULER_CONFIG, ConformanceHostActions } from "../profile";

const CASE_ID = "handle-pressure";

/** Root rules dispatching concurrently; above the profile's concurrent-handle cap. */
const DISPATCHER_COUNT = 10;

/** Ticks between a dispatcher's `defer echo` and its handle resolving. */
const DEFER_TICKS = 2;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  for (let index = 0; index < DISPATCHER_COUNT; index++) {
    const rule = index === 0 ? firstRule : page.appendNewRule()!;
    appendDo(
      rule,
      tiles.deferEcho,
      numberLiteral(environment, brainDef, index + 1),
      tiles.ticks,
      numberLiteral(environment, brainDef, DEFER_TICKS)
    );
  }

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferEcho.actionId },
    { op: Op.AWAIT },
  ]);

  const dispatchPrefix = `action ${ConformanceHostActions.DeferEcho.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0, "backpressure parks and retries, it never faults");
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    for (const lines of ticks) {
      for (const line of lines) {
        assert.ok(line.startsWith(dispatchPrefix) && line.endsWith(" async"));
      }
      assert.ok(
        lines.length <= CONFORMANCE_SCHEDULER_CONFIG.maxHandles,
        `a think dispatches at most maxHandles asynchronous actions, saw ${lines.length}`
      );
    }
    assert.equal(
      ticks[0]!.length,
      CONFORMANCE_SCHEDULER_CONFIG.maxHandles,
      "the first think fills the cap and spills the rest of the breadth"
    );

    // Every dispatcher reaches the host: the breadth over the cap is delayed by
    // the spill, never dropped, and each retry re-executes the identical
    // dispatch at its own call site.
    const sites = new Set(traceLines(variant.trace, dispatchPrefix).map((line) => line.split(" ")[3]));
    assert.equal(sites.size, DISPATCHER_COUNT);
  }
});
