/**
 * Corpus case `struct-field-nil-write`. One root rule assigning a field of a
 * `Point` variable no rule ever assigns, so the variable holds nil, with a
 * child rule reading the field back:
 *
 * ```
 * DO [pos.x = not a number]
 *   DO [emit pos.x]
 * ```
 *
 * The compiler lowers the field assignment with a guard on its object: the
 * object and the assigned value both evaluate, and a falsy object skips
 * `STRUCT_SET_FIELD` and discards the value. The trace pins that the value's
 * sensor still dispatches on every think, that nothing faults, and that the
 * child's read emits nil: the store never reached a struct.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, operatorTile, pointVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions, ConformancePointField } from "../profile";

const CASE_ID = "struct-field-nil-write";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const pos = pointVariable(brainDef, "pos");
  appendDo(firstRule, pos, tiles.pointX, operatorTile(environment, CoreOpId.Assign), tiles.notANumber);

  const read = firstRule.appendNewRule()!;
  appendDo(read, tiles.emit, pos, tiles.pointX);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.NotANumber.actionId },
    { op: Op.STACK_SET_REL, a: 1 },
    { op: Op.JMP_IF_FALSE },
    { op: Op.STRUCT_DEEP_COPY },
    { op: Op.STRUCT_SET_FIELD, a: ConformancePointField.X },
  ]);

  const valueEvent = `action ${ConformanceHostActions.NotANumber.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // Each think the assigned value's sensor dispatches, then the child emits.
  const perThink = [
    [valueEvent, emitEvent],
    [valueEvent, emitEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith("args 1 nil result void"), `unexpected emit line: ${line}`);
    }
  }
});
