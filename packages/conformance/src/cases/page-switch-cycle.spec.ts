/**
 * Corpus case `page-switch-cycle`. A three-page brain that walks from the
 * first page to the last, one switch per page:
 *
 * ```
 * page 1: DO [emit 1]        page 2: DO [emit 2]        page 3: DO [emit 3]
 *         DO [switch page 2]         DO [switch page 3]
 * ```
 *
 * The switch request is served at the START of the next think: the dispatching
 * think still belongs to the old page and runs the rest of its rules, and the
 * new page's rules first run one think later. The trace pins that boundary --
 * each page emits its own number on the thinks it is active for, and the last
 * page, which switches nowhere, emits on every remaining think.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendPage, conformanceTiles, corePageTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "page-switch-cycle";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const pageTiles = corePageTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendDo(firstRule, tiles.emit, literal(1));
  appendDo(page.appendNewRule()!, pageTiles.switchPage, literal(2));

  const second = appendPage(brainDef);
  appendDo(second.firstRule, tiles.emit, literal(2));
  appendDo(second.page.appendNewRule()!, pageTiles.switchPage, literal(3));

  const third = appendPage(brainDef);
  appendDo(third.firstRule, tiles.emit, literal(3));

  return brainDef;
}

/** The single argument value token of each `emit` line, in emission order. */
function emittedValues(trace: string): string[] {
  return traceLines(trace, `action ${ConformanceHostActions.Emit.actionId.toString(16)} `).map((line) =>
    line.split(" ").slice(6, 8).join(" ")
  );
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.HOST_ACTION_CALL, a: CoreHostActions.SwitchPage.actionId }]);

  const emit = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const switchPage = `action ${CoreHostActions.SwitchPage.actionId.toString(16)}`;
  // The switching page still runs its own emit on the think it dispatches the
  // switch; from the third think the last page is active and only emits.
  const perThink = [[emit, switchPage], [emit, switchPage], [emit], [emit], [emit]];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    assert.deepEqual(ticks.map(eventKinds), perThink);

    // Each page emits its own number, so the emit arguments name the page each
    // think belonged to: three pages in order, the last one holding.
    const emitted = emittedValues(variant.trace);
    assert.equal(new Set(emitted).size, 3, "each of the three pages emits a distinct number");
    assert.deepEqual(emitted.slice(2), [emitted[2], emitted[2], emitted[2]]);
    assert.notEqual(emitted[0], emitted[1]);
    assert.notEqual(emitted[1], emitted[2]);
  }
});
