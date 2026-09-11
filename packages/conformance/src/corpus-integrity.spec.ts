/**
 * Corpus-wide invariants, independent of any one case: the manifest and the
 * files on disk agree in both directions, every behavior tag a case uses is
 * declared in the canonical registry, and re-deriving every case from its
 * committed artifacts writes nothing.
 *
 * The registry's uncovered entries are reported, not failed.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { describe, test } from "node:test";
import {
  BEHAVIORS_PATH,
  CORPUS_DIR,
  CORPUS_MANIFEST_VERSION,
  caseArtifactPaths,
  caseSourcePath,
  MANIFEST_PATH,
  readBehaviors,
  readManifest,
} from "./corpus";
import { goldenWrites, REGENERATE_GOLDENS_ENV, remintFromCommittedProgram } from "./mint";
import { CONFORMANCE_PROFILE_ID } from "./profile";
import { OBSERVABLE_TRACE_FORMAT_VERSION } from "./trace";

/** Corpus files that belong to no single case. */
const CORPUS_INDEX_FILES = new Set([basename(MANIFEST_PATH), basename(BEHAVIORS_PATH)]);

describe("the corpus manifest", () => {
  test("declares the schema, trace format, and profile the artifacts were minted under", () => {
    const manifest = readManifest();
    assert.equal(manifest.version, CORPUS_MANIFEST_VERSION);
    assert.equal(manifest.traceFormatVersion, OBSERVABLE_TRACE_FORMAT_VERSION);
    assert.equal(manifest.profileId, CONFORMANCE_PROFILE_ID);
  });

  test("carries unique case ids, ordered, each with a schedule and at least one precision", () => {
    const ids = readManifest().cases.map((entry) => entry.id);
    assert.deepEqual(ids, [...new Set(ids)], "case ids must be unique");
    assert.deepEqual(ids, [...ids].sort(), "cases must be ordered by id");
    for (const entry of readManifest().cases) {
      assert.ok(entry.schedule.length > 0, `case '${entry.id}' must carry a schedule`);
      assert.ok(entry.precisions.length > 0, `case '${entry.id}' must declare a precision variant`);
      assert.ok(entry.behaviors.length > 0, `case '${entry.id}' must tag at least one behavior`);
      assert.ok(
        existsSync(caseSourcePath(entry)),
        `case '${entry.id}' names a source that does not exist: ${entry.source}`
      );
    }
  });

  test("names every artifact on disk, and every artifact it names is on disk", () => {
    const manifest = readManifest();
    const declared = new Set<string>();
    for (const entry of manifest.cases) {
      for (const path of caseArtifactPaths(entry)) {
        assert.ok(existsSync(path), `case '${entry.id}' is missing its committed artifact ${basename(path)}`);
        declared.add(basename(path));
      }
    }
    const onDisk = readdirSync(CORPUS_DIR).filter((name) => !CORPUS_INDEX_FILES.has(name));
    for (const name of onDisk) {
      assert.ok(declared.has(name), `corpus file ${name} is claimed by no manifest case`);
    }
    assert.equal(onDisk.length, declared.size);
  });
});

describe("the behavior registry", () => {
  test("carries unique behavior ids, ordered, each with a description", () => {
    const ids = readBehaviors().behaviors.map((entry) => entry.id);
    assert.deepEqual(ids, [...new Set(ids)], "behavior ids must be unique");
    assert.deepEqual(ids, [...ids].sort(), "behaviors must be ordered by id");
    for (const entry of readBehaviors().behaviors) {
      assert.ok(entry.description.length > 0, `behavior '${entry.id}' must carry a description`);
    }
  });

  test("declares every behavior the cases tag", () => {
    const declared = new Set(readBehaviors().behaviors.map((entry) => entry.id));
    for (const entry of readManifest().cases) {
      for (const behavior of entry.behaviors) {
        assert.ok(declared.has(behavior), `case '${entry.id}' tags undeclared behavior '${behavior}'`);
      }
      assert.deepEqual(
        [...entry.behaviors],
        [...entry.behaviors].sort(),
        `case '${entry.id}' must list its behaviors in order`
      );
    }
  });

  test("reports the behaviors no case covers yet", () => {
    const covered = new Set(readManifest().cases.flatMap((entry) => entry.behaviors));
    const uncovered = readBehaviors().behaviors.filter((entry) => !covered.has(entry.id));
    console.log(`behaviors with no covering case: ${uncovered.length}`);
    for (const entry of uncovered) {
      console.log(`  ${entry.id}: ${entry.description}`);
    }
  });
});

describe("re-deriving the corpus from its committed artifacts", () => {
  test("reproduces every binary and trace byte for byte, and writes nothing", () => {
    for (const entry of readManifest().cases) {
      const reminted = remintFromCommittedProgram(entry);
      for (const variant of reminted.variants) {
        assert.deepEqual(
          variant.committedProgramBytes,
          variant.generatedProgramBytes,
          `${entry.id}.${variant.precision}.program.bin is not byte-stable`
        );
        assert.equal(
          variant.traceRerun,
          variant.trace,
          `${entry.id}.${variant.precision}: two fresh runs must render byte-identical traces`
        );
        assert.equal(
          variant.committedTrace,
          variant.trace,
          `${entry.id}.${variant.precision}.trace is not byte-stable`
        );
      }
    }
    if (process.env[REGENERATE_GOLDENS_ENV] !== "1") {
      assert.deepEqual(goldenWrites(), [], "minting outside regeneration mode must not write to the corpus");
    }
  });
});
