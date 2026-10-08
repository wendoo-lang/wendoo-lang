/**
 * Pins the desktop panel's resize arithmetic, where its footprint is
 * published, and which tile entries the Tiles tab lists.
 *
 * The panel publishes its footprint through the shared inset seam in
 * `packages/ui`. The source pin below asserts the panel writes no custom
 * property onto the document root.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DocsRegistry } from "./DocsRegistry";
import { listedTileEntries, panelWidthPctAtPointer, separatorMoveAction } from "./DocsSidebar";

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
