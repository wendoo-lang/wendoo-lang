import { LOWEST_CONTENT_VERSION, type WendooProjectExtensions } from "@wendoo/service-api";

/**
 * Routing specifier of a `gh:` extension reference: how the reference names
 * the repository content to fetch.
 */
export type GhRoutingSpecifier =
  | {
      readonly kind: "pin";
      /**
       * Opaque immutable specifier following `@`: a tag (such as `v0.1.0`) or a
       * full commit SHA. It is fetched as written and never parsed or compared;
       * the installed version always comes from the fetched manifest.
       */
      readonly pin: string;
    }
  | {
      readonly kind: "branch";
      /**
       * Branch name following `#`. Installation resolves the branch to a commit
       * SHA and fetches that immutable commit; the resolved SHA is recorded
       * with the installed content.
       */
      readonly branch: string;
    };

/**
 * A parsed extension reference naming where a dependency comes from.
 *
 * String forms:
 * - `gh:<owner>/<repo>@<pin>` -- a GitHub repository snapshot at an immutable
 *   pin (a tag or a full commit SHA).
 * - `gh:<owner>/<repo>#<branch>` -- a GitHub repository branch, resolved to a
 *   commit SHA at install time.
 * - `embedded:<owner>/<repo>` -- an extension bundled with the host application.
 */
export type ExtensionReference =
  | {
      readonly transport: "gh";
      /** Repository owner (user or organization). */
      readonly owner: string;
      /** Repository name. */
      readonly repo: string;
      /** What to fetch: an immutable pin or a branch to resolve. */
      readonly routing: GhRoutingSpecifier;
    }
  | {
      readonly transport: "embedded";
      /** `<owner>/<repo>` coordinate identifying the bundled extension in the host application's embed records. */
      readonly coordinate: string;
    };

/**
 * Grammar for an extension coordinate `<owner>/<repo>`: an owner segment (ASCII
 * letters, digits, and `-`) and a repository segment, joined by a single slash.
 * This is the extension's identity and the key a dependency is stored under,
 * independent of the transport that delivers it.
 */
const COORDINATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const GH_PIN_REFERENCE_PATTERN = /^gh:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)@([^\s/]+)$/;

const GH_BRANCH_REFERENCE_PATTERN = /^gh:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)#([^\s]+)$/;

const ABBREVIATED_COMMIT_PIN_PATTERN = /^[0-9a-f]{7,39}$/i;

/**
 * Tests whether a `gh:` reference pin is plausibly an abbreviated commit SHA:
 * an all-hex string of 7 to 39 characters. Only the full 40-character form is
 * served as an immutable commit; a shorter hex pin is served with mutable
 * branch semantics.
 */
export function isAbbreviatedCommitPin(pin: string): boolean {
  return ABBREVIATED_COMMIT_PIN_PATTERN.test(pin);
}

/** Semver 2.0.0 version grammar (semver.org). */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function isSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

/**
 * Tests whether a value is a well-formed extension coordinate: a string in the
 * form `<owner>/<repo>`, each segment starting with a letter or digit.
 */
export function isExtensionCoordinate(value: unknown): value is string {
  return typeof value === "string" && COORDINATE_PATTERN.test(value);
}

/**
 * Parse an extension reference string. Returns `undefined` when the string is
 * not in a recognized reference form.
 */
export function parseExtensionReference(reference: string): ExtensionReference | undefined {
  const pinMatch = GH_PIN_REFERENCE_PATTERN.exec(reference);
  if (pinMatch) {
    return {
      transport: "gh",
      owner: pinMatch[1],
      repo: pinMatch[2],
      routing: { kind: "pin", pin: pinMatch[3] },
    };
  }
  const branchMatch = GH_BRANCH_REFERENCE_PATTERN.exec(reference);
  if (branchMatch) {
    return {
      transport: "gh",
      owner: branchMatch[1],
      repo: branchMatch[2],
      routing: { kind: "branch", branch: branchMatch[3] },
    };
  }
  if (reference.startsWith("embedded:")) {
    const coordinate = reference.slice("embedded:".length);
    return isExtensionCoordinate(coordinate) ? { transport: "embedded", coordinate } : undefined;
  }
  return undefined;
}

/**
 * One entry of a content manifest's {@link ProjectContentManifest.targets}
 * map: the version constraint a target package must satisfy for the extension
 * to be compatible with a platform whose stack includes that package.
 */
