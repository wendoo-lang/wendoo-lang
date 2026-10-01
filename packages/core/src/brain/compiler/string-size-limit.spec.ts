/**
 * The compiled-string size limit: a text literal or variable name whose UTF-8
 * encoding exceeds what the bytecode string table holds is reported as an
 * error-severity build diagnostic, and the build produces no program.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { coreModule, createWendooEnvironment } from "@wendoo/core";
import { type BrainServices, mkOperatorTileId, mkVariableTileId, RuleSide } from "@wendoo/core/brain";
import { type BrainBuildResult, CompilationDiagCode } from "@wendoo/core/brain/compiler";
import { BrainDef, encodePersistedBrainJson } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import { CoreOpId, CoreTypeIds, linkedBrainProgramToBytes } from "@wendoo/core/runtime";

/** Largest UTF-8 byte length a compiled string may have. */
const LIMIT = 64 * 1024;

const environment = createWendooEnvironment({ modules: [coreModule()] });
const services = (environment as unknown as { brainServices: BrainServices }).brainServices;

/**
 * A brain whose one rule assigns a text literal of `text` to a text variable
 * named `varName`.
 */
function assignmentBrain(varName: string, text: string): BrainDef {
  const brainDef = BrainDef.emptyBrainDef(services, "Size Brain");
  const variable = new BrainTileVariableDef(mkVariableTileId("sizeVar1"), varName, CoreTypeIds.String, "sizeVar1");
  const literal = new BrainTileLiteralDef(CoreTypeIds.String, text, {}, services);
  brainDef.catalog().registerTileDef(variable);
  brainDef.catalog().registerTileDef(literal);
  const rule = brainDef.pages().get(0)!.children().get(0)!;
  rule.do().appendTile(variable);
  rule.do().appendTile(services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign))!);
  rule.do().appendTile(literal);
  return brainDef;
}

/** The size-limit diagnostics of `result`. */
function sizeDiagnostics(result: BrainBuildResult) {
  return result.diagnostics.toArray().filter((diag) => diag.code === CompilationDiagCode.StringTooLarge);
}

/** Asserts `result` built no program and reports exactly one size-limit error on the first rule's DO side. */
function assertRejected(result: BrainBuildResult): void {
  assert.equal(result.program, undefined);
  const diags = sizeDiagnostics(result);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, "error");
  assert.deepEqual(diags[0].params, { rulePath: "0/0", side: RuleSide.Do });
}

/** Asserts `result` built a program that encodes to bytecode. */
function assertEncodes(result: BrainBuildResult): void {
  assert.equal(sizeDiagnostics(result).length, 0);
  assert.ok(result.program, "the brain links");
  linkedBrainProgramToBytes(result.program, { profileId: 1, precision: "f64", typeRegistry: services.runtime.types });
}

describe("compiled string size limit", () => {
  test("a text literal at the limit compiles and encodes", () => {
    assertEncodes(environment.linkBrain(assignmentBrain("message", "a".repeat(LIMIT))));
  });

  test("a text literal one byte over the limit is a build error", () => {
    assertRejected(environment.linkBrain(assignmentBrain("message", "a".repeat(LIMIT + 1))));
  });

  test("the limit counts UTF-8 bytes, not characters", () => {
    // U+20AC encodes as three bytes; U+1F680 as four bytes and two UTF-16 units.
    const euros = Math.floor(LIMIT / 3);
    assertEncodes(environment.linkBrain(assignmentBrain("message", "€".repeat(euros))));
    assertRejected(environment.linkBrain(assignmentBrain("message", "€".repeat(euros + 1))));
    assertEncodes(environment.linkBrain(assignmentBrain("message", "\u{1F680}".repeat(LIMIT / 4))));
    assertRejected(environment.linkBrain(assignmentBrain("message", `${"\u{1F680}".repeat(LIMIT / 4)}a`)));
    // An unpaired surrogate encodes as the three-byte replacement character.
    assertEncodes(environment.linkBrain(assignmentBrain("message", "\ud800".repeat(euros))));
    assertRejected(environment.linkBrain(assignmentBrain("message", "\ud800".repeat(euros + 1))));
  });

  test("a variable name over the limit is a build error", () => {
    assertRejected(environment.linkBrain(assignmentBrain("v".repeat(LIMIT + 1), "hello")));
  });

  test("a multi-megabyte text literal persists, reopens, and reports the build error", () => {
    const text = "x".repeat(4 * 1024 * 1024);
    const source = JSON.stringify(encodePersistedBrainJson(assignmentBrain("message", text), "project"));
    const reopened = environment.deserializeBrainJsonFromPlain(JSON.parse(source), "project");
    assertRejected(environment.linkBrain(reopened));
  });
});
