/**
 * Pins the composer's input model as traces: a sequence of tokens goes in, and
 * the effects the model asks for come out in order, leaving a state the next
 * token reads.
 *
 * The traces run against a scripted stand-in for the editor that applies the
 * effects a following token can read -- placements, the caret, the pivot, the
 * own-commit stack, the accordion -- and records every effect. Its rule is a
 * real one, so the caret run the model walks is the run that rule produces, and
 * its offering is resolved by the same predicates the strip resolves it with, so
 * a word commits here exactly where it commits in the editor. Tokens, effects,
 * caret positions, stable option ids, and tile labels are asserted; no display
 * prose is.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { List, type ReadonlyList } from "@wendoo/core";
import type { BrainServices, IBrainTileDef, ITileCatalog } from "@wendoo/core/brain";
import {
  CoreLiteralFactoryId,
  CoreVariableFactoryId,
  mkLiteralFactoryTileId,
  mkVariableFactoryTileId,
  RuleSide,
} from "@wendoo/core/brain";
import { __test__appendTile, __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { buildInsertionContext, suggestTiles } from "@wendoo/core/brain/language-service";
import type { BrainCommand, BrainRuleDef } from "@wendoo/core/brain/model";
import {
  BrainTileActuatorDef,
  type BrainTileFactoryDef,
  type BrainTileLiteralDef,
  BrainTileSensorDef,
  manufactureLiteralTile,
  manufactureVariableTile,
} from "@wendoo/core/brain/tiles";
import { createDefaultLocalizer, type Localizer } from "@wendoo/core/localization";
import { bag, CoreTypeIds, mkActionDescriptor, mkCallDef, NIL_VALUE } from "@wendoo/core/runtime";
import {
  buildStripCandidates,
  type CandidateEntry,
  categoryPriorityCandidateRanker,
  decideCandidateCommit,
  decideStripFocusTarget,
  highlightedStripOption,
  kBestNextBandKey,
  leadStripCandidate,
  leadStripCursor,
  mintNumberLiteralCandidate,
  mintTextLiteralCandidate,
  offersTextLiteral,
  resolveStripOffering,
  type StripCandidate,
  type StripCellGeometry,
  type StripCursor,
  type StripFocusTarget,
  type StripOption,
  type StripOptionBand,
  stripOptionId,
  tileDefersToCreateDialog,
  toCandidateEntries,
  visibleStripOptions,
} from "./candidate-strip-model";
import { type CaretEditIntent, type CaretPosition, caretEditIntent, caretRun } from "./caret-run";
import {
  type ComposerCloseReason,
  type ComposerInputEffect,
  type ComposerInputFacts,
  type ComposerInputState,
  type ComposerInputToken,
  composerEntryCharacter,
  composerHeadingToken,
  composerTokenForKey,
  consumesKey,
  decideSentenceCellEntry,
  reduceComposerInput,
} from "./composer-input-model";
import { deriveEditorMode, type EditorMode } from "./editor-mode";
import { kBestNextCandidateCount } from "./hooks/useCandidateStrip";
import { makeBrain } from "./test-only-rule-fixtures";
import { resolveTileVisualFrom } from "./tile-visual-utils";

let services: BrainServices;
let localizer: Localizer;
let nextFnId = 5120;

/** Identity of the strip the traces build option ids against. */
const kStripId = "composer-trace";

/** Band key of the accordion section the browsing traces open. */
const kSectionBandKey = "sensor";

/** Band key of the second accordion section, which the grid traces cross into. */
const kSecondSectionBandKey = "literal";

before(() => {
  services = __test__createBrainServices();
  localizer = createDefaultLocalizer();
});

/** Folds text for search the way the strip's localizer folds it. */
function foldText(text: string): string {
  return localizer.foldForSearch(text);
}

/** The label a tile's chip carries, resolved as the strip resolves it from a host supplying no visual resolver. */
function traceLabelOf(tileDef: IBrainTileDef): string {
  return resolveTileVisualFrom(undefined, tileDef).label;
}

function makeSensorTile(sensorId: string): IBrainTileDef {
  const fnId = nextFnId;
  nextFnId += 1;
  const fnEntry = services.runtime.functions.register(
    fnId,
    `${sensorId}#${fnId}`,
    false,
    { exec: () => NIL_VALUE },
    mkCallDef(bag())
  );
  return new BrainTileSensorDef(sensorId, mkActionDescriptor("sensor", fnEntry, CoreTypeIds.Boolean), {
    metadata: { label: sensorId },
  });
}

/** `count` tiles standing in for words a side already holds, named after that side. */
function fillerTiles(count: number, side: string): IBrainTileDef[] {
  const tiles: IBrainTileDef[] = [];
  for (let index = 0; index < count; index++) {
    tiles.push(makeSensorTile(`composer-trace-filler-${side}-${nextFnId}`));
  }
  return tiles;
}

function makeActuatorTile(actuatorId: string): IBrainTileDef {
  const fnId = nextFnId;
  nextFnId += 1;
  const fnEntry = services.runtime.functions.register(
    fnId,
    `${actuatorId}#${fnId}`,
    false,
    { exec: () => NIL_VALUE },
    mkCallDef(bag())
  );
  return new BrainTileActuatorDef(actuatorId, mkActionDescriptor("actuator", fnEntry), {
    metadata: { label: actuatorId },
  });
}

/** One offered candidate over a real tile, keyed and labelled as the strip's own candidates are. */
function candidateOf(tileDef: IBrainTileDef, label: string): StripCandidate {
  return {
    key: tileDef.tileId,
    tileDef,
    label,
    group: "sensor",
    viaConversion: false,
    origin: { kind: "suggested" },
  };
}

/** The core number-literal factory candidate, which the typed-number traces mint from. */
function numberFactoryCandidate(): StripCandidate {
  const tileDef = services.edit.tiles.get(mkLiteralFactoryTileId(CoreLiteralFactoryId.Number));
  assert.ok(tileDef, "core number literal factory not registered");
  return candidateOf(tileDef, "number");
}

/** The core text-literal factory candidate, which the typed-text traces mint from. */
function textFactoryCandidate(): StripCandidate {
  const tileDef = services.edit.tiles.get(mkLiteralFactoryTileId(CoreLiteralFactoryId.String));
  assert.ok(tileDef, "core text literal factory not registered");
  return candidateOf(tileDef, "text");
}

/**
 * The tile `candidate` puts in the rule: a minted candidate manufactured into
 * `catalog` and returned registered, any other candidate's own tile def.
 * Returns undefined when the mint produces nothing.
 */
function placedTileDef(candidate: StripCandidate, catalog: ITileCatalog | undefined): IBrainTileDef | undefined {
  const origin = candidate.origin;
  if (origin.kind === "minted-literal") {
    return manufactureLiteralTile(origin.factoryTileDef, catalog, origin.value, origin.displayFormat);
  }
  if (origin.kind === "minted-variable") {
    return manufactureVariableTile(origin.factoryTileDef, catalog, origin.varName);
  }
  return candidate.tileDef;
}

/** A command standing in for one the editor executed, identified by `description`. */
function makeCommand(description: string): BrainCommand {
  return { execute: () => {}, undo: () => {}, getDescription: () => description };
}

/** What one trace step reads and what the offering holds while it reads it. */
interface ComposerTraceOptions {
  /** The side composition starts armed on. */
  readonly armedSide?: RuleSide;
  /** Whether composition runs in the rule's sentence line or the strip's own tray. */
  readonly inSentence?: boolean;
  /**
   * The candidates offered for one filter text, before the filter narrows them.
   * The trace is passed along so an offering can be read from the rule as the
   * placements so far leave it.
   */
  readonly offeringFor?: (filter: string, trace: ComposerTrace) => readonly StripCandidate[];
  /** Every accordion band in display order, whether open or closed. */
  readonly bandSequence?: readonly StripOptionBand[];
  /**
   * True when the offering's leading candidates are drawn as the best-next row
   * ahead of `bandSequence`, rebuilt for each filter text, so the trace carries
   * the chip the strip highlights before any arrow key moves the cursor.
   */
  readonly drawsBestNext?: boolean;
  /**
   * How many best-next chips the synthetic layout puts on one row before the
   * rest wrap onto the next, as the rendered row wraps them. The whole row when
   * omitted.
   */
  readonly bestNextPerRow?: number;
  /** How many tiles each side starts with. */
  readonly whenTiles?: number;
  readonly doTiles?: number;
}

/**
 * A scripted editor the model's effects are applied to, so each token reads what
 * the ones before it did. The rule behind it is a real one, so the caret run the
 * model steps along is the run that rule produces.
 */
class ComposerTrace {
  state: ComposerInputState;
  /** True when the tiles of the armed side may end where composition stands. */
  armedSideCanEnd = true;
  /** True when the caret's position offers at least one tile, filter text aside. */
  positionOffersTile = true;
  /** Every effect the trace has asked for, in order. */
  readonly log: ComposerInputEffect[] = [];
  /** Why the strip closed, or undefined while it is open. */
  closedAs: ComposerCloseReason | undefined;
  /** Where the text cursor stands in the composer's box, which the horizontal arrows read. */
  textCursor: { start: number; end: number } = { start: 0, end: 0 };
  /** The rule being composed, whose tiles the placements land in. */
  readonly ruleDef: BrainRuleDef;
  /** The command history, newest last. */
  private readonly history: BrainCommand[] = [];
  /** The composition's own placements, newest last, with what each one took the place of. */
  private readonly placements: {
    command: BrainCommand;
    side: RuleSide;
    tileIndex: number;
    replaced: IBrainTileDef | undefined;
  }[] = [];
  private openSectionKey: string | null = null;
  /** Whether the tray's filter box stands shown, which text given to it opens. */
  private trayFilterShown = false;
  /** The chip each open text value offers, keyed by the value. */
  private readonly pendingTextChips = new Map<string, StripCandidate>();
  private readonly offeringFor: (filter: string, trace: ComposerTrace) => readonly StripCandidate[];
  private readonly bandSequence: readonly StripOptionBand[];
  private readonly drawsBestNext: boolean;
  private readonly bestNextPerRow: number | undefined;

  constructor(options: ComposerTraceOptions = {}) {
    const armedSide = options.armedSide ?? RuleSide.When;
    const inSentence = options.inSentence !== false;
    this.ruleDef = makeBrain(
      services,
      fillerTiles(options.whenTiles ?? 0, "when"),
      fillerTiles(options.doTiles ?? 0, "do")
    ).ruleDef;
    this.state = {
      caret: inSentence ? this.sideEndGap(armedSide) : undefined,
      armedSide,
      armedEntry: inSentence ? "sentence" : "tray",
      filter: "",
      cursor: undefined,
      highlightMode: "typing",
      pivoted: armedSide === RuleSide.Do,
      textLiteral: undefined,
    };
    this.offeringFor = options.offeringFor ?? (() => []);
    this.bandSequence = options.bandSequence ?? [];
    this.drawsBestNext = options.drawsBestNext === true;
    this.bestNextPerRow = options.bestNextPerRow;
  }

  /** The offering the filter text leaves, in the order the chips are drawn. */
  private visibleCandidates(): readonly StripCandidate[] {
    const offered = this.offeringFor(this.state.filter, this);
    return resolveStripOffering(offered, this.state.filter, traceLabelOf, foldText).visible;
  }

  /** Every band in display order: the derived best-next row, then the fixed sequence. */
  private bands(): readonly StripOptionBand[] {
    if (!this.drawsBestNext) return this.bandSequence;
    const leading = toCandidateEntries(this.visibleCandidates().slice(0, kBestNextCandidateCount));
    return [{ key: kBestNextBandKey, entries: leading }, ...this.bandSequence];
  }

  /** The end gap of `side`, which is where composition on that side starts. */
  sideEndGap(side: RuleSide): CaretPosition {
    return { kind: "gap", side, tileIndex: this.tileCount(side) };
  }

  /** The gap of `side` before the tile at `tileIndex`. */
  gap(side: RuleSide, tileIndex: number): CaretPosition {
    return { kind: "gap", side, tileIndex };
  }

  /** The position resting on the tile at `tileIndex` of `side`. */
  element(side: RuleSide, tileIndex: number): CaretPosition {
    return { kind: "element", side, tileIndex };
  }

  /** Every caret position of the rule, in reading order. */
  run(): readonly CaretPosition[] {
    return caretRun(this.ruleDef);
  }

  /** The edit the caret's position intends on the side it stands on. */
  editIntent(): CaretEditIntent {
    const caret = this.state.caret;
    assert.ok(caret, "the composition stands at a caret");
    return caretEditIntent(caret, this.tileCount(caret.side));
  }

  /** The bands whose chips are rendered: the best-next row, plus the one open section. */
  openBands(): readonly StripOptionBand[] {
    return this.bands().filter((band) => band.key === kBestNextBandKey || band.key === this.openSectionKey);
  }

  /** Every rendered chip, in the order the highlight walks them. */
  options(): readonly StripOption[] {
    return visibleStripOptions(kStripId, this.openBands());
  }

  /** Where DOM focus belongs while the highlight rests where it does. */
  focusTarget(): StripFocusTarget {
    return decideStripFocusTarget(this.options(), this.state.cursor, this.state.highlightMode);
  }

  /** The chip drawn as highlighted, which is the chip Enter places. */
  highlightedOption(): StripOption | undefined {
    return highlightedStripOption(this.options(), this.state.cursor, this.leadCandidateKey());
  }

  /** The candidate the offering leads with, whose chip is highlighted before any arrow key. */
  leadCandidateKey(): string | undefined {
    return leadStripCandidate(this.visibleCandidates(), this.state.filter)?.key;
  }

  /** The cell the offering draws the highlight on while the cursor stands on none. */
  leadCursor(): StripCursor | undefined {
    return leadStripCursor(this.options(), this.leadCandidateKey());
  }

  /** The context this arming stands the keyboard in, derived as the strip derives it. */
  mode(): EditorMode {
    return deriveEditorMode({
      arming: {
        entry: this.state.armedEntry,
        boxIsShown: this.state.armedEntry === "sentence" || this.trayFilterShown,
        textLiteralIsOpen: this.state.textLiteral !== undefined,
      },
    });
  }

  /** Add a command the composition did not make, which becomes the history's newest entry. */
  pushForeignCommand(description: string): void {
    this.history.push(makeCommand(description));
  }

  /** How many placements of the composition's own still stand. */
  ownCommitCount(): number {
    return this.placements.length;
  }

  /** How many entries the command history holds. */
  historyLength(): number {
    return this.history.length;
  }

  /** The tiles of `side`, by the id each one was registered under. */
  tileIds(side: RuleSide): string[] {
    return this.ruleDef
      .side(side)
      .tiles()
      .toArray()
      .map((tileDef) => tileDef.tileId);
  }

  /** Stand the caret at `position`, as a tap on the rule's line does. */
  placeCaret(position: CaretPosition): void {
    this.state = { ...this.state, caret: position };
  }

  /** How many tiles the rule holds on `side`. */
  tileCount(side: RuleSide): number {
    return this.ruleDef.side(side).tiles().size();
  }

  /** Type `word` a character at a time, as the filter box reports its own content. */
  typeWord(word: string): void {
    for (let length = 1; length <= word.length; length++) {
      this.press({ kind: "text", text: word.slice(0, length) });
    }
  }

  /** Feed one token through the model, apply what it asks for, and return the effects of this press. */
  press(token: ComposerInputToken): readonly ComposerInputEffect[] {
    const before = this.state;
    const outcome = reduceComposerInput(before, token, this.facts());
    this.state = outcome.state;
    const pressed: ComposerInputEffect[] = [];
    for (const effect of outcome.effects) {
      pressed.push(effect);
      this.log.push(effect);
      const followed = this.apply(effect, before);
      pressed.push(...followed);
    }
    return pressed;
  }

  /**
   * The candidate the open text value places, minted once per value so the same
   * value always offers the same chip.
   */
  pendingTextChip(): StripCandidate | undefined {
    const value = this.state.textLiteral;
    if (value === undefined) return undefined;
    const cached = this.pendingTextChips.get(value);
    if (cached) return cached;
    const minted = mintTextLiteralCandidate(this.offeringFor(this.state.filter, this), value, traceLabelOf);
    if (minted) this.pendingTextChips.set(value, minted);
    return minted;
  }

  /**
   * The element the composition's own newest placement stands at, while the
   * command that made it is still the history's newest entry.
   */
  private ownNewestPlacement(): CaretPosition | undefined {
    const own = this.placements[this.placements.length - 1];
    if (own === undefined || this.history[this.history.length - 1] !== own.command) return undefined;
    return { kind: "element", side: own.side, tileIndex: own.tileIndex };
  }

