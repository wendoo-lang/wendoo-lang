/**
 * Corpus case `timeout-sensor`. Five call sites of the core `timeout` sensor's
 * timer, read on one page over thinks 50 ms apart:
 *
 * ```
 * WHEN [timeout 0.25]             DO [emit 1]
 * WHEN [timeout]                  DO [emit 2]
 * WHEN [timeout [not a number]]   DO [emit 3]
 * WHEN [signal period 2]          DO [emit 4]
 *   WHEN [timeout 0.125]          DO [emit 5]
 * ```
 *
 * The trace pins four things. A timer arms at its first read with its delay
 * in seconds and fires on the first think whose time reaches the armed time
 * -- the 0.25 s timer on the think exactly 250 ms after its first read --
 * then re-arms from that think, so it fires again every 250 ms. An empty
 * delay slot runs the default one second. A delay slot holding a
 * not-a-number never fires; it does not fall back to the default. And a
 * timer whose call site was not read on the think before re-arms and does
 * not fire: the child rule's timer runs only on the thinks its parent's
 * signal is delivered, every second one, so it re-arms on every read and
 * never fires, though its reads run on far past its 125 ms delay.
 *
 * Every delay and schedule time is exactly representable at both precisions,
 * and so is every armed time, so the firing thinks are the same at either.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import { CoreHostActions } from "@wendoo/core/app";
import { Op } from "@wendoo/core/runtime";
import { appendDo, appendWhen, conformanceTiles, coreTimeoutTile, newBrain, numberLiteral } from "../authoring";
import { assertCaseIsStable, assertCompiledOps, mintCase, numberToken, traceEventsByTick } from "../mint";
import { ConformanceHostActions } from "../profile";

const CASE_ID = "timeout-sensor";

/** Delay in seconds of the timer read on every think. */
const PERIODIC_DELAY = 0.25;

/** Delay in seconds of the timer read only on the thinks its parent rule's signal is delivered. */
const SKIPPED_DELAY = 0.125;

/** Thinks between two deliveries of the signal gating the child rule's timer. */
const SIGNAL_PERIOD = 2;

function build(environment: WendooEnvironment): IBrainDef {
  const tiles = conformanceTiles(environment);
  const timeout = coreTimeoutTile(environment);
  const { brainDef, page, firstRule } = newBrain(environment, `${CASE_ID} brain`);
  const literal = (value: number) => numberLiteral(environment, brainDef, value);

  appendWhen(firstRule, timeout, literal(PERIODIC_DELAY));
  appendDo(firstRule, tiles.emit, literal(1));

  const defaulted = page.appendNewRule()!;
  appendWhen(defaulted, timeout);
  appendDo(defaulted, tiles.emit, literal(2));

  const notANumber = page.appendNewRule()!;
  appendWhen(notANumber, timeout, tiles.notANumber);
  appendDo(notANumber, tiles.emit, literal(3));

  const gated = page.appendNewRule()!;
  appendWhen(gated, tiles.signal, tiles.period, literal(SIGNAL_PERIOD));
  appendDo(gated, tiles.emit, literal(4));

  const skipped = gated.appendNewRule();
  appendWhen(skipped, timeout, literal(SKIPPED_DELAY));
  appendDo(skipped, tiles.emit, literal(5));

  return brainDef;
}

/** One read of a timer: the think it was read on and whether it fired. */
interface TimerRead {
  readonly tick: number;
  readonly fired: boolean;
}

/**
 * Every timer read of `trace`, keyed by the delay token the read passed --
 * `nil` for an empty slot, else its `number <bits>` token -- in think order.
 */
function timerReadsByDelay(trace: string): Map<string, TimerRead[]> {
  const prefix = `action ${CoreHostActions.Timeout.actionId.toString(16)} `;
  const reads = new Map<string, TimerRead[]>();
  for (const [index, lines] of traceEventsByTick(trace).entries()) {
    for (const line of lines) {
      if (!line.startsWith(prefix)) continue;
      const tokens = line.split(" ");
      const resultAt = tokens.indexOf("result");
      const delay = tokens.slice(6, resultAt).join(" ");
      const read = { tick: index + 1, fired: tokens.slice(resultAt + 1).join(" ") === "bool 1" };
      const existing = reads.get(delay);
      if (existing) {
        existing.push(read);
      } else {
        reads.set(delay, [read]);
      }
    }
  }
  return reads;
}

/** The thinks among `reads` the timer fired on. */
function firings(reads: readonly TimerRead[] | undefined): number[] {
  return (reads ?? []).filter((read) => read.fired).map((read) => read.tick);
}

test(`${CASE_ID}: the committed corpus artifacts are byte-stable and its traces deterministic`, () => {
  const minted = mintCase({ id: CASE_ID, build });
  assertCaseIsStable(minted);

  assertCompiledOps(minted.program, [
    { op: Op.HOST_ACTION_CALL, a: CoreHostActions.Timeout.actionId },
    { op: Op.HOST_ACTION_CALL, a: ConformanceHostActions.NotANumber.actionId },
    { op: Op.SPAWN_RULE },
  ]);

  const thinks = minted.entry.schedule.length;
  const everyThink = Array.from({ length: thinks }, (_, index) => index + 1);
  for (const variant of minted.variants) {
    const ticks = traceEventsByTick(variant.trace);
    assert.equal(ticks.length, thinks);
    assert.ok(ticks.every((lines) => lines.every((line) => !line.startsWith("fault "))));

    const reads = timerReadsByDelay(variant.trace);
    assert.equal(reads.size, 4, "four distinct delays are read: 0.25, empty, not-a-number, and 0.125");
    const periodic = reads.get(numberToken(PERIODIC_DELAY, variant.precision));
    const defaulted = reads.get("nil");
    const notANumber = reads.get(numberToken(Number.NaN, variant.precision));
    const skipped = reads.get(numberToken(SKIPPED_DELAY, variant.precision));

    // First read at think 1 (50 ms) arms 300 ms: the timer fires on think 6
    // exactly, then every 250 ms (five thinks) after.
    assert.deepEqual(
      periodic?.map((read) => read.tick),
      everyThink
    );
    assert.deepEqual(firings(periodic), [6, 11, 16, 21]);

    // The empty slot arms the default second: 50 ms + 1000 ms is think 21.
    assert.deepEqual(firings(defaulted), [21]);

    // A not-a-number delay never falls back to the default second.
    assert.equal(notANumber?.length, thinks);
    assert.deepEqual(firings(notANumber), []);

    // The child rule's timer is read only on the signal's thinks, re-arms on
    // each of those reads, and never fires.
    assert.deepEqual(
      skipped?.map((read) => read.tick),
      everyThink.filter((tick) => tick % SIGNAL_PERIOD === 0)
    );
    assert.deepEqual(firings(skipped), []);
  }
});
