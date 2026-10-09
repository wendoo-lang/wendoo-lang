/**
 * Corpus case `struct-field-write-back`. One root rule capturing an
 * asynchronous native-backed `Anchor` value, writing the `x` field of the
 * `Point` snapshot its `at` field hands out, and child rules reading the
 * result back:
 *
 * ```
 * WHEN [obj = defer anchor] DO [obj.at.x = 7.25]
 *   DO [emit obj.x]
 *   DO [emit obj.at.y]
 *   DO [spot = waypoint]
 * ```
 *
 * `obj.at` reads through the type's field getter, which builds a fresh
 * `Point` from the anchor host object, so the store of `x` lands in that
 * snapshot. The compiler writes the snapshot back into `obj.at`, and the
 * type's field setter carries both its fields to the host object: the
 * anchor's own `x` reads the written value, and its `y` reads unchanged
 * through a second snapshot. The `spot` rule keeps the `Point` type in the
 * program's type table, which a VM building the snapshot from that table
 * needs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import {
  anchorVariable,
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  numberLiteral,
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
import {
  CONFORMANCE_ANCHOR_READING,
  ConformanceAnchorField,
  ConformanceHostActions,
  ConformancePointField,
} from "../profile";

const CASE_ID = "struct-field-write-back";

/** Value the case writes through the snapshot's `x` field; exactly representable at f32. */
const WRITTEN_X = 7.25;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const assign = () => operatorTile(environment, CoreOpId.Assign);

  const obj = anchorVariable(brainDef, "obj");
  appendWhen(firstRule, obj, assign(), tiles.deferAnchor);
  appendDo(firstRule, obj, tiles.anchorAt, tiles.pointX, assign(), numberLiteral(environment, brainDef, WRITTEN_X));

  const readX = firstRule.appendNewRule()!;
  appendDo(readX, tiles.emit, obj, tiles.anchorX);

  const readY = firstRule.appendNewRule()!;
  appendDo(readY, tiles.emit, obj, tiles.anchorAt, tiles.pointY);

  const carryPoint = firstRule.appendNewRule()!;
  appendDo(carryPoint, pointVariable(brainDef, "spot"), assign(), tiles.pointWaypoint);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferAnchor.actionId },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceAnchorField.At },
    { op: Op.STRUCT_SET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_SET_FIELD, a: ConformanceAnchorField.At },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferAnchor.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, writes through the snapshot, and the two reads follow.
  const perThink = [[readEvent], [emitEvent, emitEvent], [readEvent], [emitEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const writtenX = numberToken(WRITTEN_X, variant.precision);
    const keptY = numberToken(CONFORMANCE_ANCHOR_READING.y, variant.precision);
    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.equal(emits.length, 4);
    for (const [index, line] of emits.entries()) {
      const token = index % 2 === 0 ? writtenX : keptY;
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }
  }
});
