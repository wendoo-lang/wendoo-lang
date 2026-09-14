import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createTargetAdapter,
  FAKE_BELL_CHANNEL,
  FAKE_INPUT_KIND,
  FAKE_SIGNAL_CHANNEL,
  FAKE_SUBJECT,
  FAKE_TARGET_IDENTITY,
} from "../testing/index.js";
import type { TargetAdapter, TargetBuildStamp } from "./adapter.js";
import { ADAPTER_CONTRACT_VERSION } from "./adapter.js";
import { DECLARED_SURFACE_FORMAT_VERSION, declaredSurfaceOf, declaredSurfaceSchema } from "./declared-surface.js";

/** The stamp a fixture artifact publishes. */
const stamp: TargetBuildStamp = {
  coreVersion: "0.2.18",
  coreDistHash: "a".repeat(64),
  builtAt: "2026-09-13T00:00:00.000Z",
};

describe("baking a declared surface", () => {
  test("carries the identity, the format version, the build stamp, and every declaration", () => {
    const surface = declaredSurfaceOf(createTargetAdapter(), stamp);

    assert.equal(surface.formatVersion, DECLARED_SURFACE_FORMAT_VERSION);
    assert.equal(surface.targetIdentity, FAKE_TARGET_IDENTITY);
    assert.deepEqual(surface.buildStamp, stamp);
    assert.deepEqual(surface.subjects, [FAKE_SUBJECT]);
    assert.deepEqual(
      surface.inputKinds.map((kind) => kind.name),
      [FAKE_INPUT_KIND]
    );
    assert.deepEqual(
      surface.stateChannels.map((channel) => channel.name),
      [FAKE_SIGNAL_CHANNEL, FAKE_BELL_CHANNEL]
    );
    assert.deepEqual(surface.manifest, createTargetAdapter().manifest());
  });

  test("bakes to a document the schema accepts", () => {
    const baked = JSON.stringify(declaredSurfaceOf(createTargetAdapter(), stamp));

    const parsed = declaredSurfaceSchema.safeParse(JSON.parse(baked));

    assert.equal(parsed.success, true, JSON.stringify(parsed.error));
  });

  test("leaves a state channel's identity derivation out of the baked data", () => {
    const adapter: TargetAdapter = {
      ...createTargetAdapter(),
      contractVersion: ADAPTER_CONTRACT_VERSION,
      stateChannels: () => [{ name: "ticks", description: "How many thinks have run.", identityValue: () => "any" }],
    };

    const surface = declaredSurfaceOf(adapter, stamp);

    assert.deepEqual(surface.stateChannels, [{ name: "ticks", description: "How many thinks have run." }]);
  });
});

describe("reading a declared surface", () => {
  test("accepts a document carrying fields this version does not name, and drops them", () => {
    const later = {
      ...declaredSurfaceOf(createTargetAdapter(), stamp),
      formatVersion: DECLARED_SURFACE_FORMAT_VERSION + 1,
      toolFamilies: ["edit.image"],
    };

    const parsed = declaredSurfaceSchema.safeParse(later);

    assert.equal(parsed.success, true, JSON.stringify(parsed.error));
    assert.equal("toolFamilies" in (parsed.data ?? {}), false);
    assert.equal(parsed.data?.formatVersion, DECLARED_SURFACE_FORMAT_VERSION + 1);
  });

  test("refuses a document missing a required declaration", () => {
    const complete = declaredSurfaceOf(createTargetAdapter(), stamp);
    const fields = ["formatVersion", "targetIdentity", "buildStamp", "manifest", "subjects"] as const;

    for (const field of fields) {
      const { [field]: _removed, ...rest } = complete;
      assert.equal(declaredSurfaceSchema.safeParse(rest).success, false, `expected ${field} to be required`);
    }
  });
});