  /** The facts of the moment, read the way the strip reads them. */
  private facts(): ComposerInputFacts {
    const offered = this.offeringFor(this.state.filter, this);
    const { visible } = resolveStripOffering(offered, this.state.filter, traceLabelOf, foldText);
    const activeOption = this.highlightedOption();
    return {
      mode: this.mode(),
      caretRun: this.run(),
      textCursor: this.textCursor,
      acceptsTextLiteral: offersTextLiteral(offered),
      pendingTextLiteral: this.pendingTextChip(),
      armedSideCanEnd: this.armedSideCanEnd,
      positionOffersTile: this.positionOffersTile,
      ruleIsEmpty: this.tileCount(RuleSide.When) === 0 && this.tileCount(RuleSide.Do) === 0,
      doTileCount: this.tileCount(RuleSide.Do),
      ownNewestPlacement: this.ownNewestPlacement(),
      topCandidate: decideCandidateCommit(visible, this.state.filter, "enter", foldText),
      spaceCandidate: decideCandidateCommit(visible, this.state.filter, "space", foldText),
      highlightedCandidate: visible.find((candidate) => candidate.key === activeOption?.candidateKey),
      highlightedCommand: undefined,
      leadCursor: this.leadCursor(),
      options: this.options(),
      cellGeometry: this.layOutGrid(),
    };
  }

  /**
   * Synthetic layout for the offering's grid: the best-next chips wrapped
   * `bestNextPerRow` to a row, then each section's heading on a row of its own,
   * followed by the chips it heads while that section is open. A heading spans
   * the panel, so its center sits to the right of the chips beside it.
   */
  private layOutGrid(): StripCellGeometry[] {
    const cells: StripCellGeometry[] = [];
    let row = 0;
    const addChips = (bandKey: string, entries: readonly CandidateEntry[], perRow: number) => {
      for (const [index, entry] of entries.entries()) {
        const column = index % perRow;
        if (index > 0 && column === 0) row += 1;
        cells.push({
          cursor: { kind: "chip", optionId: stripOptionId(kStripId, bandKey, entry.candidate.key) },
          left: column * 100,
          width: 90,
          top: row * 40,
        });
      }
      row += 1;
    };
    for (const band of this.bands()) {
      if (band.entries.length === 0) continue;
      if (band.key === kBestNextBandKey) {
        addChips(band.key, band.entries, this.bestNextPerRow ?? band.entries.length);
        continue;
      }
      cells.push({ cursor: { kind: "heading", sectionKey: band.key }, left: 0, width: 400, top: row * 40 });
      row += 1;
      if (band.key === this.openSectionKey) addChips(band.key, band.entries, band.entries.length);
    }
    return cells;
  }

  /** Carry out one effect, returning any effects the follow-up token asked for. */
  private apply(effect: ComposerInputEffect, before: ComposerInputState): readonly ComposerInputEffect[] {
    switch (effect.kind) {
      case "place-tile": {
        // The trace stands no create dialog, so a deferring candidate places nothing.
        if (tileDefersToCreateDialog(effect.candidate.tileDef)) return [];
        const tileDef = placedTileDef(effect.candidate, this.ruleDef.brain()?.catalog());
        if (!tileDef) return [];
        const command = makeCommand(`placed:${effect.candidate.key}`);
        const caret = before.caret;
        const side = caret?.side ?? before.armedSide;
        const tileSet = this.ruleDef.side(side);
        const tileIndex = caret === undefined ? tileSet.tiles().size() : caret.tileIndex;
        const replaced = caret?.kind === "element" ? tileSet.tiles().get(tileIndex) : undefined;
        if (replaced === undefined) tileSet.insertTileAtIndex(tileIndex, tileDef);
        else tileSet.replaceTileAtIndex(tileIndex, tileDef);
        this.history.push(command);
        this.placements.push({ command, side, tileIndex, replaced });
        return [];
      }
      case "undo-own-commit": {
        const placement = this.placements.pop();
        assert.ok(placement, "nothing of the composition's own to take back");
        this.history.pop();
        const tileSet = this.ruleDef.side(placement.side);
        if (placement.replaced === undefined) tileSet.removeTileAtIndex(placement.tileIndex);
        else tileSet.replaceTileAtIndex(placement.tileIndex, placement.replaced);
        return [];
      }
      case "delete-tile": {
        this.history.push(makeCommand(`removed:${effect.position.side}:${effect.position.tileIndex}`));
        this.ruleDef.side(effect.position.side).removeTileAtIndex(effect.position.tileIndex);
        return [];
      }
      // Text given to the box shows it, as the strip's own driver shows it.
      case "set-filter":
        if (effect.text.length > 0) this.trayFilterShown = true;
        return [];
      case "set-text-literal":
        if (effect.value !== undefined) this.trayFilterShown = true;
        return [];
      case "open-section":
        this.openSectionKey = effect.sectionKey;
        return [];
      case "close-section":
        if (this.openSectionKey === effect.sectionKey) this.openSectionKey = null;
        return [];
      case "close-strip":
        this.closedAs = effect.reason;
        return [];
      case "reask":
        return this.press(effect.token);
      case "move-caret":
        // The caret the model returned in its state is the one it asked for.
        assert.deepEqual(this.state.caret, effect.position);
        return [];
      default:
        return [];
    }
  }
}

const consumeKey: ComposerInputEffect = { kind: "consume-key" };
const typingFocus: ComposerInputEffect = { kind: "move-focus", target: { kind: "input" }, keepScroll: false };
const settledFocus: ComposerInputEffect = { kind: "move-focus", target: { kind: "input" }, keepScroll: true };
const clearHighlight: ComposerInputEffect = { kind: "highlight", cursor: undefined, mode: "typing" };
const flashCaret: ComposerInputEffect = { kind: "flash-caret" };

/** The cursor standing on the chip `optionId`. */
function chipAt(optionId: string): StripCursor {
  return { kind: "chip", optionId };
}

/** The cursor standing on the accordion heading of `sectionKey`. */
function headingAt(sectionKey: string): StripCursor {
  return { kind: "heading", sectionKey };
}

/** The re-ask a placement made on the way to nothing in particular is decided by. */
const landedReask: ComposerInputEffect = {
  kind: "reask",
  token: { kind: "placement-landed", gesture: "continue" },
};

/**
 * The effects every placement asks for, with the caret coming to rest at
 * `caret`, plus whatever gesture it was made on the way to. A placement made on
 * the way to no gesture of its own is re-asked where it landed.
 */
function placementEffects(
  candidate: StripCandidate,
  caret: CaretPosition,
  ...then: readonly ComposerInputEffect[]
): readonly ComposerInputEffect[] {
  return [
    consumeKey,
    { kind: "place-tile", candidate },
    { kind: "announce-placement", label: candidate.label },
    { kind: "move-caret", position: caret },
    clearHighlight,
    settledFocus,
    ...(then.length > 0 ? then : [landedReask]),
  ];
}

/** The effects one typed character asks for. */
function typedEffects(text: string): readonly ComposerInputEffect[] {
  return [{ kind: "set-filter", text }, clearHighlight];
}

/** Every place-tile effect of `log`, in order, by the candidate key it placed. */
function placedKeys(log: readonly ComposerInputEffect[]): string[] {
  return log.filter((effect) => effect.kind === "place-tile").map((effect) => effect.candidate.key);
}

describe("composing a rule from the keyboard", () => {
  test("word, space, word, space, comma, word, space, period places, pivots, and settles in order", () => {
    const see = candidateOf(makeSensorTile("composer-trace-see"), "see");
    const plant = candidateOf(makeSensorTile("composer-trace-plant"), "plant");
    const jump = candidateOf(makeActuatorTile("composer-trace-jump"), "jump");
    const trace = new ComposerTrace({ offeringFor: () => [see, plant, jump] });

    trace.typeWord("see");
    assert.deepEqual(trace.press({ kind: "space" }), placementEffects(see, trace.gap(RuleSide.When, 1)));
    trace.typeWord("plant");
    assert.deepEqual(trace.press({ kind: "space" }), placementEffects(plant, trace.gap(RuleSide.When, 2)));

    assert.deepEqual(trace.press({ kind: "comma" }), [
      consumeKey,
      { kind: "move-caret", position: trace.gap(RuleSide.Do, 0) },
    ]);
    assert.equal(trace.state.armedSide, RuleSide.Do);
    assert.equal(trace.state.pivoted, true);

    trace.typeWord("jump");
    assert.deepEqual(trace.press({ kind: "space" }), placementEffects(jump, trace.gap(RuleSide.Do, 1)));
    assert.deepEqual(trace.press({ kind: "period" }), [consumeKey, { kind: "close-strip", reason: "settled" }]);

    assert.deepEqual(placedKeys(trace.log), [see.key, plant.key, jump.key]);
    assert.equal(trace.closedAs, "settled");
    assert.equal(trace.tileCount(RuleSide.When), 2);
    assert.equal(trace.tileCount(RuleSide.Do), 1);
    assert.equal(trace.ownCommitCount(), 3);
    assert.equal(trace.state.filter, "");
  });

  test("the last typed character is the filter the commit resolves against", () => {
    const see = candidateOf(makeSensorTile("composer-trace-see-2"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see] });

    assert.deepEqual(trace.press({ kind: "text", text: "s" }), typedEffects("s"));
    assert.equal(trace.state.filter, "s");
    assert.deepEqual(trace.press({ kind: "text", text: "se" }), typedEffects("se"));
    trace.press({ kind: "text", text: "see" });

    assert.deepEqual(trace.press({ kind: "space" }), placementEffects(see, trace.gap(RuleSide.When, 1)));
  });

  test("Enter places the top candidate with no chip highlighted, where Space would refuse the word", () => {
    const seek = candidateOf(makeSensorTile("composer-trace-enter-seek"), "seek");
    const seed = candidateOf(makeSensorTile("composer-trace-enter-seed"), "seed");
    const trace = new ComposerTrace({ offeringFor: () => [seek, seed] });

    trace.typeWord("se");
    // The prefix fits both words, so it names no one word for Space to place.
    assert.deepEqual(trace.press({ kind: "space" }), []);

    assert.deepEqual(
      trace.press({ kind: "enter", from: "filter" }),
      placementEffects(seek, trace.gap(RuleSide.When, 1))
    );
    assert.deepEqual(trace.tileIds(RuleSide.When), [seek.key]);
    assert.equal(trace.state.cursor, undefined);
    assert.equal(trace.state.filter, "");
  });
});

/** A press of the named arrow in the composer's box. */
const leftArrow: ComposerInputToken = { kind: "arrow", direction: "left", from: "filter" };
const rightArrow: ComposerInputToken = { kind: "arrow", direction: "right", from: "filter" };

describe("walking the caret along the run", () => {
  test("Right reaches every position in order and clamps at the last, and Left walks back to the first", () => {
    const trace = new ComposerTrace({ whenTiles: 2, doTiles: 1 });
    const run = trace.run();
    trace.placeCaret(run[0]);

    for (let index = 1; index < run.length; index++) {
      trace.press(rightArrow);
      assert.deepEqual(trace.state.caret, run[index], `right to ${index}`);
    }
    assert.deepEqual(trace.press(rightArrow), [
      consumeKey,
      { kind: "move-caret", position: run[run.length - 1] },
      clearHighlight,
    ]);
    assert.deepEqual(trace.state.caret, run[run.length - 1], "the last position clamps");

    for (let index = run.length - 2; index >= 0; index--) {
      trace.press(leftArrow);
      assert.deepEqual(trace.state.caret, run[index], `left to ${index}`);
    }
    trace.press(leftArrow);
    assert.deepEqual(trace.state.caret, run[0], "the first position clamps");
  });

  test("crossing from the last WHEN tile to the DO side takes two presses", () => {
    const trace = new ComposerTrace({ whenTiles: 1, doTiles: 1 });
    trace.placeCaret(trace.element(RuleSide.When, 0));

    trace.press(rightArrow);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1), "the clause the WHEN side ends");
    trace.press(rightArrow);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.Do, 0), "and the one the DO side opens");
  });

  test("the edit intended at each position of the walk names its mode, side and tile", () => {
    const trace = new ComposerTrace({ whenTiles: 2, doTiles: 1 });
    const intents: CaretEditIntent[] = [];
    trace.placeCaret(trace.run()[0]);
    for (let index = 0; index < trace.run().length; index++) {
      intents.push(trace.editIntent());
      trace.press(rightArrow);
    }
    assert.deepEqual(intents, [
      { mode: "insert", side: RuleSide.When, tileIndex: 0 },
      { mode: "replace", side: RuleSide.When, tileIndex: 0 },
      { mode: "insert", side: RuleSide.When, tileIndex: 1 },
      { mode: "replace", side: RuleSide.When, tileIndex: 1 },
      { mode: "append", side: RuleSide.When },
      { mode: "insert", side: RuleSide.Do, tileIndex: 0 },
      { mode: "replace", side: RuleSide.Do, tileIndex: 0 },
      { mode: "append", side: RuleSide.Do },
    ]);
  });

  test("Home takes the run's first position and End its last", () => {
    const trace = new ComposerTrace({ whenTiles: 2, doTiles: 1 });
    const run = trace.run();
    trace.placeCaret(trace.element(RuleSide.When, 1));

    assert.deepEqual(trace.press({ kind: "home" }), [
      consumeKey,
      { kind: "move-caret", position: run[0] },
      clearHighlight,
    ]);
    assert.deepEqual(trace.state.caret, run[0]);

    trace.placeCaret(trace.element(RuleSide.When, 1));
    assert.deepEqual(trace.press({ kind: "end" }), [
      consumeKey,
      { kind: "move-caret", position: run[run.length - 1] },
      clearHighlight,
    ]);
    assert.deepEqual(trace.state.caret, run[run.length - 1]);
  });

  test("moving the caret releases the chip the highlight rested on", () => {
    const see = candidateOf(makeSensorTile("composer-trace-caret-highlight"), "see");
    const jump = candidateOf(makeActuatorTile("composer-trace-caret-highlight-jump"), "jump");
    const trace = new ComposerTrace({
      whenTiles: 1,
      offeringFor: () => [see, jump],
      bandSequence: [{ key: kBestNextBandKey, entries: toCandidateEntries([see, jump]) }],
      bestNextPerRow: 1,
    });
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.ok(trace.state.cursor, "the cursor stands on a chip");

    trace.press({ kind: "home" });
    assert.equal(trace.state.cursor, undefined);
    assert.equal(trace.state.highlightMode, "typing");
  });

  test("a caret the rule's run no longer holds is stood back on it, and the key steps from there", () => {
    const trace = new ComposerTrace({ whenTiles: 2 });
    trace.placeCaret(trace.gap(RuleSide.When, 2));
    trace.ruleDef.when().removeTileAtIndex(1);

    assert.deepEqual(trace.press(leftArrow), [
      consumeKey,
      { kind: "move-caret", position: trace.element(RuleSide.When, 0) },
      clearHighlight,
    ]);
  });

  test("a caret resting on a tile that has gone steps on from the gap that tile vacated", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.placeCaret(trace.element(RuleSide.When, 0));
    trace.ruleDef.when().removeTileAtIndex(0);

    assert.deepEqual(trace.press(rightArrow), [
      consumeKey,
      { kind: "move-caret", position: trace.gap(RuleSide.Do, 0) },
      clearHighlight,
    ]);
  });

  test("the key is the composer's even where standing the caret back leaves it nowhere to step", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.placeCaret(trace.element(RuleSide.When, 0));
    trace.ruleDef.when().removeTileAtIndex(0);

    assert.deepEqual(trace.press(leftArrow), [
      consumeKey,
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
      clearHighlight,
    ]);
  });

  test("a strip armed from the tray stands at no caret, so the run's own keys stay with its box", () => {
    const trace = new ComposerTrace({ inSentence: false, whenTiles: 1 });

    assert.deepEqual(trace.press({ kind: "home" }), []);
    assert.deepEqual(trace.press({ kind: "end" }), []);
  });

  test("the horizontal arrows reach no caret from the tray, and no chip where the offering stands none", () => {
    const trace = new ComposerTrace({ inSentence: false, whenTiles: 1 });
    assert.deepEqual(trace.options(), [], "the offering draws no chip");

    assert.deepEqual(trace.press(leftArrow), []);
    assert.deepEqual(trace.press(rightArrow), []);
    assert.equal(trace.state.caret, undefined);
    assert.equal(trace.state.cursor, undefined);
  });
});

