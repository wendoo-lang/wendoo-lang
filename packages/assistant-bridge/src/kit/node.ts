/**
 * The kit's tooling for a target's own build and gate: the conformance checks
 * an adapter and its built artifact must pass, and the readers for a target's
 * declared identity and its shipped tile documentation.
 *
 * Every module this entry reaches uses Node builtins, so it runs in a build
 * script, a test, or a service -- never in a bundle bound for a browser.
 */

export type { AdapterConformanceOptions, ConformanceCheck, ConformanceReport } from "./conformance.js";
export { ConformanceCheckCode, checkAdapterConformance, checkArtifactSelfContained } from "./conformance.js";
export { readTargetIdentity } from "./target-manifest.js";
export { readTileDocContent } from "./tile-doc-files.js";
