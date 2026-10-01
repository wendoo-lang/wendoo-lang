/**
 * Pins the decision behind the brain editor's discard confirmation: which
 * editing sessions hold work that closing would lose, and which hold none.
 *
 * The readings are built as plain counters, so the decision is exercised
 * without a rendered editor.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type DiscardGuardReading, hasDiscardableEdits } from "./discard-guard";

/** A reading with no user work, overridable field by field. */
function reading(overrides: Partial<DiscardGuardReading> = {}): DiscardGuardReading {
  return { undoDepth: 0, openingDepth: 0, ...overrides };
}

describe("hasDiscardableEdits", () => {
  test("a brain the user only opened holds nothing to discard", () => {
    assert.equal(hasDiscardableEdits(reading()), false);
  });

  test("a brain given a starting rule on open holds nothing to discard", () => {
    assert.equal(hasDiscardableEdits(reading({ undoDepth: 1, openingDepth: 1 })), false);
  });

  test("one edit past the opening state holds work", () => {
    assert.equal(hasDiscardableEdits(reading({ undoDepth: 1, openingDepth: 0 })), true);
    assert.equal(hasDiscardableEdits(reading({ undoDepth: 2, openingDepth: 1 })), true);
  });

  test("undoing every edit returns the session to holding nothing", () => {
    assert.equal(hasDiscardableEdits(reading({ undoDepth: 1, openingDepth: 1 })), false);
  });

  test("undoing past the opening state still holds nothing", () => {
    assert.equal(hasDiscardableEdits(reading({ undoDepth: 0, openingDepth: 1 })), false);
  });
});
