import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProjectContentManifest } from "@wendoo/app-host";
import {
  isAbbreviatedCommitPin,
  ProjectContentManifestErrorCode,
  parseExtensionReference,
  parseProjectContentManifest,
  serializeProjectContentManifest,
  validateProjectContentManifest,
  validateProjectExtensions,
} from "@wendoo/app-host";

const VALID_MANIFEST = {
  name: "My Project",
  version: "1.2.3",
  extensions: {
    "example-org/wendoo-position": "gh:example-org/wendoo-position@v1.2.0",
    "example-org/steering": "gh:example-org/steering#main",
    "wendoo-lang/microbit-stdlib": "embedded:wendoo-lang/microbit-stdlib",
  },
};

function errorCodes(result: ReturnType<typeof validateProjectContentManifest>): string[] {
  return result.errors.map((error) => error.code);
}

describe("parseExtensionReference", () => {
  it("parses a gh reference pinned at a tag", () => {
    assert.deepStrictEqual(parseExtensionReference("gh:example-org/wendoo-position@v1.2.0"), {
      transport: "gh",
      owner: "example-org",
      repo: "wendoo-position",
      routing: { kind: "pin", pin: "v1.2.0" },
    });
  });

  it("parses a gh reference pinned at a full commit SHA without interpreting it", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    assert.deepStrictEqual(parseExtensionReference(`gh:example-org/wendoo-position@${sha}`), {
      transport: "gh",
      owner: "example-org",
      repo: "wendoo-position",
      routing: { kind: "pin", pin: sha },
    });
  });

  it("parses a gh branch reference, including a branch name containing a slash", () => {
    assert.deepStrictEqual(parseExtensionReference("gh:example-org/wendoo-position#main"), {
      transport: "gh",
      owner: "example-org",
      repo: "wendoo-position",
      routing: { kind: "branch", branch: "main" },
    });
    assert.deepStrictEqual(parseExtensionReference("gh:example-org/wendoo-position#feature/steering"), {
      transport: "gh",
      owner: "example-org",
      repo: "wendoo-position",
      routing: { kind: "branch", branch: "feature/steering" },
    });
  });

  it("parses an embedded reference carrying the full coordinate", () => {
    assert.deepStrictEqual(parseExtensionReference("embedded:wendoo-lang/microbit-stdlib"), {
      transport: "embedded",
      coordinate: "wendoo-lang/microbit-stdlib",
    });
  });

  it("rejects a repo-only embedded reference", () => {
    assert.strictEqual(parseExtensionReference("embedded:microbit-stdlib"), undefined);
  });

  it("rejects unrecognized transports and malformed forms", () => {
    const malformed = [
      "npm:left-pad@1.0.0",
      "gh:owner/repo",
      "gh:owner@tag",
      "gh:owner/repo@",
      "gh:owner/repo@tag with spaces",
      "gh:owner/repo@v1/extra",
      "gh:/repo@tag",
      "gh:owner/repo#",
      "gh:owner/repo#branch with spaces",
      "gh:owner#branch",
      "embedded:",
      "embedded:reponly",
      "embedded:owner/repo/extra",
      "embedded:/repo",
      "embedded:owner/",
      "ffff:8f14e45f-ceea-4e17-a396-7f34c2d51b3a",
      "",
      "position",
    ];
    for (const reference of malformed) {
      assert.strictEqual(parseExtensionReference(reference), undefined, `Expected rejection for "${reference}"`);
    }
  });
});

describe("isAbbreviatedCommitPin", () => {
  it("matches all-hex pins of 7 to 39 characters", () => {
    for (const pin of ["b19b80b", "B19B80B0", "0123456789abcdef0123456789abcdef0123456"]) {
      assert.strictEqual(isAbbreviatedCommitPin(pin), true, `Expected match for "${pin}"`);
    }
  });

  it("does not match tags, full SHAs, or short hex strings", () => {
    for (const pin of ["v0.1.0", "0.1.0", "0123456789abcdef0123456789abcdef01234567", "abc123", "deadbeeg"]) {
      assert.strictEqual(isAbbreviatedCommitPin(pin), false, `Expected no match for "${pin}"`);
    }
  });
});

