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
// A lockfile is complete when every optionalDependencies edge it records names
// a package it also carries an entry for. An incomplete one installs nothing
// for that edge, so a platform-specific binary is absent at runtime.
//
// Fix mode regenerates each lockfile in place, repeating the whole sweep until
// a pass leaves every lockfile byte-identical, then reports the edges the
// settled lockfiles leave unanswered. Check mode regenerates each one,
// compares the result with what was there, then restores the original from a
// copy taken beforehand, so it leaves the working tree exactly as it found it
// whether it passes or fails; it then checks the restored lockfile for
// completeness. Neither mode touches node_modules, and neither runs a package's
// lifecycle scripts.

const { execFileSync } = require("node:child_process");
const { copyFileSync, existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, relative, resolve } = require("node:path");

const { buildOrder, modulesDirName } = require("./build-packages.js");

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

/**
 * Every key in a lockfile's `packages` map a package at `parentKey` resolves
 * `name` at, nearest first: its own `node_modules`, then each enclosing
 * `node_modules` out to the tree `parentKey` sits in, and finally the
 * installing root's own `node_modules`, which a key outside that tree -- a
 * linked local package, a workspace root -- also resolves from.
 *
 * @param {string} parentKey - Key of the package holding the dependency; "" for the lockfile's own root
 * @param {string} name - Name of the dependency, scope included
 */
function resolutionCandidates(parentKey, name) {
  const candidates = [];
  let prefix = parentKey;
  for (;;) {
    candidates.push(prefix === "" ? `${modulesDirName}/${name}` : `${prefix}/${modulesDirName}/${name}`);
    const at = prefix.lastIndexOf(`${modulesDirName}/`);
    if (at === -1) break;
    prefix = at === 0 ? "" : prefix.slice(0, at - 1);
  }
  const installingRoot = `${modulesDirName}/${name}`;
  if (!candidates.includes(installingRoot)) candidates.push(installingRoot);
  return candidates;
}

/**
 * One optionalDependencies edge a lockfile records without carrying an entry
 * for the package the edge names.
 *
 * @typedef {object} UnresolvedEdge
 * @property {string} parent - Key of the package declaring the edge; "" for the lockfile's own root
 * @property {string} name - Name of the optional dependency, scope included
 * @property {string} expectedKey - Key the missing entry belongs at
 */

/**
 * Every optionalDependencies edge in the parsed lockfile `lock` that names no
 * package the lockfile carries an entry for.
 *
 * @param {object} lock - A parsed package-lock.json document
 * @returns {UnresolvedEdge[]}
 */
function unresolvedOptionalEdges(lock) {
  const packages = lock.packages ?? {};
  const unresolved = [];
  for (const [key, entry] of Object.entries(packages)) {
    for (const name of Object.keys(entry?.optionalDependencies ?? {})) {
      const candidates = resolutionCandidates(key, name);
      if (candidates.some((candidate) => packages[candidate] !== undefined)) continue;
      unresolved.push({ parent: key, name, expectedKey: candidates[0] });
    }
  }
  return unresolved;
}

/** `edge` as one line of a failure report, with the lockfile's own root written as `.`. */
function describeEdge(edge) {
  return `${edge.parent === "" ? "." : edge.parent} -> ${edge.name}, expected at ${edge.expectedKey}`;
}

/** Path of `dir` as the caller would name it. */
function displayPath(dir) {
  return relative(process.cwd(), dir) || ".";
}

/** Every optionalDependencies edge the lockfile of the package at `dir` leaves with no entry. */
function incompleteEdges(dir) {
  const lockfile = join(dir, lockfileName);
  if (!existsSync(lockfile)) return [];
  return unresolvedOptionalEdges(JSON.parse(readFileSync(lockfile, "utf8")));
}

/** Longest list of unresolved edges a failure report prints in full. */
const reportedEdges = 5;

/** The `edges` of the lockfile at `path`, as the lines a failure report prints for it. */
function edgeReport(path, edges) {
  return `${path}\n    ${edges.slice(0, reportedEdges).map(describeEdge).join("\n    ")}`;
}

