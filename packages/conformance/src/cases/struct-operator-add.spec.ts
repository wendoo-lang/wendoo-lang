/**
 * Corpus case `struct-operator-add`. One root rule capturing an asynchronous
 * `Point` reading, combining it with the `waypoint` `Point` constant through
 * the profile's `point plus` operator, and reading the result:
 *
 * ```
 * WHEN [pos = defer point] DO [sum = pos point plus waypoint]
 *   DO [emit sum.x]
 *   DO [emit sum.y]
 *   DO [emit sum]
 * ```
 *
 * `point plus` is a synchronous operator whose one overload takes two
 * `Point`-typed operands and returns a `Point`, so the expression resolves by
 * operand type and compiles to a `HOST_CALL` on the overload's funcId. The
 * call is a host function, not a host action, so it renders no trace line of
 * its own: the operator's result is observable through the reads that follow.
 * The trace pins the fieldwise sums as exact bit patterns and the whole result
 * as a struct token, so a VM that resolved the operator differently, or built
 * the result value differently, diverges.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, operatorTile, pointVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import {
  CONFORMANCE_POINT_CONSTANT,
  CONFORMANCE_POINT_READING,
  ConformanceHostActions,
  ConformanceOperators,
  ConformancePointField,
} from "../profile";

const CASE_ID = "struct-operator-add";

/** The `number <bits>` token of `value` at `precision`, as the trace renders it. */
function numberToken(value: number, precision: NumberPrecision): string {
  if (precision === "f32") {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    return `number ${view.getUint32(0).toString(16).padStart(8, "0")}`;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return `number ${view.getUint32(0).toString(16).padStart(8, "0")}${view.getUint32(4).toString(16).padStart(8, "0")}`;
}

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const assign = () => operatorTile(environment, CoreOpId.Assign);

  const pos = pointVariable(brainDef, "pos");
  const sum = pointVariable(brainDef, "sum");
  appendWhen(firstRule, pos, assign(), tiles.deferPoint);
  appendDo(firstRule, sum, assign(), pos, tiles.pointAdd, tiles.pointWaypoint);

  const readX = firstRule.appendNewRule()!;
  appendDo(readX, tiles.emit, sum, tiles.pointX);

  const readY = firstRule.appendNewRule()!;
  appendDo(readY, tiles.emit, sum, tiles.pointY);

  const emitWhole = firstRule.appendNewRule()!;
  appendDo(emitWhole, tiles.emit, sum);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferPoint.actionId },
    { op: Op.AWAIT },
    { op: Op.HOST_CALL, a: ConformanceOperators.PointAdd.fnId },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.Y },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferPoint.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, the DO combines the reading with the constant, and the cascade
  // reads both fields of the result and then emits it whole.
  const perThink = [[readEvent], [emitEvent, emitEvent, emitEvent], [readEvent], [emitEvent, emitEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(!variant.trace.includes("opaque"), "no value renders opaque");

    const emits = traceLines(variant.trace, `${emitEvent} `);
    const xToken = numberToken(CONFORMANCE_POINT_READING.x + CONFORMANCE_POINT_CONSTANT.x, variant.precision);
    const yToken = numberToken(CONFORMANCE_POINT_READING.y + CONFORMANCE_POINT_CONSTANT.y, variant.precision);
    const wholeToken = `struct 2 ${xToken} ${yToken}`;
    const expected = [xToken, yToken, wholeToken];
    for (const [index, line] of emits.entries()) {
      assert.ok(
        line.endsWith(`args 1 ${expected[index % expected.length]} result void`),
        `unexpected emit line: ${line}`
      );
    }
  }
});
