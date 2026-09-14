const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, test } = require("node:test");

/**
 * Lockfile honesty: a lockfile that no longer records the resolution its
 * package.json asks for must be reported, and reporting it must leave the
 * working tree exactly as it was found. Lockfile completeness: an
 * optionalDependencies edge naming a package the lockfile carries no entry for
 * must be reported at the key node would resolve it from.
 *
 * The fixture graph holds only `file:` dependencies, so npm resolves it from
 * the filesystem.
 */

const sweep = join(__dirname, "lockfiles.js");
const { unresolvedOptionalEdges } = require("./lockfiles.js");

/** A lockfile document whose `packages` map is `packages`. */
function lockOf(packages) {
  return { name: "fixture", lockfileVersion: 3, packages };
}

/** Fixture directories and files this file created, removed once it finishes. */
const directories = [];
const files = [];

after(() => {
  for (const file of files) if (existsSync(file)) unlinkSync(file);
  for (const directory of directories.reverse()) rmdirSync(directory);
});

/** Writes `value` as the package.json of `dir`, and tracks both for cleanup. */
function writeManifest(dir, value) {
  if (!existsSync(dir)) {
    mkdirSync(dir);
    directories.push(dir);
  }
  const manifest = join(dir, "package.json");
  files.push(manifest, join(dir, "package-lock.json"));
  writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Runs the sweep over `dir` and returns its exit code. */
function run(dir, ...flags) {
  const result = spawnSync("node", [sweep, ...flags, dir], { encoding: "utf8" });
  assert.equal(result.error, undefined, "the sweep must launch");
  return result.status;
}

describe("lockfile sweep", () => {
  const root = mkdtempSync(join(tmpdir(), "wendoo-lockfiles-spec-"));
  directories.push(root);
  const libraryDir = join(root, "library");
  const appDir = join(root, "app");
  const appLock = join(appDir, "package-lock.json");

  const library = { name: "lockfiles-spec-library", version: "1.0.0", private: true };
  const app = { name: "lockfiles-spec-app", version: "1.0.0", private: true };
  const dependent = { ...app, dependencies: { [library.name]: "file:../library" } };

  test("fix mode writes a lockfile that check mode then accepts", () => {
    writeManifest(libraryDir, library);
    writeManifest(appDir, app);

    assert.equal(run(appDir, "--fix"), 0);
    assert.ok(existsSync(appLock), "fix mode must leave a lockfile behind");
    assert.equal(run(appDir), 0);
  });

  test("check mode reports a lockfile its package.json outgrew, and restores it", () => {
    const before = readFileSync(appLock);
    writeManifest(appDir, dependent);

    assert.equal(run(appDir), 1);
    assert.deepEqual(readFileSync(appLock), before, "check mode must leave the lockfile it found");
  });

  test("fix mode brings the outgrown lockfile back into step", () => {
    assert.equal(run(appDir, "--fix"), 0);
    assert.equal(run(appDir), 0);
    assert.match(readFileSync(appLock, "utf8"), new RegExp(library.name));
  });

  test("reports the lockfile of a package whose optional edge names nothing it carries", () => {
    const complete = readFileSync(appLock, "utf8");
    const lock = JSON.parse(complete);
    lock.packages[`node_modules/${library.name}`] = {
      version: "1.0.0",
      optionalDependencies: { "fixture-platform-binary": "1.0.0" },
    };
    writeFileSync(appLock, `${JSON.stringify(lock, null, 2)}\n`, "utf8");

    assert.equal(run(appDir), 1);

    writeFileSync(appLock, complete, "utf8");
    assert.equal(run(appDir), 0);
  });
});

describe("the sweep's completeness pass", () => {
  const root = mkdtempSync(join(tmpdir(), "wendoo-lockfiles-linked-"));
  directories.push(root);
  const binaryDir = join(root, "binary");
  const libraryDir = join(root, "library");
  const appDir = join(root, "app");
  const appLock = join(appDir, "package-lock.json");

  // npm records the linked library's optional edge in the app's lockfile but
  // carries no entry for the package it names, which leaves the app's lockfile
  // complete enough for regeneration to settle on and incomplete all the same.
  const binary = { name: "lockfiles-spec-binary", version: "1.0.0", private: true };
  const library = {
    name: "lockfiles-spec-linked-library",
    version: "1.0.0",
    private: true,
    optionalDependencies: { [binary.name]: "file:../binary" },
  };
  const app = {
    name: "lockfiles-spec-linked-app",
    version: "1.0.0",
    private: true,
    dependencies: { [library.name]: "file:../library" },
  };

  test("fails fix mode once regeneration has settled with an edge unanswered", () => {
    writeManifest(binaryDir, binary);
    writeManifest(libraryDir, library);
    writeManifest(appDir, app);

    assert.equal(run(appDir, "--fix"), 1);
    assert.ok(existsSync(appLock), "fix mode must leave the regenerated lockfile behind");
  });

  test("fails check mode on a lockfile its package.json has not outgrown", () => {
    const settled = readFileSync(appLock);
    run(appDir, "--fix");
    assert.deepEqual(readFileSync(appLock), settled, "the fixture lockfile must be what regeneration produces");

    assert.equal(run(appDir), 1);
  });
});

describe("optional dependency completeness", () => {
  test("accepts an edge whose package sits beside the package declaring it", () => {
    const lock = lockOf({
      "": { optionalDependencies: { "platform-binary": "1.0.0" } },
      "node_modules/platform-binary": { version: "1.0.0" },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), []);
  });

  test("reports an edge no entry in the lockfile answers, at the key the entry belongs at", () => {
    const lock = lockOf({
      "": { optionalDependencies: { "platform-binary": "1.0.0" } },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), [
      { parent: "", name: "platform-binary", expectedKey: "node_modules/platform-binary" },
    ]);
  });

  test("resolves a scoped package's edge at the enclosing node_modules, not beside its own key", () => {
    const lock = lockOf({
      "node_modules/@scope/engine": { optionalDependencies: { "@scope/engine-linux-x64": "1.0.0" } },
      "node_modules/@scope/engine-linux-x64": { version: "1.0.0" },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), []);
  });

  test("reports a scoped package's edge parked under its own scope directory", () => {
    const lock = lockOf({
      "node_modules/@scope/engine": { optionalDependencies: { "@scope/engine-linux-x64": "1.0.0" } },
      "node_modules/@scope/@scope/engine-linux-x64": { version: "1.0.0" },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), [
      {
        parent: "node_modules/@scope/engine",
        name: "@scope/engine-linux-x64",
        expectedKey: "node_modules/@scope/engine/node_modules/@scope/engine-linux-x64",
      },
    ]);
  });

  test("walks out of a nested node_modules to the tree the package sits in", () => {
    const lock = lockOf({
      "node_modules/outer/node_modules/inner": { optionalDependencies: { "platform-binary": "1.0.0" } },
      "node_modules/platform-binary": { version: "1.0.0" },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), []);
  });

  test("accepts a linked package's edge answered by the installing root", () => {
    const lock = lockOf({
      "../../packages/core/node_modules/watcher": { optionalDependencies: { "platform-binary": "1.0.0" } },
      "node_modules/platform-binary": { version: "1.0.0" },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), []);
  });

  test("accepts a workspace root's edge answered by the installing root", () => {
    const lock = lockOf({
      "packages/engine": { optionalDependencies: { "platform-binary": "1.0.0" } },
      "node_modules/platform-binary": { version: "1.0.0" },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), []);
  });

  test("reports a linked package's edge neither its own tree nor the installing root answers", () => {
    const lock = lockOf({
      "../../packages/core/node_modules/watcher": { optionalDependencies: { "platform-binary": "1.0.0" } },
    });

    assert.deepEqual(unresolvedOptionalEdges(lock), [
      {
        parent: "../../packages/core/node_modules/watcher",
        name: "platform-binary",
        expectedKey: "../../packages/core/node_modules/watcher/node_modules/platform-binary",
      },
    ]);
  });
});
