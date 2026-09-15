import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  DependencyPinProbe,
  ExtensionPublishBackend,
  ExtensionPublishResult,
  ExtensionPublishSource,
  PublishFile,
  PublishVersionBump,
} from "@wendoo/app-host";
import {
  createJsDelivrExtensionTransport,
  deriveCoordinateFromRemoteUrl,
  ExtensionPublishErrorCode,
  githubRemoteUrlForCoordinate,
  parseProjectContentManifest,
  publishExtensionVersion,
  serializeProjectContentManifest,
  WENDOO_JSON_PATH,
} from "@wendoo/app-host";
import { GitCommandError, git, tryGit } from "./git.js";

const PUBLISH_USAGE = `usage: wendoo publish [patch|minor|major] [--dir <path>] [--remote <url>] [--allow-unstable-refs]
       wendoo publish --print-remote [--dir <path>] [--remote <url>]

Publishes a version of the Wendoo project in --dir (default: the current
directory). Run from inside an already-published project's folder, no flags are
needed: the current directory supplies --dir, and the project's git checkout
supplies the remote. With a version bump, the manifest version is incremented;
without one, the manifest's current version is published as-is, which is valid
only as a first publish to a repository that has no tags. Every publish stamps
the published manifest's identity field with the <owner>/<repo> coordinate of
the publish remote; a warning is printed when the stamp changes a previously
recorded identity.

Without --remote, the publish target depends on where the project sits in its
git checkout. A standalone project, whose directory is the repository root of
its checkout, publishes to the checkout's origin: it is committed, tagged
v<version>, and the branch and tag are pushed to origin. A project kept in a
subdirectory of its checkout (for example inside a monorepo), or one whose
checkout has no origin, publishes to the GitHub remote derived from the
manifest's recorded identity, https://github.com/<owner>/<repo>.git. A first
publish, whose manifest records no identity yet, targets origin.

With --remote, or when the remote is derived from the identity, the project's
published tree (wendoo.json plus its manifest-listed files) is committed to
that remote's default branch and tagged v<version>, and the published version
and identity are written back to the project directory's wendoo.json.

  --dir <path>     project directory (default: current directory)
  --remote <url>   git remote to publish the project tree to; without it a
                   standalone checkout publishes to its origin, and a
                   subdirectory project publishes to the GitHub remote derived
                   from the recorded identity
  --allow-unstable-refs
                   allow dependencies that are unstable for consumers: a
                   branch reference, or a pinned version the fetch source
                   does not yet serve
  --print-remote   print the git remote this publish would record the version
                   on, and exit without publishing
`;

/** Stable identifiers for publish command failures beyond the engine's refusals. */
export const PublishCommandErrorCode = {
  WRITE_BACK_FAILED: "PUBLISH_WRITE_BACK_FAILED",
  REMOTE_UNRESOLVED: "PUBLISH_REMOTE_UNRESOLVED",
} as const;

/** Union of all {@link PublishCommandErrorCode} values. */
export type PublishCommandErrorCode = (typeof PublishCommandErrorCode)[keyof typeof PublishCommandErrorCode];

const VERSION_BUMPS: readonly PublishVersionBump[] = ["patch", "minor", "major"];

interface PublishArguments {
  /** Version component to increment; absent for an as-is first publish. */
  bump: PublishVersionBump | undefined;
  dir: string;
  remote: string | undefined;
  allowUnstableRefs: boolean;
  /** True to print the resolved publish remote and exit without publishing. */
  printRemote: boolean;
}

function isVersionBump(value: string): value is PublishVersionBump {
  return (VERSION_BUMPS as readonly string[]).includes(value);
}

