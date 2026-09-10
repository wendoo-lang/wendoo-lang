#!/usr/bin/env node

// Build the local package dependencies of an app or package in dependency
// order, or print that order.
//
// Usage:
//   node scripts/build-packages.js <dir>
//   node scripts/build-packages.js --order <dir>...
//
// A local package is a `file:` dependency whose directory holds a package.json.
// Dependency directories are resolved from each `file:` path, so the graph may
// span repositories. Both runtime and dev dependencies are followed.
//
// A local package that produces build output declares how it is built in a
// `wendooBuild` object in its package.json:
//
//   "wendooBuild": {
//     "script": "build:prod",   // npm script the driver runs
//     "outputs": ["dist"],      // paths the script must leave behind
//     "postProcessed": false,   // true when more than a bare tsc emit
//     "variants": {             // output groups built only when asked for
//       "<name>": { "script": "build:<name>", "outputs": ["dist/<name>"] }
//     },
//     "needs": ["<name>"]       // variants this package consumes from the graph
//   }
//
// The default script runs for every package in the graph. A variant runs only
// when some package in the graph -- the one the driver was pointed at, or any
// package it reaches -- names it in `needs`. The driver unions those names,
// then runs the matching variant of every package that declares one. Asking for
// a name no package in the graph declares is an error.
//
// A package with no declaration and no build script is source-only and is
// skipped. A package with a build script but no declaration is an error. A
// package the driver is only pointed at may carry a declaration holding
// `needs` alone.
//
// Before building anything the driver checks that every package in the graph is
// installed as it declares: each `file:` dependency linked into node_modules,
// and every command that dependency declares linked into node_modules/.bin. A
// command whose file the dependency has not built yet cannot be linked while it
// is absent, so that one gap waits for the build and the driver links it after.
//
// Each buildable package wraps its build script in a wireit block declaring
// that script's inputs and outputs. The driver runs every step; wireit skips a
// step whose declared output already reflects its declared inputs. Steps run
// with wireit's local cache disabled, so wireit judges a step in place and
// never restores output from a cache directory.

const { execSync } = require("node:child_process");
const { readdirSync, readFileSync, existsSync, statSync } = require("node:fs");
const { join, resolve, relative } = require("node:path");

/** package.json field a local package declares its build interface in. */
const buildField = "wendooBuild";

/** Prefix of a dependency specifier naming a package by its location on disk. */
const localSpecifier = "file:";

/** Scripts that mean a package produces build output. */
const buildScriptNames = ["build:prod", "build"];

/** Directory a package's installed dependencies are linked into. */
const modulesDirName = "node_modules";

/** Directory under `node_modules` holding the commands of installed dependencies. */
const binDirName = ".bin";

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/**
 * One thing a package builds: the script that builds it and the paths that
 * script must leave behind. Throws when `step` is not that shape.
 *
 * @param {object} pkg - Manifest of the package the step belongs to
 * @param {string} name - Name the package declares for itself
 * @param {string} field - Path of the step within the declaration, for error messages
 * @param {unknown} step - The declared step
 */
function readStep(pkg, name, field, step) {
  const { script, outputs } = step ?? {};
  if (typeof script !== "string" || !pkg.scripts?.[script]) {
    throw new Error(`${name}: ${field}.script must name a script the package defines`);
  }
  if (!Array.isArray(outputs) || outputs.length === 0 || outputs.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name}: ${field}.outputs must be a non-empty array of paths`);
  }
  return { script, outputs };
}

/**
 * The variant names the package at `dir` consumes from the graph it belongs to,
 * or an empty array when it names none. Throws when the declared value is not a
 * list of names.
 */
function readNeeds(dir) {
  const pkg = readPackage(dir);
  const needs = pkg[buildField]?.needs;
  if (needs === undefined) return [];
  if (!Array.isArray(needs) || needs.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${pkg.name ?? dir}: ${buildField}.needs must be an array of variant names`);
  }
  return needs;
}

/**
 * The build declaration of the package at `dir`, or `undefined` when it
 * declares nothing to build and has no build script. Throws when the package
 * has a build script but no declaration, or when its declaration is not usable.
 */
