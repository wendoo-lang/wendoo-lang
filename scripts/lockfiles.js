#!/usr/bin/env node

// Check or regenerate the package-lock.json of an app or package and of every
// local package it depends on, in dependency order.
//
// Usage:
//   node scripts/lockfiles.js <dir>...
//   node scripts/lockfiles.js --fix <dir>...
//
// The order comes from scripts/build-packages.js, so the walk covers the same
// `file:` dependency graph the build driver walks and may span repositories.
// A named directory holding no package.json is skipped, and a package reached
// more than once is visited once.
//
// A lockfile is honest when regenerating its resolution from its package.json
// leaves it unchanged. A dishonest one records a resolution its package.json no
// longer asks for, which makes `npm ci` -- the install the release path runs --
// fail.
//
// Fix mode regenerates each lockfile in place. Check mode regenerates each one,
// compares the result with what was there, then restores the original from a
// copy taken beforehand, so it leaves the working tree exactly as it found it
// whether it passes or fails. Neither mode touches node_modules, and neither
// runs a package's lifecycle scripts.

const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, relative, resolve } = require("node:path");

const { buildOrder } = require("./build-packages.js");

/** File npm records a package's resolved dependency tree in. */
const lockfileName = "package-lock.json";

/** npm arguments that rewrite the lockfile from package.json and nothing else. */
const regenerateArgs = ["install", "--package-lock-only", "--ignore-scripts"];

/** Prefix of the temporary directory check mode copies lockfiles into. */
const snapshotPrefix = "wendoo-lockfiles-";

/**
 * Rewrites the lockfile of the package at `dir` from its package.json. Throws
 * when npm cannot resolve the manifest.
 */
function regenerate(dir) {
  execFileSync("npm", regenerateArgs, { stdio: ["ignore", "ignore", "inherit"], cwd: dir });
}

/**
 * Whether the lockfile of the package at `dir` already matches its
 * package.json. Leaves the lockfile as it was found; a package that had no
 * lockfile is unmatched and is left without one.
 *
 * @param {string} dir - Directory of the package to check
 * @param {string} snapshotPath - File the original lockfile is copied to
 */
function matchesManifest(dir, snapshotPath) {
  const lockfile = join(dir, lockfileName);
  const existed = existsSync(lockfile);
  if (existed) copyFileSync(lockfile, snapshotPath);
  try {
    regenerate(dir);
    return existed && readFileSync(lockfile).equals(readFileSync(snapshotPath));
  } finally {
    if (existed) copyFileSync(snapshotPath, lockfile);
    else if (existsSync(lockfile)) unlinkSync(lockfile);
  }
}

/** Path of `dir` as the caller would name it. */
function displayPath(dir) {
  return relative(process.cwd(), dir) || ".";
}

/** Checks every package in `order`, and returns the paths of the unmatched ones. */
function checkAll(order) {
  const snapshotDir = mkdtempSync(join(tmpdir(), snapshotPrefix));
  const snapshots = [];
  const unmatched = [];
  try {
    for (const [index, dir] of order.entries()) {
      const snapshotPath = join(snapshotDir, `${index}-${lockfileName}`);
      snapshots.push(snapshotPath);
      const path = displayPath(dir);
      process.stdout.write(`  ${path}`);
      const matches = matchesManifest(dir, snapshotPath);
      if (!matches) unmatched.push(path);
      console.log(matches ? "" : " <- does not match its package.json");
    }
  } finally {
    for (const snapshot of snapshots) if (existsSync(snapshot)) unlinkSync(snapshot);
    rmdirSync(snapshotDir);
  }
  return unmatched;
}

function main(argv) {
  const fix = argv[0] === "--fix";
  const named = (fix ? argv.slice(1) : argv).map((dir) => resolve(process.cwd(), dir));
  if (named.length === 0) {
    console.error("Usage: node scripts/lockfiles.js [--fix] <dir>...");
    return 1;
  }

  const order = buildOrder(
    named.filter((dir) => existsSync(join(dir, "package.json"))),
    true
  );
  if (order.length === 0) {
    console.error("None of the named directories holds a package.json.");
    return 1;
  }

  if (fix) {
    console.log(`Regenerating ${order.length} lockfile(s), in dependency order:`);
    for (const dir of order) {
      console.log(`  ${displayPath(dir)}`);
      regenerate(dir);
    }
    console.log("\nAll lockfiles now match their package.json.");
    return 0;
  }

  console.log(`Checking ${order.length} lockfile(s), in dependency order:`);
  const unmatched = checkAll(order);
  if (unmatched.length > 0) {
    console.error(
      `\n${unmatched.length} lockfile(s) do not match their package.json:\n  ${unmatched.join("\n  ")}\n` +
        'Run "npm run lockfiles:sync" from the repository root to bring them up to date.'
    );
    return 1;
  }
  console.log("\nEvery lockfile matches its package.json.");
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