function parsePublishArguments(args: readonly string[]): PublishArguments | string {
  let bump: PublishVersionBump | undefined;
  let dir = process.cwd();
  let remote: string | undefined;
  let allowUnstableRefs = false;
  let printRemote = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--allow-unstable-refs") {
      allowUnstableRefs = true;
    } else if (arg === "--print-remote") {
      printRemote = true;
    } else if (arg === "--dir" || arg === "--remote") {
      const value = args[i + 1];
      if (value === undefined) {
        return `${arg} requires a value`;
      }
      i++;
      if (arg === "--dir") {
        dir = path.resolve(value);
      } else {
        remote = value;
      }
    } else if (isVersionBump(arg)) {
      if (bump !== undefined) {
        return `unexpected argument "${arg}"`;
      }
      bump = arg;
    } else {
      return `unexpected argument "${arg}"`;
    }
  }

  return { bump, dir, remote, allowUnstableRefs, printRemote };
}

/** Inputs {@link resolvePublishTarget} decides the publish target from. */
export interface PublishTargetInput {
  /** Value of `--remote`, or `undefined` when the flag is absent. */
  readonly explicitRemote: string | undefined;
  /**
   * The `<owner>/<repo>` identity recorded in the project's manifest, or
   * `undefined` when the manifest records none, is missing, or is invalid.
   */
  readonly identity: string | undefined;
  /**
   * `true` when the project directory is the repository root of its git
   * checkout; `false` for a subdirectory of a checkout, or a directory that is
   * not in a git checkout at all.
   */
  readonly isCheckoutRoot: boolean;
  /** `true` when the project's git checkout has an `origin` remote. */
  readonly hasOrigin: boolean;
}

/** Where a publish records its version, and how the target repository is reached. */
export type PublishTarget = { readonly mode: "in-place" } | { readonly mode: "constructed"; readonly remote: string };

/**
 * Decide where a publish records its version:
 * - `--remote` given: constructed mode to that URL.
 * - no `--remote`, a standalone project (the project directory is the
 *   repository root of a checkout that has an origin): in-place mode on
 *   origin, whatever identity the manifest records.
 * - no `--remote` and not a standalone project (a subdirectory of a checkout,
 *   or no origin), with a recorded identity: constructed mode to the GitHub
 *   remote derived from the identity, `https://github.com/<owner>/<repo>.git`.
 * - no `--remote`, not a standalone project, and no recorded identity:
 *   in-place mode on origin.
 *
 * Always returns a target and does not validate that it can publish; a missing
 * manifest, an unusable origin, or an identity that cannot be stamped is
 * refused by the publish the chosen target dispatches to.
 */
