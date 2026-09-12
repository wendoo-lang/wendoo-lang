/**
 * Corpus case `page-restart`. A one-page brain that restarts its own page on
 * every think, beside two rules that report what the restart did and did not
 * reset:
 *
 * ```
 * WHEN [on page entered] DO [emit 1]
 * WHEN [counter]         DO [emit 2]
 * DO [restart page]
 * ```
 *
 * A restart cancels the page's fibers and lets the root rules respawn on the
 * next think; it does not deactivate and reactivate the page. So the
 * activation hooks do not run again: `on page entered` is true on the first
 * think and false on every think after it, and `counter`, whose per-callsite
 * state the activation hook is the only thing that resets, keeps climbing
 * across the restarts. The trace pins both, and the respawn of all three rules
 * after each restart.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, corePageTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "page-restart";

/** The single returned value token of each line whose action id is `actionId`, in emission order. */
function resultsOf(trace: string, actionId: number): string[] {
  return traceLines(trace, `action ${actionId.toString(16)} `).map((line) => {
    const tokens = line.split(" ");
    return tokens.slice(tokens.indexOf("result") + 1).join(" ");
  });
}

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const pageTiles = corePageTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendWhen(firstRule, pageTiles.onPageEntered);
  appendDo(firstRule, tiles.emit, literal(1));

  const counted = page.appendNewRule()!;
  appendWhen(counted, tiles.counter);
  appendDo(counted, tiles.emit, literal(2));

  appendDo(page.appendNewRule()!, pageTiles.restartPage);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.RestartPage.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.OnPageEntered.actionId },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Counter.actionId },
  ]);

  const entered = `action ${CoreHostActions.OnPageEntered.actionId.toString(16)}`;
  const counter = `action ${ConformanceHostActions.Counter.actionId.toString(16)}`;
  const emit = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const restart = `action ${CoreHostActions.RestartPage.actionId.toString(16)}`;
  // Only the first think passes the `on page entered` gate; every think reads
  // the counter, emits for it, and restarts.
  const perThink = [
    [entered, emit, counter, emit, restart],
    [entered, counter, emit, restart],
    [entered, counter, emit, restart],
    [entered, counter, emit, restart],
  ];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const enteredResults = resultsOf(variant.trace, CoreHostActions.OnPageEntered.actionId);
    assert.deepEqual(enteredResults, ["bool 1", "bool 0", "bool 0", "bool 0"]);

    // The counter's per-callsite state survives every restart, so each think
    // reads a value the case has not seen before.
    const counts = resultsOf(variant.trace, ConformanceHostActions.Counter.actionId);
    assert.equal(counts.length, minted.entry.schedule.length);
    assert.equal(new Set(counts).size, counts.length, "no restart resets the counter's call-site state");
  }
});
