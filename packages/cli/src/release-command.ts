import { spawnSync } from "node:child_process";
import path from "node:path";
import type { PublishVersionBump } from "@wendoo/app-host";
import {
  checkPackagedVersionMatchesSource,
  PackagedVersionCheckCode,
  TARGET_PACKAGE_DIR_NAME,
} from "@wendoo/app-host/tooling";
import { runPublishCommand } from "./publish-command.js";
import { readTargetAppDeclaration } from "./target-app.js";
import { runVersionCommand } from "./version-command.js";

const RELEASE_USAGE = `usage: wendoo release prepare <patch|minor|major> [--dir <path>]
       wendoo release publish [--dir <path>]

Releases the target app in --dir (default: the current directory) in two stages
the caller runs in order, committing the bumped source manifest to the source
repository between them:

  prepare <bump>   increment the source manifest version, then run the app's
                   declared package script so the package is rebuilt and
                   reassembled at that version
  publish          assert the assembled package carries the source manifest's
                   version, then publish ${TARGET_PACKAGE_DIR_NAME}/ verbatim

  --dir <path>     target app directory (default: current directory)
`;

/** Stable identifiers for release command failures beyond the stages they dispatch to. */
export const ReleaseCommandErrorCode = {
  DECLARATION_UNUSABLE: "RELEASE_DECLARATION_UNUSABLE",
  STEP_FAILED: "RELEASE_STEP_FAILED",
} as const;

/** Union of all {@link ReleaseCommandErrorCode} values. */
export type ReleaseCommandErrorCode = (typeof ReleaseCommandErrorCode)[keyof typeof ReleaseCommandErrorCode];

/**
 * The effects the release stages have outside the project directory. A caller
 * supplies its own to exercise a stage without running a build or reaching a
 * remote; omitted, each stage runs for real.
 */
export interface ReleaseCommandEffects {
  /** Runs the app's npm script `script` in `appDir` and returns its exit status. */
  readonly runAppScript: (appDir: string, script: string) => number;
  /** Publishes the assembled package directory `packageDir` and returns its exit code. */
  readonly publishPackage: (packageDir: string) => Promise<number>;
}

const VERSION_BUMPS: readonly PublishVersionBump[] = ["patch", "minor", "major"];

function isVersionBump(value: string): value is PublishVersionBump {
  return (VERSION_BUMPS as readonly string[]).includes(value);
}

/** Runs `npm run <script>` in `appDir` with inherited stdio and returns its exit status. */
function runAppScript(appDir: string, script: string): number {
  process.stdout.write(`release: npm run ${script}\n`);
  const result = spawnSync("npm", ["run", script], { cwd: appDir, stdio: "inherit" });
  if (result.error !== undefined) {
    process.stderr.write(`release: failed to run "npm run ${script}": ${result.error.message}\n`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

/** The effects each stage has when the command is not given its own. */
const REAL_EFFECTS: ReleaseCommandEffects = {
  runAppScript,
  publishPackage: (packageDir) => runPublishCommand(["--dir", packageDir]),
};

type ReleaseArguments =
  | { readonly stage: "prepare"; readonly bump: PublishVersionBump; readonly dir: string }
  | { readonly stage: "publish"; readonly dir: string };

function parseReleaseArguments(args: readonly string[]): ReleaseArguments | string {
  const stage = args[0];
  if (stage === undefined) return "a stage (prepare or publish) is required";
  if (stage !== "prepare" && stage !== "publish") return `unknown stage "${stage}"`;

  let bump: PublishVersionBump | undefined;
  let dir = process.cwd();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dir") {
      const value = args[i + 1];
      if (value === undefined) return `${arg} requires a value`;
      i++;
      dir = path.resolve(value);
    } else if (stage === "prepare" && isVersionBump(arg) && bump === undefined) {
      bump = arg;
    } else {
      return `unexpected argument "${arg}"`;
    }
  }
  if (stage === "publish") return { stage, dir };
  if (bump === undefined) {
    return "prepare requires a version component (patch, minor, or major)";
  }
  return { stage, bump, dir };
}

/**
 * Bump the source manifest version, then run the app's declared package script
 * so the assembled package is rebuilt at the new version.
 */
async function runPrepareStage(dir: string, bump: PublishVersionBump, effects: ReleaseCommandEffects): Promise<number> {
  const declared = readTargetAppDeclaration(dir);
  if (!declared.ok) {
    process.stderr.write(`wendoo release: ${ReleaseCommandErrorCode.DECLARATION_UNUSABLE}: ${declared.detail}\n`);
    return 1;
  }
  const bumped = await runVersionCommand([bump, "--dir", dir]);
  if (bumped !== 0) return bumped;

  const script = declared.declaration.packageScript;
  const status = effects.runAppScript(dir, script);
  if (status !== 0) {
    process.stderr.write(
      `wendoo release: ${ReleaseCommandErrorCode.STEP_FAILED}: "npm run ${script}" exited with code ${status}.\n`
    );
    return status;
  }
  process.stdout.write(`release: prepared the ${bump} release.\n`);
  return 0;
}

/**
 * Refuse unless the assembled package carries the source manifest's version,
 * then publish the package directory verbatim.
 */
async function runPublishStage(dir: string, effects: ReleaseCommandEffects): Promise<number> {
  const checked = checkPackagedVersionMatchesSource(dir);
  if (!checked.ok) {
    if (checked.code === PackagedVersionCheckCode.PACKAGE_MISSING) {
      process.stderr.write(
        `wendoo release: ${checked.code}: no assembled package declares a version for source version ` +
          `${checked.sourceVersion}.\n`
      );
    } else {
      process.stderr.write(
        `wendoo release: ${checked.code}: the assembled package carries version ${checked.packagedVersion}, ` +
          `but the source manifest declares ${checked.sourceVersion}.\n`
      );
    }
    process.stderr.write("Run `wendoo release prepare <bump>` so the package is assembled at the current version.\n");
    return 1;
  }
  process.stdout.write(`release: the assembled package carries version ${checked.version}.\n`);
  const published = await effects.publishPackage(path.join(dir, TARGET_PACKAGE_DIR_NAME));
  if (published !== 0) return published;
  process.stdout.write("release: publish complete.\n");
  return 0;
}

/**
 * Run `wendoo release` with the arguments following the subcommand name.
 * Returns the process exit code. Pass `effects` to run a stage without
 * building or reaching a remote.
 */
export async function runReleaseCommand(
  args: readonly string[],
  effects: ReleaseCommandEffects = REAL_EFFECTS
): Promise<number> {
  const parsed = parseReleaseArguments(args);
  if (typeof parsed === "string") {
    process.stderr.write(`wendoo release: ${parsed}\n${RELEASE_USAGE}`);
    return 1;
  }
  if (parsed.stage === "prepare") {
    return runPrepareStage(parsed.dir, parsed.bump, effects);
  }
  return runPublishStage(parsed.dir, effects);
}
