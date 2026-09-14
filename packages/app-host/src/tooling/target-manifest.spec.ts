import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { readTargetPackageVersion, targetManifestPath } from "./target-manifest.js";

/** Temporary trees this file created, removed once it finishes. */
const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A fresh app directory whose published manifest holds `manifest`. */
async function appWithManifest(manifest: unknown): Promise<string> {
  const appDir = await mkdtemp(join(tmpdir(), "target-manifest-"));
  roots.push(appDir);
  const path = targetManifestPath(appDir);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(manifest), "utf8");
  return appDir;
}

describe("reading the package version a target app declares", () => {
  test("returns the version the published manifest declares, not the one its last package carried", async () => {
    const appDir = await appWithManifest({ identity: "example-target", version: "1.1.0", buildVersion: "1.0.0" });

    assert.equal(readTargetPackageVersion(appDir), "1.1.0");
  });

  test("throws when the manifest declares an empty version", async () => {
    const appDir = await appWithManifest({ identity: "example-target", version: "" });

    assert.throws(() => readTargetPackageVersion(appDir));
  });

  test("throws when the app publishes no manifest", async () => {
    const appDir = await mkdtemp(join(tmpdir(), "target-manifest-"));
    roots.push(appDir);

    assert.throws(() => readTargetPackageVersion(appDir));
  });
});
