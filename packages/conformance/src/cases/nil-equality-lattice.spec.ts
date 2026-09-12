/**
 * Corpus case `nil-equality-lattice`. One rule per core equality overload that
 * has a nil operand, each gating an emit on the comparison:
 *
 * - `WHEN [not nil] DO [emit 1]` -- fires
 * - `WHEN [nil == nil] DO [emit 2]` -- fires
 * - `WHEN [nil != nil] DO [emit 3]` -- skips
 * - then, for each of Number, Boolean and String, the four rules comparing a
 *   literal of that type with nil: `==` and `!=`, in both operand orders. The
 *   `!=` rules fire and the `==` rules skip.
 *
 * The comparisons are resolved by static type, so the fifteen rules dispatch
 * fifteen distinct host functions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, IBrainTileDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  booleanLiteral,
  conformanceTiles,
  newBrain,
  nilLiteral,
  numberLiteral,
  operatorTile,
  stringLiteral,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "nil-equality-lattice";

/** Emits of a think: the rules whose comparison holds, all of them `!=` rules and `not nil`. */
const EMITS_PER_TICK = 8;

/** Every host function a rule of this case dispatches. */
const DISPATCHED_FUNCTIONS: readonly number[] = [
  CoreFuncId.OpNotNil,
  CoreFuncId.OpEqualToNil,
  CoreFuncId.OpNotEqualToNil,
  CoreFuncId.OpEqualToNumberNil,
  CoreFuncId.OpEqualToNilNumber,
  CoreFuncId.OpNotEqualToNumberNil,
  CoreFuncId.OpNotEqualToNilNumber,
  CoreFuncId.OpEqualToBooleanNil,
  CoreFuncId.OpEqualToNilBoolean,
  CoreFuncId.OpNotEqualToBooleanNil,
  CoreFuncId.OpNotEqualToNilBoolean,
  CoreFuncId.OpEqualToStringNil,
  CoreFuncId.OpEqualToNilString,
  CoreFuncId.OpNotEqualToStringNil,
  CoreFuncId.OpNotEqualToNilString,
];

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);
  const operator = (opId: string) => operatorTile(environment, opId);
  const nil = nilLiteral(environment);

  let emitted = 0;
  const gate = (when: IBrainTileDef[]) => {
    const rule = emitted === 0 ? firstRule : page.appendNewRule()!;
    emitted++;
    appendWhen(rule, ...when);
    appendDo(rule, tiles.emit, literal(emitted));
  };

  gate([operator(CoreOpId.Not), nil]);
  gate([nil, operator(CoreOpId.EqualTo), nil]);
  gate([nil, operator(CoreOpId.NotEqualTo), nil]);

  const comparands: readonly IBrainTileDef[] = [
    literal(5),
    booleanLiteral(environment, true),
    stringLiteral(environment, brainDef, "s"),
  ];
  for (const comparand of comparands) {
    for (const opId of [CoreOpId.EqualTo, CoreOpId.NotEqualTo]) {
      gate([comparand, operator(opId), nil]);
      gate([nil, operator(opId), comparand]);
    }
  }

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(
    minted.program,
    DISPATCHED_FUNCTIONS.map((fnId) => ({ op: Op.HOST_CALL, a: fnId }))
  );

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, emitEvent).length, EMITS_PER_TICK * minted.entry.schedule.length);
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
  }
});
