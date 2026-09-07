/**
 * Pins what the value box of a placed literal draws: the node the host's entry
 * for that value type supplies, and the formatted text wherever it supplies
 * none. The entry is found by value type alone, so a literal the environment
 * catalog provides and one a document catalog holds draw the same. A node
 * drawn in place of that text stands in the same frame, at the same box and
 * label-line minimums, as the text does, and the tile's label line carries the
 * word the literal reads by.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { List } from "@wendoo/core";
import type { BrainServices, IBrainTileDef } from "@wendoo/core/brain";
import { mkLiteralFactoryTileId, RuleSide } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileFactoryDef, BrainTileLiteralDef, manufactureLiteralTile } from "@wendoo/core/brain/tiles";
import type { NumberValue, StructValue, TypeId, Value } from "@wendoo/core/runtime";
import { CoreTypeIds, mkClosedStructValue, mkNumberValue, TARGET_TYPE_ATOM_BASE } from "@wendoo/core/runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BrainEditorConfig, BrainEditorProvider, type CustomLiteralType } from "./BrainEditorContext";
import { BrainTile, kTileValueFrameAttribute } from "./BrainTile";

/** Factory id of the literal factory these specs register, standing for one an application registers. */
const kSwatchFactoryId = "swatch";

/** Value label of the swatch literal these specs register into the environment catalog. */
const kProvidedSwatchName = "dim";

/** Attribute carrying the level, on the node {@link swatchLiteralType} draws. */
const kSwatchLevelAttribute = "data-swatch-level";

/** Prefix of the text {@link swatchLiteralType} formats a swatch as. */
const kSwatchTextPrefix = "swatch#";

let services: BrainServices;
let swatchTypeId: TypeId;
let providedSwatch: BrainTileLiteralDef;

