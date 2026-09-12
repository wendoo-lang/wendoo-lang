/**
 * Corpus case `page-switch-no-arg`. A one-page brain that asks every think to
 * switch to no page at all, the nil literal standing in for a page number or a
 * page id:
 *
 * ```
 * WHEN [on page entered] DO [emit 1]
 * DO [defer echo 7 ticks 2]
 *   DO [emit 2]
 * DO [switch page nil]
 * ```
 *
 * The nil binds to one slot and nothing supplies the other, so the actuator
 * reads nil in both and is given no page to switch to. That is the restart
 * shorthand, and the trace pins it as a restart rather than a page change or a
 * no-op. `on page entered` is true only on the first think, so the page is
 * never deactivated and reactivated. Yet every think re-dispatches: the
 * restart cancels the page's fibers, so the rule parked on the handle dies
 * before the settlement reaches it, the rule nested beneath it is never run,
 * and the root rule respawns to dispatch again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  conformanceTiles,
  corePageTiles,
  newBrain,
  nilLiteral,
  numberLiteral,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "page-switch-no-arg";

/** Thinks between a dispatch and the settlement no fiber of this case lives to see. */
const DEFER_TICKS = 2;

/** Value each dispatch would resolve to if a restart did not cancel its fiber first. */
const DEFERRED_VALUE = 7;

/** Number the rule gated on `on page entered` emits. */
const ENTERED_VALUE = 1;

/** Number the rule beneath the parked dispatch would emit if it were ever reached. */
const UNREACHED_VALUE = 2;

/** What the `on page entered` gate reads on each think of the schedule. */
const ENTERED_PER_THINK = ["bool 1", "bool 0", "bool 0"];

/** Emits of the whole run: the entry gate's, on the first think, and no other. */
const TOTAL_EMITS = 1;

/** The arguments and result every `switch page` line of this case renders. */
const EMPTY_ARGUMENTS = " args 2 nil nil result void";

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
  appendDo(firstRule, tiles.emit, literal(ENTERED_VALUE));

  const deferring = page.appendNewRule()!;
  appendDo(deferring, tiles.deferEcho, literal(DEFERRED_VALUE), tiles.ticks, literal(DEFER_TICKS));
  appendDo(deferring.appendNewRule(), tiles.emit, literal(UNREACHED_VALUE));

  appendDo(page.appendNewRule()!, pageTiles.switchPage, nilLiteral(environment));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assert.equal(minted.program.pages.size(), 1);
  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.SwitchPage.actionId },
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferEcho.actionId },
  ]);

  const entered = `action ${CoreHostActions.OnPageEntered.actionId.toString(16)}`;
  const dispatch = `action ${ConformanceHostActions.DeferEcho.actionId.toString(16)}`;
  const emit = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const switchPage = `action ${CoreHostActions.SwitchPage.actionId.toString(16)}`;
  // The entry gate passes on the first think only; every think dispatches
  // afresh, because the restart cancelled the fiber the previous one parked.
  const perThink = [
    [entered, emit, dispatch, switchPage],
    [entered, dispatch, switchPage],
    [entered, dispatch, switchPage],
  ];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0, "a cancelled fiber ends without faulting");
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    assert.deepEqual(ticks.map(eventKinds), perThink);

    // The page stays active throughout, so no activation hook runs again.
    assert.deepEqual(resultsOf(variant.trace, CoreHostActions.OnPageEntered.actionId), ENTERED_PER_THINK);

    // Every call costs the page its fibers: one dispatch per think, and the
    // rule beneath the parked dispatch is never reached.
    const calls = traceLines(variant.trace, `${switchPage} `);
    assert.equal(calls.length, minted.entry.schedule.length);
    assert.deepEqual(
      calls.map((line) => line.slice(line.indexOf(" args "))),
      calls.map(() => EMPTY_ARGUMENTS)
    );
    assert.equal(traceLines(variant.trace, `${dispatch} `).length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, `${emit} `).length, TOTAL_EMITS);
  }
});
