import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { catalogDigest } from "../catalog/digest.js";
import { CatalogScope } from "../catalog/scope.js";
import { createTargetAdapter } from "../testing/index.js";
import type { CatalogTile } from "../tools/read-catalog.js";
import { readServedCatalog } from "./served-catalog.js";
import { environmentTiles } from "./tool-manifest.js";

/** The tiles the fake target installs, as a session states them. */
function servedTiles(): readonly CatalogTile[] {
  return environmentTiles(createTargetAdapter());
}

/** `tiles` as one environment group, put through the JSON a served answer travels as. */
function overTheWire(tiles: readonly CatalogTile[]): unknown {
  return JSON.parse(JSON.stringify({ groups: [{ scope: CatalogScope.Environment, tiles }], total: tiles.length }));
}

/** The environment tiles `readServedCatalog` reads back out of `payload`. */
function readBack(payload: unknown): readonly CatalogTile[] {
  const groups = readServedCatalog(payload);
  assert.ok(groups, "the payload reads as a catalog");
  return groups.find((group) => group.scope === CatalogScope.Environment)?.tiles ?? [];
}

describe("a catalog read off the wire", () => {
  test("digests to the bytes and the hash the client that answered digests the same tiles to", () => {
    const tiles = servedTiles();
    const declared = catalogDigest(tiles);

    const served = catalogDigest(readBack(overTheWire(tiles)));

    assert.ok(declared.tileCount > 0, "the target lists tiles");
    assert.equal(served.tileCount, declared.tileCount);
    assert.equal(served.text, declared.text);
    assert.equal(served.hash, declared.hash);
  });

  test("agrees on a tile carrying a field this build does not declare", () => {
    const [first, ...rest] = servedTiles();
    assert.ok(first, "the target lists tiles");
    const richer = [{ ...first, lineage: "grown" } as CatalogTile, ...rest];
    const declared = catalogDigest(richer);

    const served = catalogDigest(readBack(overTheWire(richer)));

    assert.ok(declared.text.includes('"lineage":"grown"'), "the client writes the field it carries");
    assert.ok(served.text.includes('"lineage":"grown"'), "the served text carries it too");
    assert.equal(served.text, declared.text);
    assert.equal(served.hash, declared.hash);
  });

  test("reads no catalog out of an answer that is not one", () => {
    const tiles = servedTiles();
    const [first] = tiles;
    assert.ok(first, "the target lists tiles");
    const withoutPlacement = { ...first, placement: undefined };

    assert.equal(readServedCatalog({}), undefined);
    assert.equal(readServedCatalog({ tiles, total: tiles.length }), undefined);
    assert.equal(readServedCatalog({ groups: [{ scope: "sideways", tiles }] }), undefined);
    assert.equal(
      readServedCatalog({ groups: [{ scope: CatalogScope.Environment, tiles: [withoutPlacement] }] }),
      undefined
    );
  });
});