describe("the caret against the text being typed", () => {
  /** A trace holding one tile, offering one word, with `typed` standing in its box. */
  function typedTrace(typed: string): ComposerTrace {
    const see = candidateOf(makeSensorTile(`composer-trace-typed-${typed}-${nextFnId}`), "see");
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [see] });
    trace.placeCaret(trace.gap(RuleSide.When, 1));
    trace.typeWord(typed);
    return trace;
  }

  test("with the cursor inside the text, neither arrow is the composer's", () => {
    const trace = typedTrace("se");
    trace.textCursor = { start: 1, end: 1 };

    assert.deepEqual(trace.press(leftArrow), [], "left");
    assert.deepEqual(trace.press(rightArrow), [], "right");
    assert.equal(trace.state.filter, "se", "the text stands");
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1), "and so does the caret");
  });

  test("with the text selected, neither arrow is the composer's at either end", () => {
    const trace = typedTrace("se");
    trace.textCursor = { start: 0, end: 2 };

    assert.deepEqual(trace.press(leftArrow), [], "left");
    assert.deepEqual(trace.press(rightArrow), [], "right");
    assert.equal(trace.state.filter, "se");
  });

  test("the arrow that would carry the cursor further into the text is the box's own", () => {
    const atStart = typedTrace("se");
    atStart.textCursor = { start: 0, end: 0 };
    assert.deepEqual(atStart.press(rightArrow), [], "right from the start of the text");

    const atEnd = typedTrace("se");
    atEnd.textCursor = { start: 2, end: 2 };
    assert.deepEqual(atEnd.press(leftArrow), [], "left from the end of the text");
  });

  test("Left at the start of the text abandons it and steps the caret back", () => {
    const trace = typedTrace("se");
    trace.textCursor = { start: 0, end: 0 };

    assert.deepEqual(trace.press(leftArrow), [
      consumeKey,
      { kind: "set-filter", text: "" },
      { kind: "move-caret", position: trace.element(RuleSide.When, 0) },
      clearHighlight,
    ]);
    assert.equal(trace.state.filter, "");
  });

  test("Right at the end of the text places it, coming to rest past the tile placed", () => {
    const see = candidateOf(makeSensorTile("composer-trace-right-commit"), "see");
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [see] });
    trace.placeCaret(trace.gap(RuleSide.When, 1));
    trace.typeWord("se");
    trace.textCursor = { start: 2, end: 2 };

    assert.deepEqual(trace.press(rightArrow), placementEffects(see, trace.gap(RuleSide.When, 2)));
    assert.equal(trace.tileCount(RuleSide.When), 2);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 2), "one advance, to the gap past the tile placed");
    assert.equal(trace.state.filter, "");
  });

  test("Right at the end of text that names nothing to place is refused, moving and discarding nothing", () => {
    const see = candidateOf(makeSensorTile("composer-trace-right-refuse"), "see");
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [see] });
    trace.placeCaret(trace.gap(RuleSide.When, 1));
    trace.typeWord("zzz");
    trace.textCursor = { start: 3, end: 3 };

    assert.deepEqual(trace.press(rightArrow), [consumeKey]);
    assert.equal(trace.state.filter, "zzz", "the text stands");
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1), "and so does the caret");
    assert.deepEqual(placedKeys(trace.log), []);
    assert.equal(trace.tileCount(RuleSide.When), 1);
  });

  test("a word typed over a tile is abandoned leaving that tile as it stands", () => {
    const see = candidateOf(makeSensorTile("composer-trace-abandon-see"), "see");
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [see] });
    trace.placeCaret(trace.element(RuleSide.When, 0));
    const standing = trace.ruleDef.when().tiles().get(0);
    trace.typeWord("see");
    trace.textCursor = { start: 0, end: 0 };

    trace.press(leftArrow);

    assert.deepEqual(placedKeys(trace.log), [], "nothing was placed");
    assert.equal(trace.ruleDef.when().tiles().get(0), standing, "the tile the word stood over is untouched");
    assert.equal(trace.tileCount(RuleSide.When), 1);
    assert.equal(trace.ownCommitCount(), 0);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 0));
  });

  test("Left at the start of an open text value abandons it, placing no literal", () => {
    const factory = textFactoryCandidate();
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [factory] });
    trace.placeCaret(trace.gap(RuleSide.When, 1));
    trace.press({ kind: "quote" });
    trace.typeWord("hi");
    trace.textCursor = { start: 0, end: 0 };

    assert.deepEqual(trace.press(leftArrow), [
      consumeKey,
      { kind: "set-text-literal", value: undefined },
      { kind: "move-caret", position: trace.element(RuleSide.When, 0) },
      clearHighlight,
    ]);
    assert.equal(trace.state.textLiteral, undefined);
    assert.deepEqual(placedKeys(trace.log), []);
    assert.equal(trace.tileCount(RuleSide.When), 1);
  });

  test("Right at the end of an open text value places it, exactly as its closing quote would", () => {
    const factory = textFactoryCandidate();
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [factory] });
    trace.placeCaret(trace.gap(RuleSide.When, 1));
    trace.press({ kind: "quote" });
    trace.typeWord("hi");
    trace.textCursor = { start: 2, end: 2 };
    const chip = trace.pendingTextChip();
    assert.ok(chip, "the open value offers a chip to place it with");

    assert.deepEqual(
      trace.press(rightArrow),
      placementEffects(chip, trace.gap(RuleSide.When, 2), { kind: "set-text-literal", value: undefined }, landedReask)
    );
    assert.equal(trace.state.textLiteral, undefined);
    assert.equal(trace.tileCount(RuleSide.When), 2);
  });

  test("an empty text value is left by Left, whose cursor stands at both its ends", () => {
    const factory = textFactoryCandidate();
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [factory] });
    trace.placeCaret(trace.gap(RuleSide.When, 1));
    trace.press({ kind: "quote" });
    trace.textCursor = { start: 0, end: 0 };

    trace.press(leftArrow);
    assert.equal(trace.state.textLiteral, undefined);
    assert.deepEqual(trace.state.caret, trace.element(RuleSide.When, 0));
    assert.deepEqual(placedKeys(trace.log), []);
  });

  test("Home and End belong to the box while text stands in it", () => {
    const trace = typedTrace("se");
    trace.textCursor = { start: 1, end: 1 };

    assert.deepEqual(trace.press({ kind: "home" }), []);
    assert.deepEqual(trace.press({ kind: "end" }), []);
    assert.equal(trace.state.filter, "se");
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1));
  });
});

describe("the backspace ladder", () => {
  test("walks back from a pivoted DO side through the filter, the pivot, each own commit, and then nothing", () => {
    const see = candidateOf(makeSensorTile("composer-trace-ladder-see"), "see");
    const plant = candidateOf(makeSensorTile("composer-trace-ladder-plant"), "plant");
    const trace = new ComposerTrace({ offeringFor: () => [see, plant] });

    trace.typeWord("see");
    trace.press({ kind: "space" });
    trace.typeWord("plant");
    trace.press({ kind: "space" });
    trace.press({ kind: "comma" });
    trace.typeWord("ju");

    // The word in progress goes first, and the filter box makes that edit itself.
    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), []);
    trace.press({ kind: "text", text: "j" });
    trace.press({ kind: "text", text: "" });

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "move-caret", position: trace.gap(RuleSide.When, 2) },
    ]);
    assert.equal(trace.state.pivoted, false);
    assert.equal(trace.state.armedSide, RuleSide.When);

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "undo-own-commit" },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 1) },
    ]);
    assert.equal(trace.ownCommitCount(), 1);
    assert.equal(trace.tileCount(RuleSide.When), 1);

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "undo-own-commit" },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.equal(trace.ownCommitCount(), 0);
    assert.equal(trace.tileCount(RuleSide.When), 0);

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), []);
  });

  test("a command the composition did not make becoming newest removes the tile instead of taking the placement back", () => {
    const see = candidateOf(makeSensorTile("composer-trace-foreign-see"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see] });

    trace.typeWord("see");
    trace.press({ kind: "space" });
    trace.pushForeignCommand("composer-trace-foreign-edit");

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.equal(trace.tileCount(RuleSide.When), 0);
  });

  test("backspace on a band's chips edits the word in progress and hands the keyboard back", () => {
    const see = candidateOf(makeSensorTile("composer-trace-band-see"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see] });
    trace.typeWord("se");

    assert.deepEqual(trace.press({ kind: "backspace", from: "band" }), [
      typingFocus,
      consumeKey,
      { kind: "set-filter", text: "s" },
      clearHighlight,
    ]);
    assert.equal(trace.state.filter, "s");
  });
});

describe("deleting at the caret", () => {
  /** A trace whose DO side already reads one word, with another offered to type. */
  function reportedFlowTrace(): { trace: ComposerTrace; sad: StripCandidate; happyId: string } {
    const sad = candidateOf(makeSensorTile("composer-trace-flow-sad"), "sad");
    const trace = new ComposerTrace({ offeringFor: () => [sad] });
    const happy = makeActuatorTile("composer-trace-flow-happy");
    __test__appendTile(trace.ruleDef.do(), happy);
    return { trace, sad, happyId: happy.tileId };
  }

  test("the caret decides what goes, not what the composition placed last", () => {
    const { trace, sad, happyId } = reportedFlowTrace();
    trace.placeCaret(trace.element(RuleSide.Do, 0));

    trace.press(leftArrow);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.Do, 0));

    trace.typeWord("sad");
    trace.press({ kind: "space" });
    assert.deepEqual(trace.tileIds(RuleSide.Do), [sad.tileDef.tileId, happyId]);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.Do, 1));

    trace.press(rightArrow);
    trace.press(rightArrow);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.Do, 2), "the gap past the word that was already there");

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.Do, 1) },
      { kind: "move-caret", position: trace.gap(RuleSide.Do, 1) },
    ]);
    assert.deepEqual(
      trace.tileIds(RuleSide.Do),
      [sad.tileDef.tileId],
      "the word behind the caret is the one that goes"
    );
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.Do, 1));
  });

  test("Backspace on an element deletes that element", () => {
    const trace = new ComposerTrace({ whenTiles: 2 });
    const remaining = trace.tileIds(RuleSide.When)[1];
    trace.placeCaret(trace.element(RuleSide.When, 0));

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), [remaining]);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 0), "the caret rests in the gap the tile vacated");
  });

  test("Backspace in a gap deletes the element before it", () => {
    const trace = new ComposerTrace({ whenTiles: 2 });
    const remaining = trace.tileIds(RuleSide.When)[1];
    trace.placeCaret(trace.gap(RuleSide.When, 1));

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), [remaining]);
  });

  test("Backspace at the run's first position has nothing before it to delete", () => {
    const trace = new ComposerTrace({ whenTiles: 1, doTiles: 1 });
    trace.placeCaret(trace.run()[0]);

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), []);
    assert.equal(trace.tileCount(RuleSide.When), 1);
    assert.equal(trace.tileCount(RuleSide.Do), 1);
  });

  test("Backspace in the DO side's opening gap crosses the clause comma", () => {
    const trace = new ComposerTrace({ whenTiles: 1, doTiles: 1 });
    const action = trace.tileIds(RuleSide.Do)[0];
    trace.placeCaret(trace.gap(RuleSide.Do, 0));

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), []);
    assert.deepEqual(trace.tileIds(RuleSide.Do), [action], "the DO side is untouched");
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 0));
  });

  test("Delete in a gap deletes the element after it", () => {
    const trace = new ComposerTrace({ whenTiles: 2 });
    const remaining = trace.tileIds(RuleSide.When)[1];
    trace.placeCaret(trace.gap(RuleSide.When, 0));

    assert.deepEqual(trace.press({ kind: "delete-forward" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), [remaining]);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 0));
  });

  test("Delete on an element deletes that element, as Backspace on it does", () => {
    const trace = new ComposerTrace({ whenTiles: 2 });
    const remaining = trace.tileIds(RuleSide.When)[0];
    trace.placeCaret(trace.element(RuleSide.When, 1));

    assert.deepEqual(trace.press({ kind: "delete-forward" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 1) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 1) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), [remaining]);
  });

  test("Delete at the run's last position has nothing after it to delete", () => {
    const trace = new ComposerTrace({ whenTiles: 1, doTiles: 1 });
    const run = trace.run();
    trace.placeCaret(run[run.length - 1]);

    assert.deepEqual(trace.press({ kind: "delete-forward" }), []);
    assert.equal(trace.tileCount(RuleSide.When), 1);
    assert.equal(trace.tileCount(RuleSide.Do), 1);
  });

  test("Delete in the WHEN side's end gap crosses the clause comma the other way", () => {
    const trace = new ComposerTrace({ whenTiles: 1, doTiles: 1 });
    const condition = trace.tileIds(RuleSide.When)[0];
    trace.placeCaret(trace.gap(RuleSide.When, 1));

    assert.deepEqual(trace.press({ kind: "delete-forward" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.Do, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.Do, 0) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), [condition]);
    assert.deepEqual(trace.tileIds(RuleSide.Do), []);
  });

  test("Delete belongs to the box while a word stands in it", () => {
    const see = candidateOf(makeSensorTile("composer-trace-delete-typing"), "see");
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [see] });
    trace.placeCaret(trace.gap(RuleSide.When, 0));
    trace.typeWord("se");

    assert.deepEqual(trace.press({ kind: "delete-forward" }), []);
    assert.equal(trace.state.filter, "se");
    assert.equal(trace.tileCount(RuleSide.When), 1);
  });

  test("a caret the run no longer holds deletes from where it stands on the run now", () => {
    const trace = new ComposerTrace({ whenTiles: 2 });
    const first = trace.tileIds(RuleSide.When)[0];
    trace.placeCaret(trace.element(RuleSide.When, 1));
    trace.ruleDef.when().removeTileAtIndex(1);

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), [], `the one tile left was ${first}`);
  });

  test("a named element goes whatever the caret is doing, and the caret rests where it stood", () => {
    const trace = new ComposerTrace({ whenTiles: 2 });
    const remaining = trace.tileIds(RuleSide.When)[0];
    trace.placeCaret(trace.gap(RuleSide.When, 0));

    assert.deepEqual(trace.press({ kind: "delete-element", position: trace.element(RuleSide.When, 1) }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 1) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 1) },
    ]);
    assert.deepEqual(trace.tileIds(RuleSide.When), [remaining]);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1), "the caret rests in the gap the tile vacated");
  });

  test("a named element goes with a word standing in the box, which Delete leaves alone", () => {
    const see = candidateOf(makeSensorTile("composer-trace-named-typing"), "see");
    const trace = new ComposerTrace({ whenTiles: 1, offeringFor: () => [see] });
    trace.placeCaret(trace.element(RuleSide.When, 0));
    trace.typeWord("se");

    assert.deepEqual(trace.press({ kind: "delete-forward" }), []);
    assert.deepEqual(trace.press({ kind: "delete-element", position: trace.element(RuleSide.When, 0) }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.equal(trace.tileCount(RuleSide.When), 0);
  });

  test("a named element goes from a strip standing at no caret of its own", () => {
    const trace = new ComposerTrace({ whenTiles: 1, inSentence: false });
    assert.equal(trace.state.caret, undefined);

    assert.deepEqual(trace.press({ kind: "delete-element", position: trace.element(RuleSide.When, 0) }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.equal(trace.tileCount(RuleSide.When), 0);
  });

  test("a named element the composition placed last is taken back rather than removed", () => {
    const see = candidateOf(makeSensorTile("composer-trace-named-own"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see] });
    trace.typeWord("see");
    trace.press({ kind: "space" });

    assert.deepEqual(trace.press({ kind: "delete-element", position: trace.element(RuleSide.When, 0) }), [
      consumeKey,
      { kind: "undo-own-commit" },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.equal(trace.ownCommitCount(), 0);
    assert.equal(trace.historyLength(), 0);
    assert.equal(trace.tileCount(RuleSide.When), 0);
  });

  test("the vertical arrows delete nothing and leave the caret where it stands", () => {
    for (const direction of ["up", "down"] as const) {
      const trace = new ComposerTrace({ whenTiles: 2 });
      trace.placeCaret(trace.element(RuleSide.When, 0));
      const tiles = trace.tileIds(RuleSide.When);

      trace.press({ kind: "arrow", direction, from: "filter" });

      assert.deepEqual(trace.tileIds(RuleSide.When), tiles, `${direction} deletes nothing`);
      assert.deepEqual(trace.state.caret, trace.element(RuleSide.When, 0), `${direction} moves no caret`);
    }
  });

  test("taking back the composition's own newest placement leaves what a removal leaves, and no history behind", () => {
    const see = candidateOf(makeSensorTile("composer-trace-own-newest"), "see");
    const own = new ComposerTrace({ offeringFor: () => [see] });
    own.typeWord("see");
    own.press({ kind: "space" });
    assert.equal(own.historyLength(), 1, "the placement is the one entry");

    assert.deepEqual(own.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "undo-own-commit" },
      { kind: "move-caret", position: own.gap(RuleSide.When, 0) },
    ]);
    assert.equal(own.historyLength(), 0, "which the deletion takes back rather than adding a second");

    const removed = new ComposerTrace({ offeringFor: () => [see] });
    removed.typeWord("see");
    removed.press({ kind: "space" });
    removed.pushForeignCommand("composer-trace-own-newest-edit");
    removed.press({ kind: "backspace", from: "filter" });

    assert.deepEqual(removed.tileIds(RuleSide.When), own.tileIds(RuleSide.When), "the same document either way");
    assert.deepEqual(removed.state.caret, own.state.caret, "and the same resting place");
    assert.equal(removed.historyLength(), 3, "the placement, the edit between, and a removal of its own");
  });
});

describe("the comma", () => {
  test("stays filter text with a word in progress that resolves to nothing", () => {
    const see = candidateOf(makeSensorTile("composer-trace-comma-see"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see] });
    trace.typeWord("zzz");

    assert.deepEqual(trace.press({ kind: "comma" }), []);
    assert.deepEqual(placedKeys(trace.log), []);
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.state.pivoted, false);
  });

  test("places a word in progress that resolves, then pivots against the side that word joined", () => {
    const see = candidateOf(makeSensorTile("composer-trace-comma-commit"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see] });
    trace.typeWord("see");

    assert.deepEqual(
      trace.press({ kind: "comma" }),
      placementEffects(
        see,
        trace.gap(RuleSide.When, 1),
        { kind: "reask", token: { kind: "placement-landed", gesture: "pivot" } },
        { kind: "move-caret", position: trace.gap(RuleSide.Do, 0) }
      )
    );
    assert.equal(trace.state.armedSide, RuleSide.Do);
    assert.equal(trace.state.pivoted, true);
  });

  test("holds the pivot back when the word just placed leaves the side unable to end", () => {
    const see = candidateOf(makeSensorTile("composer-trace-comma-mid"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see] });
    trace.typeWord("see");
    trace.armedSideCanEnd = false;

    assert.deepEqual(
      trace.press({ kind: "comma" }),
      placementEffects(see, trace.gap(RuleSide.When, 1), {
        kind: "reask",
        token: { kind: "placement-landed", gesture: "pivot" },
      })
    );
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.state.pivoted, false);
  });

  test("is filter text on the DO side, which has nowhere to pivot to", () => {
    const trace = new ComposerTrace({ armedSide: RuleSide.Do, doTiles: 1 });

    assert.deepEqual(trace.press({ kind: "comma" }), []);
  });

  test("is filter text in a strip armed from the tray", () => {
    const trace = new ComposerTrace({ inSentence: false });

    assert.deepEqual(trace.press({ kind: "comma" }), []);
  });
});

