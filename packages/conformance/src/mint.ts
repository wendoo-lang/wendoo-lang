import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { stream } from "@wendoo/core";
import type { IBrainDef, WendooEnvironment } from "@wendoo/core/app";
import type { Instr, LinkedBrainProgram, LinkedBrainProgramJson, NumberPrecision } from "@wendoo/core/runtime";
import {
  BrainRuntime,
  linkedBrainProgramFromBytes,
  linkedBrainProgramFromJson,
  linkedBrainProgramToBytes,
  linkedBrainProgramToJson,
} from "@wendoo/core/runtime";
import { type CorpusCaseEntry, manifestEntry, programBinPath, programJsonPath, tracePath } from "./corpus";
import { createConformanceEnvironment } from "./environment";
import { CONFORMANCE_PROFILE_ID, CONFORMANCE_SCHEDULER_CONFIG, ConformanceWorld } from "./profile";
import { ObservableTraceWriter, observableTraceVmEvents } from "./trace";

/**
 * Environment variable that puts the corpus into regeneration mode. Set it to
 * `1` to rewrite every committed artifact from a fresh build.
 */
export const REGENERATE_GOLDENS_ENV = "WENDOO_REGENERATE_GOLDENS";

/** Paths written since the process started, oldest first. */
const writtenPaths: string[] = [];

/**
 * True when the caller should write the artifact at `path`: always in
 * regeneration mode, otherwise only when the artifact does not yet exist.
 *
 * @param path - Absolute path of the artifact the caller is about to write.
 */
export function shouldWriteGolden(path: string): boolean {
  return process.env[REGENERATE_GOLDENS_ENV] === "1" || !existsSync(path);
}

/** Absolute paths this process has written to the corpus, oldest first. */
export function goldenWrites(): readonly string[] {
  return writtenPaths;
}

function writeGolden(path: string, contents: string | Uint8Array): void {
  if (!shouldWriteGolden(path)) {
    return;
  }
  writeFileSync(path, contents);
  writtenPaths.push(path);
}

/**
 * One conformance case: its manifest id and the brain it authors. `build`
 * constructs the brain through the tile APIs against `environment`.
 */
export interface ConformanceCase {
  /** Manifest id of the case; the basename its artifacts are filed under. */
  readonly id: string;
  /** Authors the case's brain in `environment`. */
  build(environment: WendooEnvironment): IBrainDef;
}

/** The artifacts a case owns at one precision, as generated and as committed. */
export interface MintedVariant {
  /** Precision the variant is minted at. */
  readonly precision: NumberPrecision;
  /** Wire binary encoded from the committed compiled-program JSON. */
  readonly generatedProgramBytes: Uint8Array;
  /** Wire binary read back from the corpus. */
  readonly committedProgramBytes: Uint8Array;
  /** Trace rendered by replaying the committed binary over the manifest schedule. */
  readonly trace: string;
  /** Trace rendered by a second, independent replay of the same binary. */
  readonly traceRerun: string;
  /** Trace read back from the corpus. */
  readonly committedTrace: string;
}

/** Everything one minting pass produced for a case. */
export interface MintedCase {
  /** The case's manifest entry. */
  readonly entry: CorpusCaseEntry;
  /** Compiled-program JSON serialized from a fresh authoring pass. */
  readonly generatedProgramJson: string;
  /** Compiled-program JSON read back from the corpus. */
  readonly committedProgramJson: string;
  /** Linked program hydrated from the committed JSON: the compiled output every assertion reads. */
  readonly program: LinkedBrainProgram;
  /** One entry per precision the manifest declares for the case, in manifest order. */
  readonly variants: readonly MintedVariant[];
}

/** Serializes a linked program as the canonical compiled-program JSON text. */
function serializeProgramJson(program: LinkedBrainProgram): string {
  return `${JSON.stringify(linkedBrainProgramToJson(program), null, 2)}\n`;
}

/** Authors, compiles, and links `def`'s brain. Throws when the brain does not link. */
function linkCase(def: ConformanceCase): LinkedBrainProgram {
  const environment = createConformanceEnvironment("f64");
  const built = environment.linkBrain(def.build(environment));
  if (!built.program) {
    const messages: string[] = [];
    for (let i = 0; i < built.diagnostics.size(); i++) {
      messages.push(built.diagnostics.get(i)!.message);
    }
    throw new Error(`case '${def.id}' did not link: ${messages.join("; ")}`);
  }
  return built.program;
}

/**
 * Replays `bytes` over `schedule` and returns the rendered observable trace.
 * The run reads nothing outside the decoded program, the schedule, and a fresh
 * {@link ConformanceWorld}.
 *
 * @param bytes - Wire binary of the case's compiled program.
 * @param precision - Numeric precision the run computes and renders at.
 * @param schedule - Tick advances in milliseconds, one think per entry.
 */
