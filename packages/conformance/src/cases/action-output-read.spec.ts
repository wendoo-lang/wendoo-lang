/**
 * Corpus case `action-output-read`. One root rule reading the two `Point`
 * outputs `point outputs` writes, one in the rule's own DO and one in a child
 * rule:
 *
 * ```
 * WHEN [point outputs] DO [emit open.x]
 *   DO [emit sealed.y]
 * ```
 *
 * On every think the sensor runs, writes a fresh `Point` to each of its
 * outputs, and returns true, so the rule fires. The rule's DO reads the `open`
 * output through its tile, and the child rule reads the `sealed` output: each
 * read resolves the output's rule variable, walking up to the sensor's rule
 * from the child, and reads one field by slot index. The trace pins both
 * field values as exact bit patterns, on both thinks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain } from "../authoring";
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

const CASE_ID = "action-output-read";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.pointOutputs);
  appendDo(firstRule, tiles.emit, tiles.pointOpen, tiles.pointX);

  const child = firstRule.appendNewRule()!;
  appendDo(child, tiles.emit, tiles.pointSealed, tiles.pointY);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.PointOutputs.actionId },
    { op: Op.HOST_CALL, a: CoreFuncId.RuleContextGetVariable },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.Y },
  ]);

  const sensorEvent = `action ${ConformanceHostActions.PointOutputs.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const perThink = [
    [sensorEvent, emitEvent, emitEvent],
    [sensorEvent, emitEvent, emitEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(
      traceLines(variant.trace, `${sensorEvent} `).every((line) => line.endsWith(" result bool 1")),
      "the sensor returns true on every run"
    );

    const openX = numberToken(CONFORMANCE_POINT_OUTPUTS_READING.open.x, variant.precision);
    const sealedY = numberToken(CONFORMANCE_POINT_OUTPUTS_READING.sealed.y, variant.precision);
    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.equal(emits.length, 4);
    for (const [index, line] of emits.entries()) {
      const token = index % 2 === 0 ? openX : sealedY;
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }
  }
});