export interface ExtensionTarget {
  /**
   * Semver range the target package's resolved version must satisfy. An
   * extension is compatible with a platform when one of its target packages is
   * in the platform's stack and the stack's version for that package satisfies
   * this range.
   */
  readonly packageVersion: string;
}

/**
 * A project's hostable app bundle: the host-served content a target package
 * ships. Its `files` are host content only and are disjoint from the
 * top-level {@link ProjectContentManifest.files}, which is consumer content.
 */
export interface ProjectContentManifestHostApp {
  /**
   * Content-relative directory whose `index.html` the host serves as the
   * project's app.
   */
  readonly path: string;
  /**
   * Content-relative paths of every file the host-served bundle comprises.
   * Disjoint from the top-level {@link ProjectContentManifest.files}.
   */
  readonly files: readonly string[];
}

/**
 * A project's headless rehearsal adapter: the built ES module a harness imports
 * to author and rehearse against the target without running its app.
 */
export interface ProjectContentManifestRehearsalAdapter {
  /**
   * Content-relative path of the built module exporting `createTargetAdapter`.
   * The module is self-contained: importing it needs nothing else the package
   * carries.
   */
  readonly path: string;
}

/**
 * A project's baked declarative surface: the JSON document a target package
 * carries stating what its adapter declares about the target, readable as data
 * by a consumer that never loads the adapter module.
 */
export interface ProjectContentManifestDeclaredSurface {
  /**
   * Content-relative path of the JSON document carrying the declared surface.
   */
  readonly path: string;
}

/**
 * A project's content manifest: the portable identity data carried in
 * `wendoo.json` alongside host-specific fields.
 */
export interface ProjectContentManifest {
  /** Project display name; also the source for the project's slug. */
  readonly name: string;
  /** Semver version of the project's content. */
  readonly version: string;
  /**
   * The project's own declared `<owner>/<repo>` coordinate: the identity the
   * project publishes under. Present only when the file carries one.
   */
  readonly identity?: string;
  /** Free-form project description; present only when the file carries one. */
  readonly description?: string;
  /** URL or data URI of a project thumbnail image; present only when the file carries one. */
  readonly thumbnailUrl?: string;
  /**
   * Extension dependencies keyed by their `<owner>/<repo>` coordinate; each
   * value is an extension reference string naming the transport. Coordinates
   * must be unique case-insensitively. Always present; an empty object means
   * the project has no extensions.
   */
  readonly extensions: WendooProjectExtensions;
  /**
   * Project-relative paths of every source and asset file this project
   * comprises: the authoritative content list used to assemble the project when
   * it is loaded as an embedded or dependency extension, or packaged for
   * delivery. The manifest itself is always part of the project and is never
   * listed. Present only when the file carries a non-empty list; a live host
   * project need not declare it, but a project assembled as an embedded
   * extension must.
   */
  readonly files?: readonly string[];
  /**
   * Content-relative paths of the `.d.ts` declaration files this content
   * contributes as ambient declarations: type declarations the consumer's
   * TypeScript environment includes globally (language globals and/or
   * `declare module "wendoo"` surfaces), pulled into scope by inclusion.
   * Present only when the file carries a non-empty list.
   */
  readonly ambient?: readonly string[];
  /**
   * Platform-compatibility targets keyed by target package `<owner>/<repo>`
   * coordinate; each value declares the semver range that package's version
   * must satisfy. Present only when the file carries a non-empty map. A
   * compatibility filter treats the extension as compatible with a platform
   * when one of these keys is in the platform's stack and the stack's version
   * for that package satisfies the entry's `packageVersion` range.
   */
  readonly targets?: Readonly<Record<string, ExtensionTarget>>;
  /**
   * The project's hostable app bundle: the directory the host serves and the
   * host-only file list it comprises. Present only when the project publishes
   * a host-served app; a package without one omits it. Its `files` are
   * disjoint from the top-level {@link ProjectContentManifest.files}.
   */
  readonly hostApp?: ProjectContentManifestHostApp;
  /**
   * The project's headless rehearsal adapter. Present only when the project
   * ships one; a package without one omits it. Its `path` publishes with the
   * project's content.
   */
  readonly rehearsalAdapter?: ProjectContentManifestRehearsalAdapter;
  /**
   * The project's baked declarative surface. Present only when the project
   * ships one; a package without one omits it. Its `path` publishes with the
   * project's content.
   */
  readonly declaredSurface?: ProjectContentManifestDeclaredSurface;
  /**
   * Root-level fields of the source document outside the manifest schema
   * (for example application-specific content), keyed by property name and
   * carried verbatim: a parse followed by a serialize preserves them. Present
   * only when the source document carries at least one such field.
   */
  readonly extras?: Readonly<Record<string, unknown>>;
}

