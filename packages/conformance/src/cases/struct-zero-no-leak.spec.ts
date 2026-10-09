/**
 * Corpus case `struct-zero-no-leak`. A variable of `Spot`, the profile's
 * struct type declaring a starting value, written through a field, beside the
 * `home` literal, which holds the same value:
 *
 * ```
 * DO [spot.x = 7.25]
 *   DO [emit home.x]
 *   DO [emit spot.x]
 * ```
 *
 * The slot is seeded with a fresh copy of the pooled starting value, never
 * the constant itself, so the field write reaches the variable alone: `home`
 * keeps its `x` and `spot` reads the written one, on every think.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, NO_VARIABLE_INIT, Op, variableInitAt } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, operatorTile, spotVariable } from "../authoring";
import {
  assertCaseIsStable,
  assertCompiledOps,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { CONFORMANCE_SPOT_ZERO, ConformanceHostActions, ConformanceSpotField } from "../profile";

const CASE_ID = "struct-zero-no-leak";

/** Value the case writes to `spot.x`; exactly representable at f32. */
const WRITTEN_X = 7.25;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const spot = spotVariable(brainDef, "spot");
  appendDo(
    firstRule,
    spot,
    tiles.spotX,
    operatorTile(environment, CoreOpId.Assign),
    numberLiteral(environment, brainDef, WRITTEN_X)
  );
  const readHome = firstRule.appendNewRule()!;
  appendDo(readHome, tiles.emit, tiles.spotHome, tiles.spotX);
  const readSpot = firstRule.appendNewRule()!;
  appendDo(readSpot, tiles.emit, spot, tiles.spotX);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assert.notEqual(
    variableInitAt(minted.program.program, 0),
    NO_VARIABLE_INIT,
    "spot carries its type's starting value"
  );

  assertCompiledOps(minted.program, [
    { op: Op.STRUCT_SET_FIELD, a: ConformanceSpotField.X },
    { op: Op.PUSH_CONST_VAL },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const perThink = [
    [emitEvent, emitEvent],
    [emitEvent, emitEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const tokens = [numberToken(CONFORMANCE_SPOT_ZERO.x, variant.precision), numberToken(WRITTEN_X, variant.precision)];
    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.equal(emits.length, 4);
    for (const [index, line] of emits.entries()) {
      assert.ok(line.endsWith(`args 1 ${tokens[index % 2]} result void`), `unexpected emit line: ${line}`);
    }
  }
});
