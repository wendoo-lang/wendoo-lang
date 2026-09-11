/**
 * Determinism of the trace renderer: one event sequence renders one text, and
 * one committed corpus binary replayed twice renders one trace.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { List, mkNumberValue, mkStringValue, NIL_VALUE, TRUE_VALUE, type Value, VOID_VALUE } from "@wendoo/core/app";
import { ErrorCode, type NumberPrecision } from "@wendoo/core/runtime";
import { programBinPath, readManifest, tracePath } from "./corpus";
import { runTrace } from "./mint";
import { CONFORMANCE_PROFILE_ID } from "./profile";
import { OBSERVABLE_TRACE_FORMAT_VERSION, ObservableTraceWriter } from "./trace";

/** Matches any character outside the printable ASCII range and the LF line ending. */
const NON_TRACE_CHARACTER = /[^\x20-\x7e\n]/;

/** Feeds one writer the same event sequence, covering every core line kind. */
function renderSampleTrace(precision: NumberPrecision): string {
  const writer = new ObservableTraceWriter({ profileId: CONFORMANCE_PROFILE_ID, precision });
  const args: List<Value> = List.from<Value>([mkNumberValue(1.5), mkStringValue('a"b'), TRUE_VALUE, NIL_VALUE]);
  writer.tick(1, 16, 0);
  writer.hostActionCall(0x400, 3, args, mkNumberValue(-2));
  writer.hostActionCallAsync(0x402, 4, args);
  writer.bytecodeActionCall(1, 5, args, VOID_VALUE);
  writer.bytecodeActionCallAsync(1, 6, args);
  writer.fiberFault(7, ErrorCode.HostError);
  return writer.render();
}

describe("the trace renderer", () => {
  test("renders the same event sequence to the same text at each precision", () => {
    for (const precision of ["f32", "f64"] as const) {
      assert.equal(renderSampleTrace(precision), renderSampleTrace(precision));
    }
  });

  test("renders the two precisions differently, and heads every trace with the locked header", () => {
    const f32 = renderSampleTrace("f32");
    const f64 = renderSampleTrace("f64");
    assert.notEqual(f32, f64, "a number renders at the profile's own width");
    for (const [precision, text] of [
      ["f32", f32],
      ["f64", f64],
    ] as const) {
      assert.deepEqual(text.split("\n").slice(0, 3), [
        `mctrace ${OBSERVABLE_TRACE_FORMAT_VERSION.toString(16)}`,
        `profile ${CONFORMANCE_PROFILE_ID.toString(16)}`,
        `precision ${precision}`,
      ]);
    }
  });

  test("ends every line, and the trace itself, with a single newline", () => {
    const text = renderSampleTrace("f64");
    assert.ok(text.endsWith("\n"));
    assert.ok(!text.endsWith("\n\n"));
    assert.equal(NON_TRACE_CHARACTER.test(text), false, "the trace is ASCII with LF line endings");
  });
});

describe("replaying a committed corpus binary", () => {
  test("renders the committed trace, twice over, for every case and precision", () => {
    for (const entry of readManifest().cases) {
      for (const precision of entry.precisions) {
        const bytes = new Uint8Array(readFileSync(programBinPath(entry.id, precision)));
        const first = runTrace(bytes, precision, entry.schedule);
        const second = runTrace(bytes, precision, entry.schedule);
        assert.equal(second, first, `${entry.id}.${precision}: two replays must render the same trace`);
        assert.equal(
          readFileSync(tracePath(entry.id, precision), "utf8"),
          first,
          `${entry.id}.${precision}.trace does not match a fresh replay`
        );
      }
    }
  });
});