before(() => {
  services = __test__createBrainServices();
  swatchTypeId = services.runtime.types.addStructType("Swatch", {
    atomId: TARGET_TYPE_ATOM_BASE,
    fields: List.from([{ name: "level", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
  });
  services.edit.tiles.registerTileDef(
    new BrainTileFactoryDef(
      mkLiteralFactoryTileId(kSwatchFactoryId),
      kSwatchFactoryId,
      (factoryTileDef, opts) => {
        const value = opts.value as StructValue;
        return new BrainTileLiteralDef(
          factoryTileDef.producedDataType,
          value,
          { valueLabel: swatchLabel(value) },
          services
        );
      },
      swatchTypeId
    )
  );
  providedSwatch = new BrainTileLiteralDef(
    swatchTypeId,
    swatch(1),
    {
      valueLabel: kProvidedSwatchName,
      persist: false,
      metadata: { label: kProvidedSwatchName, language: { form: kProvidedSwatchName } },
    },
    services
  );
  services.edit.tiles.registerTileDef(providedSwatch);
});

/** A swatch of `level`, as a struct value of the type these specs registered. */
function swatch(level: number): StructValue {
  return mkClosedStructValue(swatchTypeId, List.from<Value>([mkNumberValue(level)]));
}

/** The level a swatch value carries, and `undefined` for a value of another shape. */
function swatchLevel(value: unknown): number | undefined {
  const structValue = value as StructValue | undefined;
  if (!structValue || structValue.typeId !== swatchTypeId) return undefined;
  return ((structValue.v as List<Value>).get(0) as NumberValue).v;
}

/** The label a swatch literal's tile id carries, read off the swatch's own level. */
function swatchLabel(value: StructValue): string {
  return `level${swatchLevel(value)}`;
}

/**
 * The host's entry for the swatch type. Given `renderValue`, it draws a node
 * marked with {@link kSwatchLevelAttribute}; given none, its values fall to the
 * text `formatValue` returns.
 */
function swatchLiteralType(options: { renderValue: boolean }): CustomLiteralType {
  const entry: CustomLiteralType = {
    typeId: swatchTypeId,
    description: "Name a swatch.",
    isValid: (state) => state.level !== "",
    parseValue: (state) => swatch(Number.parseFloat(state.level ?? "")),
    toInputState: (value) => ({ level: `${swatchLevel(value) ?? ""}` }),
    renderInputFields: () => null,
    formatValue: (value) => `${kSwatchTextPrefix}${String(value)}`,
  };
  if (!options.renderValue) return entry;
  return {
    ...entry,
    renderValue: (value) => {
      const level = swatchLevel(value);
      if (level === undefined) return undefined;
      return createElement("span", { [kSwatchLevelAttribute]: `${level}` });
    },
  };
}

/** The markup a placed `tileDef` renders to under a host supplying `customLiteralTypes`. */
function renderPlacedTile(tileDef: IBrainTileDef, customLiteralTypes: CustomLiteralType[]): string {
  const config: BrainEditorConfig = {
    dataTypeIcons: new Map(),
    dataTypeNames: new Map(),
    customLiteralTypes,
  };
  return renderToStaticMarkup(
    createElement(BrainEditorProvider, { config }, createElement(BrainTile, { tileDef, side: RuleSide.Do }))
  );
}

/** The classes the value area -- the box the value frame stands centered in -- carries in `markup`. */
function valueAreaClasses(markup: string): string {
  const match = markup.match(new RegExp(`<div class="([^"]*)"><div ${kTileValueFrameAttribute}=`));
  assert.ok(match, "expected a value area around the value frame");
  return match[1];
}

/** The classes the tile's label line carries in `markup`. */
function labelLineClasses(markup: string): string {
  const match = markup.match(/<span class="([^"]*items-end[^"]*)"/);
  assert.ok(match, "expected a label line");
  return match[1];
}

/** The inline style the value frame carries in `markup`. */
function valueFrameStyle(markup: string): string {
  const match = markup.match(new RegExp(`${kTileValueFrameAttribute}="" class="[^"]*" style="([^"]*)"`));
  assert.ok(match, "expected a styled value frame");
  return match[1];
}

/** A swatch literal minted into a brain's own catalog, the way the create flow mints one. */
function documentSwatchLiteral(level: number): { brainDef: BrainDef; placed: IBrainTileDef } {
  const brainDef = BrainDef.emptyBrainDef(services, "swatch value box");
  const factoryTileDef = services.edit.tiles.get(mkLiteralFactoryTileId(kSwatchFactoryId)) as BrainTileFactoryDef;
  const placed = manufactureLiteralTile(factoryTileDef, brainDef.catalog(), swatch(level));
  assert.ok(placed);
  return { brainDef, placed };
}

describe("the value box of a literal whose type supplies a node", () => {
  test("draws that node in place of the formatted text", () => {
    const { placed } = documentSwatchLiteral(3);

    const markup = renderPlacedTile(placed, [swatchLiteralType({ renderValue: true })]);

    assert.ok(markup.includes(`${kSwatchLevelAttribute}="3"`));
    assert.ok(!markup.includes(kSwatchTextPrefix), "the formatted text is not drawn as well");
  });

  test("draws it for a literal the environment catalog provides and for one a document catalog holds", () => {
    const { brainDef, placed } = documentSwatchLiteral(3);
    assert.equal(brainDef.catalog().get(placed.tileId), placed);
    assert.equal(services.edit.tiles.get(placed.tileId), undefined, "the document's literal is the brain's alone");
    assert.equal(providedSwatch.persist, false, "the environment's literal is provided, not persisted");

    const documentMarkup = renderPlacedTile(placed, [swatchLiteralType({ renderValue: true })]);
    const providedMarkup = renderPlacedTile(providedSwatch, [swatchLiteralType({ renderValue: true })]);

    assert.ok(documentMarkup.includes(`${kSwatchLevelAttribute}="3"`));
    assert.ok(providedMarkup.includes(`${kSwatchLevelAttribute}="1"`));
    assert.ok(!providedMarkup.includes(kSwatchTextPrefix), "the provided literal draws no formatted text either");
  });

  test("falls back to the formatted text where the node is undefined", () => {
    const unreadableSwatch = new BrainTileLiteralDef(swatchTypeId, 5, { valueLabel: "unreadable" }, services);

    const markup = renderPlacedTile(unreadableSwatch, [swatchLiteralType({ renderValue: true })]);

    assert.ok(!markup.includes(kSwatchLevelAttribute));
    assert.ok(markup.includes(`${kSwatchTextPrefix}unreadable`));
  });
});

describe("the frame around a placed literal's value", () => {
  test("stands for a literal whose type draws its own node, around that node", () => {
    const { placed } = documentSwatchLiteral(3);

    const markup = renderPlacedTile(placed, [swatchLiteralType({ renderValue: true })]);

    assert.ok(markup.includes(kTileValueFrameAttribute));
    assert.ok(
      markup.indexOf(kTileValueFrameAttribute) < markup.indexOf(kSwatchLevelAttribute),
      "the frame opens before the node it carries"
    );
  });

  test("stands for a literal whose type draws text", () => {
    const { placed } = documentSwatchLiteral(3);

    const markup = renderPlacedTile(placed, [swatchLiteralType({ renderValue: false })]);

    assert.ok(markup.includes(kTileValueFrameAttribute));
  });

  test("stands for a literal of a type the host registered no entry for", () => {
    const numberLiteral = new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services);

    assert.ok(renderPlacedTile(numberLiteral, []).includes(kTileValueFrameAttribute));
  });
});

describe("the value box a drawn node stands in", () => {
  test("takes the same minimums a text tile's does, so both label lines sit at one height", () => {
    const { placed } = documentSwatchLiteral(3);
    const numberLiteral = new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services);

    const nodeMarkup = renderPlacedTile(placed, [swatchLiteralType({ renderValue: true })]);
    const textMarkup = renderPlacedTile(numberLiteral, [swatchLiteralType({ renderValue: true })]);

    assert.equal(valueAreaClasses(nodeMarkup), valueAreaClasses(textMarkup));
    assert.equal(labelLineClasses(nodeMarkup), labelLineClasses(textMarkup));
  });

  test("is filled with the panel token, where a text tile's carries the tile's own lighter fill", () => {
    const { placed } = documentSwatchLiteral(3);
    const numberLiteral = new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services);

    const nodeStyle = valueFrameStyle(renderPlacedTile(placed, [swatchLiteralType({ renderValue: true })]));
    const textStyle = valueFrameStyle(renderPlacedTile(numberLiteral, [swatchLiteralType({ renderValue: true })]));

    assert.match(nodeStyle, /background-color:var\(--color-panel\)/);
    assert.doesNotMatch(textStyle, /var\(--color-panel\)/);
    assert.match(textStyle, /background-color:#[0-9a-f]{6}/);
    assert.match(nodeStyle, /border-color:white/);
    assert.match(textStyle, /border-color:white/);
  });
});

describe("the label line of a placed literal's tile", () => {
  test("carries the word a named literal reads by", () => {
    const named = new BrainTileLiteralDef(
      swatchTypeId,
      swatch(2),
      { valueLabel: "level2", displayName: "rock" },
      services
    );

    const markup = renderPlacedTile(named, [swatchLiteralType({ renderValue: true })]);

    assert.ok(markup.includes(">rock<"));
  });

  test("carries the value of a number literal, exactly as a host registering no entry does", () => {
    const numberLiteral = new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services);

    const markup = renderPlacedTile(numberLiteral, [swatchLiteralType({ renderValue: true })]);

    assert.equal(markup, renderPlacedTile(numberLiteral, []));
    assert.ok(markup.includes(">7<"));
  });
});

describe("the value box of a literal whose type supplies no node", () => {
  test("draws the formatted text", () => {
    const { placed } = documentSwatchLiteral(3);

    const markup = renderPlacedTile(placed, [swatchLiteralType({ renderValue: false })]);

    assert.ok(markup.includes(`${kSwatchTextPrefix}level3`));
    assert.ok(!markup.includes(kSwatchLevelAttribute));
  });

  test("draws a number literal exactly as a host registering no entry at all does", () => {
    const numberLiteral = new BrainTileLiteralDef(CoreTypeIds.Number, 7, {}, services);

    const markup = renderPlacedTile(numberLiteral, [swatchLiteralType({ renderValue: true })]);

    assert.equal(markup, renderPlacedTile(numberLiteral, []));
    assert.ok(markup.includes(">7<"));
  });

  test("draws a string literal exactly as a host registering no entry at all does", () => {
    const stringLiteral = new BrainTileLiteralDef(CoreTypeIds.String, "go", {}, services);

    const markup = renderPlacedTile(stringLiteral, [swatchLiteralType({ renderValue: true })]);

    assert.equal(markup, renderPlacedTile(stringLiteral, []));
    assert.ok(markup.includes("go"));
  });
});
