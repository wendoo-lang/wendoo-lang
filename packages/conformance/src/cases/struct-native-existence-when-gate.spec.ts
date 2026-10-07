/**
 * Corpus case `struct-native-existence-when-gate`. Two root rules: one
 * capturing a `Marker` value over the world's anchor on every think, and one
 * whose WHEN is that variable alone, emitting and then destroying the anchor
 * from a child rule:
 *
 * ```
 * DO [m = marker]
 * WHEN [m] DO [emit 1]
 *   DO [destroy anchor]
 * ```
 *
 * `Marker` declares an existence hook reporting whether the world destroyed
 * the anchor behind the value. On the first think the anchor exists, so the
 * variable is truthy, the WHEN fires, and the child destroys the anchor. From
 * the second think on the variable still holds a `Marker` value over that
 * anchor, but the hook reports it gone, so the value is falsy and the WHEN
 * does not fire again: no emit and no destruction follow.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  conformanceTiles,
  markerVariable,
  newBrain,
  numberLiteral,
  operatorTile,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "struct-native-existence-when-gate";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const m = markerVariable(brainDef, "m");
  appendDo(firstRule, m, operatorTile(environment, CoreOpId.Assign), tiles.marker);

  const gated = page.appendNewRule()!;
  appendWhen(gated, m);
  appendDo(gated, tiles.emit, numberLiteral(environment, brainDef, 1));

  const destroy = gated.appendNewRule()!;
  appendDo(destroy, tiles.destroyAnchor);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Marker.actionId },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.LOAD_VAR_SLOT },
    { op: Op.WHEN_END },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.DestroyAnchor.actionId },
  ]);

  const markerEvent = `action ${ConformanceHostActions.Marker.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const destroyEvent = `action ${ConformanceHostActions.DestroyAnchor.actionId.toString(16)}`;
  // The WHEN fires on the live anchor alone; once it is destroyed the held
  // value is falsy and the rule never fires again.
  const perThink = [[markerEvent, emitEvent, destroyEvent], [markerEvent], [markerEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
  }
});
