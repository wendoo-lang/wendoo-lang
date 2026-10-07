/**
 * Corpus case `struct-native-existence-chain-read`. One root rule capturing a
 * `Marker` value over the world's anchor on every think, then child rules
 * reading its field, destroying the anchor, and reading the field again:
 *
 * ```
 * DO [m = marker]
 *   DO [emit m.x]
 *   DO [destroy anchor]
 *   DO [emit m.x]
 * ```
 *
 * The `Marker` field getter reads `x` off the anchor whether or not the world
 * destroyed it. Once the anchor is gone, the type's existence hook makes the
 * variable falsy, the compiler's guard on the read's object stops the chain
 * before `STRUCT_GET_FIELD`, the read yields nil, and the emit it is placed in
 * does not dispatch. The trace pins one emit of the
 * live `x`, before the destruction, and none after it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, markerVariable, newBrain, operatorTile } from "../authoring";
import {
  assertCaseIsStable,
  assertCompiledOps,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { CONFORMANCE_ANCHOR_READING, ConformanceHostActions, ConformanceMarkerField } from "../profile";

const CASE_ID = "struct-native-existence-chain-read";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const m = markerVariable(brainDef, "m");
  appendDo(firstRule, m, operatorTile(environment, CoreOpId.Assign), tiles.marker);

  const readLive = firstRule.appendNewRule()!;
  appendDo(readLive, tiles.emit, m, tiles.markerX);

  const destroy = firstRule.appendNewRule()!;
  appendDo(destroy, tiles.destroyAnchor);

  const readGone = firstRule.appendNewRule()!;
  appendDo(readGone, tiles.emit, m, tiles.markerX);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Marker.actionId },
    { op: Op.DUP },
    { op: Op.JMP_IF_FALSE },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceMarkerField.X },
  ]);

  const markerEvent = `action ${ConformanceHostActions.Marker.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const destroyEvent = `action ${ConformanceHostActions.DestroyAnchor.actionId.toString(16)}`;
  // Only the read before the first destruction emits; every later read stops
  // at the falsy variable and gates its emit off.
  const perThink = [
    [markerEvent, emitEvent, destroyEvent],
    [markerEvent, destroyEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const emits = traceLines(variant.trace, `${emitEvent} `);
    const liveToken = numberToken(CONFORMANCE_ANCHOR_READING.x, variant.precision);
    assert.equal(emits.length, 1);
    assert.ok(emits[0].endsWith(`args 1 ${liveToken} result void`), `unexpected emit line: ${emits[0]}`);
  }
});