describe("where a placement leaves composition", () => {
  /**
   * A trace whose word in progress places `label`, standing at a position that
   * offers nothing once that word has been placed.
   */
  function landingTrace(label: string, options: ComposerTraceOptions = {}) {
    const candidate = candidateOf(makeSensorTile(`composer-landing-${label}`), label);
    const trace = new ComposerTrace({ ...options, offeringFor: () => [candidate] });
    trace.typeWord(label);
    trace.positionOffersTile = false;
    return { trace, candidate };
  }

  test("a word leaving the when side nothing more to offer hands over to the do side", () => {
    const { trace, candidate } = landingTrace("see");

    assert.deepEqual(
      trace.press({ kind: "space" }),
      placementEffects(candidate, trace.gap(RuleSide.When, 1), landedReask, {
        kind: "move-caret",
        position: trace.gap(RuleSide.Do, 0),
      })
    );
    assert.equal(trace.state.armedSide, RuleSide.Do);
    assert.equal(trace.state.pivoted, true);
    assert.equal(trace.closedAs, undefined);
  });

  test("a word leaving the do side nothing more to offer ends the rule", () => {
    const { trace, candidate } = landingTrace("jump", { armedSide: RuleSide.Do, whenTiles: 1 });

    assert.deepEqual(
      trace.press({ kind: "space" }),
      placementEffects(candidate, trace.gap(RuleSide.Do, 1), landedReask, {
        kind: "close-strip",
        reason: "settled",
      })
    );
    assert.equal(trace.closedAs, "settled");
  });

  test("a when side that may not end yet hands over nothing", () => {
    const { trace, candidate } = landingTrace("hear");
    trace.armedSideCanEnd = false;

    assert.deepEqual(trace.press({ kind: "space" }), placementEffects(candidate, trace.gap(RuleSide.When, 1)));
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.closedAs, undefined);
  });

  test("a position that still offers carries composition on where it stands", () => {
    const { trace, candidate } = landingTrace("smell");
    trace.positionOffersTile = true;

    assert.deepEqual(trace.press({ kind: "space" }), placementEffects(candidate, trace.gap(RuleSide.When, 1)));
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.closedAs, undefined);
  });

  test("a placement made from the tray carries composition nowhere", () => {
    const { trace } = landingTrace("taste", { inSentence: false });

    const pressed = trace.press({ kind: "space" });
    assert.deepEqual(
      pressed.filter((effect) => effect.kind === "move-caret"),
      []
    );
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.closedAs, undefined);
  });

  test("moving the caret onto such a position hands over nothing, and backspace there still deletes", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.positionOffersTile = false;
    trace.placeCaret(trace.element(RuleSide.When, 0));

    assert.deepEqual(trace.press(rightArrow), [
      consumeKey,
      { kind: "move-caret", position: trace.gap(RuleSide.When, 1) },
      clearHighlight,
    ]);
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.state.pivoted, false);

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), [
      consumeKey,
      { kind: "delete-tile", position: trace.element(RuleSide.When, 0) },
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
    ]);
    assert.equal(trace.tileCount(RuleSide.When), 0);
  });

  test("the comma's own pivot is the only hand-over its placement makes", () => {
    const { trace } = landingTrace("touch");

    const pressed = trace.press({ kind: "comma" });
    assert.deepEqual(
      pressed.filter((effect) => effect.kind === "reask"),
      [{ kind: "reask", token: { kind: "placement-landed", gesture: "pivot" } }]
    );
    assert.deepEqual(
      pressed.filter((effect) => effect.kind === "move-caret" && effect.position.side === RuleSide.Do),
      [{ kind: "move-caret", position: trace.gap(RuleSide.Do, 0) }]
    );
    assert.equal(trace.state.armedSide, RuleSide.Do);
  });
});

describe("a candidate that opens a create dialog", () => {
  /**
   * A trace standing between two tiles of the WHEN side, with the core text
   * literal factory typed out and ready to commit.
   */
  function factoryTrace(): { trace: ComposerTrace; factory: StripCandidate } {
    const factory = textFactoryCandidate();
    const trace = new ComposerTrace({ whenTiles: 2, offeringFor: () => [factory] });
    trace.placeCaret(trace.gap(RuleSide.When, 1));
    trace.typeWord("text");
    return { trace, factory };
  }

  test("asks for the dialog alone, leaving the caret and the rule as they stand", () => {
    const { trace, factory } = factoryTrace();

    assert.deepEqual(trace.press({ kind: "enter", from: "filter" }), [
      consumeKey,
      { kind: "place-tile", candidate: factory },
      clearHighlight,
    ]);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1));
    assert.equal(trace.tileCount(RuleSide.When), 2);
    assert.equal(trace.state.filter, "");
  });

  test("a tap on its chip asks for the dialog on the same terms", () => {
    const { trace, factory } = factoryTrace();

    assert.deepEqual(trace.press({ kind: "candidate-tapped", candidate: factory }), [
      consumeKey,
      { kind: "place-tile", candidate: factory },
      clearHighlight,
    ]);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1));
    assert.equal(trace.tileCount(RuleSide.When), 2);
  });

  test("the comma commits it without pivoting, since no word has been placed to pivot behind", () => {
    const { trace } = factoryTrace();

    const pressed = trace.press({ kind: "comma" });

    assert.deepEqual(
      pressed.filter((effect) => effect.kind === "reask"),
      []
    );
    assert.deepEqual(
      pressed.filter((effect) => effect.kind === "move-caret"),
      []
    );
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.state.pivoted, false);
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1));
  });
});

describe("the period", () => {
  test("refuses where the armed side cannot end, adding nothing to the word in progress", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.armedSideCanEnd = false;

    assert.deepEqual(trace.press({ kind: "period" }), [consumeKey]);
    assert.equal(trace.state.filter, "");
    assert.equal(trace.closedAs, undefined);
  });

  test("refuses an unresolvable word in progress, leaving that word as it stands", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.typeWord("zzz");

    assert.deepEqual(trace.press({ kind: "period" }), [consumeKey]);
    assert.equal(trace.state.filter, "zzz");
    assert.equal(trace.closedAs, undefined);
    assert.deepEqual(placedKeys(trace.log), []);
  });

  test("is inert on a rule holding no tiles at all", () => {
    const trace = new ComposerTrace();

    assert.deepEqual(trace.press({ kind: "period" }), [consumeKey]);
    assert.equal(trace.closedAs, undefined);
  });

  test("settles a rule whose armed side may end", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });

    assert.deepEqual(trace.press({ kind: "period" }), [consumeKey, { kind: "close-strip", reason: "settled" }]);
    assert.equal(trace.closedAs, "settled");
  });
});

describe("the insertion chord inside composition", () => {
  const chord: ComposerInputToken = { kind: "settle-and-insert" };
  const settled: ComposerInputEffect = { kind: "close-strip", reason: "settled" };
  const insertRule: ComposerInputEffect = { kind: "insert-rule" };
  const chordReask: ComposerInputEffect = {
    kind: "reask",
    token: { kind: "placement-landed", gesture: "settle-and-insert" },
  };

  test("settles a rule whose armed side may end and asks for an empty rule after it", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });

    assert.deepEqual(trace.press(chord), [consumeKey, settled, insertRule]);
    assert.equal(trace.closedAs, "settled");
  });

  test("places the word in progress first, then settles and inserts", () => {
    const see = candidateOf(makeSensorTile("chord-trace-see"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see], whenTiles: 1 });
    trace.typeWord("see");

    assert.deepEqual(
      trace.press(chord),
      placementEffects(see, trace.gap(RuleSide.When, 2), chordReask, settled, insertRule)
    );
    assert.equal(trace.closedAs, "settled");
    assert.equal(trace.tileCount(RuleSide.When), 2);
  });

  test("refuses an unresolvable word in progress, leaving that word standing and inserting nothing", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.typeWord("zzz");

    assert.deepEqual(trace.press(chord), [consumeKey]);
    assert.equal(trace.state.filter, "zzz");
    assert.equal(trace.closedAs, undefined);
    assert.deepEqual(placedKeys(trace.log), []);
  });

  test("refuses on a rule holding no tiles at all", () => {
    const trace = new ComposerTrace();

    assert.deepEqual(trace.press(chord), [consumeKey]);
    assert.equal(trace.closedAs, undefined);
  });

  test("refuses where the armed side cannot end", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.armedSideCanEnd = false;

    assert.deepEqual(trace.press(chord), [consumeKey]);
    assert.equal(trace.closedAs, undefined);
  });

  test("is left alone in a strip armed from the tray", () => {
    const trace = new ComposerTrace({ inSentence: false, whenTiles: 1 });

    assert.deepEqual(trace.press(chord), []);
    assert.equal(trace.closedAs, undefined);
  });

  test("its refusals are the period's, case for case", () => {
    const scenarios: (readonly [string, () => ComposerTrace])[] = [
      ["a rule holding no tiles", () => new ComposerTrace()],
      [
        "a side left mid-expression",
        () => {
          const trace = new ComposerTrace({ whenTiles: 1 });
          trace.armedSideCanEnd = false;
          return trace;
        },
      ],
      [
        "a word that resolves to nothing",
        () => {
          const trace = new ComposerTrace({ whenTiles: 1 });
          trace.typeWord("zzz");
          return trace;
        },
      ],
      ["a side that may end", () => new ComposerTrace({ whenTiles: 1 })],
    ];

    for (const [name, build] of scenarios) {
      const byPeriod = build();
      byPeriod.press({ kind: "period" });
      const byChord = build();
      byChord.press(chord);

      assert.equal(byChord.closedAs, byPeriod.closedAs, name);
      assert.deepEqual(placedKeys(byChord.log), placedKeys(byPeriod.log), name);
      assert.equal(byChord.state.filter, byPeriod.state.filter, name);
      assert.equal(
        byChord.log.some((effect) => effect.kind === "insert-rule"),
        byPeriod.closedAs === "settled",
        name
      );
    }
  });
});

describe("stepping the composed rule", () => {
  const stepDown: ComposerInputToken = { kind: "move-rule", direction: "down" };

  test("asks for the step and nothing else, and composition carries on", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    const before = trace.state;

    assert.deepEqual(trace.press(stepDown), [consumeKey, { kind: "move-rule", direction: "down" }]);
    assert.equal(trace.closedAs, undefined);
    assert.deepEqual(trace.state, before);
  });

  test("leaves the word in progress, the caret and the offering's cursor where they stand", () => {
    const see = candidateOf(makeSensorTile("move-trace-see"), "see");
    const seed = candidateOf(makeSensorTile("move-trace-seed"), "seed");
    const trace = new ComposerTrace({
      offeringFor: () => [see, seed],
      whenTiles: 1,
      drawsBestNext: true,
      bestNextPerRow: 1,
    });
    trace.typeWord("se");
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    const cursor = trace.state.cursor;
    assert.ok(cursor !== undefined);

    trace.press({ kind: "move-rule", direction: "indent" });

    assert.equal(trace.state.filter, "se");
    assert.deepEqual(trace.state.caret, trace.gap(RuleSide.When, 1));
    assert.deepEqual(trace.state.cursor, cursor);
    assert.equal(trace.closedAs, undefined);
    assert.equal(trace.tileCount(RuleSide.When), 1);
  });

  test("an open text value keeps its content and stays open", () => {
    const trace = new ComposerTrace({ offeringFor: () => [textFactoryCandidate()], whenTiles: 1 });
    trace.press({ kind: "quote" });
    trace.typeWord("hi");

    assert.deepEqual(trace.press(stepDown), [consumeKey, { kind: "move-rule", direction: "down" }]);
    assert.equal(trace.state.textLiteral, "hi");
    assert.equal(trace.closedAs, undefined);
  });
});

describe("typed numbers", () => {
  /** The offering at a position that accepts a number: the mint the typed text names. */
  function numberOffering(): (filter: string) => readonly StripCandidate[] {
    const factory = numberFactoryCandidate();
    return (filter: string) => {
      const minted = mintNumberLiteralCandidate([factory], filter, traceLabelOf);
      return minted ? [minted] : [];
    };
  }

  test("a period continuing a whole number is filter text, and the finished number commits", () => {
    const trace = new ComposerTrace({ offeringFor: numberOffering(), whenTiles: 1 });
    trace.press({ kind: "text", text: "1" });

    assert.deepEqual(trace.press({ kind: "period" }), []);

    trace.press({ kind: "text", text: "1." });
    trace.press({ kind: "text", text: "1.5" });
    const pressed = trace.press({ kind: "space" });

    assert.equal(placedKeys(pressed).length, 1);
    assert.equal(trace.closedAs, undefined);
  });

  test("a whole number is a word the insertion chord places, where the period is filter text", () => {
    const trace = new ComposerTrace({ offeringFor: numberOffering(), whenTiles: 1 });
    trace.press({ kind: "text", text: "1" });

    const pressed = trace.press({ kind: "settle-and-insert" });
    assert.equal(placedKeys(pressed).length, 1);
    assert.equal(
      pressed.some((effect) => effect.kind === "insert-rule"),
      true
    );
    assert.equal(trace.closedAs, "settled");
  });

  test("a period on a number that already carries a decimal point commits it and settles", () => {
    const trace = new ComposerTrace({ offeringFor: numberOffering(), whenTiles: 1 });
    trace.press({ kind: "text", text: "1" });
    trace.press({ kind: "text", text: "1." });
    trace.press({ kind: "text", text: "1.5" });

    const pressed = trace.press({ kind: "period" });
    assert.equal(placedKeys(pressed).length, 1);
    assert.deepEqual(
      pressed.filter((effect) => effect.kind === "reask"),
      [{ kind: "reask", token: { kind: "placement-landed", gesture: "settle" } }]
    );
    assert.equal(trace.closedAs, "settled");
  });
});

