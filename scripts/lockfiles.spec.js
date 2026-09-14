const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, test } = require("node:test");

/**
 * Lockfile honesty: a lockfile that no longer records the resolution its
 * package.json asks for must be reported, and reporting it must leave the
 * working tree exactly as it was found.
 *
 * The fixture graph holds only `file:` dependencies, so npm resolves it from
 * the filesystem.
 */

const sweep = join(__dirname, "lockfiles.js");

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
});
