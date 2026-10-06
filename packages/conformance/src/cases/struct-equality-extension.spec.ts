/**
 * Corpus case `struct-equality-extension`. The core `eq` operator over two
 * `Point` operands, resolved to the overload the profile adds to it, each
 * comparison's result emitted as a flag:
 *
 * ```
 * DO [here = waypoint]
 *   DO [emit flag here == waypoint]                   -- true
 *   DO [emit flag here == here point plus waypoint]   -- false
 *   DO [emit flag unset == waypoint]                  -- false
 *   DO [emit flag here == unset]                      -- false
 *   DO [emit flag unset == unset]                     -- false
 * ```
 *
 * The profile registers its `Point` overload on `eq` without re-declaring the
 * operator, so the comparison is authored with the core `eq` tile and
 * resolves by operand type to the overload's funcId, compiling to a
 * `HOST_CALL` on it. `here` holds a copy of the `waypoint` constant, so the
 * first comparison holds between two distinct structs carrying equal fields.
 * `unset` is a `Point` variable nothing assigns, which reads nil: its static
 * type still selects the `Point` overload, and the overload receives the nil
 * operand and compares false, even against another nil operand. Every field
 * value is exactly representable at f32.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, operatorTile, pointVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, compiledInstructions, mintCase, traceLines } from "../mint";
import { ConformanceHostActions, ConformanceOperatorOverloads, ConformanceOperators } from "../profile";

const CASE_ID = "struct-equality-extension";

/** The rendered bool token each comparison emits, in rule order. */
const FLAG_TOKENS = ["bool 1", "bool 0", "bool 0", "bool 0", "bool 0"] as const;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const assign = () => operatorTile(environment, CoreOpId.Assign);
  const equals = () => operatorTile(environment, CoreOpId.EqualTo);

  const here = pointVariable(brainDef, "here");
  const unset = pointVariable(brainDef, "unset");
  appendDo(firstRule, here, assign(), tiles.pointWaypoint);

  const comparisons = [
    [here, equals(), tiles.pointWaypoint],
    [here, equals(), here, tiles.pointAdd, tiles.pointWaypoint],
    [unset, equals(), tiles.pointWaypoint],
    [here, equals(), unset],
    [unset, equals(), unset],
  ];
  for (const comparison of comparisons) {
    const rule = firstRule.appendNewRule()!;
    appendDo(rule, tiles.emitFlag, ...comparison);
  }

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.STORE_VAR_SLOT },
    { op: Op.HOST_CALL, a: ConformanceOperatorOverloads.PointEqual.fnId },
    { op: Op.HOST_CALL, a: ConformanceOperators.PointAdd.fnId },
  ]);
  const equalityCalls = compiledInstructions(minted.program).filter(
    (instruction) => instruction.op === Op.HOST_CALL && instruction.a === ConformanceOperatorOverloads.PointEqual.fnId
  );
  assert.equal(equalityCalls.length, FLAG_TOKENS.length, "every comparison dispatches the profile's Point overload");

  const emitFlagEvent = `action ${ConformanceHostActions.EmitFlag.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);

    const flagLines = traceLines(variant.trace, emitFlagEvent);
    assert.equal(flagLines.length, FLAG_TOKENS.length * minted.entry.schedule.length);
    for (const [index, line] of flagLines.entries()) {
      const token = FLAG_TOKENS[index % FLAG_TOKENS.length];
      assert.ok(line.endsWith(`args 1 ${token} result ${token}`), `unexpected emit-flag line: ${line}`);
    }
  }
});