describe("a typed text value", () => {
  /** The value each placement carried, read off the origin the manufacture path commits through. */
  function placedValues(log: readonly ComposerInputEffect[]): unknown[] {
    return log
      .filter((effect) => effect.kind === "place-tile")
      .map((effect) => (effect.candidate.origin.kind === "minted-literal" ? effect.candidate.origin.value : undefined));
  }

  /** The effects opening a text value asks for. */
  const openEffects: readonly ComposerInputEffect[] = [
    consumeKey,
    { kind: "set-filter", text: "" },
    { kind: "set-text-literal", value: "" },
    clearHighlight,
  ];

  /** The effects abandoning an open text value asks for. */
  const abandonEffects: readonly ComposerInputEffect[] = [consumeKey, { kind: "set-text-literal", value: undefined }];

  /** A trace at a position that accepts a text literal, alongside one word tile. */
  function textTrace(): { trace: ComposerTrace; word: StripCandidate } {
    const word = candidateOf(makeSensorTile("composer-trace-text-see"), "see");
    const factory = textFactoryCandidate();
    return { trace: new ComposerTrace({ offeringFor: () => [word, factory], whenTiles: 1 }), word };
  }

  /** A trace with `value` typed into an open text value, a character at a time. */
  function openedTextTrace(value: string): ComposerTrace {
    const { trace } = textTrace();
    trace.press({ kind: "quote" });
    trace.typeWord(value);
    return trace;
  }

  test("the closing quote places one literal carrying the text exactly as typed", () => {
    const typed = "hello world. ok";
    const trace = openedTextTrace(typed);
    assert.equal(trace.state.textLiteral, typed);

    const pressed = trace.press({ kind: "quote" });

    const placements = pressed.filter((effect) => effect.kind === "place-tile");
    assert.equal(placements.length, 1);
    assert.equal(placements[0].candidate.tileDef.kind, "literal");
    assert.deepEqual(placedValues(pressed), [typed]);
    assert.deepEqual(
      pressed.filter((effect) => effect.kind === "set-text-literal"),
      [{ kind: "set-text-literal", value: undefined }]
    );
    assert.equal(trace.state.textLiteral, undefined);
    assert.equal(trace.state.filter, "");
    assert.equal(trace.closedAs, undefined);
    assert.equal(trace.tileCount(RuleSide.When), 2);
  });

  test("opening a value takes over the word in progress", () => {
    const { trace } = textTrace();
    trace.typeWord("se");

    assert.deepEqual(trace.press({ kind: "quote" }), openEffects);
    assert.equal(trace.state.filter, "");
    assert.equal(trace.state.textLiteral, "");
  });

  test("the punctuation keys reach the value as content, placing nothing and neither pivoting nor settling", () => {
    const trace = openedTextTrace("a");

    // Each key is left to the filter box, which types it into the value.
    assert.deepEqual(trace.press({ kind: "comma" }), []);
    assert.deepEqual(trace.press({ kind: "period" }), []);
    assert.deepEqual(trace.press({ kind: "space" }), []);
    trace.press({ kind: "text", text: "a,. " });

    assert.equal(trace.state.textLiteral, "a,. ");
    assert.equal(trace.state.armedSide, RuleSide.When);
    assert.equal(trace.state.pivoted, false);
    assert.equal(trace.closedAs, undefined);
    assert.deepEqual(placedKeys(trace.log), []);
  });

  test("Enter places the value the closing quote would", () => {
    const typed = "left";
    const byQuote = openedTextTrace(typed);
    const byKey = openedTextTrace(typed);

    const quoted = byQuote.press({ kind: "quote" });
    const keyed = byKey.press({ kind: "enter", from: "filter" });

    assert.deepEqual(
      keyed.map((effect) => effect.kind),
      quoted.map((effect) => effect.kind)
    );
    assert.deepEqual(placedKeys(keyed), placedKeys(quoted));
    assert.deepEqual(placedValues(keyed), [typed]);
    assert.equal(byKey.state.textLiteral, undefined);
    assert.equal(byKey.tileCount(RuleSide.When), 2);
  });

  test("Tab is the browser's with a value open, which places nothing", () => {
    const trace = openedTextTrace("left");

    assert.equal(composerTokenForKey("Tab", "filter", false), undefined);
    assert.equal(trace.state.textLiteral, "left");
    assert.deepEqual(placedKeys(trace.log), []);
    assert.equal(trace.tileCount(RuleSide.When), 1);
  });

  test("a value holding a dollar sign, digits, and a percent places them as text", () => {
    const typed = "cost: $5 or 50%. ok?";
    const word = candidateOf(makeSensorTile("composer-trace-text-mints"), "see");
    // The position mints numbers and variables, and the open value reaches neither.
    const trace = new ComposerTrace({
      offeringFor: () => [word, numberFactoryCandidate(), textFactoryCandidate()],
      whenTiles: 1,
    });
    trace.press({ kind: "quote" });
    trace.typeWord(typed);
    assert.equal(trace.state.filter, "", "nothing the offering could filter or mint from is typed");

    const pressed = trace.press({ kind: "quote" });

    const placements = pressed.filter((effect) => effect.kind === "place-tile");
    assert.equal(placements.length, 1);
    assert.deepEqual(
      placements.map((effect) => effect.candidate.origin.kind),
      ["minted-literal"]
    );
    assert.equal((placements[0].candidate.tileDef as BrainTileLiteralDef).valueType, CoreTypeIds.String);
    assert.deepEqual(placedValues(pressed), [typed]);
  });

  test("backspace shortens the value, and past the opening quote leaves it placing nothing", () => {
    const { trace, word } = textTrace();
    trace.typeWord("see");
    trace.press({ kind: "space" });
    assert.deepEqual(placedKeys(trace.log), [word.key]);
    trace.press({ kind: "quote" });
    trace.typeWord("hi");

    // The filter box makes the edit of the value itself.
    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), []);
    trace.press({ kind: "text", text: "h" });
    trace.press({ kind: "text", text: "" });
    assert.equal(trace.state.textLiteral, "");

    assert.deepEqual(trace.press({ kind: "backspace", from: "filter" }), abandonEffects);
    assert.equal(trace.state.textLiteral, undefined);
    assert.deepEqual(placedKeys(trace.log), [word.key]);
    assert.equal(trace.ownCommitCount(), 1);
    assert.equal(trace.tileCount(RuleSide.When), 2);
  });

  test("backspace on the pending chip's band shortens the value and hands the keyboard back", () => {
    const trace = openedTextTrace("hi");

    assert.deepEqual(trace.press({ kind: "backspace", from: "band" }), [
      typingFocus,
      consumeKey,
      { kind: "set-text-literal", value: "h" },
      clearHighlight,
    ]);
    assert.equal(trace.state.textLiteral, "h");
  });

  test("escape abandons the value before it clears the word in progress and closes the strip", () => {
    const trace = openedTextTrace("hi");

    assert.deepEqual(trace.press({ kind: "escape" }), abandonEffects);
    assert.equal(trace.state.textLiteral, undefined);
    assert.equal(trace.closedAs, undefined);
    assert.deepEqual(placedKeys(trace.log), []);

    assert.deepEqual(trace.press({ kind: "escape" }), [consumeKey, { kind: "close-strip", reason: "dismissed" }]);
    assert.equal(trace.closedAs, "dismissed");
  });

  test("two quotes in a row place an empty text value", () => {
    const trace = openedTextTrace("");

    const pressed = trace.press({ kind: "quote" });

    assert.deepEqual(placedValues(pressed), [""]);
    assert.equal(trace.state.textLiteral, undefined);
  });

  test("tapping the pending chip places what the closing quote would", () => {
    const typed = "left";
    const byQuote = openedTextTrace(typed);
    const byTap = openedTextTrace(typed);
    const chip = byTap.pendingTextChip();
    assert.ok(chip, "an open value offers the chip that places it");

    const quoted = byQuote.press({ kind: "quote" });
    const tapped = byTap.press({ kind: "candidate-tapped", candidate: chip });

    assert.deepEqual(
      tapped.map((effect) => effect.kind),
      quoted.map((effect) => effect.kind)
    );
    assert.deepEqual(placedKeys(tapped), placedKeys(quoted));
    assert.deepEqual(placedValues(tapped), [typed]);
    assert.equal(byTap.state.textLiteral, undefined);
    assert.equal(byTap.tileCount(RuleSide.When), 2);
  });

  test("a quote is ordinary text where the position accepts no text literal", () => {
    const see = candidateOf(makeSensorTile("composer-trace-text-none"), "see");
    const trace = new ComposerTrace({ offeringFor: () => [see], whenTiles: 1 });

    assert.deepEqual(trace.press({ kind: "quote" }), []);
    assert.equal(trace.state.textLiteral, undefined);

    // The keystroke stays with the filter box, where it reads as unmatched text.
    trace.press({ kind: "text", text: '"' });
    assert.equal(trace.state.filter, '"');
    assert.equal(trace.state.textLiteral, undefined);
  });

  test("the comma pivot and the period settle work again once the value is placed", () => {
    const trace = openedTextTrace("hi");
    trace.press({ kind: "quote" });

    assert.deepEqual(trace.press({ kind: "comma" }), [
      consumeKey,
      { kind: "move-caret", position: trace.gap(RuleSide.Do, 0) },
    ]);
    assert.equal(trace.state.armedSide, RuleSide.Do);
    assert.deepEqual(trace.press({ kind: "period" }), [consumeKey, { kind: "close-strip", reason: "settled" }]);
    assert.equal(trace.closedAs, "settled");
  });
});

