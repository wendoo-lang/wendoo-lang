/**
 * Pins that a tile entry carrying no category, which no list shows, still
 * opens by its tile id: the detail view the standalone page opens a
 * `/docs/tiles/<tileId>` URL at, and a `tile:` reference or a tile's docs
 * action navigates to.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocsRegistry } from "./DocsRegistry";
import { DocsPanelContent } from "./DocsSidebar";
import { DocsSidebarProvider } from "./DocsSidebarContext";

const kUnlistedTileId = "tile.sensor->unlisted";

/** A registry holding one entry carrying no category, under {@link kUnlistedTileId}. */
function unlistedRegistry(): DocsRegistry {
  const registry = new DocsRegistry();
  registry.register({ tiles: [{ tileId: kUnlistedTileId, tags: [], content: "unlisted" }] });
  return registry;
}

/** The panel over {@link unlistedRegistry}, opened at the tile entry `navKey`, or at the list when it is `null`. */
function renderPanel(navKey: string | null): string {
  return renderToStaticMarkup(
    <DocsSidebarProvider registry={unlistedRegistry()} initialNavKey={navKey} initialNavTab={navKey ? "tiles" : null}>
      <DocsPanelContent />
    </DocsSidebarProvider>
  );
}

describe("an unlisted tile entry", () => {
  test("opens at its detail view by its tile id", () => {
    const html = renderPanel(kUnlistedTileId);
    assert.match(html, /<article[\s>]/);
    assert.doesNotMatch(html, /role="tabpanel"/);
  });

  test("has no link in the list view", () => {
    const html = renderPanel(null);
    assert.match(html, /role="tabpanel"/);
    assert.equal(html.includes(encodeURIComponent(kUnlistedTileId)), false);
  });
});
