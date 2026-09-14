/**
 * Build-time readers of the target package a host app publishes: where its
 * manifest sits and what version it declares.
 *
 * Every module this entry reaches uses Node builtins, so it runs in a build
 * script, a test, or a service -- never in a bundle bound for a browser.
 */

export { readTargetPackageVersion, TARGET_PACKAGE_DIR_NAME, targetManifestPath } from "./target-manifest.js";