describe("browsing the offering as one grid", () => {
  /** A best-next row of two chips, wrapped one to a row, over a closed section holding a third. */
  function browsingTrace(): { trace: ComposerTrace; best: StripCandidate[]; sectioned: StripCandidate } {
    const first = candidateOf(makeSensorTile("composer-trace-browse-one"), "one");
    const second = candidateOf(makeSensorTile("composer-trace-browse-two"), "two");
    const sectioned = candidateOf(makeSensorTile("composer-trace-browse-three"), "three");
    const trace = new ComposerTrace({
      offeringFor: () => [first, second, sectioned],
      bandSequence: [
        { key: kBestNextBandKey, entries: toCandidateEntries([first, second]) },
        { key: kSectionBandKey, entries: toCandidateEntries([sectioned]) },
      ],
      bestNextPerRow: 1,
    });
    return { trace, best: [first, second], sectioned };
  }

  /**
   * A best-next row of two chips, wrapped one to a row, over two closed
   * sections, each holding one of its own.
   */
  function twoSectionTrace(): {
    trace: ComposerTrace;
    best: StripCandidate[];
    first: StripCandidate;
    second: StripCandidate;
  } {
    const lead = candidateOf(makeSensorTile("composer-trace-grid-lead"), "lead");
    const trailing = candidateOf(makeSensorTile("composer-trace-grid-trailing"), "trailing");
    const first = candidateOf(makeSensorTile("composer-trace-grid-first"), "first");
    const second = candidateOf(makeSensorTile("composer-trace-grid-second"), "second");
    const trace = new ComposerTrace({
      offeringFor: () => [lead, trailing, first, second],
      bandSequence: [
        { key: kBestNextBandKey, entries: toCandidateEntries([lead, trailing]) },
        { key: kSectionBandKey, entries: toCandidateEntries([first]) },
        { key: kSecondSectionBandKey, entries: toCandidateEntries([second]) },
      ],
      bestNextPerRow: 1,
    });
    return { trace, best: [lead, trailing], first, second };
  }

  /** The cursor standing on the chip that `candidate` renders as in the band `bandKey`. */
  function chipOf(bandKey: string, candidate: StripCandidate): StripCursor {
    return chipAt(stripOptionId(kStripId, bandKey, candidate.key));
  }

  /** The keys of the bands whose chips the offering draws. */
  function openBandKeys(trace: ComposerTrace): string[] {
    return trace.openBands().map((band) => band.key);
  }

  /** Open the section `sectionKey` from the heading the cursor stands on, and step into its chips. */
  function enterSection(trace: ComposerTrace, sectionKey: string): void {
    trace.press({ kind: "heading-arrow", direction: "right", sectionKey });
    trace.press({ kind: "heading-arrow", direction: "down", sectionKey });
  }

  /**
   * Walk down from the box onto the first section's heading: the first step off
   * the lead's row, the second off the best-next row under it.
   */
  function walkToFirstHeading(trace: ComposerTrace): void {
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
  }

  /** Walk down from the box into the first section's chips, opening that section on the way. */
  function browseFirstSection(trace: ComposerTrace): void {
    walkToFirstHeading(trace);
    enterSection(trace, kSectionBandKey);
  }

  test("down from a closed heading steps to the next heading, opening nothing on the way", () => {
    const { trace } = twoSectionTrace();
    walkToFirstHeading(trace);
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));

    assert.deepEqual(trace.press({ kind: "heading-arrow", direction: "down", sectionKey: kSectionBandKey }), [
      { kind: "highlight", cursor: headingAt(kSecondSectionBandKey), mode: "browsing" },
      consumeKey,
    ]);
    assert.deepEqual(trace.state.cursor, headingAt(kSecondSectionBandKey));
    assert.deepEqual(openBandKeys(trace), [kBestNextBandKey], "no section was opened on the way");
  });

  test("right opens the section its heading names, and down then steps into its chips", () => {
    const { trace, sectioned } = browsingTrace();
    walkToFirstHeading(trace);

    assert.deepEqual(trace.press({ kind: "heading-arrow", direction: "right", sectionKey: kSectionBandKey }), [
      consumeKey,
      { kind: "open-section", sectionKey: kSectionBandKey },
    ]);
    assert.deepEqual(openBandKeys(trace), [kBestNextBandKey, kSectionBandKey]);
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey), "opening a section moves the cursor nowhere");

    assert.deepEqual(trace.press({ kind: "heading-arrow", direction: "down", sectionKey: kSectionBandKey }), [
      { kind: "highlight", cursor: chipOf(kSectionBandKey, sectioned), mode: "browsing" },
      consumeKey,
    ]);
    assert.deepEqual(trace.state.cursor, chipOf(kSectionBandKey, sectioned));
    assert.equal(trace.state.highlightMode, "browsing");
    assert.deepEqual(trace.focusTarget(), { kind: "band", bandKey: kSectionBandKey });
  });

  test("left closes the section its heading names, taking its chips out of the grid", () => {
    const { trace } = browsingTrace();
    walkToFirstHeading(trace);
    trace.press({ kind: "heading-arrow", direction: "right", sectionKey: kSectionBandKey });

    assert.deepEqual(trace.press({ kind: "heading-arrow", direction: "left", sectionKey: kSectionBandKey }), [
      consumeKey,
      { kind: "close-section", sectionKey: kSectionBandKey },
    ]);
    assert.deepEqual(openBandKeys(trace), [kBestNextBandKey]);
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey), "closing a section moves the cursor nowhere");

    assert.deepEqual(
      trace.press({ kind: "heading-arrow", direction: "down", sectionKey: kSectionBandKey }),
      [consumeKey],
      "the closed section draws no row below its heading"
    );
  });

  test("left on a closed heading leaves the section open elsewhere as it stands", () => {
    const { trace } = twoSectionTrace();
    walkToFirstHeading(trace);
    enterSection(trace, kSectionBandKey);
    trace.press({ kind: "arrow", direction: "down", from: "band" });
    assert.deepEqual(trace.state.cursor, headingAt(kSecondSectionBandKey));

    trace.press({ kind: "heading-arrow", direction: "left", sectionKey: kSecondSectionBandKey });

    assert.deepEqual(openBandKeys(trace), [kBestNextBandKey, kSectionBandKey]);
  });

  test("stepping down off a group's chips lands on the next group's heading, which opens into its own", () => {
    const { trace, first, second } = twoSectionTrace();
    walkToFirstHeading(trace);
    enterSection(trace, kSectionBandKey);
    assert.deepEqual(trace.state.cursor, chipOf(kSectionBandKey, first));

    assert.deepEqual(trace.press({ kind: "arrow", direction: "down", from: "band" }), [
      { kind: "highlight", cursor: headingAt(kSecondSectionBandKey), mode: "browsing" },
      consumeKey,
    ]);
    assert.deepEqual(trace.focusTarget(), { kind: "heading", sectionKey: kSecondSectionBandKey });

    enterSection(trace, kSecondSectionBandKey);
    assert.deepEqual(trace.state.cursor, chipOf(kSecondSectionBandKey, second));
    assert.deepEqual(trace.focusTarget(), { kind: "band", bandKey: kSecondSectionBandKey });
  });

  test("stepping up from a section's chips lands on that section's own heading", () => {
    const { trace } = browsingTrace();
    browseFirstSection(trace);

    assert.deepEqual(trace.press({ kind: "arrow", direction: "up", from: "band" }), [
      { kind: "highlight", cursor: headingAt(kSectionBandKey), mode: "browsing" },
      consumeKey,
    ]);
    assert.deepEqual(trace.focusTarget(), { kind: "heading", sectionKey: kSectionBandKey });
  });

  test("a cursor stepping onto a heading from the box takes the keyboard onto that heading", () => {
    const { trace } = browsingTrace();
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.focusTarget(), { kind: "input" });

    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));
    assert.equal(trace.state.highlightMode, "browsing");
    assert.deepEqual(trace.focusTarget(), { kind: "heading", sectionKey: kSectionBandKey });
  });

  test("Enter on a browsed chip places it and hands the keyboard back to the filter box", () => {
    const { trace, sectioned } = browsingTrace();
    browseFirstSection(trace);

    assert.deepEqual(
      trace.press({ kind: "enter", from: "band" }),
      placementEffects(sectioned, trace.gap(RuleSide.When, 1))
    );
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
  });

  test("a character typed while browsing a band hands the keyboard back without placing anything", () => {
    const { trace } = browsingTrace();
    browseFirstSection(trace);
    const cursor = trace.state.cursor;

    assert.deepEqual(trace.press({ kind: "printable" }), [typingFocus, { kind: "highlight", cursor, mode: "typing" }]);
    assert.deepEqual(placedKeys(trace.log), []);
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
  });

  test("a character typed on a heading releases the cursor with the keyboard it was holding", () => {
    const { trace } = browsingTrace();
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));

    assert.deepEqual(trace.press({ kind: "printable" }), [typingFocus, clearHighlight]);
    assert.equal(trace.state.cursor, undefined);
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
  });

  test("Backspace on a heading edits the word in progress and hands the keyboard back", () => {
    const { trace } = browsingTrace();
    trace.typeWord("on");
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));

    assert.deepEqual(trace.press({ kind: "backspace", from: "heading" }), [
      typingFocus,
      consumeKey,
      { kind: "set-filter", text: "o" },
      clearHighlight,
    ]);
    assert.equal(trace.state.filter, "o");
    assert.equal(trace.state.cursor, undefined);
  });

  test("the horizontal arrows belong to the caret until the cursor stands on a chip", () => {
    const { trace, best } = browsingTrace();

    assert.deepEqual(trace.press({ kind: "arrow", direction: "left", from: "filter" }), [
      consumeKey,
      { kind: "move-caret", position: trace.gap(RuleSide.When, 0) },
      clearHighlight,
    ]);
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[1]));
    assert.equal(trace.state.highlightMode, "typing");
  });

  test("one vertical arrow steps the highlight off the chip the offering leads with", () => {
    const { trace, best } = browsingTrace();
    assert.equal(trace.state.cursor, undefined, "the offering stands the cursor on no cell");
    assert.deepEqual(trace.leadCursor(), chipOf(kBestNextBandKey, best[0]), "and highlights the lead's chip");

    assert.deepEqual(trace.press({ kind: "arrow", direction: "down", from: "filter" }), [
      { kind: "highlight", cursor: chipOf(kBestNextBandKey, best[1]), mode: "typing" },
      typingFocus,
      consumeKey,
    ]);
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[1]), "one press moves the highlight");
  });

  test("the chip the offering leads with takes no cursor, so the horizontal arrows serve the caret", () => {
    const { trace, best } = browsingTrace();
    const run = trace.run();
    assert.deepEqual(trace.leadCursor(), chipOf(kBestNextBandKey, best[0]), "a chip is highlighted from the start");

    assert.deepEqual(trace.press({ kind: "arrow", direction: "right", from: "filter" }), [
      consumeKey,
      { kind: "move-caret", position: run[1] },
      clearHighlight,
    ]);
    assert.deepEqual(trace.state.caret, run[1]);
    assert.equal(trace.state.cursor, undefined, "and the key stood the cursor on no cell");
  });

  test("Enter places the highlighted chip both before the first vertical arrow and after it", () => {
    const { trace, best } = browsingTrace();
    assert.deepEqual(
      trace.press({ kind: "enter", from: "filter" }),
      placementEffects(best[0], trace.gap(RuleSide.When, 1)),
      "the lead's chip"
    );

    const stepped = browsingTrace();
    stepped.trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(
      stepped.trace.press({ kind: "enter", from: "filter" }),
      placementEffects(stepped.best[1], stepped.trace.gap(RuleSide.When, 1)),
      "the chip stepped to"
    );
  });

  test("the vertical arrows steer the offering alone, from either surface, and never the caret", () => {
    for (const from of ["filter", "band"] as const) {
      for (const direction of ["down", "up"] as const) {
        const { trace } = browsingTrace();
        // Up steers from inside the offering, which a step down enters.
        if (direction === "up") trace.press({ kind: "arrow", direction: "down", from: "filter" });
        const caret = trace.state.caret;
        const pressed = trace.press({ kind: "arrow", direction, from });
        assert.ok(pressed.length > 0, `${direction} from ${from} steers the offering`);
        assert.deepEqual(
          pressed.filter((effect) => effect.kind === "move-caret"),
          [],
          `${direction} from ${from} moves no caret`
        );
        assert.deepEqual(trace.state.caret, caret, `${direction} from ${from} leaves the caret where it stands`);
      }
    }
  });

  test("stepping up from the top row hands the keyboard back to the box, leaving the caret where it stands", () => {
    const { trace, best } = browsingTrace();
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    trace.press({ kind: "arrow", direction: "up", from: "filter" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[0]), "the cursor stands on the top row");
    const caret = trace.state.caret;

    assert.deepEqual(trace.press({ kind: "arrow", direction: "up", from: "filter" }), [
      consumeKey,
      clearHighlight,
      typingFocus,
      flashCaret,
    ]);
    assert.equal(trace.state.cursor, undefined);
    assert.equal(trace.state.highlightMode, "typing");
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
    assert.deepEqual(trace.state.caret, caret);
    assert.deepEqual(placedKeys(trace.log), []);
  });

  test("stepping up walks every row of the grid and leaves the offering from the first", () => {
    const { trace, best } = browsingTrace();
    browseFirstSection(trace);

    trace.press({ kind: "arrow", direction: "up", from: "band" });
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));

    trace.press({ kind: "heading-arrow", direction: "up", sectionKey: kSectionBandKey });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[1]));

    trace.press({ kind: "arrow", direction: "up", from: "band" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[0]));

    trace.press({ kind: "arrow", direction: "up", from: "band" });
    assert.equal(trace.state.cursor, undefined);
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
  });

  test("the bottom row of the grid has no row below it, and the key stops there", () => {
    const { trace, sectioned } = browsingTrace();
    browseFirstSection(trace);

    assert.deepEqual(trace.press({ kind: "arrow", direction: "down", from: "band" }), [consumeKey]);
    assert.deepEqual(trace.state.cursor, chipOf(kSectionBandKey, sectioned));
    assert.deepEqual(trace.focusTarget(), { kind: "band", bandKey: kSectionBandKey });
  });

  test("the last chip has none after it, and the key stops there", () => {
    const { trace, sectioned } = browsingTrace();
    browseFirstSection(trace);
    assert.deepEqual(trace.state.cursor, chipOf(kSectionBandKey, sectioned));

    assert.deepEqual(trace.press({ kind: "arrow", direction: "right", from: "band" }), [consumeKey]);
    assert.deepEqual(trace.state.cursor, chipOf(kSectionBandKey, sectioned));
  });

  test("the first chip has none before it, and the key stops there instead of reaching the caret", () => {
    const { trace, best } = browsingTrace();
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    trace.press({ kind: "arrow", direction: "up", from: "filter" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[0]));
    const caret = trace.state.caret;

    assert.deepEqual(trace.press({ kind: "arrow", direction: "left", from: "filter" }), [consumeKey]);
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[0]));
    assert.deepEqual(trace.state.caret, caret, "the caret stands where it was");
  });

  test("arrowing up from a lead standing on the grid's first row reaches no cell", () => {
    const { trace, best } = twoSectionTrace();
    assert.deepEqual(trace.leadCursor(), chipOf(kBestNextBandKey, best[0]), "the lead stands on the first row");

    assert.deepEqual(trace.press({ kind: "arrow", direction: "up", from: "filter" }), []);
    assert.equal(trace.state.cursor, undefined);
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
  });

  test("the grid is entered a row past the lead again after leaving it, and walks down to a stop", () => {
    const { trace, best, first, second } = twoSectionTrace();
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[1]));

    trace.press({ kind: "arrow", direction: "up", from: "filter" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[0]), "the lead's own row");
    trace.press({ kind: "arrow", direction: "up", from: "filter" });
    assert.equal(trace.state.cursor, undefined, "the offering is left for the caret");

    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[1]), "re-entry steps from the lead again");

    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));

    enterSection(trace, kSectionBandKey);
    assert.deepEqual(trace.state.cursor, chipOf(kSectionBandKey, first));

    trace.press({ kind: "arrow", direction: "down", from: "band" });
    assert.deepEqual(trace.state.cursor, headingAt(kSecondSectionBandKey));

    enterSection(trace, kSecondSectionBandKey);
    assert.deepEqual(trace.state.cursor, chipOf(kSecondSectionBandKey, second));

    assert.deepEqual(trace.press({ kind: "arrow", direction: "down", from: "band" }), [consumeKey]);
    assert.deepEqual(trace.state.cursor, chipOf(kSecondSectionBandKey, second), "the last row stands where it is");
  });

  test("the walk back up leaves the offering from the first row instead of reaching the last", () => {
    const { trace, first } = twoSectionTrace();
    walkToFirstHeading(trace);
    enterSection(trace, kSectionBandKey);
    assert.deepEqual(trace.state.cursor, chipOf(kSectionBandKey, first));

    trace.press({ kind: "arrow", direction: "up", from: "band" });
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));

    trace.press({ kind: "heading-arrow", direction: "up", sectionKey: kSectionBandKey });
    assert.ok(trace.state.cursor, "the row above the heading is the best-next row");

    trace.press({ kind: "arrow", direction: "up", from: "band" });
    trace.press({ kind: "arrow", direction: "up", from: "band" });
    assert.equal(trace.state.cursor, undefined, "the first row leaves the offering");
    assert.deepEqual(trace.focusTarget(), { kind: "input" });

    assert.deepEqual(
      trace.press({ kind: "arrow", direction: "up", from: "filter" }),
      [],
      "and up again reaches nothing"
    );
    assert.equal(trace.state.cursor, undefined);
  });

  test("the word in progress survives the trip into the offering and back", () => {
    const { trace } = browsingTrace();
    trace.typeWord("on");

    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.ok(trace.state.cursor, "the cursor stands on a chip");
    trace.press({ kind: "arrow", direction: "up", from: "filter" });
    trace.press({ kind: "arrow", direction: "up", from: "filter" });

    assert.equal(trace.state.filter, "on");
    assert.equal(trace.state.cursor, undefined);
  });

  test("the keyboard leaving the band releases the chip it was browsing", () => {
    const { trace } = browsingTrace();
    browseFirstSection(trace);
    assert.ok(trace.state.cursor, "the cursor stands on a chip");

    assert.deepEqual(trace.press({ kind: "focus-lost", leftStrip: false }), [clearHighlight]);
    assert.equal(trace.state.cursor, undefined);
    assert.equal(trace.state.highlightMode, "typing");
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
  });

  test("the keyboard leaving a heading releases the cursor standing on it", () => {
    const { trace } = browsingTrace();
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, headingAt(kSectionBandKey));

    assert.deepEqual(trace.press({ kind: "focus-lost", leftStrip: false }), [clearHighlight]);
    assert.equal(trace.state.cursor, undefined);
    assert.deepEqual(trace.focusTarget(), { kind: "input" });
  });

  test("the horizontal arrows walk the chips while the keyboard is in the band, and the caret once it has left", () => {
    const { trace, best } = browsingTrace();
    const run = trace.run();
    trace.placeCaret(run[0]);
    browseFirstSection(trace);
    assert.deepEqual(trace.focusTarget(), { kind: "band", bandKey: kSectionBandKey });

    const stepped = trace.press({ kind: "arrow", direction: "left", from: "band" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[1]));
    assert.deepEqual(
      stepped.filter((effect) => effect.kind === "move-caret"),
      [],
      "the chips take the key, not the caret"
    );
    assert.deepEqual(trace.state.caret, run[0], "the caret stands where it was");

    trace.press({ kind: "focus-lost", leftStrip: false });

    assert.deepEqual(trace.press({ kind: "arrow", direction: "right", from: "filter" }), [
      consumeKey,
      { kind: "move-caret", position: run[1] },
      clearHighlight,
    ]);
    assert.deepEqual(trace.state.caret, run[1], "the caret steps along the sentence");
  });

  test("the keyboard leaving with the cursor nowhere asks for nothing", () => {
    const { trace } = browsingTrace();

    assert.deepEqual(trace.press({ kind: "focus-lost", leftStrip: false }), []);
    assert.equal(trace.state.cursor, undefined);
  });

  test("a cursor the box itself held is released when the keyboard leaves the box", () => {
    const { trace } = browsingTrace();
    trace.typeWord("on");
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.ok(trace.state.cursor, "the cursor stands on a chip with the keyboard still in the box");

    assert.deepEqual(trace.press({ kind: "focus-lost", leftStrip: false }), [clearHighlight]);
    assert.equal(trace.state.cursor, undefined);
    assert.equal(trace.state.filter, "on", "the word in progress stands");
    assert.deepEqual(placedKeys(trace.log), [], "and nothing was placed");
  });

  test("they walk the chips again once the cursor stands on one, leaving the caret where it stands", () => {
    const { trace, best } = browsingTrace();
    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    trace.press({ kind: "arrow", direction: "up", from: "filter" });
    assert.deepEqual(trace.state.cursor, chipOf(kBestNextBandKey, best[0]));
    const caret = trace.state.caret;

    assert.deepEqual(trace.press({ kind: "arrow", direction: "right", from: "filter" }), [
      { kind: "highlight", cursor: chipOf(kBestNextBandKey, best[1]), mode: "typing" },
      typingFocus,
      consumeKey,
    ]);
    assert.deepEqual(trace.state.caret, caret);
  });

  describe("the flash marking where the keyboard came back to", () => {
    /** True when `effects` asks for the caret's place to be flashed. */
    function flashes(effects: readonly ComposerInputEffect[]): boolean {
      return effects.some((effect) => effect.kind === "flash-caret");
    }

    test("leaving the offering upward flashes the caret's place, from the box and from a band", () => {
      const { trace } = browsingTrace();
      trace.press({ kind: "arrow", direction: "down", from: "filter" });
      trace.press({ kind: "arrow", direction: "up", from: "filter" });
      assert.ok(flashes(trace.press({ kind: "arrow", direction: "up", from: "filter" })));

      const browsed = browsingTrace().trace;
      browseFirstSection(browsed);
      browsed.press({ kind: "arrow", direction: "up", from: "band" });
      browsed.press({ kind: "heading-arrow", direction: "up", sectionKey: kSectionBandKey });
      browsed.press({ kind: "arrow", direction: "up", from: "band" });
      assert.ok(flashes(browsed.press({ kind: "arrow", direction: "up", from: "band" })));
    });

    test("a step that stays inside the offering flashes nothing", () => {
      const { trace } = browsingTrace();
      assert.ok(!flashes(trace.press({ kind: "arrow", direction: "down", from: "filter" })), "the step in");
      assert.ok(!flashes(trace.press({ kind: "arrow", direction: "right", from: "filter" })), "the step along");
      assert.ok(!flashes(trace.press({ kind: "arrow", direction: "down", from: "filter" })), "the step between rows");
      assert.ok(
        !flashes(trace.press({ kind: "heading-arrow", direction: "right", sectionKey: kSectionBandKey })),
        "a section opened from its heading"
      );
      assert.ok(
        !flashes(trace.press({ kind: "heading-arrow", direction: "left", sectionKey: kSectionBandKey })),
        "a section closed from its heading"
      );
    });

    test("a keystroke handing the keyboard back with an edit of its own flashes nothing", () => {
      const { trace } = browsingTrace();
      trace.typeWord("on");
      browseFirstSection(trace);
      assert.ok(!flashes(trace.press({ kind: "printable" })), "a character typed while browsing");
      assert.ok(!flashes(trace.press({ kind: "backspace", from: "band" })), "a backspace pressed while browsing");
    });

    test("a placement made from a band flashes nothing", () => {
      const { trace } = browsingTrace();
      browseFirstSection(trace);
      assert.ok(!flashes(trace.press({ kind: "enter", from: "band" })));
    });

    test("the keyboard leaving, and the strip closing, flash nothing", () => {
      const { trace } = browsingTrace();
      browseFirstSection(trace);
      assert.ok(!flashes(trace.press({ kind: "focus-lost", leftStrip: false })), "the keyboard leaving");
      assert.ok(!flashes(trace.press({ kind: "escape" })), "the strip closing");
    });

    test("the caret's own steps along the line flash nothing", () => {
      const { trace } = browsingTrace();
      const steps = [
        { label: "a step right", token: { kind: "arrow", direction: "right", from: "filter" } },
        { label: "a step left", token: { kind: "arrow", direction: "left", from: "filter" } },
        { label: "the run's first position", token: { kind: "home" } },
        { label: "the run's last position", token: { kind: "end" } },
      ] as const;
      for (const step of steps) {
        assert.ok(!flashes(trace.press(step.token)), step.label);
      }
    });
  });

  describe("the keyboard leaving the strip", () => {
    test("releases the chip it was browsing and closes the offering behind it", () => {
      const { trace } = browsingTrace();
      browseFirstSection(trace);
      assert.ok(trace.state.cursor, "the cursor stands on a chip");

      assert.deepEqual(trace.press({ kind: "focus-lost", leftStrip: true }), [
        clearHighlight,
        { kind: "close-strip", reason: "dismissed" },
      ]);
      assert.equal(trace.state.cursor, undefined);
      assert.equal(trace.closedAs, "dismissed");
    });

    test("closes the offering from a place holding no cursor at all", () => {
      const { trace } = browsingTrace();

      assert.deepEqual(trace.press({ kind: "focus-lost", leftStrip: true }), [
        { kind: "close-strip", reason: "dismissed" },
      ]);
      assert.equal(trace.closedAs, "dismissed");
    });

    test("leaves nothing placed and the word in progress standing", () => {
      const { trace } = browsingTrace();
      trace.typeWord("on");

      trace.press({ kind: "focus-lost", leftStrip: true });
      assert.equal(trace.state.filter, "on");
      assert.deepEqual(placedKeys(trace.log), []);
    });

    test("a move within the strip releases the cursor and leaves the offering open", () => {
      const { trace } = browsingTrace();
      browseFirstSection(trace);

      assert.deepEqual(trace.press({ kind: "focus-lost", leftStrip: false }), [clearHighlight]);
      assert.equal(trace.closedAs, undefined);
      assert.deepEqual(trace.focusTarget(), { kind: "input" });
    });
  });
});

