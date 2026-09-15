#!/usr/bin/env node

// Discover the packages a repository holds, so a repository-wide sweep can name
// a single directory.
//
// A repository lays its packages out in container directories that are packages
// themselves -- `packages/` and `apps/` hold a package.json of their own and one
// per package beneath. Discovery follows that shape: a directory holding a
// package.json contributes itself and everything its subdirectories contribute.
// A directory that holds no package.json contributes nothing and is not
// descended into.

const { readdirSync, existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

/** Directory of installed dependencies, never a package of the repository. */
const modulesDirName = "node_modules";

function isPackageDir(dir) {
  return existsSync(join(dir, "package.json"));
}

/** Immediate subdirectories of `dir`, excluding installed dependencies and dot directories. */
function subdirectories(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== modulesDirName && !entry.name.startsWith("."))
    .map((entry) => join(dir, entry.name))
    .sort();
}

/**
 * Every package directory `dir` contributes: `dir` itself when it holds a
 * package.json, then everything each of its subdirectories contributes. Returns
 * an empty array for a directory holding no package.json.
 *
 * @param {string} dir - Directory to discover packages under
 * @returns {string[]} Absolute package directories, the named one first
 */
function repoPackages(dir) {
  const root = resolve(dir);
  if (!isPackageDir(root)) return [];
  const found = [root];
  for (const child of subdirectories(root)) found.push(...repoPackages(child));
  return found;
}

/**
 * Every package directory the named `dirs` contribute, deduplicated and in the
 * order first reached.
 *
 * @param {readonly string[]} dirs - Directories to discover packages under
 * @returns {string[]} Absolute package directories
 */
function discoverPackages(dirs) {
  const seen = new Set();
  for (const dir of dirs) for (const found of repoPackages(dir)) seen.add(found);
  return [...seen];
}

module.exports = { discoverPackages, repoPackages };
