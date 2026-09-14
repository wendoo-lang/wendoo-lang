import { readFileSync } from "node:fs";
import { targetSourceManifestPath } from "@wendoo/app-host/tooling";

/**
 * The identity the target app at `appDir` declares in its source manifest.
 * Throws when the manifest is absent or unparsable, and when it declares no
 * non-empty identity.
 *
 * @param appDir Absolute path of the target app directory.
 */
export function readTargetIdentity(appDir: string): string {
  const path = targetSourceManifestPath(appDir);
  const { identity } = JSON.parse(readFileSync(path, "utf8")) as { identity?: unknown };
  if (typeof identity !== "string" || identity.length === 0) {
    throw new Error(`${path} declares no identity.`);
  }
  return identity;
}
