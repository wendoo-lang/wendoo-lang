import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  readTargetPackageVersion,
  TARGET_PACKAGE_DIR_NAME,
  targetPackageManifestPath,
  targetSourceManifestPath,
} from "@wendoo/app-host/tooling";
import { declaredSurfaceOf, readAdapterArtifact, readBuildStamp } from "@wendoo/assistant-bridge";
import { checkArtifactSelfContained, readTargetIdentity } from "@wendoo/assistant-bridge/kit/node";
import { readTargetAppDeclaration } from "./target-app.js";

const ASSEMBLE_USAGE = `usage: wendoo assemble [--dir <path>]

Assembles the target package of the app in --dir (default: the current
directory) from its source wendoo.json plus the artifacts its build left
behind, replacing the whole ${TARGET_PACKAGE_DIR_NAME}/ directory. The app
declares the artifacts and the scripts that produce them in the "wendooTarget"
object of its package.json.

  --dir <path>     target app directory (default: current directory)
`;

/** Stable identifiers for assemble command failures. */
export const AssembleCommandErrorCode = {
  DECLARATION_UNUSABLE: "ASSEMBLE_DECLARATION_UNUSABLE",
  SOURCE_MANIFEST_MISSING: "ASSEMBLE_SOURCE_MANIFEST_MISSING",
  SOURCE_MANIFEST_UNUSABLE: "ASSEMBLE_SOURCE_MANIFEST_UNUSABLE",
  HOST_APP_MISSING: "ASSEMBLE_HOST_APP_MISSING",
  ADAPTER_MISSING: "ASSEMBLE_ADAPTER_MISSING",
  ADAPTER_NOT_SELF_CONTAINED: "ASSEMBLE_ADAPTER_NOT_SELF_CONTAINED",
  ADAPTER_NONCONFORMING: "ASSEMBLE_ADAPTER_NONCONFORMING",
  ADAPTER_BUILD_STAMP_MISSING: "ASSEMBLE_ADAPTER_BUILD_STAMP_MISSING",
} as const;

/** Union of all {@link AssembleCommandErrorCode} values. */
export type AssembleCommandErrorCode = (typeof AssembleCommandErrorCode)[keyof typeof AssembleCommandErrorCode];

/** Directory inside the package the host-served bundle is copied to. */
const HOST_APP_PATH = "app";

/** Path inside the package the adapter artifact is copied to. */
const ADAPTER_PATH = "rehearsal/adapter.js";

/** Path inside the package the adapter's declarative surface is baked to. */
const DECLARED_SURFACE_PATH = "declared-surface.json";

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

/** Lists every file under `dir` as a forward-slash path relative to `dir`. */
function listFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function parseAssembleArguments(args: readonly string[]): { dir: string } | string {
  let dir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== "--dir") {
      return `unexpected argument "${arg}"`;
    }
    const value = args[i + 1];
    if (value === undefined) {
      return `${arg} requires a value`;
    }
    i++;
    dir = path.resolve(value);
  }
  return { dir };
}

/** Print `message` under `code`, with an optional remedy line, and return the failure exit code. */
function fail(code: AssembleCommandErrorCode, message: string, remedy?: string): number {
  process.stderr.write(`wendoo assemble: ${code}: ${message}\n`);
  if (remedy !== undefined) process.stderr.write(`${remedy}\n`);
  return 1;
}

/**
 * Run `wendoo assemble` with the arguments following the subcommand name:
 * replace the app's target package directory with a package assembled from its
 * source manifest, its built app bundle, and its built rehearsal adapter, baking
 * the adapter's declared surface and stamping the built version. Returns the
 * process exit code.
 */
