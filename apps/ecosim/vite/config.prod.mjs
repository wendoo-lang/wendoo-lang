import commonjs from "@rollup/plugin-commonjs";
import react from "@vitejs/plugin-react";
import { readTargetPackageVersion } from "@wendoo/app-host/tooling";
import { createClientBuild } from "@wendoo/core/tooling";
import path from "path";
import { defineConfig } from "vite";
import { uiPlugin } from "../../../packages/ui/src/vite-plugin.ts";
import { rehearsalDefines } from "../src/rehearsal/source-content.ts";
import { embeddedExtensions } from "./embedded-extensions.mjs";
import { sitemapPlugin } from "./sitemap-plugin.mjs";

const appDir = path.resolve(__dirname, "..");

const phasermsg = () => {
  return {
    name: "phasermsg",
    buildStart() {
      process.stdout.write(`Building for production...\n`);
    },
    buildEnd() {
      process.stdout.write(` Done \n`);
    },
  };
};

export default defineConfig({
  base: "./",
  plugins: [react(), uiPlugin(), sitemapPlugin(), phasermsg(), embeddedExtensions()],
  define: {
    ...rehearsalDefines(),
    CLIENT_BUILD: JSON.stringify(createClientBuild(appDir, readTargetPackageVersion(appDir))),
  },
  resolve: {
    dedupe: ["sonner"],
    alias: {
      "@": path.resolve(appDir, "./src"),
      "@wendoo/assistant-panel": path.resolve(appDir, "../../packages/assistant-panel/src"),
      "@wendoo/docs": path.resolve(appDir, "../../packages/docs/src"),
      "@wendoo/ui": path.resolve(appDir, "../../packages/ui/src"),
      "@wendoo/app-host": path.resolve(appDir, "../../packages/app-host/src"),
      "@wendoo/ts-compiler": path.resolve(appDir, "../../packages/ts-compiler/src"),
      "@wendoo/bridge-protocol": path.resolve(appDir, "../../packages/bridge-protocol/src"),
      "@wendoo/bridge-client": path.resolve(appDir, "../../packages/bridge-client/src"),
      "@wendoo/bridge-app": path.resolve(appDir, "../../packages/bridge-app/src"),
    },
  },
  optimizeDeps: {
    exclude: ["@wendoo/core"],
  },
  ssr: {
    noExternal: ["@wendoo/core"],
  },
  logLevel: "warning",
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(appDir, "index.html"),
      },
      external: [],
      plugins: [
        commonjs({
          include: [/packages\/core/],
        }),
      ],
      output: {
        manualChunks: {
          phaser: ["phaser"],
        },
      },
    },
    minify: "terser",
    terserOptions: {
      compress: {
        passes: 2,
      },
      mangle: true,
      format: {
        comments: false,
      },
    },
  },
});