/** Root-level property names defined by the content manifest schema. */
const MANIFEST_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "version",
  "identity",
  "description",
  "thumbnailUrl",
  "extensions",
  "files",
  "ambient",
  "targets",
  "hostApp",
  "rehearsalAdapter",
  "declaredSurface",
]);

/** Stable identifiers for content manifest validation errors. */
export const ProjectContentManifestErrorCode = {
  INVALID_JSON: "PROJECT_MANIFEST_INVALID_JSON",
  INVALID_ROOT: "PROJECT_MANIFEST_INVALID_ROOT",
  INVALID_NAME: "PROJECT_MANIFEST_INVALID_NAME",
  INVALID_IDENTITY: "PROJECT_MANIFEST_INVALID_IDENTITY",
  INVALID_FILES: "PROJECT_MANIFEST_INVALID_FILES",
  INVALID_AMBIENT: "PROJECT_MANIFEST_INVALID_AMBIENT",
  FILE_ESCAPES_ROOT: "PROJECT_MANIFEST_FILE_ESCAPES_ROOT",
  INVALID_TARGETS: "PROJECT_MANIFEST_INVALID_TARGETS",
  INVALID_HOST_APP: "PROJECT_MANIFEST_INVALID_HOST_APP",
  HOST_APP_FILES_OVERLAP: "PROJECT_MANIFEST_HOST_APP_FILES_OVERLAP",
  INVALID_REHEARSAL_ADAPTER: "PROJECT_MANIFEST_INVALID_REHEARSAL_ADAPTER",
  INVALID_DECLARED_SURFACE: "PROJECT_MANIFEST_INVALID_DECLARED_SURFACE",
  INVALID_EXTENSIONS: "PROJECT_MANIFEST_INVALID_EXTENSIONS",
  INVALID_EXTENSION_COORDINATE: "PROJECT_MANIFEST_INVALID_EXTENSION_COORDINATE",
  DUPLICATE_EXTENSION_COORDINATE: "PROJECT_MANIFEST_DUPLICATE_EXTENSION_COORDINATE",
  INVALID_EXTENSION_REFERENCE: "PROJECT_MANIFEST_INVALID_EXTENSION_REFERENCE",
} as const;

/** Union of all {@link ProjectContentManifestErrorCode} values. */
export type ProjectContentManifestErrorCode =
  (typeof ProjectContentManifestErrorCode)[keyof typeof ProjectContentManifestErrorCode];

/** Validation error for a rejected content manifest. */
export interface ProjectContentManifestError {
  /** Stable machine-readable error code. */
  readonly code: ProjectContentManifestErrorCode;
  /** JSON path of the rejected field. */
  readonly path: string;
  /** Human-readable error message. */
  readonly message: string;
}

/** Result of validating or parsing a content manifest. */
export type ProjectContentManifestParseResult =
  | {
      /** True when a valid content manifest was produced. */
      readonly ok: true;
      /** Parsed content manifest. */
      readonly manifest: ProjectContentManifest;
      /** Empty error list for a valid manifest. */
      readonly errors: readonly [];
    }
  | {
      /** False when validation rejected the manifest. */
      readonly ok: false;
      /** Validation errors. */
      readonly errors: readonly ProjectContentManifestError[];
    };

/**
 * Validate an extensions map: coordinate grammar (`<owner>/<repo>`),
 * case-insensitive coordinate uniqueness, and reference form. Returns one
 * error per rejected entry.
 */
