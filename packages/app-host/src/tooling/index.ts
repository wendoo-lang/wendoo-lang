/**
 * Build-time readers of the two manifests a target app keeps: the source
 * manifest it authors, and the manifest assembled into the package it
 * publishes.
 *
 * Every module this entry reaches uses Node builtins, so it runs in a build
 * script, a test, or a service -- never in a bundle bound for a browser.
 */

export {
  checkPackagedVersionMatchesSource,
  PackagedVersionCheckCode,
  type PackagedVersionCheckResult,
  readTargetPackageVersion,
  TARGET_PACKAGE_DIR_NAME,
  targetPackageManifestPath,
  targetSourceManifestPath,
} from "./target-manifest.js";
