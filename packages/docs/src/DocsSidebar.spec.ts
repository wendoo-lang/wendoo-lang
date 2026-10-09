/**
 * Pins the desktop panel's resize arithmetic, where its footprint is
 * published, which tile entries the Tiles tab lists, and the label and icon
 * it shows for one.
 *
 * The panel publishes its footprint through the shared inset seam in
 * `packages/ui`. The source pin below asserts the panel writes no custom
 * property onto the document root.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { IBrainTileDef, ITileCatalog } from "@wendoo/core/brain";
import type { TileVisual } from "@wendoo/ui/brain-editor/types";
import { DocsRegistry, type DocsTileEntry } from "./DocsRegistry";
import { listedTileEntries, panelWidthPctAtPointer, separatorMoveAction, tileEntryVisual } from "./DocsSidebar";

const sidebarSource = readFileSync(fileURLToPath(new URL("./DocsSidebar.tsx", import.meta.url)), "utf8");

describe("the panel's published footprint", () => {
  test("the panel never writes a custom property onto the document root", () => {
    assert.doesNotMatch(sidebarSource, /documentElement/);
  });
});

describe("panelWidthPctAtPointer", () => {
  test("reads the width between the pointer and the viewport's right edge", () => {
    assert.equal(panelWidthPctAtPointer(1000, 2000), 50);
  });

  test("moving the pointer left widens the panel", () => {
    const narrow = panelWidthPctAtPointer(1600, 2000);
    const wide = panelWidthPctAtPointer(1200, 2000);
    assert.ok(wide > narrow, `${wide} is wider than ${narrow}`);
  });

  test("clamps a pointer past either limit to the panel's own range", () => {
    assert.equal(panelWidthPctAtPointer(1999, 2000), 14);
    assert.equal(panelWidthPctAtPointer(1, 2000), 55);
  });
});

describe("separatorMoveAction", () => {
  test("a move arriving with no drag recorded touches nothing", () => {
    assert.equal(separatorMoveAction(false, 1), "ignore");
    assert.equal(separatorMoveAction(false, 0), "ignore");
  });

  test("a move with a button held moves the panel edge", () => {
    assert.equal(separatorMoveAction(true, 1), "resize");
  });

  test("a move with a non-primary button held moves the panel edge", () => {
    assert.equal(separatorMoveAction(true, 2), "resize");
  });

  test("a move with no button held ends the drag instead of moving the edge", () => {
    assert.equal(separatorMoveAction(true, 0), "end");
  });
});

describe("the separator's drag end", () => {
  test("a pointer up, a pointer cancel and a lost pointer capture each end the drag", () => {
    for (const prop of ["onPointerUp", "onPointerCancel", "onLostPointerCapture"]) {
      assert.match(sidebarSource, new RegExp(`${prop}=\\{handleSeparatorDragEnd\\}`));
    }
  });
});

describe("listedTileEntries", () => {
  const kListedTileId = "tile.sensor->listed";
  const kUnlistedTileId = "tile.sensor->unlisted";
  const kSharedContent = "sharedterm";

  /** A registry holding one entry carrying a category and one carrying none, both holding {@link kSharedContent}. */
  function listingRegistry(): DocsRegistry {
    const registry = new DocsRegistry();
    registry.register({
      tiles: [
        { tileId: kListedTileId, tags: [], category: "Sensors", content: kSharedContent },
        { tileId: kUnlistedTileId, tags: [], content: kSharedContent },
      ],
    });
    return registry;
  }

  /** The tile ids of the entries listed for `search` over {@link listingRegistry}. */
  function listedIds(search: string): string[] {
    return listedTileEntries(listingRegistry(), undefined, search, (tileId) => tileId).map((entry) => entry.tileId);
  }

  test("lists an entry carrying a category, and not one carrying none, while browsing", () => {
    assert.deepEqual(listedIds(""), [kListedTileId]);
  });

  test("lists no entry carrying no category among search results, by content or by tile id", () => {
    assert.deepEqual(listedIds(kSharedContent), [kListedTileId]);
    assert.deepEqual(listedIds(kUnlistedTileId), []);
  });
});

describe("tileEntryVisual", () => {
  const kHeldTileId = "tile.var.factory->struct:<Held>";
  const kUnheldTileId = "tile.var.factory->struct:<Unheld>";
  const kTileVisual = { label: "held tile label", iconUrl: "data:image/png;base64,dGlsZQ==" };
  const kEntryVisual = { label: "entry label", iconUrl: "data:image/png;base64,ZW50cnk=" };

  /** A catalog holding one tile, under {@link kHeldTileId}. */
  const catalog = {
    get: (tileId: string) => (tileId === kHeldTileId ? ({ tileId, kind: "factory" } as IBrainTileDef) : undefined),
  } as ITileCatalog;

  /** Resolves every tile to {@link kTileVisual}. */
  const resolve = (): TileVisual => kTileVisual;

  /** An entry under `tileId`, carrying {@link kEntryVisual} as its own label and icon. */
  function carrying(tileId: string): DocsTileEntry {
    return { tileId, tags: [], content: "", ...kEntryVisual };
  }

  test("shows a held tile's own label and icon, whatever the entry carries", () => {
    assert.deepEqual(tileEntryVisual(catalog, resolve, kHeldTileId, carrying(kHeldTileId)), kTileVisual);
  });

  test("shows the label and icon an entry carries while the catalog holds no tile under its id", () => {
    assert.deepEqual(tileEntryVisual(catalog, resolve, kUnheldTileId, carrying(kUnheldTileId)), kEntryVisual);
  });

  test("shows an entry carrying neither, whose tile the catalog does not hold, by its id's last segment and no icon", () => {
    const bare: DocsTileEntry = { tileId: kUnheldTileId, tags: [], content: "" };
    assert.deepEqual(tileEntryVisual(catalog, resolve, kUnheldTileId, bare), {
      label: "struct:<Unheld>",
      iconUrl: undefined,
    });
  });
});
