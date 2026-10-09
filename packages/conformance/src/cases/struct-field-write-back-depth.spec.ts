/**
 * Corpus case `struct-field-write-back-depth`. A field assignment through a
 * chain of three field reads: a `Rig` variable holding a captured native-backed
 * `Anchor`, the `Point` snapshot of that anchor's `at` field, and the
 * snapshot's `y` field:
 *
 * ```
 * WHEN [obj = defer anchor] DO [rig = bare rig]
 *   DO [rig.anchor = obj]
 *     DO [rig.anchor.at.y = -6.5]
 *       DO [emit obj.y]
 *       DO [emit rig.anchor.at.x]
 *   DO [spot = waypoint]
 * ```
 *
 * The chain reads down outermost first, keeping the `Rig`, the `Anchor` and
 * the snapshot, stores `y` into the snapshot, then writes back innermost
 * first: the snapshot into the anchor's `at`, which the type's field setter
 * carries to the host object, then the anchor into the rig's `anchor`, a
 * plain re-store of the value it read. The host object's `y` reads the
 * written value through the captured variable, and its `x` reads unchanged
 * through the chain. The `spot` rule keeps the `Point` type in the program's
 * type table, which a VM building the snapshot from that table needs.
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
  rigVariable,
} from "../authoring";
import {
  assertCaseIsStable,
  compiledInstructions,
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
  ConformanceRigField,
} from "../profile";

const CASE_ID = "struct-field-write-back-depth";

/** Value the case writes through the snapshot's `y` field; exactly representable at f32. */
const WRITTEN_Y = -6.5;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const assign = () => operatorTile(environment, CoreOpId.Assign);

  const obj = anchorVariable(brainDef, "obj");
  const rig = rigVariable(brainDef, "rig");
  appendWhen(firstRule, obj, assign(), tiles.deferAnchor);
  appendDo(firstRule, rig, assign(), tiles.rigBare);

  const hold = firstRule.appendNewRule()!;
  appendDo(hold, rig, tiles.rigAnchor, assign(), obj);

  const write = hold.appendNewRule()!;
  appendDo(
    write,
    rig,
    tiles.rigAnchor,
    tiles.anchorAt,
    tiles.pointY,
    assign(),
    numberLiteral(environment, brainDef, WRITTEN_Y)
  );

  const readY = write.appendNewRule()!;
  appendDo(readY, tiles.emit, obj, tiles.anchorY);

  const readX = write.appendNewRule()!;
  appendDo(readX, tiles.emit, rig, tiles.rigAnchor, tiles.anchorAt, tiles.pointX);

  const carryPoint = firstRule.appendNewRule()!;
  appendDo(carryPoint, pointVariable(brainDef, "spot"), assign(), tiles.pointWaypoint);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  // The assignment's struct operations, in program order: down the chain,
  // the store, then the write-backs innermost first.
  const structOps = compiledInstructions(minted.program)
    .filter((instr) => instr.op === Op.STRUCT_SET_FIELD || instr.op === Op.STRUCT_DEEP_COPY)
    .map((instr) => (instr.op === Op.STRUCT_DEEP_COPY ? "copy" : `set ${instr.a}`));
  const cascade = [
    "copy",
    `set ${ConformancePointField.Y}`,
    `set ${ConformanceAnchorField.At}`,
    `set ${ConformanceRigField.Anchor}`,
  ];
  assert.ok(
    structOps.join(" ").includes(cascade.join(" ")),
    `the store is followed by the write-backs innermost first: ${structOps.join(", ")}`
  );

  const readEvent = `action ${ConformanceHostActions.DeferAnchor.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const perThink = [[readEvent], [emitEvent, emitEvent], [readEvent], [emitEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const writtenY = numberToken(WRITTEN_Y, variant.precision);
    const keptX = numberToken(CONFORMANCE_ANCHOR_READING.x, variant.precision);
    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.equal(emits.length, 4);
    for (const [index, line] of emits.entries()) {
      const token = index % 2 === 0 ? writtenY : keptX;
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }
  }
});
