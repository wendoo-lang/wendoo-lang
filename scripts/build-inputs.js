#!/usr/bin/env node

// Check or regenerate the dependency input globs of an app's headless build
// step, from the package graph scripts/build-packages.js walks.
//
// Usage:
//   node scripts/build-inputs.js [--fix] [--fix-command <command>] <dir>...
//
// Each named directory is expanded by scripts/repo-packages.js; every package it
// contributes that wraps a `build:headless` script in a wireit block is
// regenerated. An app's own inputs are the entries of that block's `files` that
// name a path inside the app; everything reaching outside it describes the
// package graph and is replaced wholesale.
//
// What a package in the graph contributes:
//
//   - its package.json, so a version or dependency change re-runs the step;
//   - the paths its `wendooBuild` declaration names as outputs, plus those of
//     each variant the graph asks for, when it builds;
//   - its source directory, when it is consumed from sources and builds nothing.
//
// Check mode reports the apps whose declared globs differ from the generated
// ones and changes nothing. Fix mode writes the generated globs into each
// package.json.

const { readFileSync, writeFileSync } = require("node:fs");
const { join, relative, resolve, sep } = require("node:path");

const { buildOrder, neededVariants, readDeclaration, stepsFor } = require("./build-packages.js");
const { discoverPackages } = require("./repo-packages.js");

/** wireit script whose input globs name the package graph. */
const generatedScript = "build:headless";

/** Directory a package with no build declaration is consumed from. */
const sourceDirName = "src";

/** Default text a failure report names when the caller declares no fix command. */
const defaultFixCommand = "node scripts/build-inputs.js --fix";

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/** `to` relative to `from`, written with forward slashes. */
function relativePath(from, to) {
  return relative(from, to).split(sep).join("/");
}

/** Whether `glob` names a path inside the app declaring it. */
function isAppOwned(glob) {
  return !glob.startsWith("../");
}

/**
 * The input globs the packages `appDir` depends on contribute, in dependency
 * order. Throws when a package in the graph has a build script it does not
 * declare.
 *
 * @param {string} appDir - Directory of the app whose step is generated
 * @returns {string[]} Globs relative to `appDir`, each naming a path outside it
 */
function graphGlobs(appDir) {
  const order = buildOrder([appDir], false);
  const needed = neededVariants([...order, appDir]);
  const globs = [];
  for (const dir of order) {
    const path = relativePath(appDir, dir);
    globs.push(`${path}/package.json`);
    const declaration = readDeclaration(dir);
    if (declaration === undefined) {
      globs.push(`${path}/${sourceDirName}/**`);
      continue;
    }
    for (const step of stepsFor(declaration, needed)) {
      for (const output of step.outputs) globs.push(`${path}/${output}/**`);
    }
  }
  return globs;
}

/**
 * The full `files` list the app at `appDir` should declare: the globs it owns,
 * in the order it declares them, followed by the generated graph globs.
 *
 * @param {string} appDir - Directory of the app whose step is generated
 * @param {readonly string[]} declared - The `files` the app declares today
 */
function generatedFiles(appDir, declared) {
  return [...declared.filter(isAppOwned), ...graphGlobs(appDir)];
}

/**
 * Every package in the graph of `appDir` that no glob in `globs` covers, as
 * paths relative to `appDir`. A package is covered when some glob starts with
 * its directory.
 *
 * @param {string} appDir - Directory of the app whose step is generated
 * @param {readonly string[]} globs - Declared input globs, relative to `appDir`
 * @returns {string[]} Relative paths of the uncovered packages, in dependency order
 */
function uncoveredPackages(appDir, globs) {
  const uncovered = [];
  for (const dir of buildOrder([appDir], false)) {
    const path = relativePath(appDir, dir);
    if (!globs.some((glob) => glob.startsWith(`${path}/`))) uncovered.push(path);
  }
  return uncovered;
}

/** The `files` of the generated wireit step of the package at `dir`, or `undefined` when it declares none. */
function declaredFiles(dir) {
  const files = readPackage(dir).wireit?.[generatedScript]?.files;
  return Array.isArray(files) ? files : undefined;
}

/** Write `files` as the generated step's inputs in the package.json of `dir`. */
function writeDeclaredFiles(dir, files) {
  const manifestPath = join(dir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.wireit[generatedScript].files = files;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Path of `dir` as the caller would name it. */
function displayPath(dir) {
  return relative(process.cwd(), dir) || ".";
}

/** The lines a failure report prints for the app at `dir`, given its declared and generated globs. */
function driftReport(dir, declared, generated) {
  const removed = declared.filter((glob) => !generated.includes(glob)).map((glob) => `      - ${glob}`);
  const added = generated.filter((glob) => !declared.includes(glob)).map((glob) => `      + ${glob}`);
  return [`  ${displayPath(dir)}`, ...removed, ...added].join("\n");
}

function main(argv) {
  let fix = false;
  let fixCommand = defaultFixCommand;
  const named = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fix") {
      fix = true;
    } else if (arg === "--fix-command") {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error("--fix-command requires a value.");
        return 1;
      }
      i++;
      fixCommand = value;
    } else {
      named.push(resolve(process.cwd(), arg));
    }
  }
  if (named.length === 0) {
    console.error("Usage: node scripts/build-inputs.js [--fix] [--fix-command <command>] <dir>...");
    return 1;
  }

  const apps = discoverPackages(named).filter((dir) => declaredFiles(dir) !== undefined);
  if (apps.length === 0) {
    console.error(`None of the named directories holds a package wrapping "${generatedScript}" in a wireit block.`);
    return 1;
  }

  console.log(`${fix ? "Regenerating" : "Checking"} the ${generatedScript} inputs of ${apps.length} package(s):`);
  const drifted = [];
  for (const dir of apps) {
    const declared = declaredFiles(dir);
    const generated = generatedFiles(dir, declared);
    const matches = declared.length === generated.length && declared.every((glob, at) => glob === generated[at]);
    console.log(`  ${displayPath(dir)}${matches ? "" : " <- differs from the package graph"}`);
    if (matches) continue;
    if (fix) writeDeclaredFiles(dir, generated);
    else drifted.push(driftReport(dir, declared, generated));
  }

  if (drifted.length > 0) {
    console.error(
      `\n${drifted.length} package(s) declare inputs the package graph does not produce:\n${drifted.join("\n")}\n` +
        `Run "${fixCommand}" to bring them up to date.`
    );
    return 1;
  }
  console.log(`\nEvery ${generatedScript} step declares the inputs its package graph produces.`);
  return 0;
}

module.exports = { declaredFiles, generatedFiles, graphGlobs, uncoveredPackages };

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
