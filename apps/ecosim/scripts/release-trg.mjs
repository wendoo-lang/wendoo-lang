#!/usr/bin/env node
/**
 * The release steps for the ecosim target package, in two stages the caller
 * runs in order, committing the bumped source manifest to the source repository
 * between them:
 *
 *   npm run release-trg -- prepare <patch|minor|major>
 *     1. wendoo version <bump> --dir .       (bump the source manifest)
 *     2. npm run package                     (rebuild dist + assemble the package)
 *   npm run release-trg -- publish
 *     3. assert the assembled package carries the source manifest's version
 *     4. wendoo publish --dir target-package (ship it verbatim)
 *
 * Each step runs from the app directory. A nonzero exit from any step aborts
 * the rest and becomes this script's exit code. The `wendoo` binary resolves
 * from the app's node_modules/.bin, provided by the wendoo file: devDependency.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackagedVersionMatchesSource, PackagedVersionCheckCode } from "@wendoo/app-host/tooling";

const VERSION_BUMPS = ["patch", "minor", "major"];
const USAGE = [
  "usage: npm run release-trg -- prepare <patch|minor|major>",
  "       npm run release-trg -- publish",
].join("\n");

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestDir = ".";
const targetPackageDir = "target-package";
const wendooBin = join(appDir, "node_modules", ".bin", "wendoo");

/**
 * Runs one release step from the app directory with inherited stdio. Exits this
 * process with a nonzero code when the step cannot be launched or exits nonzero,
 * so a failed step aborts the ones that follow.
 */
function runStep(command, args) {
  const printable = [command, ...args].join(" ");
  console.log(`release: ${printable}`);
  const result = spawnSync(command, args, { cwd: appDir, stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(`release: failed to run "${printable}": ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`release: "${printable}" exited with code ${result.status}.`);
    process.exit(result.status === null ? 1 : result.status);
  }
}

/**
 * Ends the process when the assembled package does not carry the version the
 * source manifest declares, which means the package was never assembled or was
 * assembled before the current version was set.
 */
function assertPackageIsCurrent() {
  const checked = checkPackagedVersionMatchesSource(appDir);
  if (checked.ok) {
    console.log(`release: the assembled package carries version ${checked.version}.`);
    return;
  }
  if (checked.code === PackagedVersionCheckCode.PACKAGE_MISSING) {
    console.error(
      `release: ${checked.code}: no assembled package declares a version for source version ${checked.sourceVersion}.`
    );
  } else {
    console.error(
      `release: ${checked.code}: the assembled package carries version ${checked.packagedVersion}, ` +
        `but the source manifest declares ${checked.sourceVersion}.`
    );
  }
  console.error("Run `npm run release-trg -- prepare <bump>` so the package is assembled at the current version.");
  process.exit(1);
}

/** Prints `message` followed by the usage, and exits with a nonzero code. */
function usageError(message) {
  console.error(`release: ${message}`);
  console.error(USAGE);
  process.exit(1);
}

const stage = process.argv[2];
const stageArgument = process.argv[3];

if (stage === "prepare") {
  if (stageArgument === undefined) {
    usageError("prepare requires a version component (patch, minor, or major).");
  }
  if (!VERSION_BUMPS.includes(stageArgument)) {
    usageError(`unknown version component "${stageArgument}".`);
  }
  runStep(wendooBin, ["version", stageArgument, "--dir", sourceManifestDir]);
  runStep("npm", ["run", "package"]);
  console.log(`release: prepared the ${stageArgument} release.`);
} else if (stage === "publish") {
  if (stageArgument !== undefined) {
    usageError(`unexpected argument "${stageArgument}".`);
  }
  assertPackageIsCurrent();
  runStep(wendooBin, ["publish", "--dir", targetPackageDir]);
  console.log("release: publish complete.");
} else if (stage === undefined) {
  usageError("a stage (prepare or publish) is required.");
} else {
  usageError(`unknown stage "${stage}".`);
}
