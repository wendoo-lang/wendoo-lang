/**
 * Corpus case `action-callsite-state`. A two-page brain with three `counter`
 * call sites, each reading at its own rate:
 *
 * ```
 * page 1: WHEN [counter]          DO [emit 1]
 *         WHEN [signal period 2]  DO [emit 2]
 *           WHEN [counter]        DO [emit 3]
 *         WHEN [signal period 3]  DO [switch page 2]
 * page 2: WHEN [counter]          DO [emit 4]
 *         WHEN [signal period 2]  DO [switch page 1]
 * ```
 *
 * `counter` returns how many times it has been read at its own call site since
 * that call site's page was last activated. The trace pins three things: the
 * count is keyed by call site, not by action -- two sites read in the same
 * think return different numbers -- it survives from one think to the next, and
 * the page-activation hook, the only thing that writes it outside a read,
 * returns it to zero each time its page is entered again.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import {
  appendDo,
  appendPage,
  appendWhen,
  conformanceTiles,
  corePageTiles,
  newBrain,
  numberLiteral,
} from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, traceLines } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "action-callsite-state";

/** Thinks between two deliveries of the sensor gating the child rule and the return switch. */
const FAST_PERIOD = 2;

/** Thinks between two deliveries of the sensor gating the outbound switch. */
const SLOW_PERIOD = 3;

/** Every `counter` read of `trace`, as call-site id to returned value tokens in emission order. */
function countsByCallSite(trace: string): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  for (const line of traceLines(trace, `action ${ConformanceHostActions.Counter.actionId.toString(16)} `)) {
    const tokens = line.split(" ");
    const site = tokens[3]!;
    const result = tokens.slice(tokens.indexOf("result") + 1).join(" ");
    const existing = reads.get(site);
    if (existing) {
      existing.push(result);
    } else {
      reads.set(site, [result]);
    }
  }
  return reads;
}

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const pageTiles = corePageTiles(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendWhen(firstRule, tiles.counter);
  appendDo(firstRule, tiles.emit, literal(1));

  const gated = page.appendNewRule()!;
  appendWhen(gated, tiles.signal, tiles.period, literal(FAST_PERIOD));
  appendDo(gated, tiles.emit, literal(2));

  const gatedChild = gated.appendNewRule();
  appendWhen(gatedChild, tiles.counter);
  appendDo(gatedChild, tiles.emit, literal(3));

  const outbound = page.appendNewRule()!;
  appendWhen(outbound, tiles.signal, tiles.period, literal(SLOW_PERIOD));
  appendDo(outbound, pageTiles.switchPage, literal(2));

  const second = appendPage(brainDef);
  appendWhen(second.firstRule, tiles.counter);
  appendDo(second.firstRule, tiles.emit, literal(4));

  const inbound = second.page.appendNewRule()!;
  appendWhen(inbound, tiles.signal, tiles.period, literal(FAST_PERIOD));
  appendDo(inbound, pageTiles.switchPage, literal(1));

  return brainDef;
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.Counter.actionId },
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.SwitchPage.actionId },
    { op: Op.SPAWN_RULE },
  ]);

  for (const variant of minted.variants) {
    assert.equal(traceLines(variant.trace, "fault ").length, 0);

    const reads = [...countsByCallSite(variant.trace).values()];
    assert.equal(reads.length, 3, "the three counter call sites each read at least once");
    const [unconditional, child, otherPage] = reads as [string[], string[], string[]];

    // Every call site starts from the same number once its page is activated,
    // and only the unconditional site reads on every think its page is active.
    const first = unconditional[0];
    assert.equal(child[0], first);
    assert.equal(otherPage[0], first);
    assert.ok(unconditional.length > child.length && unconditional.length > otherPage.length);

    // Two sites reading in one think return different numbers: the count is
    // keyed by call site, not by action.
    assert.notEqual(unconditional[1], child[0]);

    // Re-entering page 1 returns its sites to the number they start at, so the
    // run of counts before the switch repeats after it.
    const reentry = unconditional.indexOf(first!, 1);
    assert.ok(reentry > 0, "the unconditional site reads the starting number again after a re-entry");
    assert.deepEqual(unconditional.slice(reentry), unconditional.slice(0, unconditional.length - reentry));
    assert.deepEqual(
      otherPage,
      otherPage.map(() => first)
    );
  }
});
