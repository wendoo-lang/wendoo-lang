/**
 * Corpus case `struct-field-reads`. One root rule capturing an asynchronous
 * struct reading into a variable, with field reads feeding the emits:
 *
 * ```
 * WHEN [pos = defer point] DO [emit pos.x]
 *   DO [emit pos.y]
 * ```
 *
 * The rule dispatches `defer point` and parks inside its WHEN. One think later
 * the handle resolves to the fixed `Point` reading, the assignment stores it,
 * and the gate fires on the struct (a struct value is truthy). The DO and its
 * child rule each read one field by slot index (`STRUCT_GET_FIELD`) and emit
 * the number. The trace pins the parked dispatch, both field values as exact
 * bit patterns, and that no struct value reaches an observable position: the
 * asynchronous dispatch line renders its arguments and no result, and the
 * emits carry numbers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, operatorTile, pointVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { CONFORMANCE_POINT_READING, ConformanceHostActions, ConformancePointField } from "../profile";

const CASE_ID = "struct-field-reads";

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

  const pos = pointVariable(brainDef, "pos");
  appendWhen(firstRule, pos, operatorTile(environment, CoreOpId.Assign), tiles.deferPoint);
  appendDo(firstRule, tiles.emit, pos, tiles.pointX);

  const readY = firstRule.appendNewRule()!;
  appendDo(readY, tiles.emit, pos, tiles.pointY);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferPoint.actionId },
    { op: Op.AWAIT },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.Y },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferPoint.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, stores the reading, and the two field reads reach their emits.
  const perThink = [[readEvent], [emitEvent, emitEvent], [readEvent], [emitEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(
      traceLines(variant.trace, `${readEvent} `).every((line) => line.endsWith(" async")),
      "an asynchronous sensor dispatch renders no result"
    );
    assert.ok(!variant.trace.includes("struct"), "no struct value occupies an observable position");
    assert.ok(!variant.trace.includes("opaque"), "no value renders opaque");

    const emits = traceLines(variant.trace, `${emitEvent} `);
    const xToken = numberToken(CONFORMANCE_POINT_READING.x, variant.precision);
    const yToken = numberToken(CONFORMANCE_POINT_READING.y, variant.precision);
    for (const [index, line] of emits.entries()) {
      const token = index % 2 === 0 ? xToken : yToken;
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }
  }
});
