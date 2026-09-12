/**
 * Corpus case `deep-expression-overflow`. One rule whose argument is an
 * addition of more terms than the profile's value stack holds, beside a root
 * rule that keeps running:
 *
 * ```
 * DO [emit 1 + 1 + 1 + ... ]
 * DO [emit 2]
 * ```
 *
 * The chain nests one operator inside the left operand of the next, and the
 * compiled form opens each operator's argument slots on the value stack before
 * descending into its operands, so every unevaluated level of the chain holds
 * stack entries at once. The push that crosses the cap faults the fiber with
 * `StackOverflow` before any operator runs, so the rule's own emit never
 * dispatches. The fault kills the fiber, not the rule: it respawns and faults
 * again every think, and the sibling root rule emits throughout.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, IBrainTileDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreFuncId, CoreOpId, ErrorCode, Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, newBrain, numberLiteral, operatorTile } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { CONFORMANCE_SCHEDULER_CONFIG, ConformanceHostActions } from "../profile";

const CASE_ID = "deep-expression-overflow";

/** Terms of the addition; more than the profile's value stack can hold at once. */
const TERM_COUNT = CONFORMANCE_SCHEDULER_CONFIG.maxStackSize + 1;

/** Value every term of the addition contributes. */
const TERM = 1;

/** `term + term + ... ` with `count` terms, as the tile sequence an argument slot takes. */
function additionChain(environment: WendooEnvironment, term: IBrainTileDef, count: number): IBrainTileDef[] {
  const tiles: IBrainTileDef[] = [term];
  for (let i = 1; i < count; i++) {
    tiles.push(operatorTile(environment, CoreOpId.Add), term);
  }
  return tiles;
}

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  const term = numberLiteral(environment, brainDef, TERM);
  appendDo(firstRule, tiles.emit, ...additionChain(environment, term, TERM_COUNT));

  const heartbeat = page.appendNewRule()!;
  appendDo(heartbeat, tiles.emit, numberLiteral(environment, brainDef, 2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.HOST_CALL, a: CoreFuncId.OpAddNumber }]);

  const emitPrefix = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    const faults = traceLines(variant.trace, "fault ");
    assert.equal(faults.length, minted.entry.schedule.length, "the overflowing rule respawns and faults every think");
    for (const line of faults) {
      assert.ok(
        line.endsWith(` ${ErrorCode.StackOverflow.toString(16)}`),
        "crossing the value-stack cap faults with StackOverflow"
      );
    }

    // Only the heartbeat emits: the overflowing rule never reaches its own
    // dispatch.
    const emitted = traceLines(variant.trace, emitPrefix).map((line) => line.split(" ").slice(6, 8).join(" "));
    assert.equal(emitted.length, minted.entry.schedule.length);
    assert.equal(new Set(emitted).size, 1);
  }
});