describe("parseProjectContentManifest", () => {
  it("parses a manifest with all three reference forms", () => {
    const result = parseProjectContentManifest(JSON.stringify(VALID_MANIFEST));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, VALID_MANIFEST);
    }
  });

  it("defaults an absent extensions field to an empty map", () => {
    const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0" }));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.extensions, {});
    }
  });

  it("carries string description and thumbnailUrl through and captures other fields as extras", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({
        name: "P",
        version: "0.1.0",
        description: "desc",
        host: { name: "sim", version: "1.0.0" },
        thumbnailUrl: "data:,x",
      })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.manifest.description, "desc");
      assert.strictEqual(result.manifest.thumbnailUrl, "data:,x");
      assert.strictEqual("host" in result.manifest, false);
      assert.deepStrictEqual(result.manifest.extras, { host: { name: "sim", version: "1.0.0" } });
    }
  });

  it("omits extras when the document carries only schema fields", () => {
    const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0" }));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual("extras" in result.manifest, false);
    }
  });

  it("omits description and thumbnailUrl when absent or non-string", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({ name: "P", version: "0.1.0", description: 5, thumbnailUrl: null })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual("description" in result.manifest, false);
      assert.strictEqual("thumbnailUrl" in result.manifest, false);
    }
  });

  it("carries a declared identity coordinate through", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({ name: "P", version: "0.1.0", identity: "example-org/sample-project" })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.manifest.identity, "example-org/sample-project");
    }
  });

  it("omits identity when absent", () => {
    const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0" }));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual("identity" in result.manifest, false);
    }
  });

  it("carries a non-empty files string array through", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({ name: "P", version: "0.1.0", files: ["index.ts", "wendoo.core.d.ts"] })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.files, ["index.ts", "wendoo.core.d.ts"]);
    }
  });

  it("omits files when absent or empty", () => {
    for (const files of [undefined, []]) {
      const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0", files }));
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual("files" in result.manifest, false);
      }
    }
  });

  it("carries a non-empty ambient string array through", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({ name: "P", version: "0.1.0", ambient: ["wendoo.core.d.ts", "wendoo.codal.d.ts"] })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.ambient, ["wendoo.core.d.ts", "wendoo.codal.d.ts"]);
    }
  });

  it("omits ambient when absent or empty", () => {
    for (const ambient of [undefined, []]) {
      const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0", ambient }));
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual("ambient" in result.manifest, false);
      }
    }
  });

  it("carries a non-empty targets map through", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({
        name: "P",
        version: "0.1.0",
        targets: { "wendoo-lang/microbit-v2": { packageVersion: "^0.2.0" } },
      })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.targets, {
        "wendoo-lang/microbit-v2": { packageVersion: "^0.2.0" },
      });
    }
  });

  it("omits targets when absent or empty", () => {
    for (const targets of [undefined, {}]) {
      const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0", targets }));
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual("targets" in result.manifest, false);
      }
    }
  });

  it("rejects invalid JSON with INVALID_JSON", () => {
    const result = parseProjectContentManifest("{not json");
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_JSON]);
  });

  it("rejects a non-object root with INVALID_ROOT", () => {
    const result = parseProjectContentManifest("[1,2]");
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_ROOT]);
  });

  it("carries a host-app bundle through", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({
        name: "P",
        version: "0.1.0",
        hostApp: { path: "app", files: ["app/index.html", "app/main.js"] },
      })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.hostApp, { path: "app", files: ["app/index.html", "app/main.js"] });
    }
  });

  it("omits hostApp when absent", () => {
    const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0" }));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual("hostApp" in result.manifest, false);
    }
  });

  it("carries a root-level app chunk through as extras, unaffected by hostApp", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({ name: "P", version: "0.1.0", app: { "microbit-sim": { session: 1 } } })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.extras?.app, { "microbit-sim": { session: 1 } });
      assert.strictEqual("hostApp" in result.manifest, false);
    }
  });

  it("rejects a malformed hostApp with INVALID_HOST_APP", () => {
    const cases: unknown[] = [
      "not-an-object",
      { files: ["app/index.html"] },
      { path: "", files: ["app/index.html"] },
      { path: "app" },
      { path: "app", files: "app/index.html" },
      { path: "app", files: ["app/index.html", 7] },
    ];
    for (const hostApp of cases) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", hostApp });
      assert.strictEqual(result.ok, false, `Expected rejection for hostApp ${JSON.stringify(hostApp)}`);
      assert.ok(
        errorCodes(result).includes(ProjectContentManifestErrorCode.INVALID_HOST_APP),
        `Expected INVALID_HOST_APP for hostApp ${JSON.stringify(hostApp)}`
      );
    }
  });

  it("rejects a hostApp path that escapes the project root", () => {
    for (const path of ["../app", "/app", "app/../../up"]) {
      const result = validateProjectContentManifest({
        name: "P",
        version: "0.1.0",
        hostApp: { path, files: ["app/index.html"] },
      });
      assert.strictEqual(result.ok, false, `Expected rejection for hostApp.path ${JSON.stringify(path)}`);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT]);
    }
  });

  it("rejects a hostApp files entry that escapes the project root", () => {
    for (const files of [["../outside.html"], ["/absolute.html"], ["app/index.html", "a/../../leak.js"]]) {
      const result = validateProjectContentManifest({
        name: "P",
        version: "0.1.0",
        hostApp: { path: "app", files },
      });
      assert.strictEqual(result.ok, false, `Expected rejection for hostApp.files ${JSON.stringify(files)}`);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT]);
    }
  });

  it("accepts a hostApp whose path and files stay within the project root", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      hostApp: { path: "app", files: ["app/index.html", "app/nested/../main.js"] },
    });
    assert.strictEqual(result.ok, true);
  });

  it("rejects a path shared by files and hostApp.files with HOST_APP_FILES_OVERLAP", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      files: ["sensor.ts", "shared.ts"],
      hostApp: { path: "app", files: ["app/index.html", "shared.ts"] },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.HOST_APP_FILES_OVERLAP]);
  });

  it("accepts disjoint files and hostApp.files", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      files: ["sensor.ts"],
      hostApp: { path: "app", files: ["app/index.html"] },
    });
    assert.strictEqual(result.ok, true);
  });

  it("carries a rehearsal adapter through and omits it when absent", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({ name: "P", version: "0.1.0", rehearsalAdapter: { path: "rehearsal/adapter.js" } })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.rehearsalAdapter, { path: "rehearsal/adapter.js" });
    }
    const absent = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0" }));
    assert.strictEqual(absent.ok, true);
    if (absent.ok) {
      assert.strictEqual("rehearsalAdapter" in absent.manifest, false);
    }
  });

  it("rejects a malformed rehearsalAdapter with INVALID_REHEARSAL_ADAPTER", () => {
    const cases: unknown[] = ["not-an-object", {}, { path: "" }, { path: 7 }];
    for (const rehearsalAdapter of cases) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", rehearsalAdapter });
      assert.strictEqual(result.ok, false, `Expected rejection for ${JSON.stringify(rehearsalAdapter)}`);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_REHEARSAL_ADAPTER]);
    }
  });

  it("rejects a rehearsalAdapter path that escapes the project root", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      rehearsalAdapter: { path: "../adapter.js" },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT]);
  });

  it("carries a declared surface through and omits it when absent", () => {
    const result = parseProjectContentManifest(
      JSON.stringify({ name: "P", version: "0.1.0", declaredSurface: { path: "declared-surface.json" } })
    );
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest.declaredSurface, { path: "declared-surface.json" });
    }
    const absent = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0" }));
    assert.strictEqual(absent.ok, true);
    if (absent.ok) {
      assert.strictEqual("declaredSurface" in absent.manifest, false);
    }
  });

  it("rejects a malformed declaredSurface with INVALID_DECLARED_SURFACE", () => {
    const cases: unknown[] = ["not-an-object", {}, { path: "" }, { path: 7 }];
    for (const declaredSurface of cases) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", declaredSurface });
      assert.strictEqual(result.ok, false, `Expected rejection for ${JSON.stringify(declaredSurface)}`);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_DECLARED_SURFACE]);
    }
  });

  it("rejects a declaredSurface path that escapes the project root", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      declaredSurface: { path: "../declared-surface.json" },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT]);
  });

  it("carries a build version through as a declared field, not as an extra", () => {
    const result = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0", buildVersion: "0.1.0" }));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.manifest.buildVersion, "0.1.0");
      assert.strictEqual("extras" in result.manifest, false);
    }
    const absent = parseProjectContentManifest(JSON.stringify({ name: "P", version: "0.1.0" }));
    assert.strictEqual(absent.ok, true);
    if (absent.ok) {
      assert.strictEqual("buildVersion" in absent.manifest, false);
    }
  });

  it("rejects a malformed buildVersion with INVALID_BUILD_VERSION", () => {
    for (const buildVersion of ["", 7, null, { version: "0.1.0" }]) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", buildVersion });
      assert.strictEqual(result.ok, false, `Expected rejection for ${JSON.stringify(buildVersion)}`);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_BUILD_VERSION]);
    }
  });

  it("serializes a published target package byte-identically to its source bytes", () => {
    // The field order every already-published target package carries.
    const published = `${JSON.stringify(
      {
        name: "Ecosystem Simulator",
        version: "0.1.7",
        identity: "wendoo-lang/trg-ecosim",
        description: "Program the brains of carnivores, herbivores, and plants.",
        targets: { "wendoo-lang/lib-ecosim": { packageVersion: "^0.1.0" } },
        hostApp: { path: "app", files: ["app/index.html"] },
        rehearsalAdapter: { path: "rehearsal/adapter.js" },
        declaredSurface: { path: "declared-surface.json" },
        buildVersion: "0.1.7",
      },
      null,
      2
    )}`;
    const result = parseProjectContentManifest(published);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(serializeProjectContentManifest(result.manifest), published);
    }
  });
});

