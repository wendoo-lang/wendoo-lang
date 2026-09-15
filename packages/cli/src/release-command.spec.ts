import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { PackagedVersionCheckCode, TARGET_PACKAGE_DIR_NAME } from "@wendoo/app-host/tooling";
import type { ReleaseCommandEffects } from "./release-command.js";
import { ReleaseCommandErrorCode, runReleaseCommand } from "./release-command.js";
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

/** What a stage asked of the world outside the project directory, in call order. */
interface RecordedEffects extends ReleaseCommandEffects {
  /** One entry per app script run, as `<script>@<version the source manifest carried at the time>`. */
  readonly scripts: string[];
  /** One entry per package publish, holding the directory it was given. */
  readonly published: string[];
}

/**
 * Effects that record what they were asked to do and report `status` from the
 * app script and `publishCode` from the publish. They reach no build and no
 * remote.
 */
function recordEffects(appDir: string, status = 0, publishCode = 0): RecordedEffects {
  const scripts: string[] = [];
  const published: string[] = [];
  return {
    scripts,
    published,
    runAppScript: (dir, script) => {
      assert.equal(dir, appDir);
      const manifest = JSON.parse(readFileSync(path.join(dir, "wendoo.json"), "utf8")) as { version: string };
      scripts.push(`${script}@${manifest.version}`);
      return status;
    },
    publishPackage: async (packageDir) => {
      published.push(packageDir);
      return publishCode;
    },
  };
}

const DECLARATION = {
  packageScript: "package",
  hostApp: { path: "dist", script: "build" },
  rehearsalAdapter: { path: "dist-headless/rehearsal/adapter.js", script: "build:headless" },
};

/** Write a target app directory at `version`, with an assembled package at `packagedVersion` when given. */
async function writeApp(dir: string, version: string, packagedVersion?: string): Promise<void> {
  await writeProjectFiles(dir, {
    "package.json": JSON.stringify({ name: "@wendoo/example", version: "1.0.0", wendooTarget: DECLARATION }, null, 2),
    "wendoo.json": JSON.stringify({ name: "Example", version, identity: "example-org/trg-example" }, null, 2),
    ...(packagedVersion === undefined
      ? {}
      : {
          [`${TARGET_PACKAGE_DIR_NAME}/wendoo.json`]: JSON.stringify({
            name: "Example",
            version: packagedVersion,
            identity: "example-org/trg-example",
            buildVersion: packagedVersion,
          }),
        }),
  });
}

async function readVersion(dir: string): Promise<string> {
  return (JSON.parse(await readFile(path.join(dir, "wendoo.json"), "utf8")) as { version: string }).version;
}

describe("wendoo release argument handling", () => {
  it("refuses a missing or unknown stage", async () => {
    const app = await scratch();
    for (const args of [[], ["ship"]]) {
      const result = await runCliBin(app, "release", ...args);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /wendoo release/);
    }
  });

  it("refuses prepare without a version component", async () => {
    const app = await scratch();
    const result = await runCliBin(app, "release", "prepare");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /patch, minor, or major/);
  });

  it("refuses an argument the publish stage does not take", async () => {
    const app = await scratch();
    const result = await runCliBin(app, "release", "publish", "patch");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unexpected argument/);
  });
});

describe("wendoo release prepare", () => {
  it("bumps the source manifest, then runs the declared package script at the new version", async () => {
    const app = await scratch();
    await writeApp(app, "0.1.7");
    const effects = recordEffects(app);

    const code = await runReleaseCommand(["prepare", "minor", "--dir", app], effects);

    assert.equal(code, 0);
    assert.equal(await readVersion(app), "0.2.0");
    // The recorded version pins the ordering: the bump landed before the script ran.
    assert.deepEqual(effects.scripts, ["package@0.2.0"]);
  });

  it("runs the package script the app declares", async () => {
    const app = await scratch();
    await writeApp(app, "0.1.7");
    await writeProjectFiles(app, {
      "package.json": JSON.stringify(
        { name: "@wendoo/example", wendooTarget: { ...DECLARATION, packageScript: "bundle:target" } },
        null,
        2
      ),
    });
    const effects = recordEffects(app);

    const code = await runReleaseCommand(["prepare", "patch", "--dir", app], effects);

    assert.equal(code, 0);
    assert.deepEqual(effects.scripts, ["bundle:target@0.1.8"]);
  });

  it("reports the package script's exit code when it fails", async () => {
    const app = await scratch();
    await writeApp(app, "0.1.7");
    const effects = recordEffects(app, 3);

    const code = await runReleaseCommand(["prepare", "patch", "--dir", app], effects);

    assert.equal(code, 3);
  });

  it("refuses an app that declares no wendooTarget, leaving the version alone", async () => {
    const app = await scratch();
    await writeProjectFiles(app, {
      "package.json": JSON.stringify({ name: "@wendoo/example" }),
      "wendoo.json": JSON.stringify({ name: "Example", version: "0.1.7" }),
    });
    const result = await runCliBin(app, "release", "prepare", "patch");
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(ReleaseCommandErrorCode.DECLARATION_UNUSABLE));
    assert.equal(await readVersion(app), "0.1.7");
  });
});

describe("wendoo release publish", () => {
  it("publishes the assembled package directory once it carries the source version", async () => {
    const app = await scratch();
    await writeApp(app, "0.1.7", "0.1.7");
    const effects = recordEffects(app);

    const code = await runReleaseCommand(["publish", "--dir", app], effects);

    assert.equal(code, 0);
    assert.deepEqual(effects.published, [path.join(app, TARGET_PACKAGE_DIR_NAME)]);
  });

  it("reports the publish's exit code", async () => {
    const app = await scratch();
    await writeApp(app, "0.1.7", "0.1.7");
    const effects = recordEffects(app, 0, 1);

    assert.equal(await runReleaseCommand(["publish", "--dir", app], effects), 1);
  });

  it("refuses and publishes nothing when the assembled package is stale", async () => {
    const app = await scratch();
    await writeApp(app, "0.1.8", "0.1.7");
    const effects = recordEffects(app);

    const code = await runReleaseCommand(["publish", "--dir", app], effects);

    assert.equal(code, 1);
    assert.deepEqual(effects.published, []);

    const viaBin = await runCliBin(app, "release", "publish");
    assert.equal(viaBin.code, 1);
    assert.match(viaBin.stderr, new RegExp(PackagedVersionCheckCode.VERSION_STALE));
  });

  it("refuses and publishes nothing when no package is assembled", async () => {
    const app = await scratch();
    await writeApp(app, "0.1.7");
    const effects = recordEffects(app);

    const code = await runReleaseCommand(["publish", "--dir", app], effects);

    assert.equal(code, 1);
    assert.deepEqual(effects.published, []);

    const viaBin = await runCliBin(app, "release", "publish");
    assert.equal(viaBin.code, 1);
    assert.match(viaBin.stderr, new RegExp(PackagedVersionCheckCode.PACKAGE_MISSING));
  });
});
