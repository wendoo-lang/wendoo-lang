/**
 * Pins how a placed accessor tile draws: its own icon as the face, at the
 * width every icon tile takes, with no value box.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { IBrainTileDef } from "@wendoo/core/brain";
import { RuleSide } from "@wendoo/core/brain";
import { BrainTileAccessorDef, BrainTileModifierDef } from "@wendoo/core/brain/tiles";
import { CoreTypeIds, mkTypeId, NativeType } from "@wendoo/core/runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BrainEditorConfig, BrainEditorProvider } from "./BrainEditorContext";
import { BrainTile, kTileCornerIconAttribute, kTileValueFrameAttribute } from "./BrainTile";
import { tileAccessibleName } from "./tile-visual-utils";

/** Struct type the accessors these specs place read a field of. */
const kPointTypeId = mkTypeId(NativeType.Struct, "Point");

/** Icon the host maps the number type to. */
const kNumberIconUrl = "/icons/number.svg";

/** Icon the `x` accessor wears as its own. */
const kXIconUrl = "/icons/x.svg";

/** A host mapping the number type to an icon, and no other type. */
const config: BrainEditorConfig = {
  dataTypeIcons: new Map([[CoreTypeIds.Number, kNumberIconUrl]]),
  dataTypeNames: new Map(),
  customLiteralTypes: [],
};

/** An accessor reading the field `fieldName`, of type `fieldTypeId`, off a point, wearing `iconUrl`. */
function accessor(fieldName: string, fieldTypeId: string, iconUrl: string): BrainTileAccessorDef {
  return new BrainTileAccessorDef(kPointTypeId, fieldName, fieldTypeId, { metadata: { label: fieldName, iconUrl } });
}

/** The markup a placed `tileDef` renders to under {@link config}. */
function renderPlacedTile(tileDef: IBrainTileDef): string {
  return renderToStaticMarkup(
    createElement(BrainEditorProvider, { config }, createElement(BrainTile, { tileDef, side: RuleSide.When }))
  );
}

/** The `src` of every image `markup` carries outside the tile's corner, in order. */
function faceSources(markup: string): string[] {
  return [...markup.matchAll(/<img ([^>]*)>/g)]
    .map((match) => match[1])
    .filter((attributes) => !attributes.includes(`${kTileCornerIconAttribute}=`))
    .map((attributes) => attributes.match(/(?:^| )src="([^"]*)"/)?.[1] ?? "");
}

/** The classes the tile's button carries in `markup`. */
function buttonClasses(markup: string): string {
  const match = markup.match(/<button[^>]* class="([^"]*)"/);
  assert.ok(match, "expected a tile button");
  return match[1];
}

/** The accessible name the tile's button carries in `markup`. */
function buttonName(markup: string): string {
  const match = markup.match(/<button[^>]* aria-label="([^"]*)"/);
  assert.ok(match, "expected a named tile button");
  return match[1];
}

describe("a placed accessor tile", () => {
  test("wears its own icon as its face and draws no value box", () => {
    const markup = renderPlacedTile(accessor("x", CoreTypeIds.Number, kXIconUrl));

    assert.deepEqual(faceSources(markup), [kXIconUrl]);
    assert.ok(!markup.includes(kTileValueFrameAttribute));
  });

  test("takes the width every icon tile takes", () => {
    const modifier = new BrainTileModifierDef("modifier.spec.x", { metadata: { label: "x", iconUrl: kXIconUrl } });

    const accessorMarkup = renderPlacedTile(accessor("x", CoreTypeIds.Number, kXIconUrl));
    const modifierMarkup = renderPlacedTile(modifier);

    assert.equal(buttonClasses(accessorMarkup), buttonClasses(modifierMarkup));
  });

  test("reads to assistive technology by its kind and label", () => {
    const tileDef = accessor("x", CoreTypeIds.Number, kXIconUrl);

    assert.equal(buttonName(renderPlacedTile(tileDef)), tileAccessibleName(config, tileDef));
  });
});
