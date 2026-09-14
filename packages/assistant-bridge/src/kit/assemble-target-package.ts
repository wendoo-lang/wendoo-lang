#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readTargetPackageVersion,
  TARGET_PACKAGE_DIR_NAME,
  targetPackageManifestPath,
  targetSourceManifestPath,
} from "@wendoo/app-host/tooling";
import { readAdapterArtifact, readBuildStamp } from "../target/adapter.js";
import { declaredSurfaceOf } from "../target/declared-surface.js";
import { checkArtifactSelfContained } from "./conformance.js";
import { readTargetIdentity } from "./target-manifest.js";

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

/** Path inside the package the adapter's declarative surface is baked to. */
const declaredSurfacePath = "declared-surface.json";

/** What the assembled manifest declares about the app bundle it carries. */
interface HostAppDeclaration {
  readonly path: string;
  readonly files: readonly string[];
}

/** What the assembled manifest declares about a single file it carries. */
interface FileDeclaration {
  readonly path: string;
}

/** The manifest fields this assembly carries through from the source manifest and writes. */
interface TargetManifestDocument extends Record<string, unknown> {
  version?: string;
  identity?: string;
  hostApp?: HostAppDeclaration;
  rehearsalAdapter?: FileDeclaration;
  declaredSurface?: FileDeclaration;
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
const packageDir = join(appDir, TARGET_PACKAGE_DIR_NAME);
const sourceManifestPath = targetSourceManifestPath(appDir);
const packageManifestPath = targetPackageManifestPath(appDir);
const distDir = join(appDir, hostAppSource);
const artifactPath = join(appDir, adapterSource);
const bundleDir = join(packageDir, hostAppPath);
const adapterDir = join(packageDir, dirname(adapterPath));

if (!existsSync(sourceManifestPath)) {
  fail(`no target source manifest at ${sourceManifestPath}.`);
}
const manifest = JSON.parse(readFileSync(sourceManifestPath, "utf8")) as TargetManifestDocument;
let identity: string;
let version: string;
try {
  identity = readTargetIdentity(appDir);
  version = readTargetPackageVersion(appDir);
} catch (cause) {
  fail(cause instanceof Error ? cause.message : String(cause));
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

const checked = await checkArtifactSelfContained(artifactPath, { targetIdentity: identity });
if (!checked.ok) {
  fail(
    checked.checks
      .filter((check) => !check.ok)
      .map((check) => `${check.code}: ${check.detail}`)
      .join("\n"),
    "Rebuild the adapter with `npm run build:headless`, then package again."
  );
}

mkdirSync(packageDir, { recursive: true });

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
cpSync(distDir, bundleDir, { recursive: true });

rmSync(adapterDir, { recursive: true, force: true });
mkdirSync(adapterDir, { recursive: true });
const packagedArtifactPath = join(packageDir, adapterPath);
cpSync(artifactPath, packagedArtifactPath);

const packagedModule: unknown = await import(pathToFileURL(packagedArtifactPath).href);
const packaged = readAdapterArtifact(packagedModule, { targetIdentity: identity });
if (!packaged.ok) {
  fail(
    `the packaged adapter at ${packagedArtifactPath} is not a conforming adapter: ` +
      `${packaged.nonconformance.code}: ${packaged.nonconformance.detail}`,
    "Rebuild the adapter with `npm run build:headless`, then package again."
  );
}
const buildStamp = readBuildStamp(packagedModule);
if (buildStamp === undefined) {
  fail(
    `the packaged adapter at ${packagedArtifactPath} publishes no build stamp.`,
    "Build the adapter with a build stamp so the package states the language build it runs under."
  );
}

const declaredSurface = declaredSurfaceOf(packaged.adapter, buildStamp);
writeFileSync(join(packageDir, declaredSurfacePath), `${JSON.stringify(declaredSurface, null, 2)}\n`);

// hostApp.files entries are content-relative: each bundle file is listed at
// the path the published repository carries it, under the hostApp path.
const files = listFiles(bundleDir)
  .sort()
  .map((path) => `${hostAppPath}/${path}`);

manifest.hostApp = { path: hostAppPath, files };
manifest.rehearsalAdapter = { path: adapterPath };
manifest.declaredSurface = { path: declaredSurfacePath };
// The version the bundle carries; publish requires it to match the declared version.
manifest.buildVersion = version;
writeFileSync(packageManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`assembled target package: ${files.length} files under ${TARGET_PACKAGE_DIR_NAME}/${hostAppPath}/`);
for (const check of checked.checks) console.log(`${check.code}: ${check.detail}`);
console.log(
  `baked declared surface at ${TARGET_PACKAGE_DIR_NAME}/${declaredSurfacePath}: ` +
    `format ${declaredSurface.formatVersion}, core ${declaredSurface.buildStamp.coreVersion}`
);
