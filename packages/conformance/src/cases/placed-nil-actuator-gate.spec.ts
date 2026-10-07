/**
 * Corpus case `placed-nil-actuator-gate`. Actuator calls whose anonymous
 * values are placed expressions, read off a `Point` variable no rule assigns
 * and off one a rule assigns the `waypoint` constant:
 *
 * ```
 * DO [emit lost.x]
 * DO [emit all 1 lost.x 2]
 * DO [defer echo lost.x]
 * DO [spot = waypoint]
 *   DO [emit spot.x]
 *   DO [emit all 1 spot.x 2]
 * ```
 *
 * A value placed in an anonymous slot that evaluates to nothing gates its
 * call: the action is not dispatched. `lost.x` reads nil, so the first three
 * calls never dispatch -- one nil element of a repeated slot gates the whole
 * call, and the asynchronous call is skipped before it takes a handle. The
 * trace pins that only the two calls below the assignment dispatch, each
 * carrying the waypoint's `x`, and that nothing faults.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, operatorTile, pointVariable } from "../authoring";
import {
  assertCaseIsStable,
  assertCompiledOps,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { CONFORMANCE_POINT_CONSTANT, ConformanceHostActions } from "../profile";

const CASE_ID = "placed-nil-actuator-gate";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  const lost = pointVariable(brainDef, "lost");
  appendDo(firstRule, tiles.emit, lost, tiles.pointX);
  appendDo(page.appendNewRule()!, tiles.emitAll, literal(1), lost, tiles.pointX, literal(2));
  appendDo(page.appendNewRule()!, tiles.deferEcho, lost, tiles.pointX);

  const spot = pointVariable(brainDef, "spot");
  const assign = page.appendNewRule()!;
  appendDo(assign, spot, operatorTile(environment, CoreOpId.Assign), tiles.pointWaypoint);
  appendDo(assign.appendNewRule()!, tiles.emit, spot, tiles.pointX);
  appendDo(assign.appendNewRule()!, tiles.emitAll, literal(1), spot, tiles.pointX, literal(2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_CALL, a: CoreFuncId.OpNotEqualToNumberNil },
    { op: Op.JMP_IF_FALSE },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.EmitAll.actionId },
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferEcho.actionId },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const emitAllEvent = `action ${ConformanceHostActions.EmitAll.actionId.toString(16)}`;
  // Only the two calls reading the assigned variable dispatch, every think.
  const perThink = [
    [emitEvent, emitAllEvent],
    [emitEvent, emitAllEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(!variant.trace.includes(" nil "), "no call received a nil value");

    const x = numberToken(CONFORMANCE_POINT_CONSTANT.x, variant.precision);
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${x} result void`), `unexpected emit line: ${line}`);
    }
    const listToken = `list 3 ${numberToken(1, variant.precision)} ${x} ${numberToken(2, variant.precision)}`;
    for (const line of traceLines(variant.trace, `${emitAllEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${listToken} result void`), `unexpected emit all line: ${line}`);
    }
  }
});