describe("walking the offering's chips from the tray", () => {
  /**
   * A strip armed from the tray over two chips drawn on one row, the way the
   * strip draws its best-next row.
   */
  function trayTrace(): { trace: ComposerTrace; chips: StripCandidate[] } {
    const first = candidateOf(makeSensorTile(`composer-tray-walk-one-${nextFnId}`), "one");
    const second = candidateOf(makeSensorTile(`composer-tray-walk-two-${nextFnId}`), "two");
    const trace = new ComposerTrace({
      inSentence: false,
      whenTiles: 1,
      drawsBestNext: true,
      offeringFor: () => [first, second],
    });
    return { trace, chips: [first, second] };
  }

  /** The cursor standing on the chip `candidate` renders as in the best-next row. */
  function bestChip(candidate: StripCandidate): StripCursor {
    return chipAt(stripOptionId(kStripId, kBestNextBandKey, candidate.key));
  }

  test("the arming stands at no caret, with the highlight on the lead and the cursor nowhere", () => {
    const { trace, chips } = trayTrace();

    assert.equal(trace.mode(), "tray-armed");
    assert.equal(trace.state.caret, undefined);
    assert.equal(trace.state.cursor, undefined);
    assert.deepEqual(trace.leadCursor(), bestChip(chips[0]));
  });

  test("one horizontal arrow steps the highlight off the chip the offering leads with", () => {
    const { trace, chips } = trayTrace();

    assert.deepEqual(trace.press({ kind: "arrow", direction: "right", from: "filter" }), [
      { kind: "highlight", cursor: bestChip(chips[1]), mode: "typing" },
      typingFocus,
      consumeKey,
    ]);
    assert.deepEqual(trace.state.cursor, bestChip(chips[1]), "one press moves the highlight");
  });

  test("the arrow back walks to the chip the lead stood on", () => {
    const { trace, chips } = trayTrace();
    trace.press({ kind: "arrow", direction: "right", from: "filter" });

    assert.deepEqual(trace.press({ kind: "arrow", direction: "left", from: "filter" }), [
      { kind: "highlight", cursor: bestChip(chips[0]), mode: "typing" },
      typingFocus,
      consumeKey,
    ]);
    assert.deepEqual(trace.state.cursor, bestChip(chips[0]));
  });

  test("the lead has no chip before it, and the key reaches none", () => {
    const { trace, chips } = trayTrace();

    assert.deepEqual(trace.press({ kind: "arrow", direction: "left", from: "filter" }), []);
    assert.equal(trace.state.cursor, undefined);
    assert.deepEqual(trace.leadCursor(), bestChip(chips[0]), "the highlight stands where it was");
  });

  test("the last chip has none after it, and the key stops there", () => {
    const { trace, chips } = trayTrace();
    trace.press({ kind: "arrow", direction: "right", from: "filter" });

    assert.deepEqual(trace.press({ kind: "arrow", direction: "right", from: "filter" }), [consumeKey]);
    assert.deepEqual(trace.state.cursor, bestChip(chips[1]));
  });

  test("the arrows step from the lead once the tray's box stands open too", () => {
    const { trace, chips } = trayTrace();
    trace.typeWord("o");
    assert.equal(trace.mode(), "tray-filtering", "text given to the box shows it");
    assert.deepEqual(trace.leadCursor(), bestChip(chips[0]));

    assert.deepEqual(trace.press({ kind: "arrow", direction: "right", from: "filter" }), [
      { kind: "highlight", cursor: bestChip(chips[1]), mode: "typing" },
      typingFocus,
      consumeKey,
    ]);
    assert.deepEqual(trace.state.cursor, bestChip(chips[1]));
  });

  /** The effects a placement from the tray asks for, which moves no caret of its own. */
  function trayPlacementEffects(candidate: StripCandidate): readonly ComposerInputEffect[] {
    return [
      consumeKey,
      { kind: "place-tile", candidate },
      { kind: "announce-placement", label: candidate.label },
      clearHighlight,
      settledFocus,
      landedReask,
    ];
  }

  test("Enter places the highlighted chip both before the first horizontal arrow and after it", () => {
    const { trace, chips } = trayTrace();
    assert.deepEqual(trace.press({ kind: "enter", from: "filter" }), trayPlacementEffects(chips[0]), "the lead's chip");
    assert.deepEqual(trace.tileIds(RuleSide.When).slice(-1), [chips[0].key]);

    const stepped = trayTrace();
    stepped.trace.press({ kind: "arrow", direction: "right", from: "filter" });
    assert.deepEqual(
      stepped.trace.press({ kind: "enter", from: "filter" }),
      trayPlacementEffects(stepped.chips[1]),
      "the chip stepped to"
    );
    assert.deepEqual(stepped.trace.tileIds(RuleSide.When).slice(-1), [stepped.chips[1].key]);
  });

  test("the vertical arrows still step from the lead, onto the row below it", () => {
    const first = candidateOf(makeSensorTile(`composer-tray-rows-one-${nextFnId}`), "one");
    const second = candidateOf(makeSensorTile(`composer-tray-rows-two-${nextFnId}`), "two");
    const trace = new ComposerTrace({
      inSentence: false,
      whenTiles: 1,
      drawsBestNext: true,
      bestNextPerRow: 1,
      offeringFor: () => [first, second],
    });

    trace.press({ kind: "arrow", direction: "down", from: "filter" });
    assert.deepEqual(trace.state.cursor, bestChip(second));
  });
});

describe("the token vocabulary", () => {
  test("the filter box's structural keys map to their own tokens", () => {
    assert.deepEqual(composerTokenForKey(",", "filter", false), { kind: "comma" });
    assert.deepEqual(composerTokenForKey(".", "filter", false), { kind: "period" });
    assert.deepEqual(composerTokenForKey(" ", "filter", false), { kind: "space" });
    assert.deepEqual(composerTokenForKey("Enter", "filter", false), { kind: "enter", from: "filter" });
    assert.deepEqual(composerTokenForKey("Backspace", "filter", false), { kind: "backspace", from: "filter" });
    assert.deepEqual(composerTokenForKey("Escape", "filter", false), { kind: "escape" });
    assert.deepEqual(composerTokenForKey("ArrowDown", "filter", false), {
      kind: "arrow",
      direction: "down",
      from: "filter",
    });
    assert.equal(composerTokenForKey("a", "filter", false), undefined);
  });

  test("the command modifier turns Enter into the insertion chord and leaves every other key alone", () => {
    for (const surface of ["filter", "band"] as const) {
      assert.deepEqual(composerTokenForKey("Enter", surface, true), { kind: "settle-and-insert" }, surface);
    }
    assert.equal(composerTokenForKey("Enter", "close", true), undefined);
    assert.deepEqual(composerTokenForKey(".", "filter", true), { kind: "period" });
    assert.deepEqual(composerTokenForKey(" ", "filter", true), { kind: "space" });
    assert.deepEqual(composerTokenForKey("Backspace", "filter", true), { kind: "backspace", from: "filter" });
  });

  test("the command modifier turns the arrows into the rule's own steps, on every surface", () => {
    for (const surface of ["filter", "band", "close"] as const) {
      for (const [key, direction] of [
        ["ArrowUp", "up"],
        ["ArrowDown", "down"],
        ["ArrowLeft", "outdent"],
        ["ArrowRight", "indent"],
      ] as const) {
        assert.deepEqual(
          composerTokenForKey(key, surface, true),
          { kind: "move-rule", direction },
          `${surface} ${key}`
        );
      }
      assert.deepEqual(composerTokenForKey("ArrowDown", surface, false), {
        kind: "arrow",
        direction: "down",
        from: surface,
      });
    }
  });

  test("a double quote is its own token on the filter surface", () => {
    assert.deepEqual(composerTokenForKey('"', "filter", false), { kind: "quote" });
  });

  test("a band leaves the punctuation accelerators to the filter box it hands the keyboard to", () => {
    assert.deepEqual(composerTokenForKey(",", "band", false), { kind: "printable" });
    assert.deepEqual(composerTokenForKey(".", "band", false), { kind: "printable" });
    assert.deepEqual(composerTokenForKey(" ", "band", false), { kind: "printable" });
    assert.deepEqual(composerTokenForKey("Backspace", "band", false), { kind: "backspace", from: "band" });
    assert.equal(composerTokenForKey("F2", "band", false), undefined);
  });

  test("Tab belongs to the browser's focus order on every surface, so no state of the box claims it", () => {
    for (const surface of ["filter", "band", "close"] as const) {
      assert.equal(composerTokenForKey("Tab", surface, false), undefined, surface);
    }
  });

  test("the close button steers only the rows of chips", () => {
    assert.deepEqual(composerTokenForKey("ArrowUp", "close", false), { kind: "arrow", direction: "up", from: "close" });
    assert.equal(composerTokenForKey("Enter", "close", false), undefined);
    assert.equal(composerTokenForKey(" ", "close", false), undefined);
  });

  test("the run's ends have their own keys on the filter surface, and none on a band", () => {
    assert.deepEqual(composerTokenForKey("Home", "filter", false), { kind: "home" });
    assert.deepEqual(composerTokenForKey("End", "filter", false), { kind: "end" });
    assert.equal(composerTokenForKey("Home", "band", false), undefined);
    assert.equal(composerTokenForKey("End", "band", false), undefined);
    assert.equal(composerTokenForKey("Home", "close", false), undefined);
  });

  test("forward delete is the filter surface's own key", () => {
    assert.deepEqual(composerTokenForKey("Delete", "filter", false), { kind: "delete-forward" });
    assert.equal(composerTokenForKey("Delete", "band", false), undefined);
    assert.equal(composerTokenForKey("Delete", "close", false), undefined);
  });

  test("an accordion heading answers every arrow, and leaves Enter to the button", () => {
    for (const [key, direction] of [
      ["ArrowDown", "down"],
      ["ArrowUp", "up"],
      ["ArrowRight", "right"],
      ["ArrowLeft", "left"],
    ] as const) {
      assert.deepEqual(composerHeadingToken(key, kSectionBandKey), {
        kind: "heading-arrow",
        direction,
        sectionKey: kSectionBandKey,
      });
    }
    assert.equal(composerHeadingToken("Enter", kSectionBandKey), undefined);
  });

  test("a rule's entry point starts composition with the character typed on it", () => {
    for (const key of ["a", "Z", "7", "$", '"', ","]) {
      assert.equal(composerEntryCharacter(key, false), key);
    }
  });

  test("the keys that activate the entry point, and the keys that type nothing, start no word", () => {
    for (const key of [" ", "Enter", "Backspace", "Tab", "Escape", "ArrowDown", "Shift", "F2"]) {
      assert.equal(composerEntryCharacter(key, false), undefined);
    }
  });

  test("a character held with a modifier is left to the browser", () => {
    assert.equal(composerEntryCharacter("a", true), undefined);
  });
});

describe("entering composition from a rule's sentence cell", () => {
  test("space enters with nothing typed", () => {
    assert.deepEqual(decideSentenceCellEntry(" ", false), { seed: undefined });
  });

  test("enter enters with nothing typed", () => {
    assert.deepEqual(decideSentenceCellEntry("Enter", false), { seed: undefined });
  });

  test("a printable character enters and starts the word in progress", () => {
    for (const key of ["l", "Z", "7", "$", '"', ","]) {
      assert.deepEqual(decideSentenceCellEntry(key, false), { seed: key });
    }
  });

  test("the three routes reach one composition, differing only in what stands in the box", () => {
    const bySpace = decideSentenceCellEntry(" ", false);
    const byEnter = decideSentenceCellEntry("Enter", false);
    const byTyping = decideSentenceCellEntry("l", false);

    assert.ok(bySpace !== undefined && byEnter !== undefined && byTyping !== undefined);
    assert.deepEqual(Object.keys(bySpace), Object.keys(byTyping));
    assert.deepEqual(Object.keys(byEnter), Object.keys(byTyping));
    assert.deepEqual(byEnter, bySpace);
    assert.deepEqual({ ...byTyping, seed: undefined }, bySpace);
  });

  test("the keys that act elsewhere, and the keys that type nothing, enter nothing", () => {
    for (const key of ["Backspace", "Tab", "Escape", "ArrowDown", "Delete", "Shift", "F2"]) {
      assert.equal(decideSentenceCellEntry(key, false), undefined);
    }
  });

  test("a key held with a modifier is left to the browser", () => {
    for (const key of [" ", "Enter", "l"]) {
      assert.equal(decideSentenceCellEntry(key, true), undefined);
    }
  });
});

describe("enter with nothing to place", () => {
  test("settles a rule whose armed side may end", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });

    assert.deepEqual(trace.press({ kind: "enter", from: "filter" }), [
      consumeKey,
      { kind: "close-strip", reason: "settled" },
    ]);
    assert.equal(trace.closedAs, "settled");
  });

  test("refuses where the armed side cannot end", () => {
    const trace = new ComposerTrace({ whenTiles: 1 });
    trace.armedSideCanEnd = false;

    assert.deepEqual(trace.press({ kind: "enter", from: "filter" }), [consumeKey]);
    assert.equal(trace.closedAs, undefined);
  });

  test("settles nothing on a rule holding no tiles at all", () => {
    const trace = new ComposerTrace();

    assert.deepEqual(trace.press({ kind: "enter", from: "filter" }), [consumeKey]);
    assert.equal(trace.closedAs, undefined);
  });

  test("leaves the key alone on a band, and in a strip armed from the tray", () => {
    const banded = new ComposerTrace({ whenTiles: 1 });
    assert.deepEqual(banded.press({ kind: "enter", from: "band" }), []);
    assert.equal(banded.closedAs, undefined);

    const tray = new ComposerTrace({ inSentence: false, whenTiles: 1 });
    assert.deepEqual(tray.press({ kind: "enter", from: "filter" }), []);
    assert.equal(tray.closedAs, undefined);
  });
});

