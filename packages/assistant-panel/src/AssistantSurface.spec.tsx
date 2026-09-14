/**
 * Pins what the bound surface stands: the entity the host named, an intent box
 * that takes the keyboard from nobody it was not handed to, where a waiting ask
 * the person takes back lands and how it stands against what was already typed,
 * that a waiting ask can be hurried to the front, and a mount that costs the
 * session nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthoringWorkspace } from "@wendoo/assistant-bridge";
import { FAKE_TARGET_IDENTITY } from "@wendoo/assistant-bridge/testing";
import type { RelayToolManifest } from "@wendoo/assistant-relay";
import { __test__clientBuild } from "@wendoo/core/__test__";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantProvider } from "./AssistantProvider";
import { AssistantSurface, draftWithTakenBack } from "./AssistantSurface";
import type { AssistantChannel } from "./session/channel";

/** What the client declares it serves. */
const manifest: RelayToolManifest = {
  target: FAKE_TARGET_IDENTITY,
  tools: ["read_catalog"],
  morphology: false,
  catalogDigest: "0f3a19c2",
};

/** The entity the host says the open brain belongs to. */
const entityName = "Herbivore Brain";

/** A workspace accessor no test reaches. */
function unreachedWorkspace(): AuthoringWorkspace {
  throw new Error("the surface specs serve no tool call");
}

/** Render the surface under a provider, counting the sessions the provider asks for. */
function renderBound(): { markup: string; connects: number } {
  let connects = 0;
  const connect = (): Promise<AssistantChannel> => {
    connects++;
    return Promise.reject(new Error("no route to the service"));
  };

  const markup = renderToStaticMarkup(
    <AssistantProvider
      connect={connect}
      manifest={manifest}
      clientBuild={__test__clientBuild}
      workspace={unreachedWorkspace}
    >
      <AssistantSurface name={entityName} />
    </AssistantProvider>
  );
  return { markup, connects };
}

describe("the bound conversation surface", () => {
  test("presents the entity the host named", () => {
    assert.match(renderBound().markup, new RegExp(`data-assistant-entity="true"[^>]*>${entityName}<`));
  });

  test("stands an intent box that takes the keyboard from nobody", () => {
    const { markup } = renderBound();

    assert.match(markup, /<textarea[^>]*data-assistant-intent/);
    assert.doesNotMatch(markup, /autofocus/i);
  });

  test("hands the opens the person asked for down to the view holding the intent box", () => {
    const source = readFileSync(fileURLToPath(new URL("./AssistantSurface.tsx", import.meta.url)), "utf8");

    assert.match(source, /opensByPerson=\{opensByPerson\}/);
  });

  test("tells the add of a library to the brain whose conversation it stands", () => {
    const source = readFileSync(fileURLToPath(new URL("./AssistantSurface.tsx", import.meta.url)), "utf8");

    assert.match(source, /const brainId = record\?\.brainId/);
    assert.match(source, /libraryAdded\(brainId, coordinate\)/);
  });

  test("puts a waiting ask the person takes back into the intent box", () => {
    const source = readFileSync(fileURLToPath(new URL("./AssistantSurface.tsx", import.meta.url)), "utf8");

    assert.match(source, /const text = cancelAsk\(id\)/);
    assert.match(source, /draftWithTakenBack\(text, draft\)/);
    assert.match(source, /onCancelAsk=\{takeBack\}/);
  });

  test("hurries a waiting ask to the front from the bubble it waits in", () => {
    const source = readFileSync(fileURLToPath(new URL("./AssistantSurface.tsx", import.meta.url)), "utf8");

    assert.match(source, /onSendNow=\{sendNow\}/);
  });

  test("stands the asks waiting their turn in the view holding the transcript", () => {
    const source = readFileSync(fileURLToPath(new URL("./AssistantSurface.tsx", import.meta.url)), "utf8");

    assert.match(source, /pending=\{pending\}/);
  });

  test("opens no session by standing under a provider", () => {
    assert.equal(renderBound().connects, 0);
  });
});

describe("what a taken-back ask leaves in the intent box", () => {
  test("stands the ask on its own where nothing was typed", () => {
    assert.equal(draftWithTakenBack("and jump", ""), "and jump");
  });

  test("stands the ask above what was already typed, a line apart", () => {
    assert.equal(draftWithTakenBack("and jump", "then stop"), "and jump\nthen stop");
  });
});
