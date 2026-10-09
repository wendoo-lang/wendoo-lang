/**
 * Corpus case `struct-zero-seed`. A variable of `Spot`, the profile's struct
 * type declaring a starting value, read before any rule writes it, beside a
 * variable of `Point`, which declares none:
 *
 * ```
 * WHEN [spot] DO [emit spot.x]
 *   DO [emit spot.y]
 * WHEN [pos] DO [emit 1]
 * ```
 *
 * The program carries `Spot`'s starting value as a pooled constant and seeds
 * `spot` with a fresh copy of it at load, so the first WHEN finds a struct and
 * fires from the first think, and both field reads see the starting fields.
 * `pos` has no starting value, starts nil, and its WHEN never fires.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { NO_VARIABLE_INIT, Op, variableInitAt } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  numberLiteral,
  pointVariable,
  spotVariable,
} from "../authoring";
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

const CASE_ID = "struct-zero-seed";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const spot = spotVariable(brainDef, "spot");
  appendWhen(firstRule, spot);
  appendDo(firstRule, tiles.emit, spot, tiles.spotX);
  const readY = firstRule.appendNewRule()!;
  appendDo(readY, tiles.emit, spot, tiles.spotY);

  const unseeded = page.appendNewRule()!;
  appendWhen(unseeded, pointVariable(brainDef, "pos"));
  appendDo(unseeded, tiles.emit, numberLiteral(environment, brainDef, 1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  const program = minted.program.program;
  assert.deepEqual(program.variableNames.toArray(), ["spot", "pos"]);
  assert.notEqual(variableInitAt(program, 0), NO_VARIABLE_INIT, "spot carries its type's starting value");
  assert.equal(variableInitAt(program, 1), NO_VARIABLE_INIT, "pos carries none");

  assertCompiledOps(minted.program, [
    { op: Op.LOAD_VAR_SLOT, a: 0 },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceSpotField.X },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceSpotField.Y },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The seeded rule fires and reads both fields on every think; the unseeded one never fires.
  const perThink = [
    [emitEvent, emitEvent],
    [emitEvent, emitEvent],
  ];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);

    const tokens = [
      numberToken(CONFORMANCE_SPOT_ZERO.x, variant.precision),
      numberToken(CONFORMANCE_SPOT_ZERO.y, variant.precision),
    ];
    const emits = traceLines(variant.trace, `${emitEvent} `);
    assert.equal(emits.length, 4);
    for (const [index, line] of emits.entries()) {
      assert.ok(line.endsWith(`args 1 ${tokens[index % 2]} result void`), `unexpected emit line: ${line}`);
    }
  }
});
