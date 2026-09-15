import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAssembleCommand } from "./assemble-command.js";
import { isLocalBuild } from "./local-redirect.js";
import { runPublishCommand } from "./publish-command.js";
import { runReleaseCommand } from "./release-command.js";
import { runUnpackCommand } from "./unpack-command.js";
import { runVersionCommand } from "./version-command.js";

const CLI_USAGE = `usage: wendoo <command> [arguments]

commands:
  publish   publish a version of a Wendoo project to GitHub
  version   increment a Wendoo project's version in its wendoo.json
  unpack    convert a .wendoo export into a publishable project directory
  assemble  assemble a target app's publishable package from its build
  release   prepare and publish a target app's package

options:
  -v, --version   print the wendoo version
`;

/** Location of the CLI's own package.json, resolved relative to this module. */
const OWN_PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);
/** Location of the running build's entry point, resolved relative to this module. */
const OWN_MAIN_URL = new URL("main.js", import.meta.url);

/**
 * Read the `version` field from the package.json at `packageJsonPath`.
 *
 * @param packageJsonPath - Filesystem path to a package.json file.
 * @returns The declared version string, or `0.0.0` when it is absent or not a string.
 */
export function readCliVersion(packageJsonPath: string): string {
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : "0.0.0";
}

/**
 * Format the `--version` line for a build. Appends ` (local)` when the build at
 * `runningMainPath` is a working copy.
 *
 * @param version - The package version string to display.
 * @param runningMainPath - Path to the running build's entry point.
 * @returns The version, with a ` (local)` suffix for a working-copy build.
 */
export function formatCliVersion(version: string, runningMainPath: string): string {
  return isLocalBuild(runningMainPath) ? `${version} (local)` : version;
}

/**
 * Run the `wendoo` command line with `argv` (the arguments after the
 * program name). Returns the process exit code.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  if (argv.includes("--version") || argv.includes("-v")) {
    const version = readCliVersion(fileURLToPath(OWN_PACKAGE_JSON_URL));
    process.stdout.write(`${formatCliVersion(version, fileURLToPath(OWN_MAIN_URL))}\n`);
    return 0;
  }

  const [command, ...rest] = argv;
  if (command === "publish") {
    return runPublishCommand(rest);
  }
  if (command === "version") {
    return runVersionCommand(rest);
  }
  if (command === "unpack") {
    return runUnpackCommand(rest);
  }
  if (command === "assemble") {
    return runAssembleCommand(rest);
  }
  if (command === "release") {
    return runReleaseCommand(rest);
  }
  process.stderr.write(command === undefined ? CLI_USAGE : `wendoo: unknown command "${command}"\n${CLI_USAGE}`);
  return 1;
}
