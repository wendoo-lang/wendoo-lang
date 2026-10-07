/**
 * Corpus case `struct-native-existence-placed-gate`. One root rule capturing
 * a `Marker` value over the world's anchor on every think, then child rules
 * placing the value whole in an emit, destroying the anchor, and placing it
 * again:
 *
 * ```
 * DO [m = marker]
 *   DO [emit m]
 *   DO [destroy anchor]
 *   DO [emit m]
 * ```
 *
 * A placed value that evaluates to nothing gates its action off, and the
 * compiler tests a struct-typed placed value by its truthiness. While the
 * anchor exists the `Marker` value is truthy and the emit dispatches it,
 * rendering opaque; once the type's existence hook reports the anchor gone
 * the value is falsy and every later emit of it does not dispatch.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, markerVariable, newBrain, operatorTile } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "struct-native-existence-placed-gate";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const m = markerVariable(brainDef, "m");
  appendDo(firstRule, m, operatorTile(environment, CoreOpId.Assign), tiles.marker);

  const placeLive = firstRule.appendNewRule()!;
  appendDo(placeLive, tiles.emit, m);

  const destroy = firstRule.appendNewRule()!;
  appendDo(destroy, tiles.destroyAnchor);

  const placeGone = firstRule.appendNewRule()!;
  appendDo(placeGone, tiles.emit, m);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Marker.actionId },
    { op: Op.DUP },
    { op: Op.JMP_IF_FALSE },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
  ]);

  const markerEvent = `action ${ConformanceHostActions.Marker.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const destroyEvent = `action ${ConformanceHostActions.DestroyAnchor.actionId.toString(16)}`;
  // Only the placement before the first destruction dispatches.
  const perThink = [
    [markerEvent, emitEvent, destroyEvent],
    [markerEvent, destroyEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.equal(emits.length, 1);
    assert.ok(emits[0].endsWith("args 1 opaque result void"), `unexpected emit line: ${emits[0]}`);
  }
});