describe("validateProjectContentManifest", () => {
  it("rejects a missing or non-string name with INVALID_NAME", () => {
    for (const name of [undefined, 42]) {
      const result = validateProjectContentManifest({ ...VALID_MANIFEST, name });
      assert.strictEqual(result.ok, false);
      assert.ok(errorCodes(result).includes(ProjectContentManifestErrorCode.INVALID_NAME));
    }
  });

  it("backfills a missing, non-string, or non-semver version to the lowest content version", () => {
    for (const version of [undefined, 42, "1.0", "abc", "1.0.0.0", "01.0.0"]) {
      const result = validateProjectContentManifest({ ...VALID_MANIFEST, version });
      assert.strictEqual(result.ok, true, `Expected acceptance for version ${JSON.stringify(version)}`);
      if (result.ok) {
        assert.strictEqual(result.manifest.version, "0.0.0");
      }
    }
  });

  it("accepts semver prerelease and build metadata", () => {
    for (const version of ["1.0.0-alpha.1", "1.0.0+build.5", "1.0.0-rc.1+sha.abc"]) {
      const result = validateProjectContentManifest({ name: "P", version });
      assert.strictEqual(result.ok, true, `Expected acceptance for version "${version}"`);
    }
  });

  it("rejects a malformed identity with INVALID_IDENTITY", () => {
    for (const identity of [42, "", "no-slash", "owner/repo/extra", "/repo", "owner/", "-bad/repo", "owner/ repo"]) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", identity });
      assert.strictEqual(result.ok, false, `Expected rejection for identity ${JSON.stringify(identity)}`);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_IDENTITY]);
    }
  });

  it("rejects a non-array or non-string-element files field with INVALID_FILES", () => {
    for (const files of [5, "x", { a: 1 }, ["ok", 3]]) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", files });
      assert.strictEqual(result.ok, false);
      assert.ok(errorCodes(result).includes(ProjectContentManifestErrorCode.INVALID_FILES));
    }
  });

  it("rejects a non-array or non-string-element ambient field with INVALID_AMBIENT", () => {
    for (const ambient of [5, "x", { a: 1 }, ["ok", 3]]) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", ambient });
      assert.strictEqual(result.ok, false);
      assert.ok(errorCodes(result).includes(ProjectContentManifestErrorCode.INVALID_AMBIENT));
    }
  });

  it("rejects a files entry that escapes the project root with FILE_ESCAPES_ROOT", () => {
    for (const files of [["../outside.ts"], ["/absolute.ts"], ["a/../../up.ts"], ["ok.ts", "../leak.d.ts"]]) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", files });
      assert.strictEqual(result.ok, false, `Expected rejection for files ${JSON.stringify(files)}`);
      assert.ok(errorCodes(result).includes(ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT));
    }
  });

  it("rejects an ambient entry that escapes the project root with FILE_ESCAPES_ROOT", () => {
    for (const ambient of [["../ambient/wendoo.core.d.ts"], ["/abs.d.ts"], ["nested/../../up.d.ts"]]) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", ambient });
      assert.strictEqual(result.ok, false, `Expected rejection for ambient ${JSON.stringify(ambient)}`);
      assert.ok(errorCodes(result).includes(ProjectContentManifestErrorCode.FILE_ESCAPES_ROOT));
    }
  });

  it("accepts root-relative files and ambient entries, including in-root `..` re-descent", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      files: ["index.ts", "sub/image.ts", "sub/../image.ts"],
      ambient: ["wendoo.core.d.ts"],
    });
    assert.strictEqual(result.ok, true, `Expected acceptance: ${JSON.stringify(errorCodes(result))}`);
  });

  it("rejects a malformed targets field with INVALID_TARGETS", () => {
    const cases: unknown[] = [
      5,
      ["a"],
      { "-bad/repo": { packageVersion: "^1.0.0" } },
      { "wendoo-lang/codal": { packageVersion: 3 } },
      { "wendoo-lang/codal": { packageVersion: "" } },
      { "wendoo-lang/codal": "^1.0.0" },
    ];
    for (const targets of cases) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", targets });
      assert.strictEqual(result.ok, false, `Expected rejection for targets ${JSON.stringify(targets)}`);
      assert.ok(errorCodes(result).includes(ProjectContentManifestErrorCode.INVALID_TARGETS));
    }
  });

  it("rejects a non-object extensions field with INVALID_EXTENSIONS", () => {
    for (const extensions of [5, "x", ["a"], null]) {
      const result = validateProjectContentManifest({ name: "P", version: "0.1.0", extensions });
      assert.strictEqual(result.ok, false);
      assert.ok(errorCodes(result).includes(ProjectContentManifestErrorCode.INVALID_EXTENSIONS));
    }
  });

  it("rejects an invalid coordinate with INVALID_EXTENSION_COORDINATE", () => {
    for (const coordinate of ["-bad/repo", "no-slash", "owner/repo/extra"]) {
      const result = validateProjectContentManifest({
        name: "P",
        version: "0.1.0",
        extensions: { [coordinate]: "embedded:org/ok" },
      });
      assert.strictEqual(result.ok, false, `Expected rejection for coordinate "${coordinate}"`);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_EXTENSION_COORDINATE]);
    }
  });

  it("rejects case-insensitive duplicate coordinates with DUPLICATE_EXTENSION_COORDINATE", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      extensions: { "org/Sonar": "embedded:org/one", "org/sonar": "embedded:org/two" },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.DUPLICATE_EXTENSION_COORDINATE]);
  });

  it("rejects malformed and non-string references with INVALID_EXTENSION_REFERENCE", () => {
    for (const reference of ["not-a-ref", 42]) {
      const result = validateProjectContentManifest({
        name: "P",
        version: "0.1.0",
        extensions: { "org/position": reference },
      });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(errorCodes(result), [ProjectContentManifestErrorCode.INVALID_EXTENSION_REFERENCE]);
    }
  });

  it("reports one error per rejected entry with entry paths", () => {
    const result = validateProjectContentManifest({
      name: "P",
      version: "0.1.0",
      extensions: { "org/good": "embedded:org/fine", "org/bad": "nope", "-also/bad": "embedded:org/fine" },
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors.length, 2);
    assert.deepStrictEqual(result.errors.map((error) => error.path).sort(), [
      '$.extensions["-also/bad"]',
      '$.extensions["org/bad"]',
    ]);
  });
});

