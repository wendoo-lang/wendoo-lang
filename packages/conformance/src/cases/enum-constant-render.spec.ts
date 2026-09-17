/**
 * Corpus case `enum-constant-render`. One root rule emitting the profile's
 * `Mode` enum literal every think:
 *
 * ```
 * WHEN [] DO [emit seek]
 * ```
 *
 * The literal compiles into the residual constant pool as an enum constant --
 * a `(typeIdx, ordinal)` pair against the program-local `Mode` type-table
 * entry, whose symbol keys travel embedded in the program. `emit`'s argument
 * slot is Number-typed and no enum-to-number conversion is registered for a
 * string-valued enum, so the value passes into the dispatch untouched. The
 * trace pins the decoded constant and its render token in one line: the
 * dispatch's argument position carries `enum "seek"`, the symbol at ordinal 1.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { NativeType, Op, type ProgramTypeEntry } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import {
  CONFORMANCE_MODE_LITERAL_KEY,
  CONFORMANCE_MODE_SYMBOL_KEYS,
  CONFORMANCE_MODE_TYPE_ID,
  ConformanceHostActions,
} from "../profile";

const CASE_ID = "enum-constant-render";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendDo(firstRule, tiles.emit, tiles.modeSeek);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.PUSH_CONST_VAL },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
  ]);

  // The Mode type ships as a program-local enum entry carrying its symbol
  // keys in ordinal order; no atom entry stands in for it.
  const typeEntries: ProgramTypeEntry[] = minted.program.program.types?.toArray() ?? [];
  const enumEntries = typeEntries.flatMap((entry) => (entry.tag === "enum" ? [entry] : []));
  assert.equal(enumEntries.length, 1, "the type table carries exactly one program-local enum entry");
  assert.equal(enumEntries[0]?.typeId, CONFORMANCE_MODE_TYPE_ID);
  assert.deepEqual(
    enumEntries[0]?.symbols.toArray().map((symbol) => symbol.key),
    [...CONFORMANCE_MODE_SYMBOL_KEYS]
  );

  // The literal lands in the residual pool as an enum constant.
  const values = minted.program.program.constantPools.values;
  let enumConstants = 0;
  for (let i = 0; i < values.size(); i++) {
    const value = values.get(i)!;
    if (value.t !== NativeType.Enum) {
      continue;
    }
    enumConstants += 1;
    assert.equal(value.typeId, CONFORMANCE_MODE_TYPE_ID);
    assert.equal(value.v, CONFORMANCE_MODE_LITERAL_KEY);
  }
  assert.equal(enumConstants, 1, "the residual pool carries exactly one enum constant");

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  const enumToken = `enum "${CONFORMANCE_MODE_LITERAL_KEY}"`;

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.ok(!variant.trace.includes("opaque"), "no value renders opaque");
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), [[emitEvent], [emitEvent]]);
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith(`args 1 ${enumToken} result void`), `unexpected emit line: ${line}`);
    }
  }
});
