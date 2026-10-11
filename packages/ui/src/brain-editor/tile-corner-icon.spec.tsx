/**
 * Pins the icon a placed tile draws in its top-left corner: an image whose
 * source is the icon itself, drawn in its own colors. A literal's corner is the
 * icon the host maps its value type to, else its own icon, else the
 * missing-icon fallback. An accessor's corner is the icon the host maps its
 * result data type to, left out where that icon is the face itself and where
 * the type has none.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { BrainServices, IBrainTileDef } from "@wendoo/core/brain";
import { RuleSide } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { BrainTileAccessorDef, BrainTileLiteralDef } from "@wendoo/core/brain/tiles";
import { CoreTypeIds, mkTypeId, NativeType } from "@wendoo/core/runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { staticAssetUrl } from "../asset-url";
import { type BrainEditorConfig, BrainEditorProvider } from "./BrainEditorContext";
import { BrainTile, kTileCornerIconAttribute } from "./BrainTile";

/** Struct type the accessors these specs place read a field of. */
const kPointTypeId = mkTypeId(NativeType.Struct, "Point");

/** Icon the host maps the number type to. */
const kNumberIconUrl = "data:image/svg+xml;base64,bnVtYmVy";

/** Icon the host maps the point type to. */
const kPointIconUrl = "data:image/svg+xml;base64,cG9pbnQ=";

/** Icon a literal or accessor wears as its own. */
const kOwnIconUrl = "data:image/svg+xml;base64,b3du";

/** The icon a tile resolving to none wears. */
const kMissingIconUrl = staticAssetUrl("assets/brain/icons/question_mark.svg");

/** Icons the host maps the number and point types to; it maps no other type. */
const kDataTypeIcons: ReadonlyMap<string, string> = new Map([
  [CoreTypeIds.Number, kNumberIconUrl],
  [kPointTypeId, kPointIconUrl],
]);

/** A host mapping the number and point types to icons, and no other type. */
const config: BrainEditorConfig = {
  dataTypeIcons: kDataTypeIcons,
  dataTypeNames: new Map(),
  customLiteralTypes: [],
};

let services: BrainServices;

before(() => {
  services = __test__createBrainServices();
});

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

/** The attributes of every image `markup` draws in the tile's corner, in order. */
function cornerImages(markup: string): string[] {
  return [...markup.matchAll(/<img ([^>]*)>/g)]
    .map((match) => match[1])
    .filter((attributes) => attributes.includes(`${kTileCornerIconAttribute}=`));
}

/** The `src` of every image `markup` draws in the tile's corner, in order. */
function cornerSources(markup: string): string[] {
  return cornerImages(markup).map((attributes) => attributes.match(/(?:^| )src="([^"]*)"/)?.[1] ?? "");
}

describe("a placed literal's corner", () => {
  test("is an image of its value type's icon, hidden from assistive technology", () => {
    const markup = renderPlacedTile(new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services));

    assert.deepEqual(cornerSources(markup), [kNumberIconUrl]);
    const [attributes] = cornerImages(markup);
    assert.match(attributes, /(?:^| )alt=""/);
    assert.match(attributes, /(?:^| )aria-hidden="true"/);
  });

  test("is its value type's icon over an icon of its own", () => {
    const literal = new BrainTileLiteralDef(
      CoreTypeIds.Number,
      7,
      { metadata: { label: "seven", iconUrl: kOwnIconUrl } },
      services
    );

    assert.deepEqual(cornerSources(renderPlacedTile(literal)), [kNumberIconUrl]);
  });

  test("is its own icon where its value type has none", () => {
    const literal = new BrainTileLiteralDef(
      CoreTypeIds.String,
      "hi",
      { metadata: { label: "hi", iconUrl: kOwnIconUrl } },
      services
    );

    assert.deepEqual(cornerSources(renderPlacedTile(literal)), [kOwnIconUrl]);
  });

  test("is the missing-icon fallback where neither the literal nor its type carries an icon", () => {
    const markup = renderPlacedTile(new BrainTileLiteralDef(CoreTypeIds.String, "hi", {}, services));

    assert.deepEqual(cornerSources(markup), [kMissingIconUrl]);
  });
});

describe("a placed accessor's corner", () => {
  test("is an image of its result data type's icon where that differs from its face", () => {
    const markup = renderPlacedTile(accessor("x", CoreTypeIds.Number, kOwnIconUrl));

    assert.deepEqual(cornerSources(markup), [kNumberIconUrl]);
  });

  test("is not drawn where its result data type's icon is its own face", () => {
    const markup = renderPlacedTile(accessor("origin", kPointTypeId, kPointIconUrl));

    assert.deepEqual(cornerSources(markup), []);
  });

  test("is not drawn where the host maps its result data type to no icon", () => {
    const markup = renderPlacedTile(accessor("name", CoreTypeIds.String, kOwnIconUrl));

    assert.deepEqual(cornerSources(markup), []);
  });
});