function readDeclaration(dir) {
  const pkg = readPackage(dir);
  const name = pkg.name ?? dir;
  const declared = pkg[buildField];

  if (declared?.script === undefined) {
    const script = buildScriptNames.find((candidate) => pkg.scripts?.[candidate]);
    if (script === undefined) return undefined;
    throw new Error(
      `${name} declares a "${script}" script but no "${buildField}.script" in its package.json; ` +
        "the driver builds only what is declared"
    );
  }

  const { postProcessed, variants = {} } = declared;
  const step = readStep(pkg, name, buildField, declared);
  if (typeof postProcessed !== "boolean") {
    throw new Error(`${name}: ${buildField}.postProcessed must be a boolean`);
  }
  if (typeof variants !== "object" || variants === null || Array.isArray(variants)) {
    throw new Error(`${name}: ${buildField}.variants must be an object keyed by variant name`);
  }
  const byName = {};
  for (const [variant, declaredStep] of Object.entries(variants)) {
    byName[variant] = readStep(pkg, name, `${buildField}.variants.${variant}`, declaredStep);
  }
  return { name, ...step, postProcessed, variants: byName };
}

/**
 * The `file:` dependencies declared by the package at `dir`, each as the name
 * it is installed under and the directory it resolves to.
 */
function localDependencies(dir) {
  const pkg = readPackage(dir);
  const found = [];
  for (const [name, specifier] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (typeof specifier !== "string" || !specifier.startsWith(localSpecifier)) continue;
    const dependencyDir = resolve(dir, specifier.slice(localSpecifier.length));
    if (existsSync(join(dependencyDir, "package.json"))) found.push({ name, dir: dependencyDir });
  }
  return found;
}

/** The commands the package manifest `pkg` declares, each with the file it runs. */
function declaredCommands(pkg) {
  if (typeof pkg.bin === "string") return [[pkg.name.split("/").pop(), pkg.bin]];
  return Object.entries(pkg.bin ?? {});
}

/**
 * Every way the installed state of the package at `dir` differs from what it
 * declares: a `file:` dependency with no link in `node_modules`, or a command
 * such a dependency declares with no link in `node_modules/.bin`. A gap is
 * `pending` when the file the command runs is not there to link yet, which a
 * build of that dependency produces.
 */
function installGaps(dir) {
  const gaps = [];
  for (const dependency of localDependencies(dir)) {
    if (!existsSync(join(dir, modulesDirName, dependency.name))) {
      gaps.push({ detail: `${dependency.name} is not linked into ${modulesDirName}`, pending: false });
      continue;
    }
    for (const [command, file] of declaredCommands(readPackage(dependency.dir))) {
      if (existsSync(join(dir, modulesDirName, binDirName, command))) continue;
      gaps.push({
        detail: `${dependency.name} declares the "${command}" command, which is not linked into ${modulesDirName}/${binDirName}`,
        pending: !existsSync(join(dependency.dir, file)),
      });
    }
  }
  return gaps;
}

/**
 * Throws when any package in `dirs` is missing a link its manifest implies,
 * naming each package, each gap, and the command that installs it. When
 * `allowPending` is true a package whose only gaps are commands no build has
 * produced yet is returned instead of reported; call again with `allowPending`
 * false once those builds have run.
 */
