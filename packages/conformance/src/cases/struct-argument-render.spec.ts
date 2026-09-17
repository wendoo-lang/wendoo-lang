/**
 * Corpus case `struct-argument-render`. One root rule capturing an
 * asynchronous struct reading into a variable and emitting the struct whole:
 *
 * ```
 * WHEN [pos = defer point] DO [emit pos]
 * ```
 *
 * The rule dispatches `defer point` and parks inside its WHEN. One think later
 * the handle resolves to the fixed `Point` reading, the assignment stores it,
 * and the gate fires on the struct (a struct value is truthy). The DO passes
 * the struct into `emit`'s argument slot untouched -- no conversion compiles
 * for the anonymous slot -- so a struct value lands in the dispatch line's
 * argument position. The trace pins its token: the field count in minimal
 * hex, then one number token per field slot, in slot order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, operatorTile, pointVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { CONFORMANCE_POINT_READING, ConformanceHostActions } from "../profile";

const CASE_ID = "struct-argument-render";

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
  appendDo(firstRule, tiles.emit, pos);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferPoint.actionId },
    { op: Op.AWAIT },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferPoint.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, stores the reading, and the emit receives the struct whole.
  const perThink = [[readEvent], [emitEvent], [readEvent], [emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(!variant.trace.includes("opaque"), "no value renders opaque");

    const structToken = `struct 2 ${numberToken(CONFORMANCE_POINT_READING.x, variant.precision)} ${numberToken(
      CONFORMANCE_POINT_READING.y,
      variant.precision
    )}`;
    const emits = traceLines(variant.trace, `${emitEvent} `);
    for (const line of emits) {
      assert.ok(line.endsWith(`args 1 ${structToken} result void`), `unexpected emit line: ${line}`);
    }
  }
});