export function validateProjectExtensions(
  extensions: Readonly<Record<string, unknown>>
): readonly ProjectContentManifestError[] {
  const errors: ProjectContentManifestError[] = [];
  const seenCoordinates = new Set<string>();

  for (const [coordinate, reference] of Object.entries(extensions)) {
    const path = `$.extensions[${JSON.stringify(coordinate)}]`;
    if (!isExtensionCoordinate(coordinate)) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_EXTENSION_COORDINATE,
        path,
        message: `Extension coordinate "${coordinate}" must be "<owner>/<repo>", each segment starting with a letter or digit.`,
      });
      continue;
    }

    const normalizedCoordinate = coordinate.toLowerCase();
    if (seenCoordinates.has(normalizedCoordinate)) {
      errors.push({
        code: ProjectContentManifestErrorCode.DUPLICATE_EXTENSION_COORDINATE,
        path,
        message: `Extension coordinate "${coordinate}" duplicates another coordinate when compared case-insensitively.`,
      });
      continue;
    }
    seenCoordinates.add(normalizedCoordinate);

    if (typeof reference !== "string" || parseExtensionReference(reference) === undefined) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_EXTENSION_REFERENCE,
        path,
        message:
          `Extension reference for "${coordinate}" must be a string in the form ` +
          '"gh:<owner>/<repo>@<pin>", "gh:<owner>/<repo>#<branch>", or "embedded:<owner>/<repo>".',
      });
    }
  }

  return errors;
}

/**
 * Validate a compatibility targets map: an object keyed by target package
 * `<owner>/<repo>` coordinate, each value an object carrying a non-empty string
 * `packageVersion`. Returns one error per rejected entry; an empty list means
 * the map is well-formed.
 */
export function validateProjectTargets(value: unknown): readonly ProjectContentManifestError[] {
  if (!isRecord(value)) {
    return [
      {
        code: ProjectContentManifestErrorCode.INVALID_TARGETS,
        path: "$.targets",
        message: "$.targets must be an object when present.",
      },
    ];
  }
  const errors: ProjectContentManifestError[] = [];
  for (const [coordinate, target] of Object.entries(value)) {
    const path = `$.targets[${JSON.stringify(coordinate)}]`;
    if (!isExtensionCoordinate(coordinate)) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_TARGETS,
        path,
        message: `Target package coordinate "${coordinate}" must be "<owner>/<repo>".`,
      });
      continue;
    }
    if (!isRecord(target) || typeof target.packageVersion !== "string" || target.packageVersion.length === 0) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_TARGETS,
        path,
        message: `Target "${coordinate}" must be an object with a non-empty string "packageVersion".`,
      });
    }
  }
  return errors;
}

/**
 * Validate a hostable app bundle declaration: an object carrying a non-empty
 * string `path` and a `files` array of string paths, each staying within the
 * project root. Returns the normalized bundle with no errors when well-formed,
 * or one error per rejected field.
 */
