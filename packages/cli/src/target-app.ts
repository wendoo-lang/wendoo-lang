import { readFileSync } from "node:fs";
import path from "node:path";

/** package.json field a target app declares its packaging inputs in. */
const TARGET_APP_FIELD = "wendooTarget";

/** One built artifact a target app hands to the packaging step. */
export interface TargetAppArtifact {
  /** App-relative path the app's build leaves the artifact at. */
  readonly path: string;
  /** Name of the app's npm script that produces it. */
  readonly script: string;
}

/**
 * What a target app declares about the build its package is assembled from:
 * the script that produces a complete package, and the built artifacts the
 * packaging step copies into it.
 */
export interface TargetAppDeclaration {
  /** Name of the app's npm script that builds the app and assembles its package. */
  readonly packageScript: string;
  /** The built app bundle the package serves as its host app; its path names a directory. */
  readonly hostApp: TargetAppArtifact;
  /** The built headless adapter module the package carries; its path names a file. */
  readonly rehearsalAdapter: TargetAppArtifact;
}

/** A read declaration, or the reason the app's package.json does not supply one. */
export type TargetAppDeclarationResult =
  | { readonly ok: true; readonly declaration: TargetAppDeclaration }
  | { readonly ok: false; readonly detail: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readArtifact(value: unknown, field: string): TargetAppArtifact | string {
  if (!isRecord(value)) return `${TARGET_APP_FIELD}.${field} must be an object`;
  if (typeof value.path !== "string" || value.path.length === 0) {
    return `${TARGET_APP_FIELD}.${field}.path must be a non-empty string`;
  }
  if (typeof value.script !== "string" || value.script.length === 0) {
    return `${TARGET_APP_FIELD}.${field}.script must be a non-empty string`;
  }
  return { path: value.path, script: value.script };
}

/**
 * Read the packaging declaration of the target app at `appDir` from its
 * package.json. Returns the reason instead when the file is absent or
 * unparsable, when it declares no `wendooTarget` object, or when that object
 * does not carry a package script and both built artifacts.
 *
 * @param appDir - Absolute path of the target app directory.
 */
export function readTargetAppDeclaration(appDir: string): TargetAppDeclarationResult {
  const manifestPath = path.join(appDir, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (cause) {
    return {
      ok: false,
      detail: `${manifestPath} could not be read: ${cause instanceof Error ? cause.message : cause}`,
    };
  }
  const declared = isRecord(parsed) ? parsed[TARGET_APP_FIELD] : undefined;
  if (!isRecord(declared)) {
    return { ok: false, detail: `${manifestPath} declares no "${TARGET_APP_FIELD}" object` };
  }
  if (typeof declared.packageScript !== "string" || declared.packageScript.length === 0) {
    return { ok: false, detail: `${manifestPath}: ${TARGET_APP_FIELD}.packageScript must be a non-empty string` };
  }
  const hostApp = readArtifact(declared.hostApp, "hostApp");
  if (typeof hostApp === "string") return { ok: false, detail: `${manifestPath}: ${hostApp}` };
  const rehearsalAdapter = readArtifact(declared.rehearsalAdapter, "rehearsalAdapter");
  if (typeof rehearsalAdapter === "string") return { ok: false, detail: `${manifestPath}: ${rehearsalAdapter}` };
  return { ok: true, declaration: { packageScript: declared.packageScript, hostApp, rehearsalAdapter } };
}
