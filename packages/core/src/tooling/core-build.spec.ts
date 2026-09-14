import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { DEV_TARGET_PACKAGE_VERSION } from "../build-identity.js";
import { createClientBuild, describeCoreBuild, readCoreBuild } from "./core-build.js";

/** Temporary trees this file created, removed once it finishes. */
const roots: string[] = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Version the fixture language package declares for itself. */
const languageVersion = "1.2.3";

/** The Node build output of the fixture language package, keyed by path under it. */
const builtLanguage: Readonly<Record<string, string>> = {
  "index.js": "exports.think = 1;\n",
  "index.d.ts": "export declare const think: number;\n",
  "index.js.map": '{"version":3}\n',
  "brain/rules.js": "exports.armed = true;\n",
};

/** Write `content` at `path`, creating the directories above it. */
async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

/**
 * A fresh tree holding a root package that depends on a local language package
 * carrying `output` as its Node build, returning the root package directory.
 * A language package with no `output` at all is written without a build.
 */
async function tree(output: Readonly<Record<string, string>> = builtLanguage, prefix = "stamp-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await write(
    join(root, "package.json"),
    JSON.stringify({ name: "root", dependencies: { "@wendoo/core": "file:./core" } })
  );
  await write(join(root, "core", "package.json"), JSON.stringify({ name: "@wendoo/core", version: languageVersion }));
  for (const [path, content] of Object.entries(output)) {
    await write(join(root, "core", "dist", "node", ...path.split("/")), content);
  }
  return root;
}

/** The hash of a tree holding `output` as its language build. */
async function hashOf(output: Readonly<Record<string, string>>): Promise<string> {
  return (await readCoreBuild(await tree(output))).coreDistHash;
}

describe("reading the language build a package consumes", () => {
  test("reports the version the language package declares", async () => {
    const build = await readCoreBuild(await tree());

    assert.equal(build.coreVersion, languageVersion);
    assert.match(build.coreDistHash, /^[0-9a-f]{64}$/);
  });

  test("hashes the same content in another location the same", async () => {
    const [first, second] = [await hashOf(builtLanguage), await hashOf(builtLanguage)];

    assert.equal(first, second);
  });

  test("hashes differently when a script's content changes", async () => {
    const changed = { ...builtLanguage, "brain/rules.js": "exports.armed = false;\n" };

    assert.notEqual(await hashOf(changed), await hashOf(builtLanguage));
  });

  test("hashes differently when a script moves", async () => {
    const elsewhere = Object.fromEntries(
      Object.entries(builtLanguage).map(([path, content]) =>
        path === "brain/rules.js" ? ["brain/triggers.js", content] : [path, content]
      )
    );

    assert.notEqual(await hashOf(elsewhere), await hashOf(builtLanguage));
  });

  test("hashes differently when a script is added", async () => {
    const added = { ...builtLanguage, "brain/modes.js": "exports.otherwise = 1;\n" };

    assert.notEqual(await hashOf(added), await hashOf(builtLanguage));
  });

  test("hashes the same when output that is not a script changes", async () => {
    const retyped = { ...builtLanguage, "index.d.ts": "export declare const think: 1 | 2;\n" };

    assert.equal(await hashOf(retyped), await hashOf(builtLanguage));
  });

  test("reports a package that reaches no language package", async () => {
    const root = await mkdtemp(join(tmpdir(), "stamp-bare-"));
    roots.push(root);
    await write(join(root, "package.json"), JSON.stringify({ name: "root" }));

    assert.throws(() => readCoreBuild(root), /@wendoo\/core/);
  });

  test("reports a language package that was never built", async () => {
    const root = await tree({}, "stamp-unbuilt-");

    assert.throws(() => readCoreBuild(root), /dist\/node/);
  });
});

describe("the language output the hash covers", () => {
  /** This package's own directory, whose build output the assertions below read. */
  const coreDir = resolve(__dirname, "..", "..");

  test("holds none of the build tooling that computes the hash", () => {
    const languageOutput = join(coreDir, "dist", "node");

    assert.ok(existsSync(join(languageOutput, "index.js")), "the language build is built");
    assert.ok(existsSync(join(coreDir, "dist", "tooling", "index.js")), "the tooling build is built");
    assert.deepEqual(
      readdirSync(languageOutput).filter((entry) => entry === "tooling"),
      []
    );
  });
});

describe("the build a host app bundle states of itself", () => {
  test("carries the version it is given and the hash of the language build it bundles", async () => {
    const root = await tree();

    const build = createClientBuild(root, "0.4.2");

    assert.equal(build.targetPackageVersion, "0.4.2");
    assert.equal(build.coreDistHash, (await readCoreBuild(root)).coreDistHash);
  });

  test("carries the dev version for a bundle built outside a release", async () => {
    const root = await tree();

    assert.equal(createClientBuild(root, DEV_TARGET_PACKAGE_VERSION).targetPackageVersion, "dev");
  });
});

describe("a language build said as one phrase", () => {
  test("names the version and the head of the dist hash", () => {
    const phrase = describeCoreBuild({ coreVersion: "1.2.3", coreDistHash: "0123456789abcdef0123456789abcdef" });

    assert.ok(phrase.includes("1.2.3"), "the phrase names the version");
    assert.ok(phrase.includes("0123456789ab"), "the phrase names the head of the hash");
    assert.equal(phrase.includes("0123456789abc"), false, "the phrase quotes no more of the hash than that");
  });
});