/**
 * A failure report line for every package in `order` whose lockfile leaves an
 * optionalDependencies edge with no entry. Reads the lockfiles on disk and
 * runs no npm.
 */
function incompleteReports(order) {
  const incomplete = [];
  for (const dir of order) {
    const edges = incompleteEdges(dir);
    if (edges.length > 0) incomplete.push(edgeReport(displayPath(dir), edges));
  }
  return incomplete;
}

/** Print what the `incomplete` reports say, and how to answer each edge. */
function printIncomplete(incomplete) {
  console.error(
    `\n${incomplete.length} lockfile(s) leave an optionalDependencies edge with no entry:\n  ` +
      `${incomplete.join("\n  ")}\n` +
      "Regenerating does not add these. Add each missing entry at the key named above, " +
      "taking its version and integrity from the package the edge names."
  );
}

/**
 * Checks every package in `order`, and returns the paths of the ones whose
 * lockfile does not match its package.json and of the ones whose lockfile
 * leaves an optionalDependencies edge with no entry.
 */
function checkAll(order) {
  const snapshotDir = mkdtempSync(join(tmpdir(), snapshotPrefix));
  const snapshots = [];
  const unmatched = [];
  const incomplete = [];
  try {
    for (const [index, dir] of order.entries()) {
      const snapshotPath = join(snapshotDir, `${index}-${lockfileName}`);
      snapshots.push(snapshotPath);
      const path = displayPath(dir);
      process.stdout.write(`  ${path}`);
      const faults = [];
      if (!matchesManifest(dir, snapshotPath)) {
        unmatched.push(path);
        faults.push("does not match its package.json");
      }
      const edges = incompleteEdges(dir);
      if (edges.length > 0) {
        incomplete.push(edgeReport(path, edges));
        faults.push(`leaves ${edges.length} optional dependency edge(s) with no entry`);
      }
      console.log(faults.length === 0 ? "" : ` <- ${faults.join("; ")}`);
    }
  } finally {
    for (const snapshot of snapshots) if (existsSync(snapshot)) unlinkSync(snapshot);
    rmdirSync(snapshotDir);
  }
  return { unmatched, incomplete };
}

/** Passes of regeneration fix mode makes before it gives up on settling. */
const maxRegenerationPasses = 5;

/**
 * Regenerates the lockfile of every package in `order`, in order, until a pass
 * leaves all of them byte-identical. Returns the number of passes that took,
 * or `undefined` when {@link maxRegenerationPasses} passes did not settle.
 */
function regenerateUntilSettled(order) {
  for (let pass = 1; pass <= maxRegenerationPasses; pass++) {
    let changed = false;
    for (const dir of order) {
      const lockfile = join(dir, lockfileName);
      const before = existsSync(lockfile) ? readFileSync(lockfile) : undefined;
      regenerate(dir);
      if (before === undefined || !before.equals(readFileSync(lockfile))) changed = true;
    }
    if (!changed) return pass;
  }
  return undefined;
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
    for (const dir of order) console.log(`  ${displayPath(dir)}`);
    const passes = regenerateUntilSettled(order);
    if (passes === undefined) {
      console.error(
        `\nA lockfile still changed on pass ${maxRegenerationPasses}, so regeneration does not settle here.`
      );
      return 1;
    }
    const incomplete = incompleteReports(order);
    if (incomplete.length > 0) {
      printIncomplete(incomplete);
      return 1;
    }
    console.log(`\nAll lockfiles match their package.json, settled after ${passes} pass(es).`);
    return 0;
  }

  console.log(`Checking ${order.length} lockfile(s), in dependency order:`);
  const { unmatched, incomplete } = checkAll(order);
  if (unmatched.length > 0) {
    console.error(
      `\n${unmatched.length} lockfile(s) do not match their package.json:\n  ${unmatched.join("\n  ")}\n` +
        'Run "npm run lockfiles:sync" from the repository root to bring them up to date.'
    );
  }
  if (incomplete.length > 0) printIncomplete(incomplete);
  if (unmatched.length > 0 || incomplete.length > 0) return 1;
  console.log("\nEvery lockfile matches its package.json and names an entry for every optional dependency.");
  return 0;
}

module.exports = { unresolvedOptionalEdges };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
