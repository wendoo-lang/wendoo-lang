/**
 * Corpus case `struct-native-snapshot`. One root rule capturing an
 * asynchronous resolver-backed `Target` value and reading its field twice:
 *
 * ```
 * WHEN [pick = defer target] DO [emit pick.value]
 *   DO [emit pick.value]
 * ```
 *
 * `Target` registers `snapshotNative`, so the deep copy at `STORE_VAR_SLOT`
 * materializes the lazy resolver exactly once per capture, pinning the host
 * object it resolved to; both field reads of one think then go through that
 * object and emit the same value. The world's resolver counts its calls --
 * the first resolution returns the object reading 1.5, every later one the
 * object reading 8.5 -- so the first capture emits the first reading twice
 * and the second capture the second reading twice.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, type NumberPrecision, Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, operatorTile, targetVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { CONFORMANCE_TARGET_READING, ConformanceHostActions, ConformanceTargetField } from "../profile";

const CASE_ID = "struct-native-snapshot";

/** The `number <bits>` token of `value` at `precision`, as the trace renders it. */
function numberToken(value: number, precision: NumberPrecision): string {
  if (precision === "f32") {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    return `number ${view.getUint32(0).toString(16).padStart(8, "0")}`;
  }
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return `number ${view.getUint32(0).toString(16).padStart(8, "0")}${view.getUint32(4).toString(16).padStart(8, "0")}`;
}

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const pick = targetVariable(brainDef, "pick");
  appendWhen(firstRule, pick, operatorTile(environment, CoreOpId.Assign), tiles.deferTarget);
  appendDo(firstRule, tiles.emit, pick, tiles.targetValue);

  const readAgain = firstRule.appendNewRule()!;
  appendDo(readAgain, tiles.emit, pick, tiles.targetValue);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL_ASYNC, a: ConformanceHostActions.DeferTarget.actionId },
    { op: Op.AWAIT },
    { op: Op.STORE_VAR_SLOT },
    { op: Op.STRUCT_GET_FIELD, a: ConformanceTargetField.Value },
  ]);

  const readEvent = `action ${ConformanceHostActions.DeferTarget.actionId.toString(16)}`;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The rule dispatches and parks on the odd thinks; on the even thinks it
  // resumes, the store snapshots the resolver, and both reads reach their
  // emits.
  const perThink = [[readEvent], [emitEvent, emitEvent], [readEvent], [emitEvent, emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(!variant.trace.includes("struct"), "no struct value occupies an observable position");
    assert.ok(!variant.trace.includes("opaque"), "no value renders opaque");

    const emits = traceLines(variant.trace, `${emitEvent} `);
    const firstToken = numberToken(CONFORMANCE_TARGET_READING.first, variant.precision);
    const secondToken = numberToken(CONFORMANCE_TARGET_READING.second, variant.precision);
    for (const [index, line] of emits.entries()) {
      // The first capture resolved once to the first object, so both of its
      // reads emit the first reading; the second capture's snapshot resolved
      // again, so both of its reads emit the second.
      const token = index < 2 ? firstToken : secondToken;
      assert.ok(line.endsWith(`args 1 ${token} result void`), `unexpected emit line: ${line}`);
    }
  }
});
