/**
 * Corpus case `page-switch-out-of-range`. A one-page brain that asks every
 * think for a page the brain does not have:
 *
 * ```
 * WHEN [on page entered] DO [emit 1]
 * DO [emit 2]
 * DO [switch page 4]
 * ```
 *
 * A page-change request naming no page is a no-op, so the brain keeps running
 * on the page it is already on. The trace pins both halves of that: the
 * ungated rule emits on every think, and `on page entered` is true only on the
 * first, so the page is never deactivated and reactivated behind the request.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, corePageTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "page-switch-out-of-range";

/** The 1-based page ordinal the case requests; the brain has one page. */
const MISSING_PAGE_ORDINAL = 4;

/** The single argument value token of each `emit` line, in emission order. */
function emittedValues(trace: string): string[] {
  return traceLines(trace, `action ${ConformanceHostActions.Emit.actionId.toString(16)} `).map((line) =>
    line.split(" ").slice(6, 8).join(" ")
  );
}

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

  appendDo(page.appendNewRule()!, tiles.emit, literal(2));
  appendDo(page.appendNewRule()!, pageTiles.switchPage, literal(MISSING_PAGE_ORDINAL));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assert.equal(minted.program.pages.size(), 1, "the requested page ordinal must name no page of the brain");
  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.SwitchPage.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.OnPageEntered.actionId },
  ]);

  const entered = `action ${CoreHostActions.OnPageEntered.actionId.toString(16)}`;
  const emit = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const switchPage = `action ${CoreHostActions.SwitchPage.actionId.toString(16)}`;
  // Every think reads the entry gate, runs the ungated emit, and dispatches the
  // switch that names no page; only the first think passes the gate.
  const perThink = [
    [entered, emit, emit, switchPage],
    [entered, emit, switchPage],
    [entered, emit, switchPage],
  ];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    assert.deepEqual(ticks.map(eventKinds), perThink);

    // The gate is true once, so nothing reactivated the page after the request.
    assert.deepEqual(resultsOf(variant.trace, CoreHostActions.OnPageEntered.actionId), ["bool 1", "bool 0", "bool 0"]);

    // The ungated rule emits the same value on every think: one page, held.
    const emitted = emittedValues(variant.trace);
    const held = emitted.slice(1);
    assert.equal(held.length, minted.entry.schedule.length);
    assert.deepEqual(
      held,
      held.map(() => held[0])
    );
    assert.notEqual(emitted[0], held[0]);
  }
});