describe("the chip the offering leads with", () => {
  /** The core number variable factory, as a candidate the offering carries. */
  function variableFactoryCandidate(): StripCandidate {
    const tileDef = services.edit.tiles.get(mkVariableFactoryTileId(CoreVariableFactoryId.Number));
    assert.ok(tileDef, "core number variable factory not registered");
    return candidateOf(tileDef, "number");
  }

  /** A trace drawing its offering as the best-next row, the way the strip draws it. */
  function ledTrace(candidates: readonly StripCandidate[]): ComposerTrace {
    return new ComposerTrace({ whenTiles: 1, drawsBestNext: true, offeringFor: () => candidates });
  }

  /** The candidate key of the chip drawn as highlighted, or undefined when none is. */
  function highlightedKey(trace: ComposerTrace): string | undefined {
    return trace.highlightedOption()?.candidateKey;
  }

  test("the offering's first chip is highlighted with nothing typed, and Enter places it", () => {
    const see = candidateOf(makeSensorTile("composer-lead-see"), "see");
    const plant = candidateOf(makeSensorTile("composer-lead-plant"), "plant");
    const trace = ledTrace([see, plant]);

    assert.equal(highlightedKey(trace), see.key);
    assert.equal(trace.state.cursor, undefined, "the highlight rests without the cursor standing anywhere");

    assert.deepEqual(
      trace.press({ kind: "enter", from: "filter" }),
      placementEffects(see, trace.gap(RuleSide.When, 2))
    );
    assert.deepEqual(trace.tileIds(RuleSide.When).slice(-1), [see.key]);
  });

  test("the highlight follows the filter to the first match as the text narrows it", () => {
    const seek = candidateOf(makeSensorTile("composer-lead-seek"), "seek");
    const seed = candidateOf(makeSensorTile("composer-lead-seed"), "seed");
    const trace = ledTrace([seek, seed]);

    assert.equal(highlightedKey(trace), seek.key);
    trace.typeWord("se");
    assert.equal(highlightedKey(trace), seek.key, "the prefix leaves both, so the first match leads");
    trace.typeWord("seed");
    assert.equal(highlightedKey(trace), seed.key, "the narrowed offering leads with its own first match");

    assert.deepEqual(
      trace.press({ kind: "enter", from: "filter" }),
      placementEffects(seed, trace.gap(RuleSide.When, 2))
    );
  });

  test("a typed word matching nothing but a minted variable highlights no chip, and Enter places none", () => {
    const trace = ledTrace([variableFactoryCandidate()]);
    trace.typeWord("speedy");

    assert.ok(trace.options().length > 0, "the mint is offered as a chip");
    assert.equal(highlightedKey(trace), undefined);

    assert.deepEqual(trace.press({ kind: "enter", from: "filter" }), [
      consumeKey,
      { kind: "close-strip", reason: "settled" },
    ]);
    assert.equal(trace.tileCount(RuleSide.When), 1, "no variable was minted into the rule");
  });

  test("text naming a variable outright highlights the chip that mints it, which Enter places", () => {
    const trace = ledTrace([variableFactoryCandidate()]);
    trace.typeWord("$speedy");

    const minted = trace.options()[0]?.candidateKey;
    assert.ok(minted, "the accelerator offers the mint as a chip");
    assert.equal(highlightedKey(trace), minted);

    const placed = trace.press({ kind: "enter", from: "filter" }).filter((effect) => effect.kind === "place-tile");
    assert.deepEqual(
      placed.map((effect) => effect.candidate.key),
      [minted]
    );
    assert.equal(trace.tileCount(RuleSide.When), 2);
  });

  test("an open text value takes Enter itself, placing the value and not the highlighted chip", () => {
    const factory = textFactoryCandidate();
    const trace = ledTrace([factory]);
    trace.press({ kind: "quote" });
    trace.press({ kind: "text", text: "hello" });

    assert.equal(highlightedKey(trace), factory.key, "the offering still leads with a chip of its own");
    const pending = trace.pendingTextChip();
    assert.ok(pending);

    const placed = trace.press({ kind: "enter", from: "filter" }).filter((effect) => effect.kind === "place-tile");
    assert.deepEqual(
      placed.map((effect) => effect.candidate.key),
      [pending.key]
    );
    assert.equal(trace.state.textLiteral, undefined);
  });
});

describe("escape", () => {
  test("clears the word in progress before it closes the strip", () => {
    const trace = new ComposerTrace();
    trace.typeWord("se");

    assert.deepEqual(trace.press({ kind: "escape" }), [consumeKey, { kind: "set-filter", text: "" }, clearHighlight]);
    assert.equal(trace.closedAs, undefined);

    assert.deepEqual(trace.press({ kind: "escape" }), [consumeKey, { kind: "close-strip", reason: "dismissed" }]);
    assert.equal(trace.closedAs, "dismissed");
  });
});

/**
 * Formulas typed without spaces. The offering behind these traces is the real
 * suggestion oracle over the rule as the placements so far leave it, so every
 * word commits exactly where it commits in the editor and every refusal is a
 * refusal the oracle made.
 */
describe("typing a formula", () => {
  /** The catalogs the oracle is asked over: the core tiles, plus the brain's own. */
  function traceCatalogs(trace: ComposerTrace): ReadonlyList<ITileCatalog> {
    const catalogs = List.from<ITileCatalog>([services.edit.tiles]);
    const local = trace.ruleDef.brain()?.catalog();
    if (local) catalogs.push(local);
    return catalogs.asReadonly();
  }

  /**
   * The offering the suggestion oracle gives at the position `trace` stands at,
   * ranked the way the strip ranks it.
   */
  function oracleOffering(trace: ComposerTrace): readonly StripCandidate[] {
    const caret = trace.state.caret;
    assert.ok(caret, "an oracle-backed trace stands at a caret");
    const tileSet = caret.side === RuleSide.When ? trace.ruleDef.when() : trace.ruleDef.do();
    const intent = caretEditIntent(caret, tileSet.tiles().size());
    const context = buildInsertionContext({
      side: caret.side,
      expr: intent.mode === "insert" ? undefined : tileSet.expr(),
      replaceTileIndex: intent.mode === "replace" ? intent.tileIndex : undefined,
      ruleDef: trace.ruleDef,
      existingTiles: intent.mode === "insert" ? tileSet.tiles().slice(0, intent.tileIndex ?? 0) : tileSet.tiles(),
    });
    const result = suggestTiles(context, traceCatalogs(trace), services);
    return categoryPriorityCandidateRanker(buildStripCandidates(result, traceLabelOf), null);
  }

  /** Register a number variable named `name` in `trace`'s brain, as naming one does. */
  function addNumberVariable(trace: ComposerTrace, name: string): IBrainTileDef {
    const factoryTileDef = services.edit.tiles.get(mkVariableFactoryTileId(CoreVariableFactoryId.Number));
    assert.ok(factoryTileDef, "core number variable factory not registered");
    const tileDef = (factoryTileDef as BrainTileFactoryDef).manufacture(factoryTileDef as BrainTileFactoryDef, {
      name,
    });
    assert.ok(tileDef, `variable ${name} manufactured`);
    trace.ruleDef.brain()?.catalog()?.registerTileDef(tileDef);
    return tileDef;
  }

  /** A trace whose offering is the oracle's own, holding a number variable per name in `varNames`. */
  function formulaTrace(varNames: readonly string[] = [], armedSide: RuleSide = RuleSide.When): ComposerTrace {
    const trace = new ComposerTrace({ armedSide, offeringFor: (_filter, self) => oracleOffering(self) });
    for (const name of varNames) addNumberVariable(trace, name);
    return trace;
  }

  /**
   * Type `formula` a character at a time, each character reaching the model the
   * way the keyboard delivers it: its own key token where it has one, and the
   * box's content change otherwise, including where the key token declines it.
   */
  function typeFormula(trace: ComposerTrace, formula: string): void {
    for (const char of formula) {
      const token = composerTokenForKey(char, "filter", false);
      if (token !== undefined && consumesKey(trace.press(token))) continue;
      // The box holds an open text value's content when there is one, and the
      // word in progress otherwise.
      const box = trace.state.textLiteral ?? trace.state.filter;
      trace.press({ kind: "text", text: box + char });
    }
  }

  /** The word each placement of `trace` carried, in order. */
  function placedWords(trace: ComposerTrace): string[] {
    return trace.log.filter((effect) => effect.kind === "place-tile").map((effect) => effect.candidate.label);
  }

  /** The words `formula` places on an otherwise empty WHEN side, and the word left in progress. */
  function typedOnWhenSide(formula: string, varNames: readonly string[] = []): { placed: string[]; pending: string } {
    const trace = formulaTrace(varNames);
    typeFormula(trace, formula);
    return { placed: placedWords(trace), pending: trace.state.filter };
  }

  test("places a number, an operator, and a number with no spaces between them", () => {
    const trace = formulaTrace();
    typeFormula(trace, "1+3");

    assert.deepEqual(placedWords(trace), ["1", "plus"]);
    assert.equal(trace.state.filter, "3", "the last word waits for a key that commits it");

    trace.press({ kind: "space" });
    assert.deepEqual(placedWords(trace), ["1", "plus", "3"]);
    assert.equal(trace.tileCount(RuleSide.When), 3);
  });

  test("spaces between the words stay optional, not forbidden", () => {
    const spaced = formulaTrace();
    typeFormula(spaced, "1 + 3 ");
    const tight = formulaTrace();
    typeFormula(tight, "1+3 ");

    assert.deepEqual(placedWords(spaced), ["1", "plus", "3"]);
    assert.deepEqual(placedWords(tight), placedWords(spaced));
    assert.equal(tight.state.filter, "");
  });

  test("a two-character operator is one word", () => {
    assert.deepEqual(typedOnWhenSide("1>=3"), { placed: ["1", "greater than or equal to"], pending: "3" });
    assert.deepEqual(typedOnWhenSide("1!=3"), { placed: ["1", "not equal to"], pending: "3" });
    assert.deepEqual(typedOnWhenSide("1<=3"), { placed: ["1", "less than or equal to"], pending: "3" });
  });

  test("a minus past the end of an operator joins the number instead of extending it", () => {
    assert.deepEqual(typedOnWhenSide("1>=-3"), { placed: ["1", "greater than or equal to"], pending: "-3" });
  });

  test("a minus where only a value fits opens a negative number", () => {
    assert.deepEqual(typedOnWhenSide("1*-3"), { placed: ["1", "multiplied by"], pending: "-3" });
    assert.deepEqual(typedOnWhenSide("1+-3"), { placed: ["1", "plus"], pending: "-3" });
    assert.deepEqual(typedOnWhenSide("-5"), { placed: [], pending: "-5" });
  });

  test("a minus where an operator fits subtracts", () => {
    assert.deepEqual(typedOnWhenSide("1-3"), { placed: ["1", "minus"], pending: "3" });
    assert.deepEqual(typedOnWhenSide("1--3"), { placed: ["1", "minus"], pending: "-3" });
  });

  test("a negative number placed by the key that commits it carries the value typed", () => {
    const trace = formulaTrace();
    typeFormula(trace, "1*-3 ");

    const placed = trace.log.filter((effect) => effect.kind === "place-tile");
    assert.equal(placed.length, 3);
    const last = placed[2].candidate;
    assert.equal(last.origin.kind, "minted-literal");
    assert.equal(last.origin.kind === "minted-literal" ? last.origin.value : undefined, -3);
  });

  test("the decimal point stays inside the number it continues", () => {
    assert.deepEqual(typedOnWhenSide("1.5+2"), { placed: ["1.5", "plus"], pending: "2" });
  });

  test("a name is one word however many characters it takes", () => {
    assert.deepEqual(typedOnWhenSide("foobar"), { placed: [], pending: "foobar" });
    assert.deepEqual(typedOnWhenSide("foo+3", ["foo"]), { placed: ["foo", "plus"], pending: "3" });
  });

  test("a number opening a name is one word, and names nothing", () => {
    assert.deepEqual(typedOnWhenSide("2speed"), { placed: [], pending: "2speed" });
  });

  test("a named variable commits through the dollar accelerator", () => {
    const trace = formulaTrace([], RuleSide.Do);
    const foo = addNumberVariable(trace, "foo");
    __test__appendTile(trace.ruleDef.do(), foo);
    trace.placeCaret(trace.sideEndGap(RuleSide.Do));
    typeFormula(trace, "=$bar+1");

    assert.deepEqual(placedWords(trace), ["gets", "bar", "plus"]);
    assert.equal(trace.state.filter, "1");
  });

  test("a prefix operator falls out of the same rule", () => {
    const trace = formulaTrace(["foo"]);
    typeFormula(trace, "!foo");

    assert.deepEqual(placedWords(trace), ["NOT"]);
    assert.equal(trace.state.filter, "foo");
  });

  test("the assignment symbol places the word that assigns", () => {
    const trace = formulaTrace([], RuleSide.Do);
    const foo = addNumberVariable(trace, "foo");
    __test__appendTile(trace.ruleDef.do(), foo);
    trace.placeCaret(trace.sideEndGap(RuleSide.Do));

    typeFormula(trace, "=");
    assert.deepEqual(placedWords(trace), []);
    trace.press({ kind: "space" });
    assert.deepEqual(placedWords(trace), ["gets"]);
  });

  test("two equals signs are one word", () => {
    assert.deepEqual(typedOnWhenSide("1==3"), { placed: ["1", "equal to"], pending: "3" });
  });

  test("a bracketed formula with embedded variables places every tile in order", () => {
    const trace = formulaTrace(["foo", "energy"]);
    typeFormula(trace, "((foo+3)*energy)");

    assert.deepEqual(placedWords(trace), ["(", "(", "foo", "plus", "3", ")", "multiplied by", "energy", ")"]);
    assert.equal(trace.state.filter, "", "the closing bracket is a word of its own and needs no key to commit it");
    assert.equal(trace.tileCount(RuleSide.When), 9);
  });

  test("the order tiles are placed in is the order they are typed in", () => {
    const trace = formulaTrace();
    typeFormula(trace, "1+3*2 ");

    assert.deepEqual(placedWords(trace), ["1", "plus", "3", "multiplied by", "2"]);
  });

  test("a word that places nothing refuses the character that would end it", () => {
    const trace = formulaTrace();
    typeFormula(trace, "zz+");

    assert.deepEqual(placedWords(trace), []);
    assert.equal(trace.state.filter, "zz", "the word stands as it was typed");
    assert.equal(trace.tileCount(RuleSide.When), 0);
  });

  test("an operator with nothing to operate on stands unplaced", () => {
    const trace = formulaTrace();
    typeFormula(trace, "+");

    assert.deepEqual(placedWords(trace), []);
    assert.equal(trace.state.filter, "+");
  });

  test("a closing bracket with no group open stands unplaced", () => {
    const trace = formulaTrace();
    typeFormula(trace, ")");

    assert.deepEqual(placedWords(trace), []);
    assert.equal(trace.state.filter, ")");
  });

  test("an opening bracket where no group fits places the word before it and stands unplaced", () => {
    const trace = formulaTrace(["foo"]);
    typeFormula(trace, "foo(");

    assert.deepEqual(placedWords(trace), ["foo"]);
    assert.equal(trace.state.filter, "(");
  });

  test("a formula typed into an open text value is taken as content", () => {
    const trace = formulaTrace();
    trace.press({ kind: "quote" });
    assert.equal(trace.state.textLiteral, "", "the position takes a text value");
    typeFormula(trace, "((1+3)*2)");

    assert.deepEqual(placedWords(trace), []);
    assert.equal(trace.state.textLiteral, "((1+3)*2)");
    assert.equal(trace.state.filter, "");

    trace.press({ kind: "quote" });
    const placed = trace.log.filter((effect) => effect.kind === "place-tile");
    assert.equal(placed.length, 1);
    assert.equal(
      placed[0].candidate.origin.kind === "minted-literal" ? placed[0].candidate.origin.value : undefined,
      "((1+3)*2)"
    );
  });

  test("backspace walks back the commits the characters made", () => {
    const trace = formulaTrace();
    typeFormula(trace, "1+3 ");
    assert.equal(trace.ownCommitCount(), 3);

    for (let taken = 2; taken >= 0; taken--) {
      trace.press({ kind: "backspace", from: "filter" });
      assert.equal(trace.ownCommitCount(), taken, `${taken} left`);
      assert.equal(trace.tileCount(RuleSide.When), taken);
    }
  });

  test("an edit that is not one character added to the end places nothing", () => {
    const pasted = formulaTrace();
    pasted.press({ kind: "text", text: "1+3" });
    assert.deepEqual(placedWords(pasted), []);
    assert.equal(pasted.state.filter, "1+3");

    const shortened = formulaTrace();
    typeFormula(shortened, "12");
    shortened.press({ kind: "text", text: "1" });
    assert.deepEqual(placedWords(shortened), []);
    assert.equal(shortened.state.filter, "1");
  });
});