export function validateProjectHostApp(
  value: unknown
):
  | { readonly hostApp: ProjectContentManifestHostApp; readonly errors: readonly [] }
  | { readonly hostApp?: undefined; readonly errors: readonly ProjectContentManifestError[] } {
  if (!isRecord(value)) {
    return {
      errors: [
        {
          code: ProjectContentManifestErrorCode.INVALID_HOST_APP,
          path: "$.hostApp",
          message: "$.hostApp must be an object when present.",
        },
      ],
    };
  }
  const errors: ProjectContentManifestError[] = [];
  if (typeof value.path !== "string" || value.path.length === 0) {
    errors.push({
      code: ProjectContentManifestErrorCode.INVALID_HOST_APP,
      path: "$.hostApp.path",
      message: "$.hostApp.path must be a non-empty string.",
    });
  } else if (pathEscapesProjectRoot(value.path)) {
    errors.push({
      code: ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT,
      path: "$.hostApp.path",
      message: `$.hostApp.path must stay within the project root; "${value.path}" escapes it.`,
    });
  }
  if (!Array.isArray(value.files) || value.files.some((entry) => typeof entry !== "string")) {
    errors.push({
      code: ProjectContentManifestErrorCode.INVALID_HOST_APP,
      path: "$.hostApp.files",
      message: "$.hostApp.files must be an array of string paths.",
    });
  } else {
    const escaping = (value.files as readonly string[]).filter(pathEscapesProjectRoot);
    if (escaping.length > 0) {
      errors.push({
        code: ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT,
        path: "$.hostApp.files",
        message: `$.hostApp.files entries must stay within the project root; these escape it: ${escaping.join(", ")}.`,
      });
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  return {
    hostApp: { path: value.path as string, files: value.files as readonly string[] },
    errors: [],
  };
}

/** A well-formed single-path declaration, or the one error that rejected it. */
type PathDeclarationResult =
  | { readonly path: string; readonly errors: readonly [] }
  | { readonly path?: undefined; readonly errors: readonly ProjectContentManifestError[] };

/**
 * Validate a manifest field declaring one content file: an object carrying a
 * non-empty string `path` that stays within the project root. Returns the
 * declared path with no errors when well-formed, or the one error that rejected
 * it.
 *
 * @param value - The field's value, as the source document carries it.
 * @param field - Root-level field name, used to build the error paths.
 * @param invalidCode - Error code reported when the field is not a `{ path }` object.
 */
function validatePathDeclaration(
  value: unknown,
  field: string,
  invalidCode: ProjectContentManifestErrorCode
): PathDeclarationResult {
  if (!isRecord(value)) {
    return {
      errors: [
        {
          code: invalidCode,
          path: `$.${field}`,
          message: `$.${field} must be an object when present.`,
        },
      ],
    };
  }
  if (typeof value.path !== "string" || value.path.length === 0) {
    return {
      errors: [
        {
          code: invalidCode,
          path: `$.${field}.path`,
          message: `$.${field}.path must be a non-empty string.`,
        },
      ],
    };
  }
  if (pathEscapesProjectRoot(value.path)) {
    return {
      errors: [
        {
          code: ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT,
          path: `$.${field}.path`,
          message: `$.${field}.path must stay within the project root; "${value.path}" escapes it.`,
        },
      ],
    };
  }
  return { path: value.path, errors: [] };
}

/**
 * Validate a rehearsal adapter declaration: an object carrying a non-empty
 * string `path` that stays within the project root. Returns the normalized
 * declaration with no errors when well-formed, or the one error that rejected
 * it.
 */
export function validateProjectRehearsalAdapter(
  value: unknown
):
  | { readonly rehearsalAdapter: ProjectContentManifestRehearsalAdapter; readonly errors: readonly [] }
  | { readonly rehearsalAdapter?: undefined; readonly errors: readonly ProjectContentManifestError[] } {
  const declaration = validatePathDeclaration(
    value,
    "rehearsalAdapter",
    ProjectContentManifestErrorCode.INVALID_REHEARSAL_ADAPTER
  );
  if (declaration.path === undefined) return { errors: declaration.errors };
  return { rehearsalAdapter: { path: declaration.path }, errors: [] };
}

/**
 * Validate a declared surface declaration: an object carrying a non-empty
 * string `path` that stays within the project root. Returns the normalized
 * declaration with no errors when well-formed, or the one error that rejected
 * it.
 */
export function validateProjectDeclaredSurface(
  value: unknown
):
  | { readonly declaredSurface: ProjectContentManifestDeclaredSurface; readonly errors: readonly [] }
  | { readonly declaredSurface?: undefined; readonly errors: readonly ProjectContentManifestError[] } {
  const declaration = validatePathDeclaration(
    value,
    "declaredSurface",
    ProjectContentManifestErrorCode.INVALID_DECLARED_SURFACE
  );
  if (declaration.path === undefined) return { errors: declaration.errors };
  return { declaredSurface: { path: declaration.path }, errors: [] };
}

/**
 * Parse and validate a project content manifest from JSON text. String
 * `description` and `thumbnailUrl` fields are carried through; fields outside
 * the manifest schema are carried through verbatim as `extras`.
 *
 * @param content - JSON text of a `wendoo.json` file.
 */
export function parseProjectContentManifest(content: string): ProjectContentManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      ok: false,
      errors: [
        {
          code: ProjectContentManifestErrorCode.INVALID_JSON,
          path: "$",
          message: "Content manifest is not valid JSON.",
        },
      ],
    };
  }
  return validateProjectContentManifest(parsed);
}

/**
 * Validate a parsed project content manifest. String `description` and
 * `thumbnailUrl` fields are carried through; an `identity` field must be an
 * `<owner>/<repo>` coordinate and is carried through; string-array `files` and
 * `ambient` fields are carried through when non-empty; fields outside the
 * manifest schema are carried through verbatim as `extras`; an absent
 * `extensions` field yields an empty extensions map. A missing or non-semver
 * `version` is read as the lowest content version (`"0.0.0"`).
 *
 * @param value - Parsed JSON value of a `wendoo.json` file.
 */
