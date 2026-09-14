/**
 * Build-time tooling for a package that consumes this one: the reader for the
 * language build it links, and what a consumer bakes or reports from it.
 *
 * Every module this entry reaches uses Node builtins, so it runs in a build
 * script, a test, or a service -- never in a bundle bound for a browser, and
 * never on Roblox.
 */

export { createClientBuild, describeCoreBuild, readCoreBuild } from "./core-build.js";
