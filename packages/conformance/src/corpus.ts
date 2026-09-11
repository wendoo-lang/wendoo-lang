import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NumberPrecision } from "@wendoo/core/runtime";

/** Absolute path of the repository root, the base every manifest `source` is relative to. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Absolute path of the corpus directory holding the manifest and every minted artifact. */
export const CORPUS_DIR = fileURLToPath(new URL("../corpus/", import.meta.url));

/** Absolute path of the corpus manifest. */
export const MANIFEST_PATH = `${CORPUS_DIR}manifest.json`;

/** Absolute path of the canonical behavior registry. */
export const BEHAVIORS_PATH = `${CORPUS_DIR}behaviors.json`;

/** Schema version of {@link CorpusManifest}, bumped whenever an entry's shape changes. */
export const CORPUS_MANIFEST_VERSION = 1;

/** One case of the corpus: what it is, what it pins, and how a runner replays it. */
export interface CorpusCaseEntry {
  /** Case id; the basename every artifact of the case is filed under. */
  readonly id: string;
  /** Repository-relative path of the spec that authors and mints the case. */
  readonly source: string;
  /** One-line statement of what the case exercises. */
  readonly summary: string;
  /** Ids of the behaviors the case pins, as declared in the behavior registry. */
  readonly behaviors: readonly string[];
  /** Precisions the case is minted at; a runner replays the one matching its profile. */
  readonly precisions: readonly NumberPrecision[];
  /** Tick advances in milliseconds, in order; one think per entry. */
  readonly schedule: readonly number[];
}

/** The corpus index: which cases every VM must pass, and how to replay each. */
export interface CorpusManifest {
  /** Schema version of this file. */
  readonly version: number;
  /** Observable-trace format version every committed trace is rendered at. */
  readonly traceFormatVersion: number;
  /** Numeric device-profile id in every committed program envelope and trace header. */
  readonly profileId: number;
  /** The cases, ordered by id. */
  readonly cases: readonly CorpusCaseEntry[];
}

/** One entry of the canonical behavior registry. */
export interface BehaviorEntry {
  /** Behavior id, referenced by a case's `behaviors` tags. */
  readonly id: string;
  /** One-line description of the semantics the behavior names. */
  readonly description: string;
}

/** The canonical registry of behaviors the corpus must eventually represent. */
export interface BehaviorRegistry {
  /** Schema version of this file. */
  readonly version: number;
  /** The behaviors, ordered by id. Entries no case covers are expected. */
  readonly behaviors: readonly BehaviorEntry[];
}

/** Absolute path of a case's compiled-program JSON, the artifact freezing its generated ids. */
export function programJsonPath(caseId: string): string {
  return `${CORPUS_DIR}${caseId}.program.json`;
}

/** Absolute path of a case's wire binary at `precision`. */
export function programBinPath(caseId: string, precision: NumberPrecision): string {
  return `${CORPUS_DIR}${caseId}.${precision}.program.bin`;
}

/** Absolute path of a case's rendered observable trace at `precision`. */
export function tracePath(caseId: string, precision: NumberPrecision): string {
  return `${CORPUS_DIR}${caseId}.${precision}.trace`;
}

/** Absolute path of the spec that authors and mints a case. */
export function caseSourcePath(entry: CorpusCaseEntry): string {
  return `${REPO_ROOT}${entry.source}`;
}

/** Every artifact path a case owns, in the order they are minted. */
export function caseArtifactPaths(entry: CorpusCaseEntry): string[] {
  const paths = [programJsonPath(entry.id)];
  for (const precision of entry.precisions) {
    paths.push(programBinPath(entry.id, precision));
    paths.push(tracePath(entry.id, precision));
  }
  return paths;
}

/** Reads and parses the corpus manifest. */
export function readManifest(): CorpusManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as CorpusManifest;
}

/** Reads and parses the canonical behavior registry. */
export function readBehaviors(): BehaviorRegistry {
  return JSON.parse(readFileSync(BEHAVIORS_PATH, "utf8")) as BehaviorRegistry;
}

/**
 * The manifest entry for `caseId`.
 *
 * @param caseId - Id of the case to look up.
 * @throws When the manifest carries no entry with that id.
 */
export function manifestEntry(caseId: string): CorpusCaseEntry {
  const entry = readManifest().cases.find((candidate) => candidate.id === caseId);
  if (!entry) {
    throw new Error(`corpus manifest has no case '${caseId}'`);
  }
  return entry;
}
