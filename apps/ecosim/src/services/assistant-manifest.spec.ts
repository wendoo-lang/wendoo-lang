/**
 * Pins what this app declares to a service at the handshake: the target it is,
 * the bridge tools it answers, and a catalog fingerprint that is the digest's
 * own hash of the tiles its adapter installs.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CatalogScope,
  catalogDigest,
  catalogTiles,
  catalogTilesInScope,
  createAuthoringWorkspace,
  readCatalog,
  toolDefinitions,
} from "@wendoo/assistant-bridge";
import { assistantToolManifest } from "@wendoo/assistant-bridge/relay";
import { createTargetAdapter } from "@/rehearsal/adapter";
import { sourceRehearsalContent } from "@/rehearsal/source-content";

/** The app's own assets, read from the tree these specs run in. */
const CONTENT = sourceRehearsalContent();

describe("the manifest this app opens a session with", () => {
  test("asks for the target its adapter is", () => {
    const adapter = createTargetAdapter(CONTENT);

    assert.equal(assistantToolManifest(adapter).target, adapter.targetIdentity);
    assert.equal(assistantToolManifest(adapter).morphology, false);
  });

  test("declares every bridge tool, in ascending order", () => {
    const declared = assistantToolManifest(createTargetAdapter(CONTENT)).tools;

    assert.deepEqual([...declared], [...declared].sort());
    assert.deepEqual(
      [...declared],
      toolDefinitions.map((tool) => tool.name)
    );
  });

  test("fingerprints the tiles its adapter installs, and nothing a document minted", () => {
    const adapter = createTargetAdapter(CONTENT);
    const view = readCatalog(createAuthoringWorkspace(adapter, "catalog"), {});
    const environment = catalogTilesInScope(view, CatalogScope.Environment);

    const declared = assistantToolManifest(adapter).catalogDigest;

    assert.ok(environment.length > 0, "the adapter installs tiles to fingerprint");
    assert.equal(declared, catalogDigest(environment).hash);
    assert.notEqual(
      catalogDigest(catalogTiles(view)).hash,
      declared,
      "a document's own tiles would have moved the fingerprint"
    );
  });

  test("declares the same fingerprint for every build of the same adapter", () => {
    const declared = assistantToolManifest(createTargetAdapter(CONTENT)).catalogDigest;

    assert.equal(assistantToolManifest(createTargetAdapter(CONTENT)).catalogDigest, declared);
    assert.equal(declared.length, 8);
  });
});
