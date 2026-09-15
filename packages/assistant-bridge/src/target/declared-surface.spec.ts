import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CoreBuild } from "@wendoo/core";
import {
  createTargetAdapter,
  FAKE_BELL_CHANNEL,
  FAKE_INPUT_KIND,
  FAKE_SIGNAL_CHANNEL,
  FAKE_SUBJECT,
  FAKE_TARGET_IDENTITY,
} from "../testing/index.js";
import type { TargetAdapter } from "./adapter.js";
import { ADAPTER_CONTRACT_VERSION } from "./adapter.js";
import {
  DECLARED_SURFACE_FORMAT_VERSION,
  DeclaredSurfaceReadCode,
  declaredSurfaceOf,
  declaredSurfaceSchema,
  readDeclaredSurface,
} from "./declared-surface.js";

/** The language build a fixture artifact publishes. */
const stamp: CoreBuild = {
  coreVersion: "0.2.18",
  coreDistHash: "a".repeat(64),
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

  test("accepts a build stamp carrying fields this version does not name, and drops them", () => {
    const stamped = declaredSurfaceOf(createTargetAdapter(), stamp);
    const later = { ...stamped, buildStamp: { ...stamped.buildStamp, builtAt: "2026-09-14T00:00:00.000Z" } };

    const parsed = declaredSurfaceSchema.safeParse(later);

    assert.equal(parsed.success, true, JSON.stringify(parsed.error));
    assert.equal("builtAt" in (parsed.data?.buildStamp ?? {}), false);
    assert.deepEqual(parsed.data?.buildStamp, stamp);
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

describe("reading a baked declared surface", () => {
  test("reads a document this writer baked", () => {
    const baked: unknown = JSON.parse(JSON.stringify(declaredSurfaceOf(createTargetAdapter(), stamp)));

    const read = readDeclaredSurface(baked);

    assert.equal(read.ok, true);
    assert.equal(read.ok && read.surface.targetIdentity, FAKE_TARGET_IDENTITY);
    assert.deepEqual(read.ok && read.surface.buildStamp, stamp);
  });

  test("reads a document at this format carrying fields this version does not name", () => {
    const later = { ...declaredSurfaceOf(createTargetAdapter(), stamp), toolFamilies: ["edit.image"] };

    const read = readDeclaredSurface(later);

    assert.equal(read.ok, true);
    assert.deepEqual(read.ok && read.surface.subjects, [FAKE_SUBJECT]);
  });

  test("refuses a document written at any other format version, in either direction", () => {
    const neighbours = [-2, -1, 1, 2]
      .map((offset) => DECLARED_SURFACE_FORMAT_VERSION + offset)
      .filter((version) => version >= 1);
    assert.ok(neighbours.length > 0, "there is a format version other than this one to refuse");

    for (const formatVersion of neighbours) {
      const other = { ...declaredSurfaceOf(createTargetAdapter(), stamp), formatVersion };

      const read = readDeclaredSurface(other);

      assert.equal(read.ok, false, `expected format ${formatVersion} to be refused`);
      assert.equal(read.ok === false && read.rejection.code, DeclaredSurfaceReadCode.UnsupportedFormatVersion);
    }
  });

  test("refuses a document that states no format version", () => {
    const { formatVersion: _absent, ...rest } = declaredSurfaceOf(createTargetAdapter(), stamp);

    const read = readDeclaredSurface(rest);

    assert.equal(read.ok, false);
    assert.equal(read.ok === false && read.rejection.code, DeclaredSurfaceReadCode.Malformed);
  });

  test("refuses a document at this format that does not match it", () => {
    const broken = { ...declaredSurfaceOf(createTargetAdapter(), stamp), subjects: "the creature" };

    const read = readDeclaredSurface(broken);

    assert.equal(read.ok, false);
    assert.equal(read.ok === false && read.rejection.code, DeclaredSurfaceReadCode.Malformed);
  });
});