function assertInstalled(dirs, allowPending) {
  const failures = [];
  const pending = [];
  for (const dir of dirs) {
    const gaps = installGaps(dir);
    if (gaps.length === 0) continue;
    if (allowPending && gaps.every((gap) => gap.pending)) {
      pending.push(dir);
      continue;
    }
    const name = readPackage(dir).name ?? dir;
    const where = relative(process.cwd(), dir) || ".";
    failures.push(
      `${name}:\n${gaps.map((gap) => `    ${gap.detail}`).join("\n")}\n    install: npm install --force --prefix ${where}`
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} package(s) are not installed as their package.json declares:\n  ${failures.join("\n  ")}`
    );
  }
  return pending;
}

/**
 * Link the commands this run built into each package in `dirs` that declares a
 * dependency on them. Throws when a gap remains afterwards.
 */
function linkBuiltCommands(dirs) {
  for (const dir of dirs) {
    console.log(`\n> Linking the commands built in this run into ${readPackage(dir).name ?? dir}...`);
    execSync("npm rebuild", { stdio: "inherit", cwd: dir });
  }
  assertInstalled(dirs, false);
}

/**
 * Appends `dir` and everything it depends on to `order`, dependencies first.
 * `includeSelf` is false for a directory the caller named only as a starting
 * point.
 */
function collect(dir, visited, order, includeSelf) {
  const resolved = resolve(dir);
  if (visited.has(resolved)) return;
  visited.add(resolved);
  for (const dependency of localDependencies(resolved)) collect(dependency.dir, visited, order, true);
  if (includeSelf) order.push(resolved);
}

/**
 * The build order of the local dependencies of `dirs`, dependencies first,
 * including `dirs` themselves when `includeSelf` is true.
 */
function buildOrder(dirs, includeSelf) {
  const visited = new Set();
  const order = [];
  for (const dir of dirs) collect(dir, visited, order, includeSelf);
  return order;
}

/** Throws when the outputs `step` declares are absent or empty under `dir`. */
function assertOutputsPresent(dir, name, step) {
  for (const output of step.outputs) {
    const path = join(dir, output);
    const present = existsSync(path) && (!statSync(path).isDirectory() || readdirSync(path).length > 0);
    if (!present) {
      throw new Error(`${name}: "npm run ${step.script}" left no ${output}; run its clean script and build again`);
    }
  }
}

/** The variant names the packages at `dirs` consume, deduplicated and sorted. */
function neededVariants(dirs) {
  const names = new Set();
  for (const dir of dirs) for (const name of readNeeds(dir)) names.add(name);
  return [...names].sort();
}

/**
 * What the driver runs for the package `declaration` describes: its default
 * step, then the step of each name in `needed` it declares a variant for.
 */
function stepsFor(declaration, needed) {
  const steps = [{ script: declaration.script, outputs: declaration.outputs }];
  for (const name of needed) {
    const variant = declaration.variants[name];
    if (variant !== undefined) steps.push(variant);
  }
  return steps;
}

/** Environment the driver runs each build step in. */
const stepEnvironment = { ...process.env, WIREIT_CACHE: "none" };

function main(argv) {
  const orderOnly = argv[0] === "--order";
  const dirs = (orderOnly ? argv.slice(1) : argv).map((dir) => resolve(process.cwd(), dir));
  if (dirs.length === 0 || (!orderOnly && dirs.length > 1)) {
    console.error("Usage: node scripts/build-packages.js [--order] <dir>...");
    return 1;
  }

  const order = buildOrder(dirs, orderOnly);

  if (orderOnly) {
    for (const dir of order) console.log(relative(process.cwd(), dir) || ".");
    return 0;
  }

  const pending = assertInstalled([...order, ...dirs], true);

  const needed = neededVariants([...order, ...dirs]);
  const buildable = order.map((dir) => [dir, readDeclaration(dir)]).filter(([, declaration]) => declaration);
  if (buildable.length === 0) {
    console.log("No local package dependencies to build.");
    return 0;
  }

  const provided = new Set(buildable.flatMap(([, declaration]) => Object.keys(declaration.variants)));
  const unprovided = needed.filter((name) => !provided.has(name));
  if (unprovided.length > 0) {
    throw new Error(
      `no package in the dependency graph declares a "${unprovided.join('", "')}" variant, ` +
        `which is named in ${buildField}.needs`
    );
  }

  console.log(`Bringing ${buildable.length} package(s) up to date, in dependency order:`);
  for (const [, declaration] of buildable) console.log(`  ${declaration.name}`);
  if (needed.length > 0) console.log(`Variants requested: ${needed.join(", ")}`);

  for (const [dir, declaration] of buildable) {
    for (const step of stepsFor(declaration, needed)) {
      console.log(`\n> Bringing ${declaration.name} up to date (npm run ${step.script})...`);
      execSync(`npm run ${step.script}`, { stdio: "inherit", cwd: dir, env: stepEnvironment });
      assertOutputsPresent(dir, declaration.name, step);
    }
  }

  if (pending.length > 0) linkBuiltCommands(pending);

  console.log("\nAll packages are up to date.");
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
