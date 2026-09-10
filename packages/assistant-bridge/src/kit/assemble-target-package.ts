#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkArtifactSelfContained } from "./conformance.js";
import { readTargetIdentity, targetManifestPath } from "./target-manifest.js";

/**
 * Build output of the target app, copied into the package as the host-served
 * bundle.
 */
const hostAppSource = "dist";

/** Directory inside the package the host-served bundle is copied to. */
const hostAppPath = "app";

/** Built headless adapter artifact of the target app, copied into the package. */
const adapterSource = join("dist-headless", "rehearsal", "adapter.js");

/** Path inside the package the adapter artifact is copied to. */
const adapterPath = "rehearsal/adapter.js";

/** Directory of the app holding the ready-to-publish package. */
const packageDirName = "target-package";

/** What the assembled manifest declares about the app bundle it carries. */
interface HostAppDeclaration {
  readonly path: string;
  readonly files: readonly string[];
}

/** What the assembled manifest declares about the adapter artifact it carries. */
interface RehearsalAdapterDeclaration {
  readonly path: string;
}

/** The manifest fields this assembly reads and rewrites. */
interface TargetManifestDocument extends Record<string, unknown> {
  version?: string;
  identity?: string;
  hostApp?: HostAppDeclaration;
  rehearsalAdapter?: RehearsalAdapterDeclaration;
  buildVersion?: string;
}

/** Print `message` and end the assembly with a nonzero status. */
function fail(message: string, remedy?: string): never {
  console.error(`assemble-target-package: ${message}`);
  if (remedy !== undefined) console.error(remedy);
  process.exit(1);
}

/** Lists every file under `dir` as a forward-slash path relative to `dir`. */
function listFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

const appDir = process.cwd();
const packageDir = join(appDir, packageDirName);
const manifestPath = targetManifestPath(appDir);
const distDir = join(appDir, hostAppSource);
const artifactPath = join(appDir, adapterSource);
const bundleDir = join(packageDir, hostAppPath);
const adapterDir = join(packageDir, dirname(adapterPath));

if (!existsSync(manifestPath)) {
  fail(`no target manifest at ${manifestPath}.`);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TargetManifestDocument;
let identity: string;
try {
  identity = readTargetIdentity(appDir);
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
}
const { version } = manifest;
if (typeof version !== "string" || version.length === 0) {
  fail(`${manifestPath} declares no version.`);
}

if (!existsSync(distDir) || readdirSync(distDir).length === 0) {
  fail(`no app build output in ${distDir}.`, "Run `npm run package`, which builds the app and assembles the package.");
}
if (!existsSync(artifactPath)) {
  fail(
    `no adapter artifact at ${artifactPath}.`,
    "Run `npm run build:headless` to build the adapter, then package again."
  );
}

const selfContained = await checkArtifactSelfContained(artifactPath, { targetIdentity: identity });
if (!selfContained.ok) {
  fail(`${selfContained.code}: ${selfContained.detail}`);
}

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
cpSync(distDir, bundleDir, { recursive: true });

rmSync(adapterDir, { recursive: true, force: true });
mkdirSync(adapterDir, { recursive: true });
cpSync(artifactPath, join(packageDir, adapterPath));

// hostApp.files entries are content-relative: each bundle file is listed at
// the path the published repository carries it, under the hostApp path.
const files = listFiles(bundleDir)
  .sort()
  .map((path) => `${hostAppPath}/${path}`);

manifest.hostApp = { path: hostAppPath, files };
manifest.rehearsalAdapter = { path: adapterPath };
// The version the bundle carries; publish requires it to match the declared version.
manifest.buildVersion = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`assembled target package: ${files.length} files under ${packageDirName}/${hostAppPath}/`);
console.log(`${selfContained.code}: ${selfContained.detail}`);
