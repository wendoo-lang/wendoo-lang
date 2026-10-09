/**
 * Corpus case `struct-plain-literal-root-rejected`. A field assignment rooted
 * at a literal, through a plain field, with a child rule reading the field
 * back through the same literal:
 *
 * ```
 * DO [waypoint.x = 7.25]
 *   DO [emit waypoint.x]
 * ```
 *
 * `Point`'s `x` is not routed, so the store would land in the literal's own
 * constant. The compiler refuses the assignment
 * (`ReadOnlyResultFieldAssignment`) and drops it, so the rule's DO compiles to
 * nothing and the program carries no field store at all. The child rule reads
 * the literal's own `x` on every think.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CompilationDiagCode, ParseDiagCode } from "@wendoo/core/brain/compiler";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, operatorTile } from "../authoring";
import { createConformanceEnvironment } from "../environment";
import {
  assertCaseIsStable,
  compiledInstructions,
  eventKinds,
  mintCase,
  numberToken,
  traceEventsByTick,
  traceLines,
} from "../mint";
import { CONFORMANCE_POINT_CONSTANT, ConformanceHostActions } from "../profile";

const CASE_ID = "struct-plain-literal-root-rejected";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendDo(
    firstRule,
    tiles.pointWaypoint,
    tiles.pointX,
    operatorTile(environment, CoreOpId.Assign),
    numberLiteral(environment, brainDef, 7.25)
  );

  const read = firstRule.appendNewRule()!;
  appendDo(read, tiles.emit, tiles.pointWaypoint, tiles.pointX);

  return brainDef;
}

test(`${CASE_ID}: the compiler refuses the assignment and drops it`, () => {
  const environment = createConformanceEnvironment("f64");
  const built = environment.linkBrain(build(environment));
  const codes: number[] = [];
  for (let i = 0; i < built.diagnostics.size(); i++) {
    codes.push(built.diagnostics.get(i)!.code as number);
  }
  assert.ok(codes.includes(ParseDiagCode.ReadOnlyResultFieldAssignment), `diagnostics: ${codes.join(", ")}`);
  assert.ok(codes.includes(CompilationDiagCode.UncompilableExpressionDropped), `diagnostics: ${codes.join(", ")}`);
});

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assert.ok(
    !compiledInstructions(minted.program).some(
      (instr) => instr.op === Op.STRUCT_SET_FIELD || instr.op === Op.SET_FIELD
    ),
    "a refused assignment leaves no field store in the program"
  );

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const perThink = [[emitEvent], [emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    const literalX = numberToken(CONFORMANCE_POINT_CONSTANT.x, variant.precision);
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${literalX} result void`), `unexpected emit line: ${line}`);
    }
  }
});
