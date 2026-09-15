const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, test } = require("node:test");

/**
 * Closure coverage of a headless build step's declared inputs: every package the
 * step's app reaches through the `file:` dependency graph is named by some
 * declared glob.
 */

const { declaredFiles, generatedFiles, graphGlobs, uncoveredPackages } = require("./build-inputs.js");

/** The repository app whose step this file checks. */
const appDir = join(__dirname, "..", "apps", "ecosim");

describe("declared input closure", () => {
  test("every package in the app's graph is covered by a declared input glob", () => {
    assert.deepEqual(uncoveredPackages(appDir, declaredFiles(appDir)), []);
  });

  test("a package whose globs are dropped is reported as uncovered", () => {
    const withoutDocs = declaredFiles(appDir).filter((glob) => !glob.startsWith("../../packages/docs/"));

    assert.deepEqual(uncoveredPackages(appDir, withoutDocs), ["../../packages/docs"]);
  });

  test("the generated inputs cover the whole graph", () => {
    assert.deepEqual(uncoveredPackages(appDir, generatedFiles(appDir, declaredFiles(appDir))), []);
  });
});

describe("generated inputs", () => {
  test("name each building package's declared outputs and not the ones it leaves undeclared", () => {
    const globs = graphGlobs(appDir);

    assert.ok(globs.includes("../../packages/core/dist/node/**"));
    assert.ok(globs.includes("../../packages/core/dist/esm/**"));
    assert.equal(globs.includes("../../packages/core/dist/tooling/**"), false);
    assert.equal(globs.includes("../../packages/core/dist/rbx/**"), false);
  });

  test("name a source-only package's sources", () => {
    const globs = graphGlobs(appDir);

    assert.ok(globs.includes("../../packages/ui/src/**"));
    assert.equal(globs.includes("../../packages/ui/dist/**"), false);
  });

  test("name no package outside the app's graph", () => {
    assert.equal(
      graphGlobs(appDir).some((glob) => glob.startsWith("../../packages/conformance/")),
      false
    );
  });

  test("keep the app's own globs ahead of the graph's, in the order the app declares them", () => {
    const declared = declaredFiles(appDir);
    const ownGlobs = declared.filter((glob) => !glob.startsWith("../"));

    const generated = generatedFiles(appDir, declared);

    assert.deepEqual(generated.slice(0, ownGlobs.length), ownGlobs);
    assert.deepEqual(generated.slice(ownGlobs.length), graphGlobs(appDir));
  });
});
