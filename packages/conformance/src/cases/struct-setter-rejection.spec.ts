/**
 * Corpus case `struct-setter-rejection`. One root rule capturing an
 * asynchronous native-backed `Anchor` value and destroying the host object
 * behind it, then a child rule writing one of its fields and a grandchild
 * reading that field back:
 *
 * ```
 * WHEN [obj = defer anchor] DO [destroy anchor]
 *   DO [obj.x = 8.5]
 *     DO [emit obj.x]
 * ```
 *
 * `destroy anchor` leaves `obj` fronting a destroyed host object, so the
 * `Anchor` type's field setter rejects the write. The rejection faults the
 * writing fiber with `ScriptError` before the write lands, so the grandchild
 * never spawns and no emit reaches the trace. The fault kills the fiber, not
 * the rule: the root rule respawns and the same fault recurs on every resume
 * think.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, ErrorCode, Op } from "@wendoo/core/runtime";
import {
  anchorVariable,
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  numberLiteral,
  operatorTile,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceAnchorField, ConformanceHostActions } from "../profile";

const CASE_ID = "struct-setter-rejection";

/** Value the case writes through the destroyed anchor's `x` field; exactly representable at f32. */
const REJECTED_X = 8.5;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const obj = anchorVariable(brainDef, "obj");
  appendWhen(firstRule, obj, operatorTile(environment, CoreOpId.Assign), tiles.deferAnchor);
  appendDo(firstRule, tiles.destroyAnchor);

  const write = firstRule.appendNewRule()!;
  appendDo(
    write,
    obj,
    tiles.anchorX,
    operatorTile(environment, CoreOpId.Assign),
    numberLiteral(environment, brainDef, REJECTED_X)
  );

  const readBack = write.appendNewRule()!;
  appendDo(readBack, tiles.emit, obj, tiles.anchorX);

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
    { op: Op.STRUCT_SET_FIELD, a: ConformanceAnchorField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceAnchorField.X },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferAnchor.actionId.toString(16)} `;
  const destroyEvent = `action ${ConformanceHostActions.DestroyAnchor.actionId.toString(16)} `;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  // Over the four-think schedule the root rule captures twice: it dispatches
  // and parks on the odd thinks, and on the even thinks it resumes, destroys
  // the anchor, and the child's rejected write faults.
  const captures = 2;

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, readEvent).length, captures);
    assert.equal(traceLines(variant.trace, destroyEvent).length, captures);
    assert.equal(traceLines(variant.trace, emitEvent).length, 0, "the grandchild never spawns");

    const faults = traceLines(variant.trace, "fault ");
    assert.equal(faults.length, captures, "the rejected write faults on every resume think");
    for (const line of faults) {
      assert.ok(
        line.endsWith(` ${ErrorCode.ScriptError.toString(16)}`),
        "a rejected field setter faults with ScriptError"
      );
    }
  }
});
