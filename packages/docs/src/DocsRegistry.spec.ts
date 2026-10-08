import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DocsRegistry, kTileIdPlaceholder } from "./DocsRegistry";

const kButtonTileId = "tile.sensor->microbit-v2.button-a";

describe("DocsRegistry tile content templating", () => {
  test("replaces the tile-id placeholder in registered tile content with the entry's tile id", () => {
    const registry = new DocsRegistry();
    registry.register({
      tiles: [
        {
          tileId: kButtonTileId,
          tags: [],
          category: "Sensors",
          content: `\`\`\`brain noframe when\n{ "tile": "${kTileIdPlaceholder}" }\n\`\`\`\n\n# Button A\n`,
        },
      ],
    });
    const content = registry.tiles.get(kButtonTileId)?.content;
    assert.ok(content);
    assert.ok(content.includes(`{ "tile": "${kButtonTileId}" }`));
    assert.equal(content.includes(kTileIdPlaceholder), false);
  });

  test("substitutes every occurrence, not just the first", () => {
    const registry = new DocsRegistry();
    registry.register({
      tiles: [
        {
          tileId: kButtonTileId,
          tags: [],
          category: "Sensors",
          content: `{ "tile": "${kTileIdPlaceholder}" }\n{ "tiles": ["${kTileIdPlaceholder}"] }`,
        },
      ],
    });
    const content = registry.tiles.get(kButtonTileId)?.content ?? "";
    assert.equal(content.includes(kTileIdPlaceholder), false);
    assert.equal(content.split(kButtonTileId).length - 1, 2);
  });

  test("leaves tile content without the placeholder unchanged", () => {
    const registry = new DocsRegistry();
    const literal = '```brain noframe when\n{ "tile": "tile.modifier->microbit-v2.click" }\n```\n';
    registry.register({
      tiles: [{ tileId: kButtonTileId, tags: [], category: "Sensors", content: literal }],
    });
    assert.equal(registry.tiles.get(kButtonTileId)?.content, literal);
  });
});

describe("DocsRegistry unlisted tile entries", () => {
  const kListedTileId = "tile.sensor->listed";
  const kUnlistedTileId = "tile.sensor->unlisted";

  /** A registry holding one entry carrying a category and one carrying none. */
  function listingRegistry(): DocsRegistry {
    const registry = new DocsRegistry();
    registry.register({
      tiles: [
        { tileId: kListedTileId, tags: [], category: "Sensors", content: "listed" },
        { tileId: kUnlistedTileId, tags: [], content: "unlisted" },
      ],
    });
    return registry;
  }

  test("contribute no tile category", () => {
    assert.deepEqual(listingRegistry().tileCategories, ["Sensors"]);
  });

  test("are held under their tile id", () => {
    assert.equal(listingRegistry().tiles.get(kUnlistedTileId)?.tileId, kUnlistedTileId);
  });
});
