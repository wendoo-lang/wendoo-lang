/**
 * Pins how the markdown renderer wraps fenced code: a brain fence and an
 * assistant section each draw their own container, and every other fence keeps
 * a block wrapper. Also pins that an assistant section opens closed, holding
 * none of its text until a reader opens it, how a concept reference resolves
 * against the registry, and how a tile reference no catalog tile stands for
 * resolves against the registry entry it names.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocMarkdown } from "./DocMarkdown";
import { DocsRegistry } from "./DocsRegistry";
import { DocsSidebarProvider } from "./DocsSidebarContext";

const BRAIN_FENCE = '```brain\n[{ "version": 1, "when": [], "do": [] }]\n```\n';
const PLAIN_FENCE = "```\nfirst line\nsecond line\n```\n";
const LANGUAGE_FENCE = "```json\n{ }\n```\n";
const ASSISTANT_TEACHING = "notenamesnotnumbers";
const ASSISTANT_FENCE = `\`\`\`assistant\n${ASSISTANT_TEACHING}\n\`\`\`\n`;

function render(markdown: string, registry?: DocsRegistry): string {
  return renderToStaticMarkup(
    <DocsSidebarProvider registry={registry}>
      <DocMarkdown>{markdown}</DocMarkdown>
    </DocsSidebarProvider>
  );
}

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

/** The inline reference `form:id` as a markdown paragraph. */
function reference(form: string, id: string): string {
  return `before \`${form}:${id}\` after\n`;
}

describe("the wrapper a fenced code block renders in", () => {
  test("is a block for a fence carrying no language", () => {
    assert.match(render(PLAIN_FENCE), /<pre[\s>]/);
  });

  test("is a block for a fence carrying a language the renderer does not draw", () => {
    assert.match(render(LANGUAGE_FENCE), /<pre[\s>]/);
  });

  test("is absent for a brain fence, which draws its own", () => {
    assert.doesNotMatch(render(BRAIN_FENCE), /<pre[\s>]/);
  });

  test("is absent for an assistant fence, which draws its own", () => {
    assert.doesNotMatch(render(ASSISTANT_FENCE), /<pre[\s>]/);
  });
});

describe("the assistant section an assistant fence renders", () => {
  test("opens closed, on a control reporting that it is closed", () => {
    const html = render(ASSISTANT_FENCE);

    assert.match(html, /<button\s[^>]*type="button"/);
    assert.match(html, /aria-expanded="false"/);
  });

  test("holds none of its text while it is closed", () => {
    assert.ok(!render(ASSISTANT_FENCE).includes(ASSISTANT_TEACHING), "the teaching is not rendered");
  });

  test("leaves a fence of another kind rendering its text as before", () => {
    assert.ok(render(LANGUAGE_FENCE).includes("{ }"));
  });
});

describe("a concept reference", () => {
  test("renders, for a concept the registry holds, a control carrying the concept's id", () => {
    const html = render(reference("concept", REGISTERED_CONCEPT_ID), conceptRegistry());

    assert.match(html, new RegExp(`<button type="button" data-concept-id="${REGISTERED_CONCEPT_ID}"`));
    assert.doesNotMatch(html, /<code[\s>]/);
  });

  test("reads as the title the registry holds for that concept", () => {
    const registry = conceptRegistry();
    const html = render(reference("concept", REGISTERED_CONCEPT_ID), registry);
    const label = /<button[^>]*>([^<]*)<\/button>/.exec(html)?.[1];

    assert.equal(label, registry.concepts.get(REGISTERED_CONCEPT_ID)?.title);
  });

  test("renders, for a concept the registry does not hold, the id it names and no control", () => {
    const html = render(reference("concept", UNREGISTERED_CONCEPT_ID), conceptRegistry());

    assert.match(html, new RegExp(`<code class="[^"]*text-warning[^"]*">${UNREGISTERED_CONCEPT_ID}</code>`));
    assert.doesNotMatch(html, /<button[\s>]/);
  });

  test("degrades for an unknown id exactly as a tile reference does", () => {
    const registry = conceptRegistry();

    assert.equal(
      render(reference("concept", UNREGISTERED_CONCEPT_ID), registry),
      render(reference("tile", UNREGISTERED_CONCEPT_ID), registry)
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

describe("a tile reference no catalog tile stands for", () => {
  test("renders, for an entry carrying a label, a control reading as that label and no code", () => {
    const registry = entryRegistry();
    const html = render(reference("tile", LABELLED_ENTRY_ID), registry);
    const label = /<button[^>]*><span[^>]*>([^<]*)<\/span><\/button>/.exec(html)?.[1];

    assert.equal(label, registry.tiles.get(LABELLED_ENTRY_ID)?.label);
    assert.doesNotMatch(html, /<code[\s>]/);
  });

  test("renders, for an entry carrying no label, the id it names as warning code and no control", () => {
    const html = render(reference("tile", BARE_ENTRY_ID), entryRegistry());

    assert.match(html, /<code class="[^"]*text-warning[^"]*">/);
    assert.doesNotMatch(html, /<button[\s>]/);
  });
});
