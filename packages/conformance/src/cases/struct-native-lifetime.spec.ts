/**
 * Corpus case `struct-native-lifetime`. One root rule capturing an
 * asynchronous native-backed `Anchor` value, reading a field off the live
 * host object, destroying that object, and reading both fields again:
 *
 * ```
 * WHEN [obj = defer anchor] DO [emit obj.x]
 *   DO [destroy anchor]
 *   DO [emit obj.x]
 *   DO [emit obj.y]
 * ```
 *
 * The first read dispatches the `Anchor` type's field getter against the live
 * host object and emits its `x`. `destroy anchor` then destroys that object
 * while `obj` keeps fronting it, so every later read resolves nothing: the
 * getter returns absent and the field read pushes nil. The trace pins both
 * sides -- the live reading before the destruction and the nil tokens after --
 * and the destruction outlives the root rule, so the re-capture on the second
 * dispatch reads nil from its first field read on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import { anchorVariable, appendDo, appendWhen, conformanceTiles, newBrain, operatorTile } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { CONFORMANCE_ANCHOR_READING, ConformanceAnchorField, ConformanceHostActions } from "../profile";

const CASE_ID = "struct-native-lifetime";

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

  const obj = anchorVariable(brainDef, "obj");
  appendWhen(firstRule, obj, operatorTile(environment, CoreOpId.Assign), tiles.deferAnchor);
  appendDo(firstRule, tiles.emit, obj, tiles.anchorX);

  const destroy = firstRule.appendNewRule()!;
  appendDo(destroy, tiles.destroyAnchor);

  const readX = firstRule.appendNewRule()!;
  appendDo(readX, tiles.emit, obj, tiles.anchorX);

  const readY = firstRule.appendNewRule()!;
  appendDo(readY, tiles.emit, obj, tiles.anchorY);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferAnchor.actionId },
    { op: Op.AWAIT },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.DestroyAnchor.actionId },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceAnchorField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceAnchorField.Y },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferAnchor.actionId.toString(16)}`;
  const destroyEvent = `action ${ConformanceHostActions.DestroyAnchor.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, its DO emits the live `x`, and the cascade destroys the anchor
  // and reads both fields off the destroyed object.
  const perThink = [
    [readEvent],
    [emitEvent, destroyEvent, emitEvent, emitEvent],
    [readEvent],
    [emitEvent, destroyEvent, emitEvent, emitEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const emits = traceLines(variant.trace, `${emitEvent} `);
    const liveToken = numberToken(CONFORMANCE_ANCHOR_READING.x, variant.precision);
    // Only the first emit of the first capture reads a live anchor; the
    // destruction stands from then on, so every later read is nil.
    const expected = [liveToken, "nil", "nil", "nil", "nil", "nil"];
    for (const [index, line] of emits.entries()) {
      assert.ok(line.endsWith(`args 1 ${expected[index]} result void`), `unexpected emit line: ${line}`);
    }
    assert.equal(emits.length, expected.length);
  }
});
