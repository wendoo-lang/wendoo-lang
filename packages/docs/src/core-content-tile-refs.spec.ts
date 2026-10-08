/**
 * Pins that every tile reference in the core docs markdown, read from core's
 * source tree, names a tile the core catalog holds.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ITileCatalog } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";

/** Root of the core docs markdown, relative to this module. */
const CORE_CONTENT_DIR = fileURLToPath(new URL("../../core/src/docs/content", import.meta.url));

/** An inline `tile:<id>` code span, capturing the id. */
const TILE_REF_RE = /`tile:([^`]*)`/g;

/** One tile reference found in the content tree. */
interface ContentTileRef {
  /** Path of the markdown file, relative to the content root. */
  file: string;
  /** The tile id the reference names. */
  tileId: string;
}

/** Every `.md` file under `dir` and its subdirectories, as paths relative to `dir`. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      found.push(...markdownFiles(path.join(dir, entry.name)).map((child) => path.join(entry.name, child)));
    } else if (entry.name.endsWith(".md")) {
      found.push(entry.name);
    }
  }
  return found;
}

/** Every tile reference in the core content tree, in file then document order. */
function coreContentTileRefs(): ContentTileRef[] {
  const refs: ContentTileRef[] = [];
  for (const file of markdownFiles(CORE_CONTENT_DIR)) {
    const markdown = fs.readFileSync(path.join(CORE_CONTENT_DIR, file), "utf-8");
    for (const match of markdown.matchAll(TILE_REF_RE)) {
      refs.push({ file, tileId: match[1] });
    }
  }
  return refs;
}

let coreCatalog: ITileCatalog;

before(() => {
  coreCatalog = __test__createBrainServices().edit.tiles;
});

describe("the tile references in the core docs content", () => {
  test("number at least one", () => {
    assert.ok(coreContentTileRefs().length > 0, `no tile references found under ${CORE_CONTENT_DIR}`);
  });

  test("name only tile ids the core catalog holds", () => {
    const unresolved = coreContentTileRefs()
      .filter((ref) => coreCatalog.get(ref.tileId) === undefined)
      .map((ref) => `${ref.file}: ${ref.tileId}`);
    assert.deepEqual(unresolved, []);
  });
});