export function validateProjectContentManifest(value: unknown): ProjectContentManifestParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        {
          code: ProjectContentManifestErrorCode.INVALID_ROOT,
          path: "$",
          message: "Content manifest root must be an object.",
        },
      ],
    };
  }

  const errors: ProjectContentManifestError[] = [];

  if (typeof value.name !== "string") {
    errors.push({
      code: ProjectContentManifestErrorCode.INVALID_NAME,
      path: "$.name",
      message: "$.name must be a string.",
    });
  }

  const version = isSemver(value.version) ? value.version : LOWEST_CONTENT_VERSION;

  let identity: string | undefined;
  if (value.identity !== undefined) {
    if (!isExtensionCoordinate(value.identity)) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_IDENTITY,
        path: "$.identity",
        message: '$.identity must be an "<owner>/<repo>" coordinate when present.',
      });
    } else {
      identity = value.identity;
    }
  }

  let files: readonly string[] | undefined;
  if (value.files !== undefined) {
    if (!Array.isArray(value.files) || value.files.some((entry) => typeof entry !== "string")) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_FILES,
        path: "$.files",
        message: "$.files must be an array of string paths when present.",
      });
    } else {
      const escaping = (value.files as readonly string[]).filter(pathEscapesProjectRoot);
      if (escaping.length > 0) {
        errors.push({
          code: ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT,
          path: "$.files",
          message: `$.files entries must stay within the project root; these escape it: ${escaping.join(", ")}.`,
        });
      } else if (value.files.length > 0) {
        files = value.files as readonly string[];
      }
    }
  }

  let ambient: readonly string[] | undefined;
  if (value.ambient !== undefined) {
    if (!Array.isArray(value.ambient) || value.ambient.some((entry) => typeof entry !== "string")) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_AMBIENT,
        path: "$.ambient",
        message: "$.ambient must be an array of string paths when present.",
      });
    } else {
      const escaping = (value.ambient as readonly string[]).filter(pathEscapesProjectRoot);
      if (escaping.length > 0) {
        errors.push({
          code: ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT,
          path: "$.ambient",
          message: `$.ambient entries must stay within the project root; these escape it: ${escaping.join(", ")}.`,
        });
      } else if (value.ambient.length > 0) {
        ambient = value.ambient as readonly string[];
      }
    }
  }

  let targets: Readonly<Record<string, ExtensionTarget>> | undefined;
  if (value.targets !== undefined) {
    const targetErrors = validateProjectTargets(value.targets);
    if (targetErrors.length > 0) {
      errors.push(...targetErrors);
    } else if (Object.keys(value.targets as Record<string, unknown>).length > 0) {
      targets = value.targets as Readonly<Record<string, ExtensionTarget>>;
    }
  }

  let hostApp: ProjectContentManifestHostApp | undefined;
  if (value.hostApp !== undefined) {
    const hostAppResult = validateProjectHostApp(value.hostApp);
    if (hostAppResult.errors.length > 0) {
      errors.push(...hostAppResult.errors);
    } else {
      hostApp = hostAppResult.hostApp;
    }
  }

  let rehearsalAdapter: ProjectContentManifestRehearsalAdapter | undefined;
  if (value.rehearsalAdapter !== undefined) {
    const adapterResult = validateProjectRehearsalAdapter(value.rehearsalAdapter);
    if (adapterResult.errors.length > 0) {
      errors.push(...adapterResult.errors);
    } else {
      rehearsalAdapter = adapterResult.rehearsalAdapter;
    }
  }

  let declaredSurface: ProjectContentManifestDeclaredSurface | undefined;
  if (value.declaredSurface !== undefined) {
    const surfaceResult = validateProjectDeclaredSurface(value.declaredSurface);
    if (surfaceResult.errors.length > 0) {
      errors.push(...surfaceResult.errors);
    } else {
      declaredSurface = surfaceResult.declaredSurface;
    }
  }

  if (files !== undefined && hostApp !== undefined) {
    const topLevelFiles = new Set(files);
    for (const path of hostApp.files) {
      if (topLevelFiles.has(path)) {
        errors.push({
          code: ProjectContentManifestErrorCode.HOST_APP_FILES_OVERLAP,
          path: `$.hostApp.files[${JSON.stringify(path)}]`,
          message: `"${path}" appears in both $.files (consumer content) and $.hostApp.files (host content); the two lists must be disjoint.`,
        });
      }
    }
  }

  let extensions: WendooProjectExtensions = {};
  if (value.extensions !== undefined) {
    if (!isRecord(value.extensions)) {
      errors.push({
        code: ProjectContentManifestErrorCode.INVALID_EXTENSIONS,
        path: "$.extensions",
        message: "$.extensions must be an object when present.",
      });
    } else {
      const extensionErrors = validateProjectExtensions(value.extensions);
      if (extensionErrors.length > 0) {
        errors.push(...extensionErrors);
      } else {
        extensions = value.extensions as WendooProjectExtensions;
      }
    }
  }

  let extras: Record<string, unknown> | undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (MANIFEST_SCHEMA_FIELDS.has(key)) continue;
    extras ??= {};
    extras[key] = entry;
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: {
      name: value.name as string,
      version,
      ...(identity !== undefined ? { identity } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(typeof value.thumbnailUrl === "string" ? { thumbnailUrl: value.thumbnailUrl } : {}),
      extensions,
      ...(files !== undefined ? { files } : {}),
      ...(ambient !== undefined ? { ambient } : {}),
      ...(targets !== undefined ? { targets } : {}),
      ...(hostApp !== undefined ? { hostApp } : {}),
      ...(rehearsalAdapter !== undefined ? { rehearsalAdapter } : {}),
      ...(declaredSurface !== undefined ? { declaredSurface } : {}),
      ...(extras !== undefined ? { extras } : {}),
    },
    errors: [],
  };
}

