export type { EmbeddedExtensionKind } from "./embedded-extension-loader.js";
export {
  buildEmbeddedExtensionFromDir,
  extensionSourceFiles,
  findMissingExtensionFiles,
} from "./embedded-extension-loader.js";
export type {
  EmbeddedExtensionRegistration,
  EmbeddedExtensionsVitePlugin,
} from "./embedded-extension-vite-plugin.js";
export { EMBEDDED_EXTENSIONS_MODULE_ID, embeddedExtensionsVitePlugin } from "./embedded-extension-vite-plugin.js";
