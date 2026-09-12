/**
 * Corpus case `budget-exhaustion`. One rule whose WHEN section is a chain of
 * `and` gates long enough to outrun the profile's per-slice instruction budget,
 * beside a root rule that keeps running:
 *
 * ```
 * WHEN [true and true and true and ... ] DO [emit 1]
 * DO [emit 2]
 * ```
 *
 * Every gate holds, so the chain evaluates end to end, and each gate compiles
 * to a branch over a duplicated operand. The first slice spends its budget part
 * way along and the fiber re-enters the run queue with its program counter
 * where it stopped; it finishes in the next round, which is the next think, and
 * fires there. The rule then respawns and repeats, so its emit lands on every
 * second think while the sibling root rule emits on every one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, IBrainTileDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreOpId, Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendWhen,
  booleanLiteral,
  conformanceTiles,
  newBrain,
  numberLiteral,
  operatorTile,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, eventKinds, mintCase, traceEventsByTick, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "budget-exhaustion";

/**
 * Gates in the chain. Each costs roughly four instructions, so the chain runs
 * past one slice of the profile's 1000-instruction budget and finishes within
 * the second.
 */
const GATE_COUNT = 400;

/** `operand and operand and ... ` with `count` operands, as the tile sequence a WHEN section takes. */
function andChain(environment: WendooEnvironment, operand: IBrainTileDef, count: number): IBrainTileDef[] {
  const tiles: IBrainTileDef[] = [operand];
  for (let i = 1; i < count; i++) {
    tiles.push(operatorTile(environment, CoreOpId.And), operand);
  }
  return tiles;
}

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);

  appendWhen(firstRule, ...andChain(environment, booleanLiteral(environment, true), GATE_COUNT));
  appendDo(firstRule, tiles.emit, numberLiteral(environment, brainDef, 1));

  const heartbeat = page.appendNewRule()!;
  appendDo(heartbeat, tiles.emit, numberLiteral(environment, brainDef, 2));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [{ op: Op.JMP_IF_FALSE }]);

  const emit = `action ${ConformanceHostActions.Emit.actionId.toString(16)}`;
  // The chain spends a whole slice before its gate resolves, so the gated rule
  // emits on the even thinks only; the heartbeat emits on every think.
  const perThink = [[emit], [emit, emit], [emit], [emit, emit]];
  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0, "a spent budget re-enqueues the fiber, never faults");
    const ticks = traceEventsByTick(variant.trace);
    assert.deepEqual(ticks.map(eventKinds), perThink);

    // On the thinks the gated rule finishes, its emit precedes the heartbeat's
    // and carries the other number.
    const value = (line: string) => line.split(" ").slice(6, 8).join(" ");
    const heartbeatValue = value(ticks[0]![0]!);
    assert.equal(value(ticks[1]![1]!), heartbeatValue);
    assert.notEqual(value(ticks[1]![0]!), heartbeatValue);
    assert.equal(value(ticks[3]![0]!), value(ticks[1]![0]!));
  }
});
