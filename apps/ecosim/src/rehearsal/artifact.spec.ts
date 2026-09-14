import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ConformanceCheck } from "@wendoo/assistant-bridge/kit/node";
import { ConformanceCheckCode, checkArtifactSelfContained } from "@wendoo/assistant-bridge/kit/node";

/** The app directory, from this module's own location. */
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The identity this target's own manifest declares, which its artifact must report. */
const targetIdentity = (JSON.parse(readFileSync(join(APP_DIR, "wendoo.json"), "utf8")) as { identity: string })
  .identity;

/** The headless adapter artifact `npm run build:headless` produces. */
const artifactPath = join(APP_DIR, "dist-headless", "rehearsal", "adapter.js");

describe("the built headless adapter artifact", () => {
  test("loads, documents its tiles, and rehearses away from the tree that built it", async () => {
    const result = await checkArtifactSelfContained(artifactPath, { targetIdentity });

    assert.equal(result.ok, true, JSON.stringify(result.checks));
    for (const code of [ConformanceCheckCode.SelfContainment, ConformanceCheckCode.BuildStamp]) {
      const check: ConformanceCheck | undefined = result.checks.find((candidate) => candidate.code === code);
      assert.equal(check?.ok, true, check?.detail ?? `the result carries no ${code} check`);
    }
  });
});
