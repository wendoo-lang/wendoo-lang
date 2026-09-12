/**
 * Corpus case `page-switch-cancellation`. A page switched away from while a
 * child-rule fiber two levels down is parked on a handle that has not settled:
 *
 * ```
 * page 1: DO [emit 1]
 *           DO [defer echo 7 ticks 3]
 *             DO [emit 2]
 *         WHEN [signal period 2] DO [switch page 2]
 * page 2: DO [emit 3]
 * ```
 *
 * The parked fiber is the grandchild of a root rule whose own fiber is already
 * done, so only the cascade reaches it: the switch cancels the page's root
 * fibers and then every live child-rule fiber beneath them. The cancelled
 * fiber stops awaiting, so when its handle settles two thinks later the
 * settlement reaches nobody and the innermost rule never runs. The trace pins
 * the single dispatch, the absence of the innermost emit, and that no fiber
 * faults on the way out.
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
  conformanceTiles,
  corePageTiles,
  newBrain,
  numberLiteral,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "page-switch-cancellation";

/** Thinks between the parked dispatch and the settlement the cancelled fiber no longer waits for. */
const DEFER_TICKS = 3;

/** Thinks between two deliveries of the sensor gating the switch. */
const SWITCH_PERIOD = 2;

/** Number the rule beneath the parked dispatch would emit if it were ever reached. */
const UNREACHED_VALUE = 2;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const pageTiles = corePageTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendDo(firstRule, tiles.emit, literal(1));

  const deferring = firstRule.appendNewRule();
  appendDo(deferring, tiles.deferEcho, literal(7), tiles.ticks, literal(DEFER_TICKS));

  const afterAwait = deferring.appendNewRule();
  appendDo(afterAwait, tiles.emit, literal(UNREACHED_VALUE));

  const switcher = page.appendNewRule()!;
  appendWhen(switcher, tiles.signal, tiles.period, literal(SWITCH_PERIOD));
  appendDo(switcher, pageTiles.switchPage, literal(2));

  const second = appendPage(brainDef);
  appendDo(second.firstRule, tiles.emit, literal(3));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferEcho.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.SwitchPage.actionId },
    { op: Op.SPAWN_RULE },
  ]);

  const dispatch = `action ${ConformanceHostActions.DeferEcho.actionId.toString(16)}`;
  const emit = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const signal = `action ${ConformanceHostActions.Signal.actionId.toString(16)}`;
  const switchPage = `action ${CoreHostActions.SwitchPage.actionId.toString(16)}`;
  // The first think dispatches and parks; the second switches away; from the
  // third only the second page's rule runs, including the think the abandoned
  // handle settles on.
  const perThink = [[emit, dispatch, signal], [signal, switchPage], [emit], [emit], [emit]];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0, "a cancelled fiber ends without faulting");
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.equal(traceLines(variant.trace, `${dispatch} `).length, 1, "the parked rule never re-fires");

    // The rule beneath the cancelled dispatch is never reached, so the only
    // emits are the one above it and the second page's.
    const emitted = traceLines(variant.trace, `${emit} `).map((line) => line.split(" ").slice(6, 8).join(" "));
    assert.equal(new Set(emitted).size, 2);
    assert.deepEqual(emitted.slice(1), [emitted[1], emitted[1], emitted[1]]);
  }
});
