import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { WENDOO_PROJECT_FORMAT } from "@wendoo/service-api";
import { listProjectFiles, makeScratchDir, runCliBin, writeProjectFiles } from "./test-support/publish-fixtures.js";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await makeScratchDir();
  scratchDirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of scratchDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const TILE_SOURCE = 'import { Sensor } from "wendoo";\nexport default Sensor({ name: "probe" });\n';
const SVG_ASSET = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>\n';

/** An export document whose embedded manifest carries brains, an app chunk, and extensions. */
function sampleDocument(): Record<string, unknown> {
  return {
    format: WENDOO_PROJECT_FORMAT,
    manifest: {
      name: "Rover",
      version: "0.2.0",
      description: "A rover project",
      extensions: { "example-org/position": "gh:example-org/position@v1.2.0" },
      brains: { main: { rules: [1, 2, 3], nested: { deep: true } } },
      app: { "@example/app": { actors: [{ archetype: "rover", desiredCount: 2 }] } },
    },
    contents: {
      "tiles/probe.ts": TILE_SOURCE,
      "assets/logo.svg": SVG_ASSET,
      "notes.txt": "scratch notes\n",
    },
  };
}

async function writeDocument(dir: string, document: unknown): Promise<string> {
  const file = path.join(dir, "rover.wendoo");
  await writeProjectFiles(dir, { "rover.wendoo": JSON.stringify(document, null, 2) });
  return file;
}

async function readManifest(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(dir, "wendoo.json"), "utf8")) as Record<string, unknown>;
}

