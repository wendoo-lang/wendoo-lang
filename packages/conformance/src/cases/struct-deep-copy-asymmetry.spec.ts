/**
 * Corpus case `struct-deep-copy-asymmetry`. One root rule capturing an
 * asynchronous struct reading, copying it into a second variable, mutating a
 * field of the copy, and emitting the same field from both variables:
 *
 * ```
 * WHEN [pos = defer point] DO [copy = pos]
 *   DO [copy.x = 8.5]
 *   DO [emit pos.x]
 *   DO [emit copy.x]
 * ```
 *
 * `copy = pos` stores through `STORE_VAR_SLOT`, which deep-copies a struct on
 * store, so the two variables do not alias. `copy.x = 8.5` lowers to
 * `STRUCT_DEEP_COPY` (of the assigned value; a runtime no-op on a number)
 * plus `STRUCT_SET_FIELD`, which writes the stored struct's field slot in
 * place with no store-back. The synchronous child cascade orders the
 * mutation before the reads, and the emits pin the asymmetry: `pos.x` still
 * carries the settled reading while `copy.x` carries the mutated value.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  numberLiteral,
  operatorTile,
  pointVariable,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { CONFORMANCE_POINT_READING, ConformanceHostActions, ConformancePointField } from "../profile";

const CASE_ID = "struct-deep-copy-asymmetry";

/** Value the case writes into the copy's `x` field; exactly representable at f32. */
const MUTATED_X = 8.5;

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
  const copy = pointVariable(brainDef, "copy");
  appendWhen(firstRule, pos, assign(), tiles.deferPoint);
  appendDo(firstRule, copy, assign(), pos);

  const mutate = firstRule.appendNewRule()!;
  appendDo(mutate, copy, tiles.pointX, assign(), numberLiteral(environment, brainDef, MUTATED_X));

  const readPos = firstRule.appendNewRule()!;
  appendDo(readPos, tiles.emit, pos, tiles.pointX);

  const readCopy = firstRule.appendNewRule()!;
  appendDo(readCopy, tiles.emit, copy, tiles.pointX);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferPoint.actionId },
    { op: Op.AWAIT },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.STRUCT_DEEP_COPY },
    { op: Op.STRUCT_SET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.X },
    { op: Op.SPAWN_RULE },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferPoint.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, the cascade mutates the copy, and the two reads reach their emits.
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
    const posToken = numberToken(CONFORMANCE_POINT_READING.x, variant.precision);
    const copyToken = numberToken(MUTATED_X, variant.precision);
    for (const [index, line] of emits.entries()) {
      // Each resume think emits pos.x (the reading, untouched by the copy's
      // mutation) and then copy.x (the mutated value).
      const token = index % 2 === 0 ? posToken : copyToken;
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }
  }
});
