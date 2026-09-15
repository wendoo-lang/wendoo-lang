import type { DependencyPinProbe } from "./dependency-stability.js";
import { collectUnstableDependencies } from "./dependency-stability.js";
import {
  isExtensionCoordinate,
  type ProjectContentManifest,
  parseProjectContentManifest,
  readExplicitContentManifestVersion,
  serializeProjectContentManifest,
} from "./project-content-manifest.js";
import { WENDOO_JSON_PATH } from "./wendoo-json.js";

/** Project-relative path of the README furniture a publish writes into a repository. */
const README_PATH = "README.md";

/**
 * Generate the Markdown of the README a publish writes into a published
 * repository that carries no author-provided one, so the repository is not
 * bare. Built from the published (identity-stamped) manifest and its
 * `<owner>/<repo>` coordinate: a top-level heading from the manifest `name`, the
 * `description` line when the manifest carries one, the
 * `gh:<owner>/<repo>@<version>` install reference, and a kind-conditional usage
 * block -- an `@lib/<owner>/<repo>` import snippet for a library (a manifest
 * without a `hostApp` bundle), or a create-a-project line for a target (a
 * manifest with a `hostApp` bundle).
 *
 * @param manifest - The published manifest, after its version bump and identity stamp.
 * @param coordinate - The `<owner>/<repo>` coordinate the project publishes under.
 * @returns The README Markdown text.
 */