export function runTrace(bytes: Uint8Array, precision: NumberPrecision, schedule: readonly number[]): string {
  const environment = createConformanceEnvironment(precision);
  const decoded = linkedBrainProgramFromBytes(stream.byteArrayFromUint8Array(bytes), {
    precision,
    typeRegistry: environment.brainServices.runtime.types,
  });
  assert.equal(decoded.profileId, CONFORMANCE_PROFILE_ID, "binary envelope carries the conformance profile id");

  const writer = new ObservableTraceWriter({ profileId: CONFORMANCE_PROFILE_ID, precision });
  const world = new ConformanceWorld();
  const services = environment.brainServices;
  const runtime = new BrainRuntime(
    decoded.program.program,
    decoded.program.pages,
    { runtime: services.runtime, shared: services.shared, app: services.app },
    world,
    undefined,
    observableTraceVmEvents(writer),
    CONFORMANCE_SCHEDULER_CONFIG
  );
  runtime.startup();

  let lastThinkTimeMs = 0;
  for (const [index, advanceMs] of schedule.entries()) {
    const ordinal = index + 1;
    const timeMs = lastThinkTimeMs + advanceMs;
    writer.tick(ordinal, timeMs, lastThinkTimeMs === 0 ? 0 : timeMs - lastThinkTimeMs);
    world.settleDue(ordinal);
    runtime.think(timeMs);
    lastThinkTimeMs = timeMs;
  }
  return writer.render();
}

/**
 * Derives everything downstream of a case's committed compiled-program JSON:
 * the wire binary of each declared precision, and the trace each binary
 * renders over the manifest schedule, replayed twice. Writes any of those
 * artifacts the corpus is missing, and nothing at all when they are all
 * present and the corpus is not in regeneration mode.
 *
 * @param entry - Manifest entry of the case to derive.
 */
export function remintFromCommittedProgram(entry: CorpusCaseEntry): Omit<MintedCase, "generatedProgramJson"> {
  const committedProgramJson = readFileSync(programJsonPath(entry.id), "utf8");
  const program = linkedBrainProgramFromJson(JSON.parse(committedProgramJson) as LinkedBrainProgramJson);

  const environment = createConformanceEnvironment("f64");
  const variants: MintedVariant[] = [];
  for (const precision of entry.precisions) {
    const binPath = programBinPath(entry.id, precision);
    const generatedProgramBytes = stream.byteArrayToUint8Array(
      linkedBrainProgramToBytes(program, {
        profileId: CONFORMANCE_PROFILE_ID,
        precision,
        typeRegistry: environment.brainServices.runtime.types,
      })
    ) as Uint8Array;
    writeGolden(binPath, generatedProgramBytes);
    const committedProgramBytes = new Uint8Array(readFileSync(binPath));

    const trace = runTrace(committedProgramBytes, precision, entry.schedule);
    const traceRerun = runTrace(committedProgramBytes, precision, entry.schedule);
    const textPath = tracePath(entry.id, precision);
    writeGolden(textPath, trace);
    variants.push({
      precision,
      generatedProgramBytes,
      committedProgramBytes,
      trace,
      traceRerun,
      committedTrace: readFileSync(textPath, "utf8"),
    });
  }

  return { entry, committedProgramJson, program, variants };
}

/**
 * Mints `def`: authors and compiles the brain, writes the compiled-program
 * JSON if the corpus is missing it, then derives the binary and the trace of
 * each declared precision from the committed JSON. Writes nothing when every
 * artifact is already committed and the corpus is not in regeneration mode.
 *
 * @param def - The case to mint.
 */
export function mintCase(def: ConformanceCase): MintedCase {
  const entry = manifestEntry(def.id);
  const generatedProgramJson = serializeProgramJson(linkCase(def));
  writeGolden(programJsonPath(entry.id), generatedProgramJson);
  return { ...remintFromCommittedProgram(entry), generatedProgramJson };
}

/**
 * Asserts the invariants every corpus case carries: the compiled program, the
 * wire binary, and the rendered trace of each precision match the committed
 * artifacts byte for byte, and two independent replays of one binary render
 * the same trace.
 *
 * @param minted - The case's minting result.
 */
export function assertCaseIsStable(minted: MintedCase): void {
  assert.equal(
    minted.committedProgramJson,
    minted.generatedProgramJson,
    `${minted.entry.id}.program.json does not match a fresh authoring pass`
  );
  for (const variant of minted.variants) {
    assert.deepEqual(
      variant.committedProgramBytes,
      variant.generatedProgramBytes,
      `${minted.entry.id}.${variant.precision}.program.bin is not byte-stable`
    );
    assert.equal(
      variant.traceRerun,
      variant.trace,
      `${minted.entry.id}.${variant.precision}: two fresh runs must render byte-identical traces`
    );
    assert.equal(
      variant.committedTrace,
      variant.trace,
      `${minted.entry.id}.${variant.precision}.trace is not byte-stable`
    );
  }
}

/** Every instruction of every function of `program`, in function then program order. */
export function compiledInstructions(program: LinkedBrainProgram): Instr[] {
  const out: Instr[] = [];
  const functions = program.program.functions;
  for (let i = 0; i < functions.size(); i++) {
    const code = functions.get(i)!.code;
    for (let j = 0; j < code.size(); j++) {
      out.push(code.get(j)!);
    }
  }
  return out;
}

/**
 * Asserts `program`'s compiled bytecode carries an instruction with each
 * required opcode and, where given, operand `a`.
 *
 * @param program - Compiled program to scan.
 * @param required - Opcode (and optional first operand) each assertion demands.
 */
export function assertCompiledOps(
  program: LinkedBrainProgram,
  required: readonly { readonly op: number; readonly a?: number }[]
): void {
  const seen = compiledInstructions(program);
  for (const want of required) {
    assert.ok(
      seen.some((instr) => instr.op === want.op && (want.a === undefined || instr.a === want.a)),
      `compiled bytecode should carry op ${want.op}${want.a === undefined ? "" : ` operand ${want.a}`}`
    );
  }
}

/** The lines of `trace` that begin with `prefix`, in emission order. */
export function traceLines(trace: string, prefix: string): string[] {
  return trace.split("\n").filter((line) => line.startsWith(prefix));
}
