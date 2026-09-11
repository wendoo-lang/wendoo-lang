/**
 * Opcode coverage of the corpus. Every committed corpus binary is decoded with
 * core's own program reader, and the union of the opcodes it carries is
 * checked against core's own operand schema.
 *
 * An opcode outside the schema fails the suite; an opcode the schema declares
 * and no case reaches is reported in the test output.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { stream } from "@wendoo/core";
import { linkedBrainProgramFromBytes, OPERAND_SCHEMA, Op } from "@wendoo/core/runtime";
import { programBinPath, readManifest } from "./corpus";
import { createConformanceEnvironment } from "./environment";

/** Prefix of the reserved opcode members, which have no VM handler. */
const RESERVED_OPCODE_PREFIX = "RESERVED_";

/** Name core declares for `op`, or its number when the enum has no member for it. */
function opName(op: number): string {
  return (Op as unknown as Record<number, string | undefined>)[op] ?? `Op(${op})`;
}

/** The opcodes appearing in every committed binary of the corpus, in numeric order. */
function decodedOpcodes(): number[] {
  const environment = createConformanceEnvironment("f64");
  const seen = new Set<number>();
  for (const entry of readManifest().cases) {
    for (const precision of entry.precisions) {
      const bytes = new Uint8Array(readFileSync(programBinPath(entry.id, precision)));
      const decoded = linkedBrainProgramFromBytes(stream.byteArrayFromUint8Array(bytes), {
        precision,
        typeRegistry: environment.brainServices.runtime.types,
      });
      const functions = decoded.program.program.functions;
      for (let i = 0; i < functions.size(); i++) {
        const code = functions.get(i)!.code;
        for (let j = 0; j < code.size(); j++) {
          seen.add(code.get(j)!.op);
        }
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** Every opcode core's operand schema declares, in numeric order. */
function schemaOpcodes(): number[] {
  return Object.keys(OPERAND_SCHEMA)
    .map((key) => Number(key))
    .sort((a, b) => a - b);
}

describe("opcode coverage derived from the committed corpus binaries", () => {
  test("every opcode the corpus carries is declared by core's operand schema", () => {
    const declared = new Set(schemaOpcodes());
    for (const op of decodedOpcodes()) {
      assert.ok(declared.has(op), `corpus binary carries opcode ${opName(op)} (${op}) with no operand-schema entry`);
    }
  });

  test("the corpus reaches the opcodes every compiled rule carries", () => {
    const covered = new Set(decodedOpcodes());
    for (const op of [Op.WHEN_START, Op.WHEN_END, Op.DO_START, Op.DO_END, Op.RET]) {
      assert.ok(covered.has(op), `every compiled rule carries ${opName(op)}; the corpus must reach it`);
    }
  });

  test("reports the opcodes no corpus case reaches yet", () => {
    const covered = new Set(decodedOpcodes());
    const uncovered = schemaOpcodes().filter(
      (op) => !covered.has(op) && !opName(op).startsWith(RESERVED_OPCODE_PREFIX)
    );
    console.log(`opcodes covered: ${covered.size} of ${schemaOpcodes().length} (reserved slots included)`);
    console.log(`opcodes with no covering case: ${uncovered.length}`);
    for (const op of uncovered) {
      console.log(`  ${op} ${opName(op)}`);
    }
  });
});
