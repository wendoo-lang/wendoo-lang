/**
 * Corpus case `page-identity-read`. A two-page brain whose pages switch to each
 * other every think, each gating its emit on a comparison of the two page
 * identity sensors:
 *
 * ```
 * page 1: WHEN [current page == previous page] DO [emit 1]
 *         DO [switch page 2]
 * page 2: WHEN [current page == previous page] DO [emit 2]
 *         DO [switch page 1]
 * ```
 *
 * `current page` reads the active page's stable id. `previous page` reads the
 * most recently deactivated page's, and falls back to the current page's id
 * while no page has been deactivated yet -- so the comparison holds only on the
 * first think and fails on every think after a switch. The trace pins both
 * readings and the page each names.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendPage,
  appendWhen,
  conformanceTiles,
  corePageTiles,
  newBrain,
  numberLiteral,
  operatorTile,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "page-identity-read";

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

  appendWhen(firstRule, pageTiles.currentPage, operatorTile(environment, CoreOpId.EqualTo), pageTiles.previousPage);
  appendDo(firstRule, tiles.emit, literal(1));
  appendDo(page.appendNewRule()!, pageTiles.switchPage, literal(2));

  const second = appendPage(brainDef);
  appendWhen(
    second.firstRule,
    pageTiles.currentPage,
    operatorTile(environment, CoreOpId.EqualTo),
    pageTiles.previousPage
  );
  appendDo(second.firstRule, tiles.emit, literal(2));
  appendDo(second.page.appendNewRule()!, pageTiles.switchPage, literal(1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.CurrentPage.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.PreviousPage.actionId },
    { op: Op.HOST_CALL, a: CoreFuncId.OpEqualToString },
  ]);

  const currentPage = `action ${CoreHostActions.CurrentPage.actionId.toString(16)}`;
  const previousPage = `action ${CoreHostActions.PreviousPage.actionId.toString(16)}`;
  const emit = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const switchPage = `action ${CoreHostActions.SwitchPage.actionId.toString(16)}`;
  // The first think reads both sensors, fires, and switches; every later think
  // reads both, does not fire, and switches back.
  const perThink = [
    [currentPage, previousPage, emit, switchPage],
    [currentPage, previousPage, switchPage],
    [currentPage, previousPage, switchPage],
    [currentPage, previousPage, switchPage],
  ];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const current = resultsOf(variant.trace, CoreHostActions.CurrentPage.actionId);
    const previous = resultsOf(variant.trace, CoreHostActions.PreviousPage.actionId);
    assert.equal(current.length, minted.entry.schedule.length);
    assert.equal(new Set(current).size, 2, "the two pages carry distinct ids");
    assert.equal(previous[0], current[0], "before any deactivation previous page reads the current page");
    for (let tick = 1; tick < current.length; tick++) {
      assert.equal(previous[tick], current[tick - 1], "previous page reads the page the switch just left");
      assert.notEqual(previous[tick], current[tick]);
    }
  }
});
