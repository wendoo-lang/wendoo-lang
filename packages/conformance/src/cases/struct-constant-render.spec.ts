/**
 * Corpus case `struct-constant-render`. One root rule storing the profile's
 * `waypoint` Point literal into a variable, with field reads and the whole
 * struct feeding the emits:
 *
 * ```
 * WHEN [pos = waypoint] DO [emit pos.x]
 *   DO [emit pos.y]
 *   DO [emit pos]
 * ```
 *
 * The literal compiles into the residual constant pool as a closed-struct
 * constant: the `Point` type-table index plus one recursively encoded number
 * constant per field slot. Every think the WHEN pushes the decoded constant,
 * the assignment stores a deep copy, and the gate fires on the struct (a
 * struct value is truthy). The DO and its child rules pin the decode end to
 * end: both fields read by slot index as exact bit patterns, and the struct
 * whole rendering its struct token in the dispatch's argument position.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, NativeType, type NumberPrecision, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, operatorTile, pointVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import {
  CONFORMANCE_POINT_CONSTANT,
  CONFORMANCE_POINT_TYPE_ID,
  ConformanceHostActions,
  ConformancePointField,
} from "../profile";

const CASE_ID = "struct-constant-render";

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
  appendWhen(firstRule, pos, operatorTile(environment, CoreOpId.Assign), tiles.pointWaypoint);
  appendDo(firstRule, tiles.emit, pos, tiles.pointX);

  const readY = firstRule.appendNewRule()!;
  appendDo(readY, tiles.emit, pos, tiles.pointY);

  const emitWhole = firstRule.appendNewRule()!;
  appendDo(emitWhole, tiles.emit, pos);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.PUSH_CONST_VAL },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.Y },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
  ]);

  // The literal lands in the residual pool as a closed-struct constant with
  // one number constant per field slot.
  const values = minted.program.program.constantPools.values;
  let structConstants = 0;
  for (let i = 0; i < values.size(); i++) {
    const value = values.get(i)!;
    if (value.t !== NativeType.Struct) {
      continue;
    }
    structConstants += 1;
    assert.equal(value.typeId, CONFORMANCE_POINT_TYPE_ID);
    const fields = value.v;
    assert.ok(fields, "the struct constant carries a field list");
    assert.deepEqual(
      fields.toArray().map((field) => (field.t === NativeType.Number ? field.v : field.t)),
      [CONFORMANCE_POINT_CONSTANT.x, CONFORMANCE_POINT_CONSTANT.y]
    );
  }
  assert.equal(structConstants, 1, "the residual pool carries exactly one struct constant");

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // Every think the WHEN stores the constant and fires, then the DO and the
  // two child rules emit x, y, and the struct whole, in rule order.
  const perThink = [
    [emitEvent, emitEvent, emitEvent],
    [emitEvent, emitEvent, emitEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.ok(!variant.trace.includes("opaque"), "no value renders opaque");
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const xToken = numberToken(CONFORMANCE_POINT_CONSTANT.x, variant.precision);
    const yToken = numberToken(CONFORMANCE_POINT_CONSTANT.y, variant.precision);
    const structToken = `struct 2 ${xToken} ${yToken}`;
    const expected = [xToken, yToken, structToken];
    const emits = traceLines(variant.trace, `${emitEvent} `);
    for (const [index, line] of emits.entries()) {
      const token = expected[index % expected.length];
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }
  }
});
