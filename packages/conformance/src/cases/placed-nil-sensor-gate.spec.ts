/**
 * Corpus case `placed-nil-sensor-gate`. WHEN-side sensor calls whose
 * anonymous values are placed expressions, read off a `Point` variable no rule
 * assigns and off a number variable a rule assigns:
 *
 * ```
 * WHEN [echo lost.x]     DO [emit 1]
 * WHEN [timeout lost.x]  DO [emit 2]
 * DO [n = 7]
 * WHEN [echo n]          DO [emit 3]
 * ```
 *
 * A value placed in an anonymous slot that evaluates to nothing gates its
 * call: the sensor is not dispatched and reads nil, so its rule does not
 * fire. `lost.x` reads nil, so neither `echo` nor the core timer it is placed
 * in ever dispatches, and neither rule emits. The trace pins that only the
 * echo of the assigned variable dispatches, carrying 7, and that its rule
 * fires, with nothing faulting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  conformanceTiles,
  coreTimeoutTile,
  newBrain,
  numberLiteral,
  numberVariable,
  operatorTile,
  pointVariable,
} from "../authoring";
import {
  assertCaseIsStable,
  assertCompiledOps,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "placed-nil-sensor-gate";

/** Value the assigned variable holds and its echo carries; exactly representable at f32. */
const ASSIGNED = 7;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  const lost = pointVariable(brainDef, "lost");
  appendWhen(firstRule, tiles.echo, lost, tiles.pointX);
  appendDo(firstRule, tiles.emit, literal(1));

  const timer = page.appendNewRule()!;
  appendWhen(timer, coreTimeoutTile(environment), lost, tiles.pointX);
  appendDo(timer, tiles.emit, literal(2));

  const n = numberVariable(brainDef, "n");
  appendDo(page.appendNewRule()!, n, operatorTile(environment, CoreOpId.Assign), literal(ASSIGNED));

  const present = page.appendNewRule()!;
  appendWhen(present, tiles.echo, n);
  appendDo(present, tiles.emit, literal(3));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.JMP_IF_FALSE },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Echo.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.Timeout.actionId },
  ]);

  const echoEvent = `action ${ConformanceHostActions.Echo.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // Only the echo of the assigned variable dispatches, and only its rule emits.
  const perThink = [
    [echoEvent, emitEvent],
    [echoEvent, emitEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const assigned = numberToken(ASSIGNED, variant.precision);
    for (const line of traceLines(variant.trace, `${echoEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${assigned} result ${assigned}`), `unexpected echo line: ${line}`);
    }
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${numberToken(3, variant.precision)} result void`), `unexpected emit: ${line}`);
    }
  }
});
