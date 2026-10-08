/**
 * Pins that the editor's chrome reads its colors from the token contract: the
 * accent, the ink scale and its wells, semantic amber, the badges a tile
 * carries, the WHEN/DO capsules, the rule row's pills, the shared destructive
 * role, and the shadows cast on the desk and by a rule card. Each test asserts
 * the token reference a component emits and the absence of a palette literal.
 *
 * Also pins that a placed tile and a candidate chip take their border from the
 * one shared computation.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { BrainServices, IBrainTileDef } from "@wendoo/core/brain";
import { RuleSide } from "@wendoo/core/brain";
import { __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { BrainCommandHistory, type BrainPageDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type ArmedTargetController, ArmedTargetProvider, type ArmedTileTarget } from "./ArmedTargetContext";
import { type BrainEditorConfig, BrainEditorProvider } from "./BrainEditorContext";
import { BrainRuleEditor } from "./BrainRuleEditor";
import { BrainRulesRegion, type BrainRulesRegionProps } from "./BrainRulesRegion";
import { BrainTile } from "./BrainTile";
import {
  arrangeCandidateSubcategories,
  type CandidateEntry,
  type StripCandidate,
  tileCandidateGroup,
  toCandidateEntries,
} from "./candidate-strip-model";
import type { CandidateStripSection, CandidateStripState } from "./hooks/useCandidateStrip";
import { makeActuator, makeAsyncActuator, makeBrain, makeSensor, StripSurface } from "./test-only-rule-fixtures";
import type { TileBadge } from "./tile-badges";
import { tileBorderColor } from "./tile-visual-utils";

let services: BrainServices;

/** The hues the host app resolves every fixture tile in, one per rule side. */
const tileHues = { when: "#123456", do: "#abcdef" } as const;

const editorConfig: BrainEditorConfig = {
  dataTypeIcons: new Map(),
  dataTypeNames: new Map(),
  customLiteralTypes: [],
  resolveTileVisual: () => ({ label: "", colorDef: { when: tileHues.when, do: tileHues.do } }),
};

before(() => {
  services = __test__createBrainServices();
});

function candidate(tileDef: IBrainTileDef): StripCandidate {
  return {
    key: tileDef.tileId,
    tileDef,
    label: tileDef.tileId,
    group: tileCandidateGroup(tileDef),
    viaConversion: false,
    origin: { kind: "suggested" },
  };
}

function section(entries: readonly CandidateEntry[]): CandidateStripSection {
  const subcategories = arrangeCandidateSubcategories(entries, {}, []);
  return {
    key: entries[0].candidate.group,
    group: entries[0].candidate.group,
    subcategories,
    entries: subcategories.flatMap((subcategory) => subcategory.entries),
    totalCount: entries.length,
  };
}

/** The whole rule card for a rule holding one tile on each side. */
function renderRuleCard(): string {
  const { ruleDef } = makeBrain(services, [makeSensor(services, "token-see")], [makeActuator(services, "token-move")]);
  const controller: ArmedTargetController = {
    target: null,
    arm: () => {},
    disarm: () => {},
    mode: null,
    reportMode: () => {},
  };
  return renderToStaticMarkup(
    createElement(
      BrainEditorProvider,
      { config: editorConfig },
      createElement(
        ArmedTargetProvider,
        { value: controller },
        createElement(BrainRuleEditor, {
          ruleDef: ruleDef as BrainRuleDef,
          lineNumber: 1,
          ruleCount: 1,
          revision: "",
          commandHistory: new BrainCommandHistory(),
        })
      )
    )
  );
}

/** The offering, open on one candidate, with `isUnknown` deciding its reading. */
function renderStrip(tileDef: IBrainTileDef, isUnknown = false): string {
  const entries = toCandidateEntries([candidate(tileDef)]);
  const { ruleDef } = makeBrain(services, [], []);
  const target: ArmedTileTarget = {
    ruleDef: ruleDef as BrainRuleDef,
    side: RuleSide.When,
    mode: "append",
    onTileSelected: () => true,
  };
  const state: CandidateStripState = {
    commands: [],
    runCommand: () => {},
    bestNext: entries,
    sections: [section(entries)],
    filter: isUnknown ? "nothing fits" : "",
    offeringOpen: true,
    isUnknown,
    acceptsTextLiteral: false,
    textLiteralCandidate: () => undefined,
    setFilter: () => {},
    commit: () => {},
    commitByKey: () => {},
    candidateFromKey: () => undefined,
  };
  return renderToStaticMarkup(
    createElement(
      BrainEditorProvider,
      { config: editorConfig },
      createElement(StripSurface, { id: "strip", state, target, onDismiss: () => {} })
    )
  );
}

/** One placed tile on the DO side, carrying `badge` when one is given. */
function renderTile(tileDef: IBrainTileDef, badge?: TileBadge): string {
  return renderToStaticMarkup(
    createElement(
      BrainEditorProvider,
      { config: editorConfig },
      createElement(BrainTile, { tileDef, side: RuleSide.Do, badge })
    )
  );
}

