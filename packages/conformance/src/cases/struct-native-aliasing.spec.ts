/**
 * Corpus case `struct-native-aliasing`. One root rule capturing an
 * asynchronous native-backed `Anchor` value, copying it into a second
 * variable, writing a field through the copy, reading the same field from
 * both variables, and emitting the value whole:
 *
 * ```
 * WHEN [obj = defer anchor] DO [copy = obj]
 *   DO [copy.x = 8.5]
 *   DO [emit obj.x]
 *   DO [emit copy.x]
 *   DO [emit obj]
 * ```
 *
 * `Anchor` is native-backed and registers no `snapshotNative`, so the deep
 * copies at `STORE_VAR_SLOT` copy the native handle by reference: both
 * variables front the world's one anchor host object. `copy.x = 8.5`
 * dispatches the type's field setter into that object, and both field reads
 * dispatch its field getter, so every read shows the written value. The
 * final emit lands the native-backed value in an argument position, pinning
 * its `opaque` render token.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import {
  anchorVariable,
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  numberLiteral,
  operatorTile,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceAnchorField, ConformanceHostActions } from "../profile";

const CASE_ID = "struct-native-aliasing";

/** Value the case writes through the copy's `x` field; exactly representable at f32. */
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

  const obj = anchorVariable(brainDef, "obj");
  const copy = anchorVariable(brainDef, "copy");
  appendWhen(firstRule, obj, assign(), tiles.deferAnchor);
  appendDo(firstRule, copy, assign(), obj);

  const mutate = firstRule.appendNewRule()!;
  appendDo(mutate, copy, tiles.anchorX, assign(), numberLiteral(environment, brainDef, MUTATED_X));

  const readObj = firstRule.appendNewRule()!;
  appendDo(readObj, tiles.emit, obj, tiles.anchorX);

  const readCopy = firstRule.appendNewRule()!;
  appendDo(readCopy, tiles.emit, copy, tiles.anchorX);

  const emitWhole = firstRule.appendNewRule()!;
  appendDo(emitWhole, tiles.emit, obj);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferAnchor.actionId },
    { op: Op.AWAIT },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.STRUCT_SET_FIELD, a: ConformanceAnchorField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceAnchorField.X },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferAnchor.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, the cascade writes through the copy, and the reads and the
  // whole-value emit follow.
  const perThink = [[readEvent], [emitEvent, emitEvent, emitEvent], [readEvent], [emitEvent, emitEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(!variant.trace.includes("struct"), "a native-backed struct never renders a struct token");

    const emits = traceLines(variant.trace, `${emitEvent} `);
    const mutatedToken = numberToken(MUTATED_X, variant.precision);
    for (const [index, line] of emits.entries()) {
      // Each resume think emits obj.x and copy.x -- both aliases of the one
      // mutated host object -- then the value whole, which renders opaque.
      const suffix = index % 3 === 2 ? "args 1 opaque result void" : `args 1 ${mutatedToken} result void`;
      assert.ok(line.endsWith(suffix), `unexpected emit line: ${line}`);
    }
  }
});
