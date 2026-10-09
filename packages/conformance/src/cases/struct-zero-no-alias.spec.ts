/**
 * Corpus case `struct-zero-no-alias`. Two variables of `Spot`, the profile's
 * struct type declaring a starting value, one written through a field and the
 * other read:
 *
 * ```
 * DO [first.x = 7.25]
 *   DO [emit second.x]
 *   DO [emit first.x]
 * ```
 *
 * Each slot is seeded with a fresh copy of `Spot`'s pooled starting value,
 * so the field write lands in `first` alone: `second` keeps the starting `x`
 * and `first` reads the written one, on every think.
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

const CASE_ID = "struct-zero-no-alias";

/** Value the case writes to `first.x`; exactly representable at f32. */
const WRITTEN_X = 7.25;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const first = spotVariable(brainDef, "first");
  const second = spotVariable(brainDef, "second");
  appendDo(
    firstRule,
    first,
    tiles.spotX,
    operatorTile(environment, CoreOpId.Assign),
    numberLiteral(environment, brainDef, WRITTEN_X)
  );
  const readSecond = firstRule.appendNewRule()!;
  appendDo(readSecond, tiles.emit, second, tiles.spotX);
  const readFirst = firstRule.appendNewRule()!;
  appendDo(readFirst, tiles.emit, first, tiles.spotX);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  const program = minted.program.program;
  assert.deepEqual(program.variableNames.toArray(), ["first", "second"]);
  assert.notEqual(variableInitAt(program, 0), NO_VARIABLE_INIT, "first carries its type's starting value");
  assert.notEqual(variableInitAt(program, 1), NO_VARIABLE_INIT, "second carries its type's starting value");

  assertCompiledOps(minted.program, [{ op: Op.STRUCT_SET_FIELD, a: ConformanceSpotField.X }]);

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
