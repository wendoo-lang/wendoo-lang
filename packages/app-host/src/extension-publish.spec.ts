import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ExtensionPublishBackend,
  ExtensionPublishCommit,
  ExtensionPublishSource,
  PublishVersionBump,
} from "@wendoo/app-host";
import {
  bumpVersion,
  deriveCoordinateFromRemoteUrl,
  ExtensionPublishErrorCode,
  githubRemoteUrlForCoordinate,
  publishExtensionVersion,
  serializeProjectContentManifest,
  validateProjectContentManifest,
} from "@wendoo/app-host";

const COORDINATE = "acme/position";

function memorySource(files: Record<string, string | Uint8Array>): ExtensionPublishSource {
  const encoder = new TextEncoder();
  return {
    readManifest: async () => {
      const content = files["wendoo.json"];
      if (content === undefined) return undefined;
      return typeof content === "string" ? content : new TextDecoder().decode(content);
    },
    readFile: async (path) => {
      const content = files[path];
      if (content === undefined) return undefined;
      return typeof content === "string" ? encoder.encode(content) : content;
    },
  };
}

interface MemoryBackend {
  backend: ExtensionPublishBackend;
  applied: ExtensionPublishCommit[];
}

function memoryBackend(overrides?: Partial<ExtensionPublishBackend>): MemoryBackend {
  const applied: ExtensionPublishCommit[] = [];
  const backend: ExtensionPublishBackend = {
    isClean: async () => true,
    tagExists: async () => false,
    hasAnyTags: async () => false,
    readHeadManifest: async () => undefined,
    apply: async (commit) => {
      applied.push(commit);
    },
    ...overrides,
  };
  return { backend, applied };
}

function manifestText(document: Record<string, unknown>): string {
  const result = validateProjectContentManifest(document);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  return serializeProjectContentManifest(result.manifest);
}

function decode(content: Uint8Array): string {
  return new TextDecoder().decode(content);
}

describe("deriveCoordinateFromRemoteUrl", () => {
  it("derives the coordinate from the common GitHub remote forms", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["git@github.com:acme/position.git", "acme/position"],
      ["git@github.com:acme/position", "acme/position"],
      ["ssh://git@github.com/acme/position.git", "acme/position"],
      ["ssh://git@github.com/acme/position", "acme/position"],
      ["https://github.com/acme/position.git", "acme/position"],
      ["https://github.com/acme/position", "acme/position"],
      ["https://github.com/acme/position/", "acme/position"],
    ];
    for (const [url, expected] of cases) {
      assert.equal(deriveCoordinateFromRemoteUrl(url), expected, url);
    }
  });

  it("derives the coordinate from a plain repository path", () => {
    assert.equal(deriveCoordinateFromRemoteUrl("/tmp/fixtures/acme/position.git"), "acme/position");
  });

  it("returns undefined for remotes that yield no coordinate", () => {
    const cases: readonly string[] = [
      "",
      "https://github.com",
      "/position.git",
      "git@github.com:acme/_position.git",
      "https://github.com/_acme/position.git",
    ];
    for (const url of cases) {
      assert.equal(deriveCoordinateFromRemoteUrl(url), undefined, url);
    }
  });
});

describe("githubRemoteUrlForCoordinate", () => {
  it("builds the canonical HTTPS GitHub remote URL for a coordinate", () => {
    assert.equal(githubRemoteUrlForCoordinate("acme/position"), "https://github.com/acme/position.git");
  });

  it("round-trips through deriveCoordinateFromRemoteUrl", () => {
    for (const coordinate of ["acme/position", "wendoo-lang/lib-codal-position", "a1/b2.c3"]) {
      assert.equal(deriveCoordinateFromRemoteUrl(githubRemoteUrlForCoordinate(coordinate)), coordinate);
    }
  });

  it("throws for a value that is not a valid coordinate", () => {
    assert.throws(() => githubRemoteUrlForCoordinate("_bad/coordinate"));
    assert.throws(() => githubRemoteUrlForCoordinate("noslash"));
  });
});