/** The offering armed on a placed tile, which is what opens its position pivot and removal control. */
function renderEditPointStrip(): string {
  const tileDef = makeSensor(services, "token-edit-point");
  const entries = toCandidateEntries([candidate(tileDef)]);
  const { ruleDef } = makeBrain(services, [tileDef], []);
  const target: ArmedTileTarget = {
    ruleDef: ruleDef as BrainRuleDef,
    side: RuleSide.When,
    mode: "replace",
    tileIndex: 0,
    onTileSelected: () => true,
  };
  const state: CandidateStripState = {
    commands: [],
    runCommand: () => {},
    bestNext: entries,
    sections: [section(entries)],
    filter: "",
    offeringOpen: true,
    isUnknown: false,
    acceptsTextLiteral: false,
    textLiteralCandidate: () => undefined,
    setFilter: () => {},
    commit: () => {},
    commitByKey: () => {},
    candidateFromKey: () => undefined,
  };
  return renderToStaticMarkup(
    createElement(
      BrainEditorProvider,
      { config: editorConfig },
      createElement(StripSurface, {
        id: "edit-point-strip",
        state,
        target,
        onDismiss: () => {},
        editPoint: { position: "replace", arm: () => {}, menu: undefined },
      })
    )
  );
}

/** The class attributes of `markup`, joined into one searchable run. */
function classes(markup: string): string {
  return [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]).join(" ");
}

describe("the editor's chrome reads the token contract", () => {
  test("the WHEN and DO capsules take their fill, edge and ink from the capsule tokens", () => {
    const found = classes(renderRuleCard());
    assert.ok(found.includes("bg-brain-capsule"));
    assert.ok(found.includes("border-brain-capsule-edge"));
    assert.ok(found.includes("text-brain-capsule-ink"));
    assert.ok(!/-slate-(?:900|500)\b/.test(found));
  });

  test("the rule row's pills take their fill, hover, edge and ink from the pill tokens", () => {
    const found = classes(renderRuleCard());
    assert.ok(found.includes("bg-brain-pill"));
    assert.ok(found.includes("hover:bg-brain-pill-hover"));
    assert.ok(found.includes("border-brain-pill-edge"));
    assert.ok(found.includes("text-brain-pill-ink"));
    assert.ok(!/-slate-(?:100|200|300|700)\b/.test(found));
  });

  test("the rule card and the offering hold no white or black alpha step of their own", () => {
    for (const found of [classes(renderRuleCard()), classes(renderStrip(makeSensor(services, "token-ink")))]) {
      assert.ok(!/-white\/\d/.test(found), found);
      assert.ok(!/-black\/\d/.test(found), found);
    }
  });

  test("the sentence and the offering hold no accent value of their own", () => {
    for (const found of [classes(renderRuleCard()), classes(renderStrip(makeSensor(services, "token-accent")))]) {
      assert.ok(!/-violet-\d/.test(found), found);
    }
    assert.ok(classes(renderStrip(makeSensor(services, "token-accent"))).includes("focus:ring-brain-accent"));
  });

  test("text naming no tile that fits reads in the amber tokens", () => {
    const found = classes(renderStrip(makeSensor(services, "token-amber"), true));
    assert.ok(found.includes("border-brain-amber"));
    assert.ok(found.includes("text-brain-amber-ink"));
    assert.ok(!/-amber-\d/.test(found), found);
  });

  test("the badge on a tile whose reading is incomplete takes the warn tokens", () => {
    const found = classes(renderTile(makeActuator(services, "token-warn"), { type: "warning", message: "incomplete" }));
    assert.ok(found.includes("bg-brain-warn"));
    assert.ok(found.includes("border-brain-warn-edge"));
    assert.ok(found.includes("text-brain-warn-ink"));
    assert.ok(!/-amber-\d/.test(found), found);
  });

  test("the badge on an action that may take time takes the timed tokens", () => {
    const found = classes(renderTile(makeAsyncActuator(services, "token-timed")));
    assert.ok(found.includes("bg-brain-timed"));
    assert.ok(found.includes("border-brain-timed-ink"));
    assert.ok(found.includes("text-brain-timed-ink"));
    assert.ok(!/-slate-\d/.test(found), found);
  });
});

describe("the shared destructive role", () => {
  test("the badge on a tile that does not parse takes the destructive tokens", () => {
    const found = classes(
      renderTile(makeActuator(services, "token-destructive"), { type: "error", message: "broken" })
    );
    assert.ok(found.includes("bg-destructive"));
    assert.ok(found.includes("text-destructive-foreground"));
    assert.ok(!/-red-\d/.test(found), found);
  });

  test("the offering's removal control takes the destructive tokens", () => {
    const found = classes(renderEditPointStrip());
    assert.ok(found.includes("bg-destructive/15"));
    assert.ok(found.includes("border-destructive/40"));
    assert.ok(found.includes("text-destructive"));
    assert.ok(!/-rose-\d/.test(found), found);
  });
});

describe("tile borders", () => {
  test("a placed tile and a candidate chip take the same border computation", () => {
    const tileDef = makeSensor(services, "token-border");
    const expected = tileBorderColor(tileHues.when);
    assert.ok(renderRuleCard().includes(expected));
    assert.ok(renderStrip(tileDef).includes(expected));
  });
});

describe("the editor's shadows", () => {
  /** The desk-shade token's default value written as a palette literal. */
  const shadeLiteral = /rgba\(0, ?0, ?0, ?0\.45\)/;

  test("the rule card casts the rule card's shadow token", () => {
    assert.ok(classes(renderRuleCard()).includes("shadow-(--shadow-brain-rule)"));
  });

  test("the desk's vignette takes the desk-shade token", () => {
    const found = renderToStaticMarkup(createElement(BrainRulesRegion, { stand: "loading" } as BrainRulesRegionProps));
    assert.ok(found.includes("var(--color-brain-desk-shade)"), found);
    assert.ok(!shadeLiteral.test(found), found);
  });

  test("the offering panel's drop shadow takes the desk-shade token", () => {
    const found = renderStrip(makeSensor(services, "token-shade"));
    assert.ok(found.includes("var(--color-brain-desk-shade)"), found);
    assert.ok(!shadeLiteral.test(found), found);
  });
});
