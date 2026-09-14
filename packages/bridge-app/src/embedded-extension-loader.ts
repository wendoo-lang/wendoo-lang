import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { parseProjectContentManifest, WENDOO_JSON_PATH } from "@wendoo/app-host";
import type { EmbeddedExtension, EmbeddedExtensionFile } from "./embedded-extensions.js";
import { findMissingListedFiles } from "./manifest-files.js";

/**
 * Map a manifest `files` entry to the extension-relative path it occupies in the
 * assembled bundle. An entry that stays within the extension directory keeps its
 * directory-relative path; an entry the manifest pulls in from outside that
 * directory (a generated artifact reached through `..`) is placed at the
 * extension root under its base name.
 */
function bundlePathFor(dir: string, entry: string): string {
  const rel = relative(dir, resolve(dir, entry));
  return rel.startsWith("..") ? basename(entry) : rel.split(sep).join("/");
}

/**
 * What an embedded extension contributes, which decides whether its manifest
 * must name content files.
 *
 * - `library`: source content a consumer compiles against. Its manifest must
 *   declare a `files` list naming that content, or a `hostApp` bundle.
 * - `target`: a runnable platform, contributing identity and compatibility
 *   metadata only. Its bundle is its manifest alone, so it needs neither.
 */
export type EmbeddedExtensionKind = "library" | "target";

/**
 * Read and parse the `files` list an extension declares in its own
 * `wendoo.json`. A library must declare content `files` or a `hostApp` bundle;
 * a `target` extension, and any manifest declaring a `hostApp`, carries no
 * library content and resolves to an empty file list. A library manifest
 * declaring neither is rejected.
 */
function readManifestFiles(
  dir: string,
  kind: EmbeddedExtensionKind
): { manifestText: string; files: readonly string[] } {
  const manifestPath = resolve(dir, WENDOO_JSON_PATH);
  if (!existsSync(manifestPath)) {
    throw new Error(`Embedded extension at ${dir} has no ${WENDOO_JSON_PATH}.`);
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  const parsed = parseProjectContentManifest(manifestText);
  if (!parsed.ok) {
    throw new Error(
      `Embedded extension manifest at ${manifestPath} is invalid: ` +
        parsed.errors.map((e) => `${e.path} ${e.message}`).join("; ")
    );
  }
  if (parsed.manifest.files === undefined) {
    if (kind === "target" || parsed.manifest.hostApp !== undefined) {
      return { manifestText, files: [] };
    }
    throw new Error(
      `Embedded extension manifest at ${manifestPath} must declare a "files" list naming its content, or a "hostApp" bundle.`
    );
  }
  return { manifestText, files: parsed.manifest.files };
}

/**
 * Return the declared `files` entries an extension names but that do not exist on
 * disk, resolved relative to the extension's manifest directory. An empty result
 * means every listed file is present. Files present on disk but absent from the
 * list are valid content exclusions and are never reported: this checks only the
 * error direction, a listed file the build cannot assemble.
 *
 * @param dir - Directory holding the extension's `wendoo.json`.
 * @param kind - What the extension contributes; a `target` names no content files.
 */
export function findMissingExtensionFiles(dir: string, kind: EmbeddedExtensionKind = "library"): readonly string[] {
  const { files } = readManifestFiles(dir, kind);
  return findMissingListedFiles(files, (entry) => existsSync(resolve(dir, entry)));
}

/**
 * Absolute paths of every on-disk file that backs an embedded extension: its
 * `wendoo.json` plus each file its `files` list names. A build-time provider
 * watches these so editing extension source refreshes the assembled bundle.
 *
 * @param dir - Directory holding the extension's `wendoo.json`.
 * @param kind - What the extension contributes; a `target` names no content files.
 */
export function extensionSourceFiles(dir: string, kind: EmbeddedExtensionKind = "library"): readonly string[] {
  const { files } = readManifestFiles(dir, kind);
  return [resolve(dir, WENDOO_JSON_PATH), ...files.map((entry) => resolve(dir, entry))];
}

/**
 * Assemble an embedded extension by reading its `wendoo.json` from `dir`,
 * loading exactly the files its `files` list names, and returning the bundle
 * keyed by `canonicalOrigin`. The manifest is included at the extension root as
 * `wendoo.json` and is never listed by `files`. Each listed entry is resolved
 * relative to `dir` and bundled at its extension-relative path.
 *
 * @param dir - Directory holding the extension's `wendoo.json`.
 * @param canonicalOrigin - The `<owner>/<repo>` coordinate the bundle is keyed under.
 * @param kind - What the extension contributes; a `target` names no content files.
 * @throws {Error} when the manifest is missing, invalid, is a library declaring
 *   neither `files` nor a `hostApp` bundle, or names a file absent from disk.
 */
export function buildEmbeddedExtensionFromDir(
  dir: string,
  canonicalOrigin: string,
  kind: EmbeddedExtensionKind = "library"
): EmbeddedExtension {
  const { manifestText, files: declared } = readManifestFiles(dir, kind);

  const missing = findMissingExtensionFiles(dir, kind);
  if (missing.length > 0) {
    throw new Error(
      `Embedded extension "${canonicalOrigin}" at ${dir} declares files absent from disk: ${missing.join(", ")}.`
    );
  }

  const files: EmbeddedExtensionFile[] = declared.map((entry) => ({
    path: bundlePathFor(dir, entry),
    content: readFileSync(resolve(dir, entry), "utf8"),
  }));
  files.push({ path: WENDOO_JSON_PATH, content: manifestText });

  return { canonicalOrigin, files };
}