describe("publishExtensionVersion", () => {
  it("publishes the bumped manifest followed by each listed file", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({ name: "Position", version: "0.1.0", files: ["index.ts", "assets/a.bin"] }),
      "index.ts": "export const x = 1;",
      "assets/a.bin": new Uint8Array([0, 1, 255, 128]),
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ bump: "patch", coordinate: COORDINATE, source, backend });

    assert.deepEqual(result, { ok: true, version: "0.1.1", tag: "v0.1.1", identity: COORDINATE });
    assert.equal(applied.length, 1);
    const commit = applied[0];
    assert.equal(commit.version, "0.1.1");
    assert.equal(commit.tag, "v0.1.1");
    assert.deepEqual(
      commit.files.map((file) => file.path),
      ["wendoo.json", "index.ts", "assets/a.bin", "README.md"]
    );
    const published = JSON.parse(decode(commit.files[0].content)) as Record<string, unknown>;
    assert.equal(published.version, "0.1.1");
    assert.equal(published.identity, COORDINATE);
    assert.deepEqual(Array.from(commit.files[2].content), [0, 1, 255, 128]);
  });

  it("bumps the requested version component", async () => {
    const cases: ReadonlyArray<[PublishVersionBump, string]> = [
      ["patch", "1.2.4"],
      ["minor", "1.3.0"],
      ["major", "2.0.0"],
    ];
    for (const [bump, expected] of cases) {
      const source = memorySource({ "wendoo.json": manifestText({ name: "P", version: "1.2.3" }) });
      const { backend } = memoryBackend();
      const result = await publishExtensionVersion({ bump, coordinate: COORDINATE, source, backend });
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.version, expected);
        assert.equal(result.tag, `v${expected}`);
      }
    }
  });

  it("carries fields outside the manifest schema through the bump byte-faithfully", async () => {
    const original = manifestText({
      name: "Position",
      version: "1.2.3",
      identity: COORDINATE,
      files: ["index.ts"],
      brains: { main: { rules: [1, 2, 3], nested: { deep: true } } },
      appChunk: ["verbatim", null, 4],
    });
    const source = memorySource({ "wendoo.json": original, "index.ts": "export {};" });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ bump: "patch", coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.previousIdentity, undefined);
    const published = decode(applied[0].files[0].content);
    assert.equal(published, original.replace('"version": "1.2.3"', '"version": "1.2.4"'));
  });

  it("stamps the identity on a first as-is publish of a manifest without one", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({ name: "P", version: "0.3.0", files: ["index.ts"] }),
      "index.ts": "export {};",
    });
    const { backend, applied } = memoryBackend({
      // In-place first publish: the manifest version is already at head.
      readHeadManifest: async () => manifestText({ name: "P", version: "0.3.0" }),
    });

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend });

    assert.deepEqual(result, { ok: true, version: "0.3.0", tag: "v0.3.0", identity: COORDINATE });
    const published = JSON.parse(decode(applied[0].files[0].content)) as Record<string, unknown>;
    assert.equal(published.version, "0.3.0");
    assert.equal(published.identity, COORDINATE);
  });

  it("restamps a changed identity and reports the replaced value", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({ name: "P", version: "0.3.0", identity: "old-owner/position" }),
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend });

    assert.deepEqual(result, {
      ok: true,
      version: "0.3.0",
      tag: "v0.3.0",
      identity: COORDINATE,
      previousIdentity: "old-owner/position",
    });
    const published = JSON.parse(decode(applied[0].files[0].content)) as Record<string, unknown>;
    assert.equal(published.identity, COORDINATE);
  });

  it("refuses a publish without a coordinate", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      source: memorySource({ "wendoo.json": manifestText({ name: "P", version: "0.1.0" }) }),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.IDENTITY_UNKNOWN);
  });

  it("refuses an as-is publish when the repository already has tags", async () => {
    const result = await publishExtensionVersion({
      coordinate: COORDINATE,
      source: memorySource({ "wendoo.json": manifestText({ name: "P", version: "0.3.0" }) }),
      backend: memoryBackend({ hasAnyTags: async () => true }).backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.VERSION_BUMP_REQUIRED);
  });

  it("refuses a project without a manifest", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({}),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.MANIFEST_MISSING);
  });

  it("refuses an invalid manifest", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({ "wendoo.json": JSON.stringify({ version: "1.0.0" }) }),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, ExtensionPublishErrorCode.MANIFEST_INVALID);
      assert.match(result.error.message, /PROJECT_MANIFEST_INVALID_NAME/);
    }
  });

  it("refuses an unconfirmed branch dependency and proceeds when confirmed", async () => {
    const files = {
      "wendoo.json": manifestText({
        name: "P",
        version: "0.1.0",
        extensions: { "author/steering": "gh:author/steering#main" },
      }),
    };
    const refused = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource(files),
      backend: memoryBackend().backend,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.error.code, ExtensionPublishErrorCode.UNSTABLE_DEPENDENCIES_UNCONFIRMED);
      assert.match(refused.error.message, /author\/steering/);
      assert.match(refused.error.message, /DEPENDENCY_BRANCH_REFERENCE/);
    }

    const confirmed = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      confirmUnstableDependencies: true,
      source: memorySource(files),
      backend: memoryBackend().backend,
    });
    assert.equal(confirmed.ok, true);
  });

  it("refuses an unconfirmed pin the fetch source does not serve and passes a published pin silently", async () => {
    const files = {
      "wendoo.json": manifestText({
        name: "P",
        version: "0.1.0",
        extensions: {
          "author/published": "gh:author/published@v1.0.0",
          "author/unpublished": "gh:author/unpublished@v9.9.9",
        },
      }),
    };
    const probed: string[] = [];
    const isPinPublished = async (owner: string, repo: string, pin: string) => {
      probed.push(`${owner}/${repo}@${pin}`);
      return repo === "published";
    };

    const refused = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      isPinPublished,
      source: memorySource(files),
      backend: memoryBackend().backend,
    });
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.error.code, ExtensionPublishErrorCode.UNSTABLE_DEPENDENCIES_UNCONFIRMED);
      assert.match(refused.error.message, /author\/unpublished/);
      assert.match(refused.error.message, /DEPENDENCY_VERSION_UNPUBLISHED/);
      assert.doesNotMatch(refused.error.message, /author\/published/);
    }
    assert.deepEqual(probed, ["author/published@v1.0.0", "author/unpublished@v9.9.9"]);

    const confirmed = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      confirmUnstableDependencies: true,
      isPinPublished: async () => false,
      source: memorySource(files),
      backend: memoryBackend().backend,
    });
    assert.equal(confirmed.ok, true);
  });

  it("publishes a project whose extensions map carries an embedded reference without confirmation", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({
        "wendoo.json": manifestText({
          name: "P",
          version: "0.1.0",
          extensions: { "author/position": "embedded:author/position" },
        }),
      }),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, true);
  });

  it("publishes a project whose pinned dependency the fetch source serves without confirmation", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      isPinPublished: async () => true,
      source: memorySource({
        "wendoo.json": manifestText({
          name: "P",
          version: "0.1.0",
          extensions: { "author/published": "gh:author/published@v1.0.0" },
        }),
      }),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, true);
  });

  it("publishes a project whose targets map declares compatibility packages", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({
        "wendoo.json": manifestText({
          name: "P",
          version: "0.1.0",
          targets: {
            "wendoo-lang/lib-codal": { packageVersion: "^0.2.0" },
            "wendoo-lang/trg-microbit-v2": { packageVersion: "^0.2.0" },
          },
        }),
      }),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, true);
  });

  it("refuses a repository with uncommitted changes", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({ "wendoo.json": manifestText({ name: "P", version: "0.1.0" }) }),
      backend: memoryBackend({ isClean: async () => false }).backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.UNCOMMITTED_CHANGES);
  });

  it("refuses when the bumped version is already the head manifest version", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({ "wendoo.json": manifestText({ name: "P", version: "0.1.0" }) }),
      backend: memoryBackend({
        readHeadManifest: async () => manifestText({ name: "P", version: "0.1.1" }),
      }).backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.VERSION_ALREADY_PUBLISHED);
  });

  it("refuses when the computed tag already exists", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({ "wendoo.json": manifestText({ name: "P", version: "0.1.0" }) }),
      backend: memoryBackend({ tagExists: async (tag) => tag === "v0.1.1" }).backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.TAG_EXISTS);
  });

  it("refuses when a manifest-listed file is missing", async () => {
    const result = await publishExtensionVersion({
      bump: "patch",
      coordinate: COORDINATE,
      source: memorySource({
        "wendoo.json": manifestText({ name: "P", version: "0.1.0", files: ["ghost.ts"] }),
      }),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, ExtensionPublishErrorCode.LISTED_FILE_MISSING);
      assert.match(result.error.message, /ghost\.ts/);
    }
  });

  it("publishes host-app bundle files at their content-relative paths after the listed files", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Microbit V2",
        version: "0.1.0",
        files: ["index.ts"],
        hostApp: { path: "app", files: ["app/index.html", "app/assets/main.js"] },
      }),
      "index.ts": "export {};",
      "app/index.html": "<!doctype html><title>t</title>",
      "app/assets/main.js": "console.log(1);",
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    const commit = applied[0];
    assert.deepEqual(
      commit.files.map((file) => file.path),
      ["wendoo.json", "index.ts", "app/index.html", "app/assets/main.js", "README.md"]
    );
    const published = JSON.parse(decode(commit.files[0].content)) as { hostApp?: unknown };
    assert.deepEqual(published.hostApp, { path: "app", files: ["app/index.html", "app/assets/main.js"] });
    assert.equal(decode(commit.files[2].content), "<!doctype html><title>t</title>");
  });

  it("refuses when a host-app bundle file is missing", async () => {
    const result = await publishExtensionVersion({
      coordinate: COORDINATE,
      source: memorySource({
        "wendoo.json": manifestText({
          name: "Microbit V2",
          version: "0.1.0",
          hostApp: { path: "app", files: ["app/index.html", "app/ghost.js"] },
        }),
        "app/index.html": "<!doctype html>",
      }),
      backend: memoryBackend().backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, ExtensionPublishErrorCode.LISTED_FILE_MISSING);
      assert.match(result.error.message, /app\/ghost\.js/);
    }
  });

  it("publishes the bumped manifest once even when the files list names it", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({ name: "P", version: "0.1.0", files: ["wendoo.json", "index.ts"] }),
      "index.ts": "export {};",
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ bump: "patch", coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    const manifestEntries = applied[0].files.filter((file) => file.path === "wendoo.json");
    assert.equal(manifestEntries.length, 1);
    const published = JSON.parse(decode(manifestEntries[0].content)) as Record<string, unknown>;
    assert.equal(published.version, "0.1.1");
  });

  it("adds a generated README carrying the name, coordinate, version, and library import to a library publish", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Position",
        version: "0.1.0",
        description: "Tracks the robot position.",
        files: ["index.ts"],
      }),
      "index.ts": "export {};",
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ bump: "patch", coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    const readme = applied[0].files.find((file) => file.path === "README.md");
    assert.ok(readme, "the published tree includes a README.md");
    const text = decode(readme.content);
    assert.match(text, /Position/);
    assert.match(text, /Tracks the robot position\./);
    assert.match(text, /acme\/position/);
    assert.match(text, /0\.1\.1/);
    assert.match(text, /@lib\/acme\/position/);
  });

  it("adds a generated README with no library import to a target publish", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Microbit V2",
        version: "0.2.0",
        files: ["index.ts"],
        hostApp: { path: "app", files: ["app/index.html"] },
      }),
      "index.ts": "export {};",
      "app/index.html": "<!doctype html>",
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    const readme = applied[0].files.find((file) => file.path === "README.md");
    assert.ok(readme, "the published tree includes a README.md");
    const text = decode(readme.content);
    assert.match(text, /Microbit V2/);
    assert.match(text, /acme\/position/);
    assert.match(text, /0\.2\.0/);
    assert.doesNotMatch(text, /@lib\//);
  });

  it("publishes the author's own README byte-for-byte and does not generate one", async () => {
    const authored = "# Written by the author\n\nCustom prose the generator would never produce.\n";
    const source = memorySource({
      "wendoo.json": manifestText({ name: "Position", version: "0.1.0", files: ["index.ts"] }),
      "index.ts": "export {};",
      "README.md": authored,
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ bump: "patch", coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    const readme = applied[0].files.find((file) => file.path === "README.md");
    assert.ok(readme, "the published tree includes a README.md");
    assert.equal(decode(readme.content), authored);
    // A generated README carries the install reference; the author's does not.
    assert.doesNotMatch(decode(readme.content), /gh:acme\/position/);
  });

  it("leaves the published manifest's files array unchanged by the README furniture", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({ name: "Position", version: "0.1.0", files: ["index.ts"] }),
      "index.ts": "export {};",
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ bump: "patch", coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    const published = JSON.parse(decode(applied[0].files[0].content)) as { files?: readonly string[] };
    assert.deepEqual(published.files, ["index.ts"]);
    assert.ok(applied[0].files.some((file) => file.path === "README.md"));
  });

  it("does not add README furniture when the manifest already lists a README", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({ name: "Position", version: "0.1.0", files: ["index.ts", "README.md"] }),
      "index.ts": "export {};",
      "README.md": "# listed readme\n",
    });
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ bump: "patch", coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    const readmes = applied[0].files.filter((file) => file.path === "README.md");
    assert.equal(readmes.length, 1);
    assert.equal(decode(readmes[0].content), "# listed readme\n");
    const published = JSON.parse(decode(applied[0].files[0].content)) as { files?: readonly string[] };
    assert.deepEqual(published.files, ["index.ts", "README.md"]);
  });
});

