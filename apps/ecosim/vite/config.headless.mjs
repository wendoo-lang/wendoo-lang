import { readCoreBuild } from "@wendoo/core/tooling";
import path from "path";
import { defineConfig } from "vite";
import { rehearsalDefines } from "../src/rehearsal/source-content.ts";

const appDir = path.resolve(__dirname, "..");

// Build output of packages linked into the app from this repository, which sits
// outside node_modules.
const linkedPackages = /[\\/]dist[\\/]node[\\/]/;

// Builds the headless target adapter: one self-contained,
// plain-Node-importable ES module that runs the world without a renderer.
// Everything it needs is inside it, so it loads and rehearses from wherever it
// is copied to.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(appDir, "./src"),
      "@wendoo/docs": path.resolve(appDir, "../../packages/docs/src"),
      "@wendoo/ui": path.resolve(appDir, "../../packages/ui/src"),
    },
  },
  ssr: {
    noExternal: true,
  },
  define: { ...rehearsalDefines(), BUILD_STAMP: JSON.stringify(readCoreBuild(appDir)) },
  publicDir: false,
  logLevel: "warn",
  build: {
    ssr: path.resolve(appDir, "src/rehearsal/adapter.ts"),
    outDir: "dist-headless",
    emptyOutDir: true,
    minify: false,
    commonjsOptions: {
      include: [/node_modules/, linkedPackages],
    },
    rollupOptions: {
      output: {
        format: "es",
        entryFileNames: "rehearsal/adapter.js",
      },
    },
  },
});