describe("validateProjectExtensions", () => {
  it("returns no errors for a valid extensions map", () => {
    assert.deepStrictEqual(validateProjectExtensions(VALID_MANIFEST.extensions), []);
  });
});

describe("serializeProjectContentManifest", () => {
  it("round-trips through parse", () => {
    const manifest: ProjectContentManifest = VALID_MANIFEST;
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
  });

  it("omits the extensions field when the map is empty", () => {
    const serialized = serializeProjectContentManifest({ name: "P", version: "0.1.0", extensions: {} });
    assert.strictEqual(serialized.includes("extensions"), false);
  });

  it("round-trips description and thumbnailUrl", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      description: "desc",
      thumbnailUrl: "data:,x",
      extensions: {},
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
  });

  it("omits description and thumbnailUrl when absent", () => {
    const serialized = serializeProjectContentManifest({ name: "P", version: "0.1.0", extensions: {} });
    assert.strictEqual(serialized.includes("description"), false);
    assert.strictEqual(serialized.includes("thumbnailUrl"), false);
  });

  it("round-trips identity and omits it when absent", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      identity: "example-org/sample-project",
      extensions: {},
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
    const withoutIdentity = serializeProjectContentManifest({ name: "P", version: "0.1.0", extensions: {} });
    assert.strictEqual(withoutIdentity.includes("identity"), false);
  });

  it("round-trips a non-empty files list and omits it when empty", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      extensions: {},
      files: ["index.ts", "wendoo.core.d.ts"],
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
    const emptySerialized = serializeProjectContentManifest({
      name: "P",
      version: "0.1.0",
      extensions: {},
      files: [],
    });
    assert.strictEqual(emptySerialized.includes("files"), false);
  });

  it("round-trips a non-empty ambient list and omits it when empty", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      extensions: {},
      ambient: ["wendoo.core.d.ts"],
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
    const emptySerialized = serializeProjectContentManifest({
      name: "P",
      version: "0.1.0",
      extensions: {},
      ambient: [],
    });
    assert.strictEqual(emptySerialized.includes("ambient"), false);
  });

  it("round-trips a non-empty targets map and omits it when empty", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      extensions: {},
      targets: { "wendoo-lang/microbit-v2": { packageVersion: "^0.2.0" } },
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
    const emptySerialized = serializeProjectContentManifest({
      name: "P",
      version: "0.1.0",
      extensions: {},
      targets: {},
    });
    assert.strictEqual(emptySerialized.includes("targets"), false);
  });

  it("round-trips a host-app bundle and omits it when absent", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      extensions: {},
      hostApp: { path: "app", files: ["app/index.html", "app/main.js"] },
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
    const withoutHostApp = serializeProjectContentManifest({ name: "P", version: "0.1.0", extensions: {} });
    assert.strictEqual(withoutHostApp.includes("hostApp"), false);
  });

  it("round-trips a rehearsal adapter and omits it when absent", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      extensions: {},
      rehearsalAdapter: { path: "rehearsal/adapter.js" },
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
    const without = serializeProjectContentManifest({ name: "P", version: "0.1.0", extensions: {} });
    assert.strictEqual(without.includes("rehearsalAdapter"), false);
  });

  it("round-trips a declared surface and omits it when absent", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      extensions: {},
      declaredSurface: { path: "declared-surface.json" },
    };
    const result = parseProjectContentManifest(serializeProjectContentManifest(manifest));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
    }
    const without = serializeProjectContentManifest({ name: "P", version: "0.1.0", extensions: {} });
    assert.strictEqual(without.includes("declaredSurface"), false);
  });

  it("round-trips extras byte-faithfully after the schema fields", () => {
    const manifest: ProjectContentManifest = {
      name: "P",
      version: "0.1.0",
      extensions: {},
      files: ["index.ts"],
      extras: { brains: { main: { rules: [1, 2] } }, appChunk: ["verbatim", null] },
    };
    const serialized = serializeProjectContentManifest(manifest);
    const result = parseProjectContentManifest(serialized);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.deepStrictEqual(result.manifest, manifest);
      assert.strictEqual(serializeProjectContentManifest(result.manifest), serialized);
    }
  });
});
