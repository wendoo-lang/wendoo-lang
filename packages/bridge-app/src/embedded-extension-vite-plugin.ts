import type { EmbeddedExtensionKind } from "./embedded-extension-loader.js";
import { buildEmbeddedExtensionFromDir, extensionSourceFiles } from "./embedded-extension-loader.js";
import type { EmbeddedExtension } from "./embedded-extensions.js";

/** One embedded extension a host application registers: its coordinate and the directory holding its `wendoo.json`. */
export interface EmbeddedExtensionRegistration {
  /** Canonical `<owner>/<repo>` coordinate the assembled bundle is keyed under. */
  coordinate: string;
  /** Absolute path to the directory holding the extension's `wendoo.json`. */
  dir: string;
  /**
   * What the extension contributes; defaults to `library`. Register the host's
   * own target as `target`, whose bundle is its manifest alone.
   */
  kind?: EmbeddedExtensionKind;
}

/**
 * The subset of the Vite plugin surface this factory implements, typed
 * structurally so the package needs no dependency on Vite. A Vite build consumes
 * the returned object as an ordinary plugin.
 */
export interface EmbeddedExtensionsVitePlugin {
  name: string;
  resolveId(id: string): string | undefined;
  load(id: string): string | undefined;
}

/** Default specifier a host application imports the assembled bundles from. */
export const EMBEDDED_EXTENSIONS_MODULE_ID = "virtual:wendoo-embedded-extensions";

/**
 * Build a Vite plugin that assembles each registered extension from its own
 * `wendoo.json` `files` list and exposes the bundles as the default export of
 * a virtual module (`virtual:wendoo-embedded-extensions` unless overridden).
 * A host application registers coordinates and directories only; the file list
 * comes from each extension's manifest, so adding a file to an extension needs
 * no change here. Assembly runs through {@link buildEmbeddedExtensionFromDir},
 * the single content-loading path shared with the tests and build gates, and
 * fails the build when a listed file is missing from disk.
 *
 * @param registrations - The extensions the host application offers.
 * @param moduleId - Virtual specifier to expose the bundles under.
 */
export function embeddedExtensionsVitePlugin(
  registrations: readonly EmbeddedExtensionRegistration[],
  moduleId: string = EMBEDDED_EXTENSIONS_MODULE_ID
): EmbeddedExtensionsVitePlugin {
  const resolvedId = `\0${moduleId}`;
  return {
    name: "wendoo-embedded-extensions",
    resolveId(id: string): string | undefined {
      return id === moduleId ? resolvedId : undefined;
    },
    load(this: { addWatchFile?: (path: string) => void }, id: string): string | undefined {
      if (id !== resolvedId) {
        return undefined;
      }
      const bundles: EmbeddedExtension[] = registrations.map(({ coordinate, dir, kind = "library" }) => {
        if (this.addWatchFile) {
          for (const file of extensionSourceFiles(dir, kind)) {
            this.addWatchFile(file);
          }
        }
        return buildEmbeddedExtensionFromDir(dir, coordinate, kind);
      });
      return `export default ${JSON.stringify(bundles)};`;
    },
  };
}
