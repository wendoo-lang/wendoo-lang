/**
 * Pins how the print view resolves a concept reference against the registry:
 * a concept the registry holds prints as its registered title alone, and one
 * it does not hold prints as the id it names. Also pins how it resolves a tile
 * reference no catalog tile stands for: an entry carrying a label prints as
 * that label, and one carrying none as the id it names.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocsPrintView } from "./DocsPrintView";
import { DocsRegistry } from "./DocsRegistry";
import { DocsSidebarProvider } from "./DocsSidebarContext";

const REGISTERED_CONCEPT_ID = "registered-concept";
const UNREGISTERED_CONCEPT_ID = "unregistered-concept";

/** A registry holding one concept page, under {@link REGISTERED_CONCEPT_ID}. */
function conceptRegistry(): DocsRegistry {
  const registry = new DocsRegistry();
  registry.register({
    concepts: [{ id: REGISTERED_CONCEPT_ID, title: "registered-concept-title", tags: [], content: "" }],
  });
  return registry;
}

/** The print view of a one-paragraph page holding nothing but a reference to concept `id`. */
function renderReference(id: string, registry: DocsRegistry): string {
  return renderToStaticMarkup(
    <DocsSidebarProvider registry={registry}>
      <DocsPrintView content={`\`concept:${id}\`\n`} />
    </DocsSidebarProvider>
  );
}

/** The text the page's one paragraph holds, tags included. */
function paragraphBody(html: string): string | undefined {
  return /<p class="docs-print-p">(.*)<\/p>/.exec(html)?.[1];
}

describe("a concept reference in the print view", () => {
  test("prints, for a concept the registry holds, the registered title alone", () => {
    const registry = conceptRegistry();

    assert.equal(
      paragraphBody(renderReference(REGISTERED_CONCEPT_ID, registry)),
      registry.concepts.get(REGISTERED_CONCEPT_ID)?.title
    );
  });

  test("prints, for a concept the registry does not hold, the id it names as code", () => {
    assert.equal(
      paragraphBody(renderReference(UNREGISTERED_CONCEPT_ID, conceptRegistry())),
      `<code class="docs-print-code-inline">${UNREGISTERED_CONCEPT_ID}</code>`
    );
  });
});

const LABELLED_ENTRY_ID = "tile.labelled-entry";
const BARE_ENTRY_ID = "tile.bare-entry";

/**
 * A registry holding two tile entries no tile catalog holds a tile for: one
 * carrying a label, under {@link LABELLED_ENTRY_ID}, and one carrying none,
 * under {@link BARE_ENTRY_ID}.
 */
function entryRegistry(): DocsRegistry {
  const registry = new DocsRegistry();
  registry.register({
    tiles: [
      { tileId: LABELLED_ENTRY_ID, tags: [], label: "labelled-entry-label", content: "" },
      { tileId: BARE_ENTRY_ID, tags: [], content: "" },
    ],
  });
  return registry;
}

/** The print view of a one-paragraph page holding nothing but a reference to tile `id`. */
function renderTileReference(id: string, registry: DocsRegistry): string {
  return renderToStaticMarkup(
    <DocsSidebarProvider registry={registry}>
      <DocsPrintView content={`\`tile:${id}\`\n`} />
    </DocsSidebarProvider>
  );
}

describe("a tile reference no catalog tile stands for, in the print view", () => {
  test("prints, for an entry carrying a label, a tile chip reading as that label", () => {
    const registry = entryRegistry();
    const body = paragraphBody(renderTileReference(LABELLED_ENTRY_ID, registry));

    assert.equal(
      /<span class="docs-print-inline-tile"[^>]*>([^<]*)<\/span>/.exec(body ?? "")?.[1],
      registry.tiles.get(LABELLED_ENTRY_ID)?.label
    );
  });

  test("prints, for an entry carrying no label, the id it names as code", () => {
    assert.equal(
      paragraphBody(renderTileReference(BARE_ENTRY_ID, entryRegistry())),
      `<code class="docs-print-code-inline">${BARE_ENTRY_ID}</code>`
    );
  });
});
