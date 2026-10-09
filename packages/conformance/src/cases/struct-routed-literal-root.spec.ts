/**
 * Corpus case `struct-routed-literal-root`. A field assignment rooted at a
 * literal, through a field its type routes to host state, with a child rule
 * reading the field back through the same literal:
 *
 * ```
 * DO [gauge one.level = 5.5]
 *   DO [emit gauge one.level]
 * ```
 *
 * `Gauge`'s `level` is routed: the type's field setter takes a write to the
 * world's level of the gauge the value's `index` names, and its field getter
 * reads it from there, so the assignment compiles although its root is a
 * literal. The store reaches the world and the pooled constant is never
 * written; the read shows the written level.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, operatorTile } from "../authoring";
import {
  assertCaseIsStable,
  assertCompiledOps,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { ConformanceGaugeField, ConformanceHostActions } from "../profile";

const CASE_ID = "struct-routed-literal-root";

/** Level the case writes; exactly representable at f32. */
const WRITTEN_LEVEL = 5.5;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendDo(
    firstRule,
    tiles.gaugeOne,
    tiles.gaugeLevel,
    operatorTile(environment, CoreOpId.Assign),
    numberLiteral(environment, brainDef, WRITTEN_LEVEL)
  );

  const read = firstRule.appendNewRule()!;
  appendDo(read, tiles.emit, tiles.gaugeOne, tiles.gaugeLevel);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.PUSH_CONST_VAL },
    { op: Op.STRUCT_SET_FIELD, a: ConformanceGaugeField.Level },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceGaugeField.Level },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const perThink = [[emitEvent], [emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    const written = numberToken(WRITTEN_LEVEL, variant.precision);
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${written} result void`), `unexpected emit line: ${line}`);
    }
  }
});
