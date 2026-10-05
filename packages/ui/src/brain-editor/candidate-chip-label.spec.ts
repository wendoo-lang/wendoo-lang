/**
 * Pins the text the candidate strip puts on a tile's chip, read through the
 * strip's own hook: the tile's label, whatever words its sentence reads it
 * by, and the label the strip's filter matches. Each assertion compares a
 * chip's text with the metadata field it is drawn from, never with wording of
 * its own.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { List } from "@wendoo/core";
import type { BrainServices, IBrainTileDef } from "@wendoo/core/brain";
import { RuleSide } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import type { BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainTileSensorDef } from "@wendoo/core/brain/tiles";
import { bag, CoreTypeIds, mkActionDescriptor, mkCallDef, VOID_VALUE } from "@wendoo/core/runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArmedTargetProvider, type ArmedTileTarget } from "./ArmedTargetContext";
import { type BrainEditorConfig, BrainEditorProvider } from "./BrainEditorContext";
import { filterStripCandidates, type StripCandidate } from "./candidate-strip-model";
import { type CandidateStripState, useCandidateStrip } from "./hooks/useCandidateStrip";
import { makeBrain } from "./test-only-rule-fixtures";

let services: BrainServices;

/** The sensor whose label and sentence form differ. */
let wordedSensor: IBrainTileDef;

/** The sensor carrying a label and no sentence form. */
let labelledSensor: IBrainTileDef;

/** Register a boolean sensor with no argument slot under `fnId`, carrying `metadata`. */
function registerSensor(fnId: number, sensorId: string, metadata: BrainTileSensorDef["metadata"]): IBrainTileDef {
  const fnEntry = services.runtime.functions.register(
    fnId,
    sensorId,
    false,
    { exec: () => VOID_VALUE },
    mkCallDef(bag())
  );
  const tileDef = new BrainTileSensorDef(sensorId, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Boolean), {
    metadata,
  });
  services.edit.tiles.registerTileDef(tileDef);
  return tileDef;
}

before(() => {
  services = __test__createBrainServices();
  wordedSensor = registerSensor(5701, "chip-label-worded", {
    label: "chip-label-worded",
    language: { form: "chip-label-worded-form" },
  });
  labelledSensor = registerSensor(5702, "chip-label-labelled", { label: "chip-label-labelled" });
});

/** The strip state the hook builds for appending to the WHEN side of `ruleDef`. */
function stripStateFor(ruleDef: BrainRuleDef): CandidateStripState {
  const config: BrainEditorConfig = {
    dataTypeIcons: new Map(),
    dataTypeNames: new Map(),
    customLiteralTypes: [],
    brainServices: services,
    tileCatalogs: [services.edit.tiles],
  };
  const target: ArmedTileTarget = { ruleDef, side: RuleSide.When, mode: "append", onTileSelected: () => true };
  let captured: CandidateStripState | undefined;
  function Probe() {
    captured = useCandidateStrip({
      ruleDef,
      target,
      catalogs: List.from([services.edit.tiles]),
      revision: "",
      onEditLiteral: () => {},
    });
    return null;
  }
  renderToStaticMarkup(
    createElement(
      BrainEditorProvider,
      { config },
      createElement(
        ArmedTargetProvider,
        { value: { target, arm: () => {}, disarm: () => {}, mode: null, reportMode: () => {} } },
        createElement(Probe)
      )
    )
  );
  assert.ok(captured, "the probe rendered the strip's hook");
  return captured;
}

/** Every candidate the strip offers, across its sections. */
function offeredCandidates(state: CandidateStripState): StripCandidate[] {
  return state.sections.flatMap((section) => section.entries.map((entry) => entry.candidate));
}

/** The candidate the strip offers for `tileDef`. */
function candidateFor(state: CandidateStripState, tileDef: IBrainTileDef): StripCandidate {
  const found = offeredCandidates(state).find((candidate) => candidate.tileDef.tileId === tileDef.tileId);
  assert.ok(found, `the strip offers ${tileDef.tileId}`);
  return found;
}

describe("the candidate strip's chip text", () => {
  test("a tile whose label and sentence form differ shows its label on its chip", () => {
    const state = stripStateFor(makeBrain(services, [], []).ruleDef);
    const chip = candidateFor(state, wordedSensor).label;

    assert.equal(chip, wordedSensor.metadata?.label);
    assert.notEqual(chip, wordedSensor.metadata?.language?.form);
  });

  test("a tile carrying no sentence form shows its label on its chip", () => {
    const state = stripStateFor(makeBrain(services, [], []).ruleDef);

    assert.equal(candidateFor(state, labelledSensor).label, labelledSensor.metadata?.label);
  });

  test("the filter matches a tile by the label its chip shows", () => {
    const state = stripStateFor(makeBrain(services, [], []).ruleDef);
    const label = wordedSensor.metadata?.label ?? "";
    const matched = filterStripCandidates(offeredCandidates(state), label, (text) =>
      services.app.localizer.foldForSearch(text)
    );

    assert.equal(matched[0]?.tileDef.tileId, wordedSensor.tileId);
    assert.equal(matched[0]?.label, label);
  });
});
