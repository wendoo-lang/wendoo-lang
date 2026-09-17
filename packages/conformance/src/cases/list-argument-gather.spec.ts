/**
 * Corpus case `list-argument-gather`. One root rule with an empty WHEN whose
 * DO fills `emit all`'s repeated value slot with three values of three kinds:
 *
 * ```
 * WHEN [] DO [emit all 4.5 "hi" waypoint]
 * ```
 *
 * The compiler gathers the slot's arguments, in source order, into one list
 * value built with `LIST_NEW` and one `LIST_PUSH` per element, and the list
 * lands whole in the dispatch line's argument position. The trace pins its
 * token: the element count in minimal hex, then one value token per element,
 * in order -- here a number, a string, and the closed `Point` struct constant
 * rendered recursively.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { type NumberPrecision, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, stringLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { CONFORMANCE_POINT_CONSTANT, ConformanceHostActions } from "../profile";

const CASE_ID = "list-argument-gather";

/** Number element of the gathered list; exactly representable at f32. */
const NUMBER_ELEMENT = 4.5;

/** String element of the gathered list. */
const STRING_ELEMENT = "hi";

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

  appendDo(
    firstRule,
    tiles.emitAll,
    numberLiteral(environment, brainDef, NUMBER_ELEMENT),
    stringLiteral(environment, brainDef, STRING_ELEMENT),
    tiles.pointWaypoint
  );

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.LIST_NEW },
    { op: Op.LIST_PUSH },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.EmitAll.actionId },
  ]);

  const emitAllEvent = `action ${ConformanceHostActions.EmitAll.actionId.toString(16)}`;
  // The rule has no WHEN, so it fires every think and emits once per think.
  const perThink = [[emitAllEvent], [emitAllEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    assert.ok(!variant.trace.includes("opaque"), "no value renders opaque");

    const structToken = `struct 2 ${numberToken(CONFORMANCE_POINT_CONSTANT.x, variant.precision)} ${numberToken(
      CONFORMANCE_POINT_CONSTANT.y,
      variant.precision
    )}`;
    const listToken = `list 3 ${numberToken(NUMBER_ELEMENT, variant.precision)} string "${STRING_ELEMENT}" ${structToken}`;
    const emits = traceLines(variant.trace, `${emitAllEvent} `);
    assert.equal(emits.length, 2);
    for (const line of emits) {
      assert.ok(line.endsWith(`args 1 ${listToken} result void`), `unexpected emit all line: ${line}`);
    }
  }
});