export async function runAssembleCommand(args: readonly string[]): Promise<number> {
  const parsed = parseAssembleArguments(args);
  if (typeof parsed === "string") {
    process.stderr.write(`wendoo assemble: ${parsed}\n${ASSEMBLE_USAGE}`);
    return 1;
  }
  const appDir = parsed.dir;

  const declared = readTargetAppDeclaration(appDir);
  if (!declared.ok) {
    return fail(AssembleCommandErrorCode.DECLARATION_UNUSABLE, declared.detail);
  }
  const { hostApp, rehearsalAdapter } = declared.declaration;

  const sourceManifestPath = targetSourceManifestPath(appDir);
  if (!existsSync(sourceManifestPath)) {
    return fail(
      AssembleCommandErrorCode.SOURCE_MANIFEST_MISSING,
      `no target source manifest at ${sourceManifestPath}.`
    );
  }
  const manifest = JSON.parse(readFileSync(sourceManifestPath, "utf8")) as TargetManifestDocument;
  let identity: string;
  let version: string;
  try {
    identity = readTargetIdentity(appDir);
    version = readTargetPackageVersion(appDir);
  } catch (cause) {
    return fail(
      AssembleCommandErrorCode.SOURCE_MANIFEST_UNUSABLE,
      cause instanceof Error ? cause.message : String(cause)
    );
  }

  const distDir = path.join(appDir, hostApp.path);
  if (!existsSync(distDir) || readdirSync(distDir).length === 0) {
    return fail(
      AssembleCommandErrorCode.HOST_APP_MISSING,
      `no app build output in ${distDir}.`,
      `Run \`npm run ${hostApp.script}\` to build the app, then assemble again.`
    );
  }
  const artifactPath = path.join(appDir, rehearsalAdapter.path);
  if (!existsSync(artifactPath)) {
    return fail(
      AssembleCommandErrorCode.ADAPTER_MISSING,
      `no adapter artifact at ${artifactPath}.`,
      `Run \`npm run ${rehearsalAdapter.script}\` to build the adapter, then assemble again.`
    );
  }

  const checked = await checkArtifactSelfContained(artifactPath, { targetIdentity: identity });
  if (!checked.ok) {
    return fail(
      AssembleCommandErrorCode.ADAPTER_NOT_SELF_CONTAINED,
      checked.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.code}: ${check.detail}`)
        .join("\n"),
      `Rebuild the adapter with \`npm run ${rehearsalAdapter.script}\`, then assemble again.`
    );
  }

  const packageDir = path.join(appDir, TARGET_PACKAGE_DIR_NAME);
  const bundleDir = path.join(packageDir, HOST_APP_PATH);
  const adapterDir = path.join(packageDir, path.dirname(ADAPTER_PATH));

  mkdirSync(packageDir, { recursive: true });

  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(bundleDir, { recursive: true });
  cpSync(distDir, bundleDir, { recursive: true });

  rmSync(adapterDir, { recursive: true, force: true });
  mkdirSync(adapterDir, { recursive: true });
  const packagedArtifactPath = path.join(packageDir, ADAPTER_PATH);
  cpSync(artifactPath, packagedArtifactPath);

  const packagedModule: unknown = await import(pathToFileURL(packagedArtifactPath).href);
  const packaged = readAdapterArtifact(packagedModule, { targetIdentity: identity });
  if (!packaged.ok) {
    return fail(
      AssembleCommandErrorCode.ADAPTER_NONCONFORMING,
      `the packaged adapter at ${packagedArtifactPath} is not a conforming adapter: ` +
        `${packaged.nonconformance.code}: ${packaged.nonconformance.detail}`,
      `Rebuild the adapter with \`npm run ${rehearsalAdapter.script}\`, then assemble again.`
    );
  }
  const buildStamp = readBuildStamp(packagedModule);
  if (buildStamp === undefined) {
    return fail(
      AssembleCommandErrorCode.ADAPTER_BUILD_STAMP_MISSING,
      `the packaged adapter at ${packagedArtifactPath} publishes no build stamp.`,
      "Build the adapter with a build stamp so the package states the language build it runs under."
    );
  }

  const declaredSurface = declaredSurfaceOf(packaged.adapter, buildStamp);
  writeFileSync(path.join(packageDir, DECLARED_SURFACE_PATH), `${JSON.stringify(declaredSurface, null, 2)}\n`);

  // hostApp.files entries are content-relative: each bundle file is listed at
  // the path the published repository carries it, under the hostApp path.
  const files = listFiles(bundleDir)
    .sort()
    .map((file) => `${HOST_APP_PATH}/${file}`);

  manifest.hostApp = { path: HOST_APP_PATH, files };
  manifest.rehearsalAdapter = { path: ADAPTER_PATH };
  manifest.declaredSurface = { path: DECLARED_SURFACE_PATH };
  manifest.buildVersion = version;
  writeFileSync(targetPackageManifestPath(appDir), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `assembled target package: ${files.length} files under ${TARGET_PACKAGE_DIR_NAME}/${HOST_APP_PATH}/\n`
  );
  for (const check of checked.checks) process.stdout.write(`${check.code}: ${check.detail}\n`);
  process.stdout.write(
    `baked declared surface at ${TARGET_PACKAGE_DIR_NAME}/${DECLARED_SURFACE_PATH}: ` +
      `format ${declaredSurface.formatVersion}, core ${declaredSurface.buildStamp.coreVersion}\n`
  );
  return 0;
}
