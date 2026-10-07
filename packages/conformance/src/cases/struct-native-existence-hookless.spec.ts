/**
 * Corpus case `struct-native-existence-hookless`. Two root rules: one
 * capturing an asynchronous `Anchor` value and destroying the anchor behind
 * it, and one whose WHEN is the captured variable alone:
 *
 * ```
 * WHEN [obj = defer anchor] DO [destroy anchor]
 * WHEN [obj] DO [emit 1]
 * ```
 *
 * `Anchor` declares no existence hook, so its values stay truthy after the
 * world destroys their host object -- the control beside the `Marker` cases.
 * The second rule does not fire while `obj` is unassigned and nil; once the
 * first rule's capture has landed and destroyed the anchor, `obj` holds a
 * value fronting a destroyed object, and the second rule fires on it on every
 * think from then on.
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
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "struct-native-existence-hookless";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const obj = anchorVariable(brainDef, "obj");
  appendWhen(firstRule, obj, operatorTile(environment, CoreOpId.Assign), tiles.deferAnchor);
  appendDo(firstRule, tiles.destroyAnchor);

  const held = page.appendNewRule()!;
  appendWhen(held, obj);
  appendDo(held, tiles.emit, numberLiteral(environment, brainDef, 1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferAnchor.actionId },
    { op: Op.AWAIT },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.LOAD_VAR_SLOT },
    { op: Op.WHEN_END },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferAnchor.actionId.toString(16)}`;
  const destroyEvent = `action ${ConformanceHostActions.DestroyAnchor.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The capturing rule dispatches on the odd thinks and destroys on the even
  // ones; the holding rule fires from the first capture on, destroyed anchor
  // and all.
  const perThink = [[readEvent], [destroyEvent, emitEvent], [readEvent, emitEvent], [destroyEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
  }
});
