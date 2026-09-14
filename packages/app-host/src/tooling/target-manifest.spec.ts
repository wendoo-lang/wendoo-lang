import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  checkPackagedVersionMatchesSource,
  PackagedVersionCheckCode,
  readTargetPackageVersion,
  targetPackageManifestPath,
  targetSourceManifestPath,
} from "./target-manifest.js";

/** Temporary trees this file created, removed once it finishes. */
const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A fresh app directory, with no manifest of either kind. */
async function emptyApp(): Promise<string> {
  const appDir = await mkdtemp(join(tmpdir(), "target-manifest-"));
  roots.push(appDir);
  return appDir;
}

/** Writes `manifest` to `path`, creating the directory that holds it. */
async function writeManifest(path: string, manifest: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(manifest), "utf8");
}

/** A fresh app directory whose source manifest holds `manifest`. */
async function appWithSourceManifest(manifest: unknown): Promise<string> {
  const appDir = await emptyApp();
  await writeManifest(targetSourceManifestPath(appDir), manifest);
  return appDir;
}

describe("reading the package version a target app declares", () => {
  test("returns the version the source manifest declares", async () => {
    const appDir = await appWithSourceManifest({ identity: "example/trg-target", version: "1.1.0" });

    assert.equal(readTargetPackageVersion(appDir), "1.1.0");
  });

  test("reads the source manifest, not the assembled package's", async () => {
    const appDir = await appWithSourceManifest({ identity: "example/trg-target", version: "1.1.0" });
    await writeManifest(targetPackageManifestPath(appDir), { version: "1.0.0", buildVersion: "1.0.0" });

    assert.equal(readTargetPackageVersion(appDir), "1.1.0");
  });

  test("throws when the manifest declares an empty version", async () => {
    const appDir = await appWithSourceManifest({ identity: "example/trg-target", version: "" });

    assert.throws(() => readTargetPackageVersion(appDir));
  });

  test("throws when the app has no source manifest", async () => {
    const appDir = await emptyApp();

    assert.throws(() => readTargetPackageVersion(appDir));
  });
});

describe("checking an assembled package against the source manifest", () => {
  test("accepts a package assembled at the source manifest's version", async () => {
    const appDir = await appWithSourceManifest({ version: "2.0.0" });
    await writeManifest(targetPackageManifestPath(appDir), { version: "2.0.0", buildVersion: "2.0.0" });

    assert.deepEqual(checkPackagedVersionMatchesSource(appDir), { ok: true, version: "2.0.0" });
  });

  test("refuses a package assembled before the version was bumped", async () => {
    const appDir = await appWithSourceManifest({ version: "2.1.0" });
    await writeManifest(targetPackageManifestPath(appDir), { version: "2.0.0", buildVersion: "2.0.0" });

    assert.deepEqual(checkPackagedVersionMatchesSource(appDir), {
      ok: false,
      code: PackagedVersionCheckCode.VERSION_STALE,
      sourceVersion: "2.1.0",
      packagedVersion: "2.0.0",
    });
  });

  test("refuses when no package has been assembled", async () => {
    const appDir = await appWithSourceManifest({ version: "2.1.0" });

    assert.deepEqual(checkPackagedVersionMatchesSource(appDir), {
      ok: false,
      code: PackagedVersionCheckCode.PACKAGE_MISSING,
      sourceVersion: "2.1.0",
    });
  });
});
