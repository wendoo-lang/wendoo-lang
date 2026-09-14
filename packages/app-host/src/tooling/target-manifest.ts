import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WENDOO_JSON_PATH } from "../wendoo-json.js";

/** Directory of a target app holding its ready-to-publish package. */
export const TARGET_PACKAGE_DIR_NAME = "target-package";

/**
 * Path of the manifest the target app at `appDir` publishes.
 *
 * @param appDir Absolute path of the target app directory.
 */
export function targetManifestPath(appDir: string): string {
  return join(appDir, TARGET_PACKAGE_DIR_NAME, WENDOO_JSON_PATH);
}

/**
 * The version the target app at `appDir` declares in its published manifest,
 * which is the version the next package assembled from it carries. Throws when
 * the manifest is absent or unparsable, and when it declares no non-empty
 * version.
 *
 * @param appDir Absolute path of the target app directory.
 */
export function readTargetPackageVersion(appDir: string): string {
  const path = targetManifestPath(appDir);
  const { version } = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${path} declares no version.`);
  }
  return version;
}
