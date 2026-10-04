/**
 * Pins a display-only literal type: a `customLiteralTypes` entry carrying no
 * dialog members renders its values -- the node its `renderValue` draws in a
 * placed literal's value box -- and never offers the literal-value editor,
 * even where a literal factory producing its type is registered, so neither
 * the tile menu's value entries nor the candidate strip's edit and duplicate
 * commands stand for it, and the create-literal dialog stands no name field
 * for it.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { List } from "@wendoo/core";
import type { BrainServices } from "@wendoo/core/brain";
import { mkLiteralFactoryTileId, RuleSide } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileFactoryDef, BrainTileLiteralDef } from "@wendoo/core/brain/tiles";
import type { NumberValue, StructValue, TypeId, Value } from "@wendoo/core/runtime";
import { CoreTypeIds, mkClosedStructValue, mkNumberValue, TARGET_TYPE_ATOM_BASE } from "@wendoo/core/runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BrainEditorConfig, BrainEditorProvider, type CustomLiteralType } from "./BrainEditorContext";
import { BrainTile } from "./BrainTile";
import { literalTypeTakesName } from "./CreateLiteralDialog";
import { literalValueEditor } from "./tile-menu-model";

/** Attribute carrying the level, on the node the display-only entry draws. */
const kGaugeLevelAttribute = "data-gauge-level";

let services: BrainServices;
let gaugeTypeId: TypeId;
let gauge: BrainTileLiteralDef;

before(() => {
  services = __test__createBrainServices();
  gaugeTypeId = services.runtime.types.addStructType("Gauge", {
    atomId: TARGET_TYPE_ATOM_BASE,
    fields: List.from([{ name: "level", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
  });
  services.edit.tiles.registerTileDef(
    new BrainTileFactoryDef(
      mkLiteralFactoryTileId("gauge"),
      "gauge",
      (factoryTileDef, opts) =>
        new BrainTileLiteralDef(factoryTileDef.producedDataType, opts.value as StructValue, {}, services),
      gaugeTypeId
    )
  );
  gauge = new BrainTileLiteralDef(
    gaugeTypeId,
    mkClosedStructValue(gaugeTypeId, List.from<Value>([mkNumberValue(3)])),
    { valueLabel: "full", persist: false, metadata: { label: "full" } },
    services
  );
  services.edit.tiles.registerTileDef(gauge);
});

/** The level a gauge value carries. */
function gaugeLevel(value: unknown): number {
  return (((value as StructValue).v as List<Value>).get(0) as NumberValue).v;
}

/** The host's display-only entry for the gauge type: it formats and draws values, and carries no dialog members. */
const displayOnlyGauge = (): CustomLiteralType => ({
  typeId: gaugeTypeId,
  description: "A gauge.",
  formatValue: (value) => `gauge ${gaugeLevel(value)}`,
  renderValue: (value) => createElement("span", { [kGaugeLevelAttribute]: `${gaugeLevel(value)}` }),
});

/** The same entry carrying the dialog members as well. */
const dialogGauge = (): CustomLiteralType => ({
  ...displayOnlyGauge(),
  isValid: () => true,
  parseValue: () => mkClosedStructValue(gaugeTypeId, List.from<Value>([mkNumberValue(1)])),
  toInputState: () => ({}),
  renderInputFields: () => null,
});

describe("a display-only literal type", () => {
  test("draws a placed literal's value through its renderValue", () => {
    const config: BrainEditorConfig = {
      dataTypeIcons: new Map(),
      dataTypeNames: new Map(),
      customLiteralTypes: [displayOnlyGauge()],
    };

    const markup = renderToStaticMarkup(
      createElement(BrainEditorProvider, { config }, createElement(BrainTile, { tileDef: gauge, side: RuleSide.Do }))
    );

    assert.match(markup, new RegExp(`${kGaugeLevelAttribute}="3"`));
  });

  test("offers no literal-value editor though a factory produces its type", () => {
    const brainDef = BrainDef.emptyBrainDef(services, "gauges");

    assert.equal(literalValueEditor(gauge, [displayOnlyGauge()], services.edit.tiles, brainDef.catalog()), undefined);
    assert.notEqual(literalValueEditor(gauge, [dialogGauge()], services.edit.tiles, brainDef.catalog()), undefined);
  });

  test("stands no name field in the create-literal dialog", () => {
    assert.equal(literalTypeTakesName(gaugeTypeId, [displayOnlyGauge()]), false);
    assert.equal(literalTypeTakesName(gaugeTypeId, [dialogGauge()]), true);
  });
});
