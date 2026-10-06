/**
 * Corpus case `random-sensor`. One call site of the core `random number`
 * sensor, read inline as the argument of `emit` on every think:
 *
 * ```
 * WHEN []  DO [emit [random number]]
 * ```
 *
 * The trace pins that each read returns the next number of the run's random
 * stream, unchanged: the profile's declared draw list in order, starting over
 * from its first draw once the last has been read. The case runs more thinks
 * than the list holds draws, so the reads wrap.
 *
 * Every draw is exactly representable at both precisions, so the readings are
 * the same numbers at either.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, conformanceTiles, coreRandomTile, newBrain } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, numberToken, traceEventsByTick } from "../mint";
import { CONFORMANCE_RANDOM_DRAWS, ConformanceHostActions } from "../profile";

const CASE_ID = "random-sensor";

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const { brainDef, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  appendDo(firstRule, tiles.emit, coreRandomTile(environment));
  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.Random.actionId },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Emit.actionId },
  ]);

  const thinks = minted.entry.schedule.length;
  assert.ok(thinks > CONFORMANCE_RANDOM_DRAWS.length, "the reads run past the end of the draw list");
  const randomEvent = `action ${CoreHostActions.Random.actionId.toString(16)} `;
  const emitEvent = `action ${ConformanceHostActions.Emit.actionId.toString(16)} `;
  for (const variant of minted.variants) {
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, thinks);
    for (const [index, lines] of ticks.entries()) {
      const draw = numberToken(CONFORMANCE_RANDOM_DRAWS[index % CONFORMANCE_RANDOM_DRAWS.length], variant.precision);
      const reads = lines.filter((line) => line.startsWith(randomEvent));
      const emits = lines.filter((line) => line.startsWith(emitEvent));
      assert.equal(reads.length, 1, `think ${index + 1} reads the sensor once`);
      assert.ok(reads[0].endsWith(`args 0 result ${draw}`), `think ${index + 1} reads ${draw}`);
      assert.equal(emits.length, 1, `think ${index + 1} emits once`);
      assert.ok(emits[0].endsWith(`args 1 ${draw} result void`), `think ${index + 1} emits ${draw}`);
      assert.ok(lines.every((line) => !line.startsWith("fault ")));
    }
  }
});
