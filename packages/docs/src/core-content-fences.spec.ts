/**
 * Pins that every `brain` fence in the core docs content draws what it names:
 * the fence body parses, and every tile id in it resolves against the core
 * catalog or the fence's own local catalog. An app-only tile id in shared core
 * content resolves in one app and silently draws nothing in the other.
 *
 * The markdown is read from core's source tree, so the sweep sees a content
 * edit without core's `npm run build:docs` having run.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BrainServices, ITileCatalog } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { coreTileDocs } from "@wendoo/core/docs";
import { type BrainFenceRule, buildBrainFenceCatalog, parseBrainFence, resolveBrainFenceTiles } from "./brain-fence";
import { kTileIdPlaceholder } from "./DocsRegistry";

/** Root of the core docs markdown, relative to this module. */
const CORE_CONTENT_DIR = fileURLToPath(new URL("../../core/src/docs/content", import.meta.url));

/** Directory name, under a locale, holding the pages registered as tile entries. */
const TILE_PAGE_DIR = "tiles";

/** Tile id each tile page is registered under, keyed by the page's filename stem. */
const TILE_ID_BY_CONTENT_KEY = new Map(coreTileDocs.map((meta) => [meta.contentKey, meta.tileId]));

/**
 * Tile pages the core manifest names no entry for, so nothing registers them
 * and their tile-id placeholder resolves to nothing. Their fences are outside
 * this sweep. Shrink-only: a manifest entry for one of these takes it off the
 * list and puts its fences under the sweep.
 */
const UNREGISTERED_TILE_PAGES = ["cf-restart-page"];

/** A ```brain fence, capturing the body inside its info line and its closing line. */
const BRAIN_FENCE_RE = /^```brain[^\n]*\n([\s\S]*?)\n```$/gm;

/** One fence found in the content tree, named by the file it came from. */
interface ContentFence {
  /** Path of the markdown file, relative to the content root. */
  file: string;
  /** Ordinal of the fence within that file, counting from one. */
  ordinal: number;
  body: string;
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

/** Whether `file` sits directly under a locale's tile directory. */
function isTilePage(file: string): boolean {
  return path.basename(path.dirname(file)) === TILE_PAGE_DIR;
}

/** Tile id the page at `file` registers under, or undefined for any other page. */
function registeredTileId(file: string): string | undefined {
  return isTilePage(file) ? TILE_ID_BY_CONTENT_KEY.get(path.basename(file, ".md")) : undefined;
}

/** Filename stems of the tile pages under `CORE_CONTENT_DIR` that register under no tile id. */
function unregisteredTilePages(): string[] {
  return markdownFiles(CORE_CONTENT_DIR)
    .filter((file) => isTilePage(file) && registeredTileId(file) === undefined)
    .map((file) => path.basename(file, ".md"))
    .sort();
}

/**
 * Every `brain` fence in the core content tree, in file then document order,
 * with the tile-id placeholder resolved the way the registry resolves it.
 * Pages listed in {@link UNREGISTERED_TILE_PAGES} contribute none.
 */
function coreContentFences(): ContentFence[] {
  const fences: ContentFence[] = [];
  for (const file of markdownFiles(CORE_CONTENT_DIR)) {
    const stem = path.basename(file, ".md");
    if (UNREGISTERED_TILE_PAGES.includes(stem)) continue;
    const tileId = registeredTileId(file);
    const raw = fs.readFileSync(path.join(CORE_CONTENT_DIR, file), "utf-8");
    const markdown = tileId === undefined ? raw : raw.split(kTileIdPlaceholder).join(tileId);
    let ordinal = 0;
    for (const match of markdown.matchAll(BRAIN_FENCE_RE)) {
      ordinal += 1;
      fences.push({ file, ordinal, body: match[1] });
    }
  }
  return fences;
}

/** Every tile id a fence rule names, its own sides first, then its children's. */
function ruleTileIds(rule: BrainFenceRule): string[] {
  return [...(rule.when ?? []), ...(rule.do ?? []), ...(rule.children ?? []).flatMap(ruleTileIds)];
}

let services: BrainServices;
let coreCatalog: ITileCatalog;

before(() => {
  services = __test__createBrainServices();
  coreCatalog = services.edit.tiles;
});

describe("the brain fences in the core docs content", () => {
  test("number at least one", () => {
    assert.ok(coreContentFences().length > 0, `no brain fences found under ${CORE_CONTENT_DIR}`);
  });

  test("cover every tile page except the ones the core manifest registers no entry for", () => {
    assert.deepEqual(unregisteredTilePages(), [...UNREGISTERED_TILE_PAGES].sort());
  });

  test("each parse in one of the shapes the fence grammar names", () => {
    for (const fence of coreContentFences()) {
      assert.ok(parseBrainFence(fence.body), `${fence.file} fence ${fence.ordinal}: body parses in no fence shape`);
    }
  });

  test("name only tile ids the core catalog or their own catalog holds", () => {
    const unresolved: string[] = [];
    for (const fence of coreContentFences()) {
      const parsed = parseBrainFence(fence.body);
      if (!parsed) continue;
      const localCatalog = buildBrainFenceCatalog(parsed.catalogEntries, services);
      const tileIds = parsed.kind === "tiles" ? parsed.tileIds : parsed.rules.flatMap(ruleTileIds);
      for (const tileId of tileIds) {
        if (resolveBrainFenceTiles([tileId], coreCatalog, localCatalog).length === 0) {
          unresolved.push(`${fence.file} fence ${fence.ordinal}: ${tileId}`);
        }
      }
    }
    assert.deepEqual(unresolved, []);
  });
});
