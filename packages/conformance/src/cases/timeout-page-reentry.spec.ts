/**
 * Corpus case `timeout-page-reentry`. A two-page brain whose pages each switch
 * to the other once their own timer runs out, over thinks 50 ms apart:
 *
 * ```
 * page 1: WHEN [timeout 0.25]  DO [switch page 2]
 * page 2: WHEN [timeout 0.25]  DO [switch page 1]
 * ```
 *
 * The brain ping-pongs between its pages, and the trace pins that each page's
 * timer runs its full delay from every entry of its page. Page 1's timer fires
 * on think 6, 250 ms after its first read; the switch is served at the next
 * think, and page 2's timer, first read on think 7, fires on think 12. When
 * page 1 is entered again on think 13, its timer last armed 550 ms, a time
 * already passed; it re-arms from think 13 and fires on think 18, not on
 * think 13.
 *
 * Every delay and schedule time is exactly representable at both precisions,
 * and so is every armed time, so the switching thinks are the same at either.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendPage,
  appendWhen,
  corePageTiles,
  coreTimeoutTile,
  newBrain,
  numberLiteral,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceEventsByTick } from "../mint";

const CASE_ID = "timeout-page-reentry";

/** Delay in seconds of each page's timer. */
const DELAY = 0.25;

/** The thinks a page switch is dispatched on: five thinks after each entry of a page. */
const SWITCH_THINKS = [6, 12, 18, 24];

function build(environment: WendooEnvironment): IBrainDef {
  const pageTiles = corePageTiles(environment);
  const timeout = coreTimeoutTile(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendWhen(firstRule, timeout, literal(DELAY));
  appendDo(firstRule, pageTiles.switchPage, literal(2));

  const second = appendPage(brainDef);
  appendWhen(second.firstRule, timeout, literal(DELAY));
  appendDo(second.firstRule, pageTiles.switchPage, literal(1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.Timeout.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.SwitchPage.actionId },
  ]);

  const timer = `action ${CoreHostActions.Timeout.actionId.toString(16)} `;
  const switchPage = `action ${CoreHostActions.SwitchPage.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    assert.ok(ticks.every((lines) => lines.every((line) => !line.startsWith("fault "))));

    // Every think reads the active page's one timer, and a page switch is
    // dispatched exactly on the thinks its timer fires.
    const switches: number[] = [];
    const sites: string[] = [];
    for (const [index, lines] of ticks.entries()) {
      const reads = lines.filter((line) => line.startsWith(timer));
      assert.equal(reads.length, 1, `think ${index + 1} reads one timer`);
      sites.push(reads[0]!.split(" ")[3]!);
      const fired = reads[0]!.endsWith("result bool 1");
      const switched = lines.some((line) => line.startsWith(switchPage));
      assert.equal(switched, fired, `think ${index + 1} switches exactly when its timer fires`);
      if (switched) switches.push(index + 1);
    }
    assert.deepEqual(switches, SWITCH_THINKS);

    // The two pages' timers are two call sites, each read on the thinks its
    // page is active: page 1 through think 6 and again from think 13.
    const [first, second] = [sites[0]!, sites[6]!];
    assert.notEqual(first, second);
    assert.deepEqual(
      sites.map((site) => (site === first ? 1 : 2)),
      [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]
    );
  }
});
