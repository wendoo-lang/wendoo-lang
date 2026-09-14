import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WENDOO_JSON_PATH } from "../wendoo-json.js";

/** Directory of a target app holding its ready-to-publish package. */
export const TARGET_PACKAGE_DIR_NAME = "target-package";

/**
 * Path of the manifest a target app authors, declaring its identity, metadata,
 * and version.
 *
 * @param appDir Absolute path of the target app directory.
 */
export function targetSourceManifestPath(appDir: string): string {
  return join(appDir, WENDOO_JSON_PATH);
}

/**
 * Path of the manifest the target app at `appDir` publishes, assembled into its
 * package directory from the source manifest plus the build.
 *
 * @param appDir Absolute path of the target app directory.
 */
export function targetPackageManifestPath(appDir: string): string {
  return join(appDir, TARGET_PACKAGE_DIR_NAME, WENDOO_JSON_PATH);
}

/**
 * Read the `version` a manifest declares. Throws when the file is absent or
 * unparsable, and when it declares no non-empty version.
 */
function readDeclaredVersion(path: string): string {
  const { version } = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${path} declares no version.`);
  }
  return version;
}

/**
 * The version the target app at `appDir` declares in its source manifest, which
 * is the version the next package assembled from it carries. Throws when the
 * source manifest is absent or unparsable, and when it declares no non-empty
 * version.
 *
 * @param appDir Absolute path of the target app directory.
 */
export function readTargetPackageVersion(appDir: string): string {
  return readDeclaredVersion(targetSourceManifestPath(appDir));
}

/** Stable identifiers for {@link checkPackagedVersionMatchesSource} refusals. */
export const PackagedVersionCheckCode = {
  PACKAGE_MISSING: "PACKAGED_VERSION_PACKAGE_MISSING",
  VERSION_STALE: "PACKAGED_VERSION_STALE",
} as const;

/** Union of all {@link PackagedVersionCheckCode} values. */
export type PackagedVersionCheckCode = (typeof PackagedVersionCheckCode)[keyof typeof PackagedVersionCheckCode];

/** Outcome of comparing an assembled package against the source manifest it was assembled from. */
export type PackagedVersionCheckResult =
  | {
      /** True when the assembled package carries the source manifest's version. */
      readonly ok: true;
      /** The version both manifests declare. */
      readonly version: string;
    }
  | {
      /** False when no package is assembled, or it carries an older version. */
      readonly ok: false;
      /** Stable machine-readable refusal code. */
      readonly code: PackagedVersionCheckCode;
      /** Version the source manifest declares. */
      readonly sourceVersion: string;
      /** Version the assembled package declares, absent when no package is assembled. */
      readonly packagedVersion?: string;
    };

/**
 * Compare the version the target app at `appDir` declares in its source
 * manifest against the version its assembled package carries. Returns `ok` when
 * they match, and a refusal carrying a {@link PackagedVersionCheckCode}
 * otherwise. Throws when the source manifest is absent or unparsable, and when
 * either manifest declares no non-empty version.
 *
 * @param appDir Absolute path of the target app directory.
 */
export function checkPackagedVersionMatchesSource(appDir: string): PackagedVersionCheckResult {
  const sourceVersion = readTargetPackageVersion(appDir);
  const packagePath = targetPackageManifestPath(appDir);
  let packagedVersion: string;
  try {
    packagedVersion = readDeclaredVersion(packagePath);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, code: PackagedVersionCheckCode.PACKAGE_MISSING, sourceVersion };
    }
    throw cause;
  }
  if (packagedVersion !== sourceVersion) {
    return { ok: false, code: PackagedVersionCheckCode.VERSION_STALE, sourceVersion, packagedVersion };
  }
  return { ok: true, version: sourceVersion };
}
