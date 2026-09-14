import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClientBuild, CoreBuild } from "../build-identity.js";

/** Name of the package whose build decides the semantics a rehearsed brain runs under. */
const languagePackage = "@wendoo/core";

/** Prefix of a dependency specifier naming a package by its location on disk. */
const localSpecifier = "file:";

/** The manifest fields a search through `file:` dependencies reads. */
interface LinkedManifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** Read the manifest of the package at `packageDir`. Throws when it is absent or unparsable. */
function readManifest(packageDir: string): LinkedManifest {
  return JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as LinkedManifest;
}

/**
 * Directory of the package named `packageName` that `packageDir` reaches
 * through `file:` dependencies, runtime and dev alike, transitively;
 * `undefined` when nothing it reaches declares that name. `packageDir` itself
 * is walked but never returned.
 */
function localDependencyDir(packageDir: string, packageName: string): string | undefined {
  const visited = new Set<string>();

  const walk = (dir: string, isRoot: boolean): string | undefined => {
    const resolved = resolve(dir);
    if (visited.has(resolved)) return undefined;
    visited.add(resolved);

    const manifest = readManifest(resolved);
    if (!isRoot && manifest.name === packageName) return resolved;

    for (const specifier of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) {
      if (!specifier.startsWith(localSpecifier)) continue;
      const dependencyDir = resolve(resolved, specifier.slice(localSpecifier.length));
      if (!existsSync(join(dependencyDir, "package.json"))) continue;
      const found = walk(dependencyDir, false);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return walk(packageDir, true);
}

/**
 * Output group of the language package a Node consumer imports and a headless
 * adapter artifact bundles, as a POSIX path relative to that package.
 */
const languageOutput = "dist/node";

/** Suffix of the build output whose content decides those semantics. */
const scriptSuffix = ".js";

/** The one manifest field a language build reads. */
interface VersionedManifest {
  readonly version?: string;
}

/** `path`, a POSIX relative path, as a location under `directory`. */
function locate(directory: string, path: string): string {
  return join(directory, ...path.split("/"));
}

/** Every script under `directory` and below, as POSIX paths relative to it. */
function scriptsUnder(directory: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...scriptsUnder(join(directory, entry.name), path));
    } else if (entry.isFile() && entry.name.endsWith(scriptSuffix)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Hex sha256 over `paths` under `directory`, each path and its bytes in sorted
 * path order. The same content under the same layout hashes the same wherever
 * the directory sits.
 */
function digestOf(directory: string, paths: readonly string[]): string {
  const digest = createHash("sha256");
  for (const path of [...paths].sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(readFileSync(locate(directory, path)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Language builds already read, keyed by the resolved directory that asked for one. */
const readBuilds = new Map<string, CoreBuild>();

/**
 * The language build the package at `packageDir` consumes, read from the
 * `@wendoo/core` it reaches through its `file:` dependencies. This reads build
 * output, so run the package's `build:deps` script first. The first read of a
 * directory walks and hashes; every later read of the same directory in the
 * same process returns that same result.
 *
 * Throws when nothing the package reaches is `@wendoo/core`, and when that
 * package's Node build output is absent or empty.
 *
 * Hand the result to a bundler's `define` for an adapter artifact to republish
 * as its `buildStamp` export.
 *
 * @param packageDir Absolute path of the package whose language build to read.
 */
export function readCoreBuild(packageDir: string): CoreBuild {
  const asked = resolve(packageDir);
  const read = readBuilds.get(asked);
  if (read !== undefined) return read;

  const build = hashCoreBuild(asked);
  readBuilds.set(asked, build);
  return build;
}

/** The language build the package at `packageDir` consumes, walked and hashed afresh. */
function hashCoreBuild(packageDir: string): CoreBuild {
  const coreDir = localDependencyDir(packageDir, languagePackage);
  if (coreDir === undefined) {
    throw new Error(
      `${packageDir} reaches no ${languagePackage} through its file: dependencies, so it states no language build`
    );
  }

  const outputDir = locate(coreDir, languageOutput);
  if (!existsSync(outputDir)) {
    throw new Error(`${coreDir} holds no ${languageOutput}; build ${languagePackage} before reading its build`);
  }
  const scripts = scriptsUnder(outputDir);
  if (scripts.length === 0) {
    throw new Error(`${outputDir} holds no ${scriptSuffix} output; build ${languagePackage} before reading its build`);
  }

  const { version } = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8")) as VersionedManifest;
  if (version === undefined) throw new Error(`${coreDir} declares no version`);

  return { coreVersion: version, coreDistHash: digestOf(outputDir, scripts) };
}

/**
 * What the host app bundle built from `packageDir` states of its own build: the
 * version it is published under, and the language build it bundles. Hand the
 * result to a bundler's `define` so the bundle carries it.
 *
 * Throws for the reasons {@link readCoreBuild} does.
 *
 * @param packageDir Absolute path of the app whose bundle is being built.
 * @param targetPackageVersion Version the bundle states for itself: the one its
 *   target manifest declares for a release build, and core's
 *   `DEV_TARGET_PACKAGE_VERSION` for any other.
 */
export function createClientBuild(packageDir: string, targetPackageVersion: string): ClientBuild {
  return { targetPackageVersion, coreDistHash: readCoreBuild(packageDir).coreDistHash };
}

/** Characters of a dist hash a phrase quotes. */
const quotedHashLength = 12;

/**
 * `build` as one phrase naming the language version and the head of its dist
 * hash, for a diagnostic line a person reads.
 */
export function describeCoreBuild(build: CoreBuild): string {
  return `core ${build.coreVersion} (dist ${build.coreDistHash.slice(0, quotedHashLength)})`;
}
