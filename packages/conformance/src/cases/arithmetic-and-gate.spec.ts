/**
 * Corpus case `arithmetic-and-gate`. Three rules on one page:
 *
 * - `WHEN [echo 1] DO [emit 2 + 3]` -- a truthy gate over a synchronous
 *   sensor, with the sum computed by the core operator host call.
 * - `WHEN [echo 0] DO [emit 9]` -- a falsy gate whose DO section never runs.
 * - `DO [count = count + 2] [emit count]` -- an empty WHEN that fires every
 *   think, accumulating into a brain-global variable slot.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  conformanceTiles,
  newBrain,
  numberLiteral,
  numberVariable,
  operatorTile,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "arithmetic-and-gate";

/** Emits of the two rules that fire on a think: the sum, then the running count. */
const EMITS_PER_TICK = 2;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, tiles.echo, numberLiteral(environment, brainDef, 1));
  appendDo(
    firstRule,
    tiles.emit,
    numberLiteral(environment, brainDef, 2),
    operatorTile(environment, CoreOpId.Add),
    numberLiteral(environment, brainDef, 3)
  );

  const skipped = page.appendNewRule()!;
  appendWhen(skipped, tiles.echo, numberLiteral(environment, brainDef, 0));
  appendDo(skipped, tiles.emit, numberLiteral(environment, brainDef, 9));

  const counter = numberVariable(brainDef, "count");
  const accumulate = page.appendNewRule()!;
  appendDo(
    accumulate,
    counter,
    operatorTile(environment, CoreOpId.Assign),
    counter,
    operatorTile(environment, CoreOpId.Add),
    numberLiteral(environment, brainDef, 2)
  );

  const report = page.appendNewRule()!;
  appendDo(report, tiles.emit, counter);

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Echo.actionId },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
    { op: Op.HOST_CALL, a: CoreFuncId.OpAddNumber },
    { op: Op.WHEN_START },
    { op: Op.WHEN_END },
    { op: Op.LOAD_VAR_SLOT },
    { op: Op.STORE_VAR_SLOT },
  ]);

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "tick ").length, minted.entry.schedule.length);
    assert.equal(
      traceLines(variant.trace, `action ${ConformanceHostActions.Emit.actionId.toString(16)} `).length,
      EMITS_PER_TICK * minted.entry.schedule.length
    );
    assert.equal(traceLines(variant.trace, "fault ").length, 0);
  }
});
