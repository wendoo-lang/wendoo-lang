/**
 * Headless stand-in for the Vite-provided `virtual:wendoo-embedded-extensions`
 * module: an empty embedded-extension bundle. Specs map the specifier here
 * through a `node:module` resolve hook. Use it only in specs that build their
 * own host and never read the app-bundled embed record.
 */
export default [];
