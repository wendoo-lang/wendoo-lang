import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const config = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  platform: "browser",
  outfile: "dist/extension.js",
  external: ["vscode"],
  logLevel: "info",
};

/**
 * Owns the watch mode build-cycle log lines. Launch tooling reads the exact
 * phrase "build finished" as the signal that dist/ holds a fresh bundle and
 * the extension host may start, so that phrase is emitted only for a build
 * with no errors; a failed build gets a distinct "build failed" line.
 */
const watchSignalPlugin = {
  name: "watch-signal",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.error(`[watch] build failed with ${result.errors.length} error(s); dist/ was not updated`);
      } else {
        console.error("[watch] build finished, watching for changes...");
      }
    });
  },
};

if (watch) {
  // logLevel "warning" keeps error/warning output but suppresses esbuild's
  // own info-level cycle lines, which report "build finished" even for a
  // failed build; the plugin's lines replace them.
  const ctx = await esbuild.context({ ...config, logLevel: "warning", plugins: [watchSignalPlugin] });
  await ctx.watch();
} else {
  await esbuild.build(config);
}