describe("bumpVersion", () => {
  it("increments the requested component and zeroes the lower ones", () => {
    assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
    assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
    assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  });
});

/**
 * A target manifest as the release flow produces it: a hostApp bundle plus a
 * build-version stamp equal to the version the bundle was packaged at.
 */
function targetManifest(version: string, stamp = version): string {
  return manifestText({
    name: "Microbit V2",
    version,
    files: ["index.ts"],
    hostApp: { path: "app", files: ["app/index.html"] },
    buildVersion: stamp,
  });
}

function targetSource(version: string, stamp = version): ExtensionPublishSource {
  return memorySource({
    "wendoo.json": targetManifest(version, stamp),
    "index.ts": "export {};",
    "app/index.html": "<!doctype html>",
  });
}

describe("publishExtensionVersion for a target (hostApp)", () => {
  it("ships the manifest's current version verbatim without a bump", async () => {
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source: targetSource("0.9.1"), backend });

    assert.deepEqual(result, { ok: true, version: "0.9.1", tag: "v0.9.1", identity: COORDINATE });
    const published = JSON.parse(decode(applied[0].files[0].content)) as { version: string; buildVersion?: string };
    assert.equal(published.version, "0.9.1");
    assert.equal(published.buildVersion, "0.9.1");
  });

  it("refuses a version bump on a target", async () => {
    for (const bump of ["patch", "minor", "major"] as const) {
      const result = await publishExtensionVersion({
        bump,
        coordinate: COORDINATE,
        source: targetSource("0.9.1"),
        backend: memoryBackend().backend,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.HOST_APP_BUMP_UNSUPPORTED);
    }
  });

  it("refuses when the manifest version does not match the build-version stamp", async () => {
    const { backend, applied } = memoryBackend();

    const result = await publishExtensionVersion({
      coordinate: COORDINATE,
      // Version bumped to 0.9.2 but the bundle was still packaged at 0.9.1.
      source: targetSource("0.9.2", "0.9.1"),
      backend,
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.HOST_APP_STAMP_MISMATCH);
    assert.equal(applied.length, 0);
  });

  it("ships the rehearsal adapter the manifest declares", async () => {
    const { backend, applied } = memoryBackend();
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Microbit V2",
        version: "0.9.1",
        hostApp: { path: "app", files: ["app/index.html"] },
        rehearsalAdapter: { path: "rehearsal/adapter.js" },
      }),
      "app/index.html": "<!doctype html>",
      "rehearsal/adapter.js": "export function createTargetAdapter() {}",
    });

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    assert.ok(
      applied[0].files.some((file) => file.path === "rehearsal/adapter.js"),
      "the published tree carries the adapter artifact"
    );
  });

  it("ships the declared surface the manifest declares", async () => {
    const { backend, applied } = memoryBackend();
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Microbit V2",
        version: "0.9.1",
        hostApp: { path: "app", files: ["app/index.html"] },
        declaredSurface: { path: "declared-surface.json" },
      }),
      "app/index.html": "<!doctype html>",
      "declared-surface.json": '{"formatVersion":1}',
    });

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend });

    assert.equal(result.ok, true);
    assert.ok(
      applied[0].files.some((file) => file.path === "declared-surface.json"),
      "the published tree carries the baked declared surface"
    );
  });

  it("refuses a target whose declared surface is not in the project", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Microbit V2",
        version: "0.9.1",
        hostApp: { path: "app", files: ["app/index.html"] },
        declaredSurface: { path: "declared-surface.json" },
      }),
      "app/index.html": "<!doctype html>",
    });

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend: memoryBackend().backend });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.LISTED_FILE_MISSING);
  });

  it("refuses a target whose declared rehearsal adapter is not in the project", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Microbit V2",
        version: "0.9.1",
        hostApp: { path: "app", files: ["app/index.html"] },
        rehearsalAdapter: { path: "rehearsal/adapter.js" },
      }),
      "app/index.html": "<!doctype html>",
    });

    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend: memoryBackend().backend });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.LISTED_FILE_MISSING);
  });

  it("ships a target that carries no build-version stamp", async () => {
    const source = memorySource({
      "wendoo.json": manifestText({
        name: "Microbit V2",
        version: "0.9.1",
        files: ["index.ts"],
        hostApp: { path: "app", files: ["app/index.html"] },
      }),
      "index.ts": "export {};",
      "app/index.html": "<!doctype html>",
    });
    const result = await publishExtensionVersion({ coordinate: COORDINATE, source, backend: memoryBackend().backend });
    assert.equal(result.ok, true);
  });

  it("publishes a first target version even when the head manifest already carries it", async () => {
    // A target keeps its version as-is, so the head manifest matching it is the
    // normal first-publish state and must not be read as a re-publish.
    const result = await publishExtensionVersion({
      coordinate: COORDINATE,
      source: targetSource("0.9.1"),
      backend: memoryBackend({ readHeadManifest: async () => targetManifest("0.9.1") }).backend,
    });
    assert.equal(result.ok, true);
  });

  it("refuses re-publishing a version whose tag already exists", async () => {
    const result = await publishExtensionVersion({
      coordinate: COORDINATE,
      source: targetSource("0.9.1"),
      backend: memoryBackend({ tagExists: async (tag) => tag === "v0.9.1" }).backend,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, ExtensionPublishErrorCode.TAG_EXISTS);
  });
});
