/**
 * Corpus case `presence-gate`. A bare presence-gated value sensor as the WHEN
 * root of a rule, and again as the WHEN root of its `otherwise` sibling:
 *
 * ```
 * WHEN      [signal period 2] DO [emit 1]
 * OTHERWISE [signal period 1] DO [emit 2]
 * ```
 *
 * `signal` delivers the number `0` on the thinks its period divides and nil on
 * the rest, so a truthiness gate would never fire on it. The head rule gates on
 * presence (`WHEN_END_PRESENT`) and fires on the even thinks; the `otherwise`
 * rule takes the chain form of the same gate (`WHEN_END_PRESENT_CHAIN`), so it
 * fires on the odd thinks its head left the chain open and stays quiet on the
 * thinks the head fired. The trace pins the delivered and absent readings, and
 * which rule each think admits.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { RuleTriggerMode } from "@wendoo/core/brain";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "presence-gate";

/** Thinks between two deliveries of the head rule's sensor. */
const HEAD_PERIOD = 2;

/** Thinks between two deliveries of the `otherwise` rule's sensor. */
const CHAIN_PERIOD = 1;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.signal, tiles.period, numberLiteral(environment, brainDef, HEAD_PERIOD));
  appendDo(firstRule, tiles.emit, numberLiteral(environment, brainDef, 1));

  const chained = page.appendNewRule()!;
  chained.setTrigger(RuleTriggerMode.Otherwise);
  appendWhen(chained, tiles.signal, tiles.period, numberLiteral(environment, brainDef, CHAIN_PERIOD));
  appendDo(chained, tiles.emit, numberLiteral(environment, brainDef, 2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.WHEN_END_PRESENT },
    { op: Op.WHEN_END_PRESENT_CHAIN },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Signal.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.Otherwise.actionId },
  ]);

  const signalEvent = `action ${ConformanceHostActions.Signal.actionId.toString(16)}`;
  const otherwiseEvent = `action ${CoreHostActions.Otherwise.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The head fires on a think its period divides, closing the chain before the
  // `otherwise` rule reads its own sensor; otherwise the chain stays open and
  // the second rule's reading is the one that gates.
  const headFires = [signalEvent, emitEvent, otherwiseEvent];
  const chainFires = [signalEvent, otherwiseEvent, signalEvent, emitEvent];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, minted.entry.schedule.length);
    for (const [index, lines] of ticks.entries()) {
      const ordinal = index + 1;
      assert.deepEqual(eventKinds(lines), ordinal % HEAD_PERIOD === 0 ? headFires : chainFires);
    }
    // Every delivered reading is the falsy number a truthiness gate would skip.
    const deliveries = traceLines(variant.trace, `${signalEvent} `).filter((line) => !line.endsWith("result nil"));
    assert.ok(deliveries.length > 0, "the sensor must deliver on at least one think");
    for (const line of deliveries) {
      assert.ok(line.endsWith(` result number ${"0".repeat(variant.precision === "f32" ? 8 : 16)}`));
    }
  }
});
