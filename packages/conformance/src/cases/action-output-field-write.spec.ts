/**
 * Corpus case `action-output-field-write`. A field assignment through the
 * tile of the `open` output, which `point outputs` declares writable-result,
 * observed by the rules below it:
 *
 * ```
 * WHEN [point outputs] DO [emit open.x]
 *   DO [open.x = 7.25]
 *     DO [emit open.x]
 *   DO [emit open.x]
 *   DO [emit open.y]
 * ```
 *
 * On every think the sensor writes a fresh `Point` `{x: 5.5, y: -1.5}` to
 * `open`. The rule's DO reads `x` before any write. The first child rule's
 * assignment lowers to a read of the output's rule variable and an in-place
 * field store (`STRUCT_SET_FIELD`), with no copy of the struct between them,
 * so the write lands on the struct the output holds: the grandchild and the
 * next child, reading `x` through the same output, both see `7.25`, and the
 * last child reads `y` unchanged. The next think's run writes a fresh struct,
 * so the rule's DO reads `5.5` again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral, operatorTile } from "../authoring";
import {
  assertCaseIsStable,
  assertCompiledOps,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { CONFORMANCE_POINT_OUTPUTS_READING, ConformanceHostActions, ConformancePointField } from "../profile";

const CASE_ID = "action-output-field-write";

/** Number the assignment writes to the `open` output's `x` field; exactly representable at f32. */
const WRITTEN_X = 7.25;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.pointOutputs);
  appendDo(firstRule, tiles.emit, tiles.pointOpen, tiles.pointX);

  const write = firstRule.appendNewRule()!;
  appendDo(
    write,
    tiles.pointOpen,
    tiles.pointX,
    operatorTile(environment, CoreOpId.Assign),
    numberLiteral(environment, brainDef, WRITTEN_X)
  );
  const readBelow = write.appendNewRule()!;
  appendDo(readBelow, tiles.emit, tiles.pointOpen, tiles.pointX);

  const readBeside = firstRule.appendNewRule()!;
  appendDo(readBeside, tiles.emit, tiles.pointOpen, tiles.pointX);

  const readOther = firstRule.appendNewRule()!;
  appendDo(readOther, tiles.emit, tiles.pointOpen, tiles.pointY);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.PointOutputs.actionId },
    { op: Op.HOST_CALL, a: CoreFuncId.RuleContextGetVariable },
    { op: Op.STRUCT_SET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.Y },
  ]);

  const sensorEvent = `action ${ConformanceHostActions.PointOutputs.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const thinkEvents = [sensorEvent, emitEvent, emitEvent, emitEvent, emitEvent];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), [thinkEvents, thinkEvents]);

    const { open } = CONFORMANCE_POINT_OUTPUTS_READING;
    const expected = [open.x, WRITTEN_X, WRITTEN_X, open.y].map((value) => numberToken(value, variant.precision));
    for (const events of traceEventsByTick(variant.trace)) {
      const emits = events.filter((line) => line.startsWith(`${emitEvent} `));
      assert.deepEqual(
        emits.map((line) => line.split(" args 1 ")[1]),
        expected.map((token) => `${token} result void`),
        `unexpected emits: ${emits.join(" | ")}`
      );
    }
  }
});
