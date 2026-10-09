/**
 * Corpus case `struct-field-write-back-nil-links`. One field assignment
 * through the same three-link chain -- a `Rig` variable, its `anchor`, the
 * anchor's `at` snapshot, and the snapshot's `x` -- with each link in turn
 * reading nil:
 *
 * ```
 * WHEN [obj = defer anchor] DO [lost = bare rig]
 *   DO [lost.anchor = obj]
 *   DO [bare = bare rig]
 *   DO [destroy anchor]
 *   DO [unset.anchor.at.x = not a number]
 *   DO [bare.anchor.at.x = not a number]
 *   DO [lost.anchor.at.x = not a number]
 * ```
 *
 * `unset` is never assigned, so the chain's root is nil; `bare` holds a rig
 * whose `anchor` is nil; and `lost` holds a rig whose anchor fronts the host
 * object the world has destroyed, so its `at` field getter designates
 * nothing and the snapshot reads nil. Each falsy link skips the rest of the
 * chain, the store, and every write-back, while the assigned value still
 * evaluates: the trace pins one dispatch of the value's sensor per
 * assignment and no fault -- a write-back into the destroyed anchor would be
 * rejected by its field setter and fault the rule.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId } from "@wendoo/core/runtime";
import {
  anchorVariable,
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  operatorTile,
  rigVariable,
} from "../authoring";
import { assertCaseIsStable, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "struct-field-write-back-nil-links";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const assign = () => operatorTile(environment, CoreOpId.Assign);

  const obj = anchorVariable(brainDef, "obj");
  const unset = rigVariable(brainDef, "unset");
  const bare = rigVariable(brainDef, "bare");
  const lost = rigVariable(brainDef, "lost");
  appendWhen(firstRule, obj, assign(), tiles.deferAnchor);
  appendDo(firstRule, lost, assign(), tiles.rigBare);

  const hold = firstRule.appendNewRule()!;
  appendDo(hold, lost, tiles.rigAnchor, assign(), obj);

  const holdBare = firstRule.appendNewRule()!;
  appendDo(holdBare, bare, assign(), tiles.rigBare);

  const destroy = firstRule.appendNewRule()!;
  appendDo(destroy, tiles.destroyAnchor);

  for (const root of [unset, bare, lost]) {
    const write = firstRule.appendNewRule()!;
    appendDo(write, root, tiles.rigAnchor, tiles.anchorAt, tiles.pointX, assign(), tiles.notANumber);
  }

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  const readEvent = `action ${ConformanceHostActions.DeferAnchor.actionId.toString(16)}`;
  const destroyEvent = `action ${ConformanceHostActions.DestroyAnchor.actionId.toString(16)}`;
  const valueEvent = `action ${ConformanceHostActions.NotANumber.actionId.toString(16)}`;
  // On each resume think the anchor is destroyed, then each of the three
  // assignments evaluates its value and skips its store and write-backs.
  const resume = [destroyEvent, valueEvent, valueEvent, valueEvent];
  const perThink = [[readEvent], resume, [readEvent], resume];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0, "no skipped write-back faults");
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
  }
});