export function resolvePublishTarget(input: PublishTargetInput): PublishTarget {
  if (input.explicitRemote !== undefined) {
    return { mode: "constructed", remote: input.explicitRemote };
  }
  if (input.isCheckoutRoot && input.hasOrigin) {
    return { mode: "in-place" };
  }
  if (input.identity !== undefined) {
    return { mode: "constructed", remote: githubRemoteUrlForCoordinate(input.identity) };
  }
  return { mode: "in-place" };
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Read the `<owner>/<repo>` identity recorded in the project's `wendoo.json`.
 * Returns `undefined` when the directory has no manifest, its manifest does not
 * parse, or it records no identity; a missing or invalid manifest is reported
 * by the publish itself.
 */
async function readRecordedIdentity(dir: string): Promise<string | undefined> {
  let manifestText: string;
  try {
    manifestText = await readFile(path.join(dir, WENDOO_JSON_PATH), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
  const parsed = parseProjectContentManifest(manifestText);
  return parsed.ok ? parsed.manifest.identity : undefined;
}

/**
 * A publish content source over a project directory: the manifest is
 * `<dir>/wendoo.json`, and listed files resolve relative to `dir`. Paths
 * that resolve outside `dir` read as absent.
 */
function directoryContentSource(dir: string): ExtensionPublishSource {
  const root = path.resolve(dir);
  return {
    readManifest: async () => {
      try {
        return await readFile(path.join(root, WENDOO_JSON_PATH), "utf8");
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
    },
    readFile: async (filePath) => {
      const resolved = path.resolve(root, filePath);
      const relative = path.relative(root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return undefined;
      }
      try {
        return new Uint8Array(await readFile(resolved));
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
    },
  };
}

async function writePublishFiles(root: string, files: readonly PublishFile[]): Promise<void> {
  for (const file of files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
}

/**
 * A publish backend over a git checkout whose repository root is `dir`: the
 * repository's own history defines the published content. Applying a publish
 * writes the publish files into the checkout, commits them, tags, and pushes
 * the current branch and the tag to `origin`.
 */
function checkoutPublishBackend(dir: string): ExtensionPublishBackend {
  return {
    isClean: async () => (await git(dir, "status", "--porcelain")).trim() === "",
    tagExists: async (tag) => {
      if ((await tryGit(dir, "rev-parse", "--verify", `refs/tags/${tag}`)) !== undefined) {
        return true;
      }
      const remoteTag = await git(dir, "ls-remote", "--tags", "origin", `refs/tags/${tag}`);
      return remoteTag.trim() !== "";
    },
    hasAnyTags: async () => {
      if ((await git(dir, "tag", "--list")).trim() !== "") {
        return true;
      }
      return (await git(dir, "ls-remote", "--tags", "origin")).trim() !== "";
    },
    readHeadManifest: () => tryGit(dir, "show", `HEAD:${WENDOO_JSON_PATH}`),
    apply: async ({ tag, files }) => {
      await writePublishFiles(dir, files);
      await git(dir, "add", "--", ...files.map((file) => file.path));
      // An as-is publish can leave the tree identical to head; the tag alone
      // records the publish then.
      if ((await tryGit(dir, "diff", "--cached", "--quiet")) === undefined) {
        await git(dir, "commit", "-m", tag);
      }
      await git(dir, "tag", tag);
      await git(dir, "push", "origin", "HEAD", `refs/tags/${tag}`);
    },
  };
}

/**
 * A dependency pin probe over the public content CDN: a pin is published
 * exactly when the CDN serves the repository's `wendoo.json` at it.
 */
function cdnPinProbe(): DependencyPinProbe {
  const transport = createJsDelivrExtensionTransport();
  return async (owner, repo, pin) => {
    const result = await transport.fetchFile(owner, repo, pin, WENDOO_JSON_PATH);
    return result.ok;
  };
}

/**
 * Publish the checkout at `dir` in place: bump, commit, tag, and push on the
 * repository the directory itself is a checkout of. The stamped identity
 * coordinate derives from the checkout's `origin` remote URL.
 */
async function publishInCheckout(options: PublishArguments): Promise<ExtensionPublishResult> {
  const originUrl = (await tryGit(options.dir, "remote", "get-url", "origin"))?.trim();
  return publishExtensionVersion({
    bump: options.bump,
    coordinate: originUrl === undefined ? undefined : deriveCoordinateFromRemoteUrl(originUrl),
    confirmUnstableDependencies: options.allowUnstableRefs,
    isPinPublished: cdnPinProbe(),
    source: directoryContentSource(options.dir),
    backend: checkoutPublishBackend(options.dir),
  });
}

/**
 * Publish the project directory's manifest-described tree to `remote` through
 * a temporary clone: the clone's working tree is replaced with the publish
 * files, committed to the remote's default branch, tagged, and pushed. The
 * stamped identity coordinate derives from the `remote` URL.
 */
async function publishToRemote(options: PublishArguments, remote: string): Promise<ExtensionPublishResult> {
  const scratch = await mkdtemp(path.join(tmpdir(), "wendoo-publish-"));
  try {
    const clone = path.join(scratch, "repo");
    await git(scratch, "clone", "--quiet", remote, clone);
    const branch = (await git(clone, "symbolic-ref", "--short", "HEAD")).trim();

    const backend: ExtensionPublishBackend = {
      isClean: async () => true,
      tagExists: async (tag) => (await tryGit(clone, "rev-parse", "--verify", `refs/tags/${tag}`)) !== undefined,
      hasAnyTags: async () => (await git(clone, "tag", "--list")).trim() !== "",
      readHeadManifest: async () => {
        try {
          return await readFile(path.join(clone, WENDOO_JSON_PATH), "utf8");
        } catch (error) {
          if (isFileNotFound(error)) return undefined;
          throw error;
        }
      },
      apply: async ({ tag, files }) => {
        for (const entry of await readdir(clone)) {
          if (entry === ".git") continue;
          await rm(path.join(clone, entry), { recursive: true, force: true });
        }
        await writePublishFiles(clone, files);
        await git(clone, "add", "--all");
        await git(clone, "commit", "-m", tag);
        await git(clone, "tag", tag);
        await git(clone, "push", "--quiet", "origin", branch, `refs/tags/${tag}`);
      },
    };

    return await publishExtensionVersion({
      bump: options.bump,
      coordinate: deriveCoordinateFromRemoteUrl(remote),
      confirmUnstableDependencies: options.allowUnstableRefs,
      isPinPublished: cdnPinProbe(),
      source: directoryContentSource(options.dir),
      backend,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Write a successful publish's version and stamped identity into the source
 * directory's `wendoo.json` through the manifest serializer, leaving every
 * other field as parsed. Throws when the manifest cannot be read, parsed, or
 * written.
 */
async function writeBackPublishedManifest(dir: string, version: string, identity: string): Promise<void> {
  const manifestPath = path.join(dir, WENDOO_JSON_PATH);
  const parsed = parseProjectContentManifest(await readFile(manifestPath, "utf8"));
  if (!parsed.ok) {
    throw new Error(`${manifestPath} is no longer a valid content manifest`);
  }
  await writeFile(manifestPath, serializeProjectContentManifest({ ...parsed.manifest, version, identity }));
}

/**
 * Run `wendoo publish` with the arguments following the subcommand name.
 * Returns the process exit code.
 */
export async function runPublishCommand(args: readonly string[]): Promise<number> {
  const parsed = parsePublishArguments(args);
  if (typeof parsed === "string") {
    process.stderr.write(`wendoo publish: ${parsed}\n${PUBLISH_USAGE}`);
    return 1;
  }

  try {
    const originUrl = (await tryGit(parsed.dir, "remote", "get-url", "origin"))?.trim();
    // --show-prefix is the project directory's path relative to its checkout's
    // repository root: empty at the root, and absent outside any checkout.
    const checkoutPrefix = (await tryGit(parsed.dir, "rev-parse", "--show-prefix"))?.trim();
    const target = resolvePublishTarget({
      explicitRemote: parsed.remote,
      identity: await readRecordedIdentity(parsed.dir),
      isCheckoutRoot: checkoutPrefix === "",
      hasOrigin: originUrl !== undefined,
    });
    if (parsed.printRemote) {
      const remote = target.mode === "constructed" ? target.remote : originUrl;
      if (remote === undefined) {
        process.stderr.write(
          `wendoo publish: ${PublishCommandErrorCode.REMOTE_UNRESOLVED}: ${parsed.dir} publishes to its ` +
            "checkout's origin, which has no URL.\n"
        );
        return 1;
      }
      process.stdout.write(`${remote}\n`);
      return 0;
    }
    const result =
      target.mode === "constructed" ? await publishToRemote(parsed, target.remote) : await publishInCheckout(parsed);
    if (!result.ok) {
      process.stderr.write(`wendoo publish: ${result.error.code}: ${result.error.message}\n`);
      if (result.error.code === ExtensionPublishErrorCode.UNSTABLE_DEPENDENCIES_UNCONFIRMED) {
        process.stderr.write("Pass --allow-unstable-refs to publish anyway.\n");
      }
      return 1;
    }
    if (result.previousIdentity !== undefined) {
      process.stderr.write(`warning: identity changed: ${result.previousIdentity} -> ${result.identity}\n`);
    }
    if (target.mode === "constructed") {
      try {
        await writeBackPublishedManifest(parsed.dir, result.version, result.identity);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `wendoo publish: ${PublishCommandErrorCode.WRITE_BACK_FAILED}: version ${result.version} was ` +
            `published (tag ${result.tag}), but writing it back to ${path.join(parsed.dir, WENDOO_JSON_PATH)} ` +
            `failed: ${message}\n`
        );
        return 1;
      }
    }
    process.stdout.write(`published ${result.version} (tag ${result.tag})\n`);
    return 0;
  } catch (error) {
    if (error instanceof GitCommandError) {
      process.stderr.write(`wendoo publish: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}
