/**
 * Corpus case `async-operator-await`. Two rules with no WHEN section, one
 * emitting what an asynchronous operator evaluated to and one emitting what a
 * synchronous operator evaluated to:
 *
 * ```
 * DO [emit 3 defer plus 4]
 * DO [emit 1 plus 2]
 * ```
 *
 * The asynchronous operator compiles to a host-function dispatch and an await,
 * so its rule parks mid-expression on the think it dispatches and reaches its
 * emit only on the next one, when the handle has resolved. The synchronous
 * operator's rule emits on every think. The alternation is the whole trace
 * shape: a think with one emit is one where the awaiting rule is parked, and a
 * think with two is one where its handle settled.
 *
 * Every operand is exactly representable at both profile precisions, so the two
 * precision variants differ only in the width of the rendered bit pattern.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, operatorTile } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions, ConformanceOperators } from "../profile";

const CASE_ID = "async-operator-await";

/** Operands of the asynchronous operator, summed one tick after its dispatch. */
const AWAITED_OPERANDS = [3, 4];

/** Operands of the synchronous operator, summed within the think that reads them. */
const IMMEDIATE_OPERANDS = [1, 2];

/** Emits the awaiting rule reaches over the schedule: one per settle. */
const AWAITED_EMITS = 2;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendDo(firstRule, tiles.emit, literal(AWAITED_OPERANDS[0]), tiles.deferAdd, literal(AWAITED_OPERANDS[1]));

  const immediate = page.appendNewRule()!;
  appendDo(
    immediate,
    tiles.emit,
    literal(IMMEDIATE_OPERANDS[0]),
    operatorTile(environment, CoreOpId.Add),
    literal(IMMEDIATE_OPERANDS[1])
  );

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_CALL_ASYNC, a: ConformanceOperators.DeferAdd.fnId },
    { op: Op.AWAIT },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The awaiting rule dispatches and parks on the odd thinks; on the even
  // thinks its handle has settled and it reaches its emit beside the other
  // rule's.
  const perThink = [[emitEvent], [emitEvent, emitEvent], [emitEvent], [emitEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    const byTick = traceEventsByTick(variant.trace);
    assert.deepEqual(byTick.map(eventKinds), perThink);
    // The one emit of a parked think is the rule whose operator settled in
    // place; every other emit is the awaited sum arriving at its own call site.
    const immediate = byTick[0][0];
    const awaited = byTick.flat().filter((line) => line !== immediate);
    assert.equal(awaited.length, AWAITED_EMITS);
    assert.equal(new Set(awaited).size, 1, "every settle carries the same sum to the same call site");
  }
});
