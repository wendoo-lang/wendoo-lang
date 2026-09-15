import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { AssembleCommandErrorCode } from "./assemble-command.js";
import { makeScratchDir, runCliBin, writeProjectFiles } from "./test-support/publish-fixtures.js";

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

/** A `wendooTarget` declaration naming `hostAppPath` and `adapterPath`. */
function declaration(hostAppPath = "dist", adapterPath = "dist-headless/rehearsal/adapter.js"): unknown {
  return {
    packageScript: "package",
    hostApp: { path: hostAppPath, script: "build" },
    rehearsalAdapter: { path: adapterPath, script: "build:headless" },
  };
}

/** Write an app directory whose package.json carries `wendooTarget`, plus `files`. */
async function writeApp(dir: string, wendooTarget: unknown, files: Record<string, string> = {}): Promise<void> {
  await writeProjectFiles(dir, {
    "package.json": JSON.stringify({ name: "@wendoo/example", version: "1.0.0", wendooTarget }, null, 2),
    ...files,
  });
}

const SOURCE_MANIFEST = JSON.stringify({ name: "Example", version: "0.1.0", identity: "example-org/trg-example" });

describe("wendoo assemble argument handling", () => {
  it("refuses an unexpected argument", async () => {
    const app = await scratch();
    const result = await runCliBin(app, "assemble", "--nope");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unexpected argument/);
  });

  it("refuses --dir without a value", async () => {
    const app = await scratch();
    const result = await runCliBin(app, "assemble", "--dir");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires a value/);
  });
});

describe("wendoo assemble declaration reading", () => {
  it("refuses an app whose package.json declares no wendooTarget", async () => {
    const app = await scratch();
    await writeProjectFiles(app, { "package.json": JSON.stringify({ name: "@wendoo/example" }) });
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.DECLARATION_UNUSABLE));
  });

  it("refuses every malformed wendooTarget shape", async () => {
    const cases: unknown[] = [
      "not-an-object",
      {},
      { packageScript: "package" },
      { packageScript: "", hostApp: { path: "dist", script: "build" } },
      { packageScript: "package", hostApp: { path: "dist" }, rehearsalAdapter: { path: "a.js", script: "b" } },
      {
        packageScript: "package",
        hostApp: { path: "", script: "build" },
        rehearsalAdapter: { path: "a.js", script: "b" },
      },
      { packageScript: "package", hostApp: { path: "dist", script: "build" }, rehearsalAdapter: { path: "a.js" } },
    ];
    for (const wendooTarget of cases) {
      const app = await scratch();
      await writeApp(app, wendooTarget);
      const result = await runCliBin(app, "assemble");
      assert.equal(result.code, 1, JSON.stringify(wendooTarget));
      assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.DECLARATION_UNUSABLE));
    }
  });
});

describe("wendoo assemble input checks", () => {
  it("refuses an app with no source manifest", async () => {
    const app = await scratch();
    await writeApp(app, declaration(), { "dist/index.html": "<!doctype html>" });
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.SOURCE_MANIFEST_MISSING));
  });

  it("refuses a source manifest that declares no identity", async () => {
    const app = await scratch();
    await writeApp(app, declaration(), {
      "wendoo.json": JSON.stringify({ name: "Example", version: "0.1.0" }),
      "dist/index.html": "<!doctype html>",
    });
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.SOURCE_MANIFEST_UNUSABLE));
  });

  it("refuses when the declared host app output is absent", async () => {
    const app = await scratch();
    await writeApp(app, declaration(), { "wendoo.json": SOURCE_MANIFEST });
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.HOST_APP_MISSING));
    assert.match(result.stderr, /npm run build/);
  });

  it("refuses when the declared host app output is an empty directory", async () => {
    const app = await scratch();
    await writeApp(app, declaration(), { "wendoo.json": SOURCE_MANIFEST, "dist/placeholder": "" });
    await rm(path.join(app, "dist", "placeholder"));
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.HOST_APP_MISSING));
  });

  it("refuses when the declared host app output is absent even though the conventional one is not", async () => {
    const app = await scratch();
    await writeApp(app, declaration("build-output"), {
      "wendoo.json": SOURCE_MANIFEST,
      "dist/index.html": "<!doctype html>",
    });
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.HOST_APP_MISSING));
    assert.match(result.stderr, /build-output/);
  });

  it("refuses when the declared adapter artifact is absent", async () => {
    const app = await scratch();
    await writeApp(app, declaration(), { "wendoo.json": SOURCE_MANIFEST, "dist/index.html": "<!doctype html>" });
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.ADAPTER_MISSING));
    assert.match(result.stderr, /npm run build:headless/);
  });

  it("reads the artifact paths and scripts the app declares rather than fixed ones", async () => {
    const app = await scratch();
    await writeApp(app, declaration("build-output", "artifacts/headless.js"), {
      "wendoo.json": SOURCE_MANIFEST,
      "build-output/index.html": "<!doctype html>",
      "dist-headless/rehearsal/adapter.js": "export const createTargetAdapter = () => ({});\n",
    });
    const result = await runCliBin(app, "assemble");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(AssembleCommandErrorCode.ADAPTER_MISSING));
    assert.match(result.stderr, /artifacts\/headless\.js/);
  });
});
