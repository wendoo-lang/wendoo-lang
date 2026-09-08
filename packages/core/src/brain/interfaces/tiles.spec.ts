import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CoreLiteralFactoryId,
  fixedFormat,
  isDisplayFormat,
  isLiteralFactoryTileId,
  LiteralDisplayFormats,
  mkLiteralFactoryTileId,
  mkLiteralTileId,
  mkVariableFactoryTileId,
  percentFormat,
  timeMsFormat,
  timeSecondsFormat,
} from "@wendoo/core/brain";
import { CoreTypeIds, mkActuatorTileId } from "@wendoo/core/runtime";

describe("isLiteralFactoryTileId", () => {
  test("holds for every core literal factory", () => {
    assert.equal(isLiteralFactoryTileId(mkLiteralFactoryTileId(CoreLiteralFactoryId.Number)), true);
    assert.equal(isLiteralFactoryTileId(mkLiteralFactoryTileId(CoreLiteralFactoryId.String)), true);
  });

  test("holds for a factory id no core enum names", () => {
    assert.equal(isLiteralFactoryTileId(mkLiteralFactoryTileId("swatch")), true);
  });

  test("does not hold for the literal tiles a factory produces", () => {
    assert.equal(isLiteralFactoryTileId(mkLiteralTileId(CoreTypeIds.Number, "7")), false);
    assert.equal(isLiteralFactoryTileId(mkLiteralTileId(CoreTypeIds.Number, "7", "percent")), false);
  });

  test("does not hold for another area's tiles", () => {
    assert.equal(isLiteralFactoryTileId(mkVariableFactoryTileId("number")), false);
    assert.equal(isLiteralFactoryTileId(mkActuatorTileId("wait")), false);
  });

  test("does not hold for text that is not a tile id", () => {
    assert.equal(isLiteralFactoryTileId(""), false);
    assert.equal(isLiteralFactoryTileId("lit.factory->number"), false);
    assert.equal(isLiteralFactoryTileId("tile.lit.factory"), false);
    assert.equal(isLiteralFactoryTileId("tile.lit.factorynumber"), false);
  });
});

describe("isDisplayFormat", () => {
  test("holds for every format the grammar names", () => {
    for (const fmt of [
      "default",
      "percent",
      "percent:2",
      "fixed:0",
      "fixed:12",
      "thousands",
      "time_seconds",
      "time_seconds:3",
      "time_ms",
      "time_ms:1",
    ]) {
      assert.equal(isDisplayFormat(fmt), true, fmt);
    }
  });

  test("holds for the formats the builders produce", () => {
    assert.equal(isDisplayFormat(percentFormat(1)), true);
    assert.equal(isDisplayFormat(fixedFormat(2)), true);
    assert.equal(isDisplayFormat(timeSecondsFormat(3)), true);
    assert.equal(isDisplayFormat(timeMsFormat(0)), true);
    assert.equal(isDisplayFormat(LiteralDisplayFormats.Default), true);
  });

  test("does not hold for text outside the grammar", () => {
    for (const fmt of [
      "",
      "Percent",
      "percentage",
      "percent:",
      "percent:x",
      "percent: 2",
      "percent:2.5",
      "percent:-1",
      "fixed",
      "seconds",
      "time_ms:1s",
    ]) {
      assert.equal(isDisplayFormat(fmt), false, fmt);
    }
  });
});