/**
 * Project a {@link ProjectContentManifest} onto the plain JSON object a
 * `wendoo.json` file carries. Schema fields appear in a fixed order;
 * `extras` entries follow them verbatim.
 */
export function projectContentManifestToJson(manifest: ProjectContentManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.identity !== undefined ? { identity: manifest.identity } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.thumbnailUrl !== undefined ? { thumbnailUrl: manifest.thumbnailUrl } : {}),
    ...(Object.keys(manifest.extensions).length > 0 ? { extensions: manifest.extensions } : {}),
    ...(manifest.files !== undefined && manifest.files.length > 0 ? { files: manifest.files } : {}),
    ...(manifest.ambient !== undefined && manifest.ambient.length > 0 ? { ambient: manifest.ambient } : {}),
    ...(manifest.targets !== undefined && Object.keys(manifest.targets).length > 0
      ? { targets: manifest.targets }
      : {}),
    ...(manifest.hostApp !== undefined ? { hostApp: manifest.hostApp } : {}),
    ...(manifest.rehearsalAdapter !== undefined ? { rehearsalAdapter: manifest.rehearsalAdapter } : {}),
    ...(manifest.declaredSurface !== undefined ? { declaredSurface: manifest.declaredSurface } : {}),
    ...(manifest.extras !== undefined ? manifest.extras : {}),
  };
}

/**
 * Serialize a {@link ProjectContentManifest} to a pretty-printed JSON string.
 * Schema fields are written in a fixed order; `extras` entries follow them
 * verbatim.
 */
export function serializeProjectContentManifest(manifest: ProjectContentManifest): string {
  return JSON.stringify(projectContentManifestToJson(manifest), null, 2);
}

/**
 * Read the `version` a `wendoo.json` document explicitly declares, returning
 * it only when it is a valid semver string. Returns `undefined` when the
 * content is unparseable, omits `version`, or carries a non-semver `version`.
 *
 * @param content - JSON text of a `wendoo.json` file.
 */
export function readExplicitContentManifestVersion(content: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  return isSemver(parsed.version) ? parsed.version : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Tests whether a forward-slash content path points outside the project root:
 * an absolute path (leading `/`), or a relative path whose `..` segments walk
 * above the root. A path that stays within the root (including one that uses
 * `..` only to re-descend, such as `a/../b`) does not escape. The check is
 * purely lexical and never touches the filesystem.
 *
 * @param entry - A content-relative path declared by a manifest.
 */
function pathEscapesProjectRoot(entry: string): boolean {
  if (entry.startsWith("/")) {
    return true;
  }
  let depth = 0;
  for (const segment of entry.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) {
        return true;
      }
    } else {
      depth += 1;
    }
  }
  return false;
}
