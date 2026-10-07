/**
 * Corpus case `struct-field-nil-read`. Two root rules reading a field of a
 * `Point` variable no rule ever assigns, so the variable holds nil:
 *
 * ```
 * WHEN [pos.x] DO [emit 1]
 * DO [emit pos.x]
 * ```
 *
 * The compiler lowers each field read with a guard on its object: a falsy
 * object skips `STRUCT_GET_FIELD` and the read yields nil. The first rule's
 * WHEN therefore reads nil and does not fire, and the second rule emits nil.
 * The trace pins that neither rule faults on any think: the only events are
 * the second rule's emits, each carrying nil.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, newBrain, numberLiteral, pointVariable } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions, ConformancePointField } from "../profile";

const CASE_ID = "struct-field-nil-read";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const pos = pointVariable(brainDef, "pos");
  appendWhen(firstRule, pos, tiles.pointX);
  appendDo(firstRule, tiles.emit, numberLiteral(environment, brainDef, 1));

  const read = page.appendNewRule()!;
  appendDo(read, tiles.emit, pos, tiles.pointX);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.LOAD_VAR_SLOT },
    { op: Op.DUP },
    { op: Op.JMP_IF_FALSE },
    { op: Op.STRUCT_GET_FIELD, a: ConformancePointField.X },
    { op: Op.POP },
    { op: Op.PUSH_CONST_VAL },
  ]);

  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The WHEN-gated rule never fires; the reading rule emits once per think.
  const perThink = [[emitEvent], [emitEvent]];

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
    assert.deepEqual(traceEventsByTick(variant.trace).map(eventKinds), perThink);
    for (const line of traceLines(variant.trace, `${emitEvent} `)) {
      assert.ok(line.endsWith("args 1 nil result void"), `unexpected emit line: ${line}`);
    }
  }
});