describe("wendoo unpack", () => {
  it("writes the document contents and the embedded manifest with a synthesized files list", async () => {
    const root = await scratch();
    const document = sampleDocument();
    const file = await writeDocument(root, document);
    const target = path.join(root, "unpacked");

    const result = await runCliBin(root, "unpack", file, target);

    assert.equal(result.code, 0, result.stderr);

    assert.deepEqual(await listProjectFiles(target), ["assets/logo.svg", "notes.txt", "tiles/probe.ts", "wendoo.json"]);
    assert.equal(await readFile(path.join(target, "tiles/probe.ts"), "utf8"), TILE_SOURCE);
    assert.equal(await readFile(path.join(target, "assets/logo.svg"), "utf8"), SVG_ASSET);

    const embedded = document.manifest as Record<string, unknown>;
    const manifest = await readManifest(target);
    assert.equal(manifest.name, "Rover");
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.description, "A rover project");
    assert.deepEqual(manifest.files, ["tiles/probe.ts", "assets/logo.svg", "notes.txt"]);
    assert.deepEqual(manifest.extensions, embedded.extensions);
    assert.equal(JSON.stringify(manifest.brains), JSON.stringify(embedded.brains));
    assert.equal(JSON.stringify(manifest.app), JSON.stringify(embedded.app));
    assert.equal("format" in manifest, false);
    assert.equal("contents" in manifest, false);
  });

  it("seeds a compatibility target when the manifest declares one registry target", async () => {
    const root = await scratch();
    const document = sampleDocument();
    (document.manifest as Record<string, unknown>).extensions = {
      "wendoo-lang/trg-ecosim": "embedded:wendoo-lang/trg-ecosim",
    };
    const file = await writeDocument(root, document);
    const target = path.join(root, "unpacked");

    const result = await runCliBin(root, "unpack", file, target);

    assert.equal(result.code, 0, result.stderr);
    const manifest = await readManifest(target);
    assert.deepEqual(manifest.targets, { "wendoo-lang/trg-ecosim": { packageVersion: "^0.1.5" } });
  });

  it("writes no targets section when the manifest declares no registry target", async () => {
    const root = await scratch();
    const file = await writeDocument(root, sampleDocument());
    const target = path.join(root, "unpacked");

    const result = await runCliBin(root, "unpack", file, target);

    assert.equal(result.code, 0, result.stderr);
    assert.equal("targets" in (await readManifest(target)), false);
  });

  it("preserves a files list the embedded manifest declares", async () => {
    const root = await scratch();
    const document = sampleDocument();
    (document.manifest as Record<string, unknown>).files = ["tiles/probe.ts"];
    const file = await writeDocument(root, document);
    const target = path.join(root, "unpacked");

    const result = await runCliBin(root, "unpack", file, target);

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /prune wendoo\.json/);
    const manifest = await readManifest(target);
    assert.deepEqual(manifest.files, ["tiles/probe.ts"]);
  });

  it("records the published identity when --coordinate is given and refuses a malformed one", async () => {
    const root = await scratch();
    const file = await writeDocument(root, sampleDocument());

    const malformed = await runCliBin(root, "unpack", file, path.join(root, "a"), "--coordinate", "not-a-coordinate");
    assert.equal(malformed.code, 1);
    assert.match(malformed.stderr, /UNPACK_INVALID_COORDINATE/);
    assert.equal(existsSync(path.join(root, "a")), false);

    const target = path.join(root, "b");
    const result = await runCliBin(root, "unpack", file, target, "--coordinate", "example-org/rover");
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readManifest(target)).identity, "example-org/rover");
  });

  it("defaults the target directory to the document's base name", async () => {
    const root = await scratch();
    await writeDocument(root, sampleDocument());

    const result = await runCliBin(root, "unpack", "rover.wendoo");

    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readManifest(path.join(root, "rover"))).name, "Rover");
  });

  it("refuses a missing or unreadable document", async () => {
    const root = await scratch();
    const result = await runCliBin(root, "unpack", path.join(root, "ghost.wendoo"));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /UNPACK_DOCUMENT_MISSING/);
  });

  it("refuses a document that is not valid JSON or not in the current format", async () => {
    const root = await scratch();
    await writeProjectFiles(root, { "broken.wendoo": "{not json" });
    const notJson = await runCliBin(root, "unpack", path.join(root, "broken.wendoo"));
    assert.equal(notJson.code, 1);
    assert.match(notJson.stderr, /UNPACK_DOCUMENT_INVALID/);

    const retired = {
      format: "wendoo.project",
      name: "Rover",
      description: "",
      files: [{ path: "tiles/probe.ts", content: TILE_SOURCE }],
      brains: {},
      targets: {},
    };
    await writeProjectFiles(root, { "retired.wendoo": JSON.stringify(retired) });
    const invalid = await runCliBin(root, "unpack", path.join(root, "retired.wendoo"));
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /UNPACK_DOCUMENT_INVALID/);
    assert.match(invalid.stderr, /WENDOO_PROJECT_INVALID_FORMAT/);
  });

  it("refuses a document whose embedded manifest is not a valid content manifest", async () => {
    const root = await scratch();
    const document = sampleDocument();
    (document.manifest as Record<string, unknown>).ambient = 5;
    const file = await writeDocument(root, document);

    const result = await runCliBin(root, "unpack", file, path.join(root, "out"));

    assert.equal(result.code, 1);
    assert.match(result.stderr, /UNPACK_DOCUMENT_INVALID/);
    assert.match(result.stderr, /PROJECT_MANIFEST_INVALID_AMBIENT/);
  });

  it("refuses a non-empty target directory unless --force is passed", async () => {
    const root = await scratch();
    const file = await writeDocument(root, sampleDocument());
    const target = path.join(root, "occupied");
    await writeProjectFiles(target, { "existing.txt": "keep\n" });

    const refused = await runCliBin(root, "unpack", file, target);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /UNPACK_TARGET_DIR_NOT_EMPTY/);
    assert.match(refused.stderr, /--force/);

    const forced = await runCliBin(root, "unpack", file, target, "--force");
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(await readFile(path.join(target, "existing.txt"), "utf8"), "keep\n");
    assert.equal((await readManifest(target)).name, "Rover");
  });

  it("refuses a target that exists as a file", async () => {
    const root = await scratch();
    const file = await writeDocument(root, sampleDocument());
    await writeProjectFiles(root, { occupied: "a file, not a directory\n" });

    const result = await runCliBin(root, "unpack", file, path.join(root, "occupied"));

    assert.equal(result.code, 1);
    assert.match(result.stderr, /UNPACK_TARGET_DIR_NOT_EMPTY/);
    assert.match(result.stderr, /not a directory/);
  });
});