export function generatePublishedReadme(manifest: ProjectContentManifest, coordinate: string): string {
  const isTarget = manifest.hostApp !== undefined;
  const installReference = `gh:${coordinate}@${manifest.version}`;
  const lines: string[] = [`# ${manifest.name}`, ""];
  if (manifest.description !== undefined) {
    lines.push(manifest.description, "");
  }
  if (isTarget) {
    lines.push("Create a new project for this target:", "", "```", installReference, "```");
  } else {
    lines.push(
      "Add this library to a project's dependencies:",
      "",
      "```",
      installReference,
      "```",
      "",
      "Then import from it:",
      "",
      "```ts",
      `import { } from "@lib/${coordinate}";`,
      "```"
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Derive the `<owner>/<repo>` extension coordinate a git remote URL publishes
 * under: the last two segments of the URL's path, with a trailing `.git`
 * stripped. Handles scp-like remotes (`git@github.com:owner/repo.git`), URL
 * remotes (`ssh://git@github.com/owner/repo`, `https://github.com/owner/repo`),
 * and plain paths. Returns `undefined` when the URL yields fewer than two path
 * segments or the segments do not form a valid coordinate.
 */
export function deriveCoordinateFromRemoteUrl(url: string): string | undefined {
  let remotePath = url;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(remotePath);
  if (scheme) {
    // URL form: the path follows the authority.
    const rest = remotePath.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    if (slash === -1) return undefined;
    remotePath = rest.slice(slash + 1);
  } else {
    // scp-like form: the path follows the colon after user@host.
    const scpLike = /^[^/]+@[^/:]+:(.*)$/.exec(remotePath);
    if (scpLike) remotePath = scpLike[1];
  }
  remotePath = remotePath.replace(/\/+$/, "");
  if (remotePath.endsWith(".git")) {
    remotePath = remotePath.slice(0, -".git".length);
  }
  const segments = remotePath.split("/").filter((segment) => segment !== "");
  if (segments.length < 2) return undefined;
  const coordinate = `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return isExtensionCoordinate(coordinate) ? coordinate : undefined;
}

/**
 * Build the canonical HTTPS GitHub remote URL a `<owner>/<repo>` extension
 * coordinate publishes under: `https://github.com/<owner>/<repo>.git`. Throws
 * when `coordinate` is not a valid `<owner>/<repo>` coordinate.
 */
export function githubRemoteUrlForCoordinate(coordinate: string): string {
  if (!isExtensionCoordinate(coordinate)) {
    throw new Error(`"${coordinate}" is not a valid <owner>/<repo> extension coordinate.`);
  }
  return `https://github.com/${coordinate}.git`;
}

/** Version component a publish increments. */
export type PublishVersionBump = "patch" | "minor" | "major";

/** One file of a published project tree. */
export interface PublishFile {
  /** Project-relative path of the file. */
  readonly path: string;
  /** File content bytes. */
  readonly content: Uint8Array;
}

/** Reads the content of the project being published. */
export interface ExtensionPublishSource {
  /**
   * Text of the project's `wendoo.json`, or `undefined` when the project
   * has none.
   */
  readManifest(): Promise<string | undefined>;
  /**
   * Bytes of the project file at a manifest-listed project-relative path, or
   * `undefined` when no such file exists.
   */
  readFile(path: string): Promise<Uint8Array | undefined>;
}

/** The content and tag one publish records on the target repository. */
export interface ExtensionPublishCommit {
  /** Manifest version being published. */
  readonly version: string;
  /** Tag naming the published version (`v<version>`). */
  readonly tag: string;
  /**
   * The published tree: the `wendoo.json` carrying the published version
   * first, followed by each manifest-listed file and each host-app bundle
   * file, and a `README.md` -- the author's own when the project carries one,
   * otherwise one generated from the manifest -- unless the manifest already
   * lists a `README.md`.
   */
  readonly files: readonly PublishFile[];
}

/** Performs repository operations for a publish. */
export interface ExtensionPublishBackend {
  /** Resolves `true` when the target repository has no uncommitted changes. */
  isClean(): Promise<boolean>;
  /** Resolves `true` when `tag` already exists on the target repository. */
  tagExists(tag: string): Promise<boolean>;
  /** Resolves `true` when the target repository has at least one tag. */
  hasAnyTags(): Promise<boolean>;
  /**
   * Text of `wendoo.json` at the target repository's current head, or
   * `undefined` when the repository is empty or its head carries none.
   */
  readHeadManifest(): Promise<string | undefined>;
  /** Records the publish: commits the files, creates the tag, and pushes both. */
  apply(commit: ExtensionPublishCommit): Promise<void>;
}

/** Stable identifiers for publish refusals. */
export const ExtensionPublishErrorCode = {
  MANIFEST_MISSING: "PUBLISH_MANIFEST_MISSING",
  MANIFEST_INVALID: "PUBLISH_MANIFEST_INVALID",
  IDENTITY_UNKNOWN: "PUBLISH_IDENTITY_UNKNOWN",
  UNSTABLE_DEPENDENCIES_UNCONFIRMED: "PUBLISH_UNSTABLE_DEPENDENCIES_UNCONFIRMED",
  UNCOMMITTED_CHANGES: "PUBLISH_UNCOMMITTED_CHANGES",
  VERSION_ALREADY_PUBLISHED: "PUBLISH_VERSION_ALREADY_PUBLISHED",
  VERSION_BUMP_REQUIRED: "PUBLISH_VERSION_BUMP_REQUIRED",
  TAG_EXISTS: "PUBLISH_TAG_EXISTS",
  LISTED_FILE_MISSING: "PUBLISH_LISTED_FILE_MISSING",
  HOST_APP_BUMP_UNSUPPORTED: "PUBLISH_HOST_APP_BUMP_UNSUPPORTED",
  HOST_APP_STAMP_MISMATCH: "PUBLISH_HOST_APP_STAMP_MISMATCH",
} as const;

/** Union of all {@link ExtensionPublishErrorCode} values. */
export type ExtensionPublishErrorCode = (typeof ExtensionPublishErrorCode)[keyof typeof ExtensionPublishErrorCode];

/** A publish refusal. */
export interface ExtensionPublishError {
  /** Stable machine-readable refusal code. */
  readonly code: ExtensionPublishErrorCode;
  /** Human-readable refusal message. */
  readonly message: string;
}

/** Result of {@link publishExtensionVersion}. */
export type ExtensionPublishResult =
  | {
      /** True when the publish was applied. */
      readonly ok: true;
      /** Manifest version that was published. */
      readonly version: string;
      /** Tag recording the published version. */
      readonly tag: string;
      /** Coordinate stamped as the published manifest's identity. */
      readonly identity: string;
      /**
       * Identity the source manifest declared before this publish, present
       * only when the stamped coordinate replaced a different value.
       */
      readonly previousIdentity?: string;
    }
  | {
      /** False when the publish was refused before being applied. */
      readonly ok: false;
      /** The refusal. */
      readonly error: ExtensionPublishError;
    };

/** Options for {@link publishExtensionVersion}. */
export interface ExtensionPublishOptions {
  /**
   * Version component to increment. When absent, the manifest's current
   * version is published as-is; this is valid only as a first publish, to a
   * repository that has no tags.
   */
  readonly bump?: PublishVersionBump;
  /**
   * The `<owner>/<repo>` coordinate the publish stamps into the published
   * manifest's `identity`, derived from the target repository's remote. A
   * publish without one is refused.
   */
  readonly coordinate?: string;
  /**
   * Confirms publishing a project whose extensions map contains dependencies
   * that are not stable for consumers: a branch reference, or a pinned version
   * the fetch source does not serve. Without this confirmation such a publish
   * is refused.
   */
  readonly confirmUnstableDependencies?: boolean;
  /**
   * Reports whether the public fetch source serves a dependency's pinned
   * content, consulted for `gh:` pin references when the publish is not
   * already confirmed. When absent, pinned references are not probed and only
   * branch references require confirmation.
   */
  readonly isPinPublished?: DependencyPinProbe;
  /** Content of the project being published. */
  readonly source: ExtensionPublishSource;
  /** Repository the publish is recorded on. */
  readonly backend: ExtensionPublishBackend;
}

function refusal(code: ExtensionPublishErrorCode, message: string): ExtensionPublishResult {
  return { ok: false, error: { code, message } };
}

/**
 * Increment one component of a semver `version` string. `patch` increments the
 * patch component; `minor` increments the minor and zeroes the patch; `major`
 * increments the major and zeroes the minor and patch. A version without three
 * numeric components is read as `0.0.0` before the increment.
 */
export function bumpVersion(version: string, bump: PublishVersionBump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = match ? Number(match[1]) : 0;
  const minor = match ? Number(match[2]) : 0;
  const patch = match ? Number(match[3]) : 0;
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * Publish a version of a project: reads the project's manifest, bumps its
 * `version` by `bump` (or keeps it as-is when `bump` is absent), stamps the
 * manifest's `identity` with `coordinate`, and records the published tree --
 * the published `wendoo.json`, every manifest-listed file, every host-app
 * bundle file, and a `README.md` (the author's own, or one generated from the
 * manifest when the project carries none, unless the manifest already lists a
 * `README.md`) -- on the target repository as a commit tagged
 * `v<version>`. For a library (a manifest with no `hostApp` bundle) an as-is
 * publish is a first publish: it is accepted only when the target repository
 * has no tags. When the stamp replaces a different previously declared
 * identity, the ok result carries the replaced value as `previousIdentity`.
 *
 * A target (a manifest that declares a `hostApp` bundle) sets its version
 * before packaging, so it publishes the manifest's current version verbatim: a
 * `bump` is refused, and the version already recorded in the manifest is
 * published as long as its tag does not already exist. The manifest's
 * build-version stamp must equal the manifest version when present, so a version
 * bumped without repackaging is refused.
 *
 * Refuses without applying anything when the manifest is missing or invalid,
 * no `coordinate` was provided, the project has unconfirmed dependencies that
 * are not stable for consumers, a `bump` was requested for a target, the
 * repository has uncommitted changes, a target's manifest version does not
 * match its build-version stamp, the version is already the repository head's
 * manifest version, a library as-is publish targets a repository that already
 * has tags, the tag already exists, or a manifest-listed or host-app bundle
 * file is absent. Each refusal carries its {@link ExtensionPublishErrorCode}.
 */
export async function publishExtensionVersion(options: ExtensionPublishOptions): Promise<ExtensionPublishResult> {
  const { source, backend } = options;

  const manifestText = await source.readManifest();
  if (manifestText === undefined) {
    return refusal(ExtensionPublishErrorCode.MANIFEST_MISSING, `The project has no ${WENDOO_JSON_PATH} manifest.`);
  }

  const parsed = parseProjectContentManifest(manifestText);
  if (!parsed.ok) {
    const details = parsed.errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join(" ");
    return refusal(
      ExtensionPublishErrorCode.MANIFEST_INVALID,
      `${WENDOO_JSON_PATH} is not a valid content manifest. ${details}`
    );
  }
  const manifest = parsed.manifest;

  const coordinate = options.coordinate;
  if (coordinate === undefined) {
    return refusal(
      ExtensionPublishErrorCode.IDENTITY_UNKNOWN,
      "The publish has no <owner>/<repo> coordinate to stamp as the manifest's identity; " +
        "the repository remote did not yield one."
    );
  }

  if (options.confirmUnstableDependencies !== true) {
    const unstable = await collectUnstableDependencies(
      manifest.extensions,
      options.isPinPublished ?? (async () => true)
    );
    if (unstable.length > 0) {
      const details = unstable
        .map((dependency) => `${dependency.coordinate} ("${dependency.reference}"): ${dependency.code}`)
        .join(", ");
      return refusal(
        ExtensionPublishErrorCode.UNSTABLE_DEPENDENCIES_UNCONFIRMED,
        `The project depends on extensions that are not stable for consumers (${details}); ` +
          "publishing it requires explicit confirmation."
      );
    }
  }

  const isTarget = manifest.hostApp !== undefined;

  if (isTarget && options.bump !== undefined) {
    return refusal(
      ExtensionPublishErrorCode.HOST_APP_BUMP_UNSUPPORTED,
      "A target (a manifest that declares a hostApp bundle) sets its version before packaging; " +
        "publish it without a version bump. Set the next version with the version command and repackage first."
    );
  }

  const version = options.bump === undefined ? manifest.version : bumpVersion(manifest.version, options.bump);
  const tag = `v${version}`;

  if (!(await backend.isClean())) {
    return refusal(ExtensionPublishErrorCode.UNCOMMITTED_CHANGES, "The repository has uncommitted changes.");
  }

  if (isTarget) {
    // A target ships its already-baked version verbatim. The build-version
    // stamp records the version the bundle was packaged with; a mismatch means
    // the manifest version moved without repackaging. Re-publish protection is
    // the tag namespace below: a target keeps its manifest version, so the head
    // manifest version equals it by construction and cannot distinguish a
    // re-publish from a first publish.
    const stamp = manifest.buildVersion;
    if (stamp !== undefined && stamp !== version) {
      return refusal(
        ExtensionPublishErrorCode.HOST_APP_STAMP_MISMATCH,
        `The manifest version ${version} does not match the packaged build stamp ${stamp}; ` +
          "repackage the target so the built bundle matches the version before publishing."
      );
    }
  } else if (options.bump === undefined) {
    // Library as-is first publish: the repository must carry no earlier
    // publish. An as-is publish keeps the head manifest version, so duplicate
    // protection is the tag namespace, not the head manifest version.
    if (await backend.hasAnyTags()) {
      return refusal(
        ExtensionPublishErrorCode.VERSION_BUMP_REQUIRED,
        "The repository already has published tags; publish with a version bump (patch, minor, or major)."
      );
    }
  } else {
    const headManifestText = await backend.readHeadManifest();
    if (headManifestText !== undefined && readExplicitContentManifestVersion(headManifestText) === version) {
      return refusal(
        ExtensionPublishErrorCode.VERSION_ALREADY_PUBLISHED,
        `Version ${version} is already the manifest version at the repository head; ` +
          "update the project's manifest version before publishing."
      );
    }
  }

  if (await backend.tagExists(tag)) {
    return refusal(ExtensionPublishErrorCode.TAG_EXISTS, `Tag ${tag} already exists on the repository.`);
  }

  const encoder = new TextEncoder();
  const publishedManifestData: ProjectContentManifest = { ...manifest, version, identity: coordinate };
  const publishedManifest = serializeProjectContentManifest(publishedManifestData);
  const files: PublishFile[] = [{ path: WENDOO_JSON_PATH, content: encoder.encode(publishedManifest) }];
  const listedPaths = [
    ...(manifest.files ?? []),
    ...(manifest.hostApp?.files ?? []),
    ...(manifest.rehearsalAdapter === undefined ? [] : [manifest.rehearsalAdapter.path]),
    ...(manifest.declaredSurface === undefined ? [] : [manifest.declaredSurface.path]),
  ];
  for (const path of listedPaths) {
    // The manifest serialized above is the published manifest; a files entry
    // naming it must not overwrite it with the source bytes.
    if (path === WENDOO_JSON_PATH) continue;
    const content = await source.readFile(path);
    if (content === undefined) {
      return refusal(
        ExtensionPublishErrorCode.LISTED_FILE_MISSING,
        `Manifest-listed file "${path}" was not found in the project.`
      );
    }
    files.push({ path, content });
  }

  // README furniture for the published repository: skipped when the manifest
  // already lists a README (that copy publishes as listed content). Otherwise
  // the author's own README publishes when the project has one, and a generated
  // README publishes when it does not.
  if (!listedPaths.includes(README_PATH)) {
    const authoredReadme = await source.readFile(README_PATH);
    files.push({
      path: README_PATH,
      content: authoredReadme ?? encoder.encode(generatePublishedReadme(publishedManifestData, coordinate)),
    });
  }

  await backend.apply({ version, tag, files });
  const identityChanged = manifest.identity !== undefined && manifest.identity !== coordinate;
  return {
    ok: true,
    version,
    tag,
    identity: coordinate,
    ...(identityChanged ? { previousIdentity: manifest.identity } : {}),
  };
}
