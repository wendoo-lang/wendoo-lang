import { assertUnreachable } from "@wendoo/core";
import {
  CoreCapabilityBits,
  fixedFormat,
  type IBrainTileDef,
  isCoreLiteralFactoryTileId,
  isLiteralFactoryTileId,
  isVariableFactoryTileId,
  type LiteralDisplayFormat,
  LiteralDisplayFormats,
  mkOperatorTileId,
  percentFormat,
  RuleSide,
  TilePlacement,
  timeMsFormat,
  timeSecondsFormat,
} from "@wendoo/core/brain";
import type { TileSuggestion, TileSuggestionResult } from "@wendoo/core/brain/language-service";
import {
  applyDisplayFormat,
  type BrainTileFactoryDef,
  type BrainTileOperatorDef,
  type BrainTileVariableDef,
} from "@wendoo/core/brain/tiles";
import {
  CoreHostActions,
  CoreOpId,
  CoreTypeIds,
  mkActuatorTileId,
  mkSensorTileId,
  type TypeId,
} from "@wendoo/core/runtime";
import type { ArmedTileTarget } from "./ArmedTargetContext";
import type { StripCommand } from "./strip-commands";
import { groupTilesByLibrary, type TileSourceLibrary, tileSourceNamespace } from "./tile-library-groups";

/** The category a candidate is filed under in the strip's accordion. */
export type TileCandidateGroup =
  | "actuator"
  | "sensor"
  | "output"
  | "function"
  | "parameter+modifier"
  | "variable"
  | "accessor"
  | "literal"
  | "page"
  | "operator+controlFlow"
  | "other";

/** Display heading for each {@link TileCandidateGroup}. */
export const tileCandidateGroupNames: Record<TileCandidateGroup, string> = {
  actuator: "Actuators",
  sensor: "Sensors",
  output: "Outputs",
  function: "Functions",
  "parameter+modifier": "Parameters",
  variable: "Variables",
  accessor: "Field Accessors",
  literal: "Literals",
  page: "Pages",
  "operator+controlFlow": "Operators",
  other: "Other",
};

function allTileCandidateGroups<const T extends readonly TileCandidateGroup[]>(
  groups: T & ([TileCandidateGroup] extends [T[number]] ? T : never)
): T {
  return groups;
}

const defaultGroupOrder = allTileCandidateGroups([
  "actuator",
  "sensor",
  "output",
  "function",
  "parameter+modifier",
  "variable",
  "accessor",
  "literal",
  "page",
  "operator+controlFlow",
  "other",
]);

const pagesFirstGroupOrder = allTileCandidateGroups([
  "page",
  "literal",
  "variable",
  "output",
  "function",
  "actuator",
  "sensor",
  "parameter+modifier",
  "accessor",
  "operator+controlFlow",
  "other",
]);

/** The {@link TileCandidateGroup} a tile is filed under, keyed by kind, placement, and capability. */
export function tileCandidateGroup(tileDef: IBrainTileDef): TileCandidateGroup {
  if (
    tileDef.kind === "sensor" &&
    tileDef.placement !== undefined &&
    (tileDef.placement & TilePlacement.Inline) !== 0
  ) {
    if (tileDef.capabilities().get(CoreCapabilityBits.PageSensor) !== 0) return "page";
    return "function";
  }
  if (tileDef.kind === "factory") {
    if (tileDef.tileId.includes("var.factory")) return "variable";
    if (tileDef.tileId.includes("lit.factory")) return "literal";
    return "other";
  }
  switch (tileDef.kind) {
    case "parameter":
    case "modifier":
      return "parameter+modifier";
    case "operator":
    case "controlFlow":
      return "operator+controlFlow";
    case "actuator":
    case "sensor":
    case "output":
    case "variable":
    case "accessor":
    case "literal":
    case "page":
      return tileDef.kind;
    case "undefined":
    case "missing":
      return "other";
    default:
      return assertUnreachable(tileDef.kind);
  }
}

/**
 * True when the tile preceding the armed position switches pages, in which
 * case page tiles lead the group order.
 */
export function shouldOrderPagesFirst(
  existingTiles: readonly IBrainTileDef[],
  replaceTileIndex: number | undefined
): boolean {
  const precedingIndex = replaceTileIndex != null ? replaceTileIndex - 1 : existingTiles.length - 1;
  if (precedingIndex < 0) return false;
  return existingTiles[precedingIndex]?.tileId === mkActuatorTileId(CoreHostActions.SwitchPage.key);
}

/**
 * Where a candidate's tile came from:
 *
 * - `suggested` -- the suggestion oracle offered it
 * - `minted-literal` -- typed digits mint it, carrying the value and the display
 *   format it places
 * - `minted-variable` -- a typed word mints it, carrying the name it places
 *
 * A minted candidate carries the factory that manufactures its tile, so
 * committing it runs the same manufacture and registration path the factory
 * tiles run.
 */
export type CandidateOrigin =
  | { readonly kind: "suggested" }
  | {
      readonly kind: "minted-literal";
      readonly factoryTileDef: BrainTileFactoryDef;
      readonly value: unknown;
      /** The format the placed literal displays `value` in, which reads back as the typed text. */
      readonly displayFormat: LiteralDisplayFormat;
    }
  | { readonly kind: "minted-variable"; readonly factoryTileDef: BrainTileFactoryDef; readonly varName: string };

/** One tile offered at the armed position. */
export interface StripCandidate {
  /** Stable identity within one offering; unique across the candidate list. */
  readonly key: string;
  /** The tile placed when this candidate commits. Minted candidates carry an unregistered preview def. */
  readonly tileDef: IBrainTileDef;
  /** Word-chip label, resolved by the caller from the tile's visual. */
  readonly label: string;
  readonly group: TileCandidateGroup;
  /** True when the tile fits the position only through a conversion. */
  readonly viaConversion: boolean;
  readonly origin: CandidateOrigin;
}

/**
 * True when choosing `tileDef` opens a create dialog: the variable factories and
 * the literal factories, whichever package registered them, each of which
 * manufactures the tile the dialog names. Nothing is placed until that dialog is
 * submitted, and abandoning it places nothing at all.
 */
export function tileDefersToCreateDialog(tileDef: IBrainTileDef): boolean {
  if (tileDef.kind !== "factory") return false;
  return isVariableFactoryTileId(tileDef.tileId) || isLiteralFactoryTileId(tileDef.tileId);
}

const suggestedOrigin: CandidateOrigin = { kind: "suggested" };

function toCandidate(suggestion: TileSuggestion, label: string, viaConversion: boolean): StripCandidate {
  return {
    key: viaConversion ? `conv:${suggestion.tileDef.tileId}` : suggestion.tileDef.tileId,
    tileDef: suggestion.tileDef,
    label,
    group: tileCandidateGroup(suggestion.tileDef),
    viaConversion,
    origin: suggestedOrigin,
  };
}

/**
 * Flatten a {@link TileSuggestionResult} into candidates in oracle order:
 * exact matches first as returned, then conversion matches ordered by
 * conversion cost. `labelOf` supplies each tile's word-chip label.
 */
export function buildStripCandidates(
  result: TileSuggestionResult,
  labelOf: (tileDef: IBrainTileDef) => string
): StripCandidate[] {
  const candidates: StripCandidate[] = [];
  for (let i = 0; i < result.exact.size(); i++) {
    const suggestion = result.exact.get(i);
    candidates.push(toCandidate(suggestion, labelOf(suggestion.tileDef), false));
  }
  const conversions: TileSuggestion[] = [];
  for (let i = 0; i < result.withConversion.size(); i++) {
    conversions.push(result.withConversion.get(i));
  }
  conversions.sort((a, b) => a.conversionCost - b.conversionCost);
  for (const suggestion of conversions) {
    candidates.push(toCandidate(suggestion, labelOf(suggestion.tileDef), true));
  }
  return candidates;
}

/** One accordion section: the candidates of a single group, whether they fit directly or by conversion. */
export interface CandidateSection {
  /** Stable identity of the section, unique within one offering. */
  readonly key: string;
  readonly group: TileCandidateGroup;
  readonly candidates: readonly StripCandidate[];
}

/**
 * Partition candidates into one accordion section per group, in group order.
 * Candidate order within a section is the input order. `pagesFirst` leads with
 * page tiles.
 */
export function groupStripCandidates(
  candidates: readonly StripCandidate[],
  pagesFirst: boolean = false
): CandidateSection[] {
  const order = pagesFirst ? pagesFirstGroupOrder : defaultGroupOrder;
  const sections: CandidateSection[] = [];
  for (const group of order) {
    const items = candidates.filter((c) => c.group === group);
    if (items.length === 0) continue;
    sections.push({ key: group, group, candidates: items });
  }
  return sections;
}

/**
 * Fuzzy character-bag match over search-folded text: every character of `needle`
 * exists in `haystack`, order-independent. Both sides arrive folded.
 */
function fuzzyTileMatch(needle: string, haystack: string): boolean {
  const pool = haystack.split("");
  for (let fi = 0; fi < needle.length; fi++) {
    const idx = pool.indexOf(needle[fi]);
    if (idx === -1) return false;
    pool.splice(idx, 1);
  }
  return true;
}

/**
 * How well one of a tile's matchable texts -- its label, or an alias it is also
 * reachable by -- matches filter text, best quality first:
 *
 * - "exact" -- the whole text is the filter text
 * - "prefix" -- the text starts with the filter text
 * - "word-prefix" -- the filter text starts a later word of the text, so a
 *   multi-word form is reachable by any word it opens with
 * - "substring" -- the filter text appears contiguously inside the text,
 *   starting inside a word
 * - "fuzzy" -- every character of the filter text appears in the text, in any order
 */
export type TileMatchQuality = "exact" | "prefix" | "word-prefix" | "substring" | "fuzzy";

const tileMatchRank: Record<TileMatchQuality, number> = {
  exact: 0,
  prefix: 1,
  "word-prefix": 2,
  substring: 3,
  fuzzy: 4,
};

/** True when `needle` starts a word of `haystack` other than its first. */
function startsLaterWord(needle: string, haystack: string): boolean {
  let at = haystack.indexOf(needle);
  while (at > 0) {
    if (haystack[at - 1] === " ") return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

/**
 * The quality with which `text` matches `filter`, or undefined when it does not
 * match at all. Both sides are compared trimmed and folded through `foldText`;
 * empty filter text matches nothing, so callers handle it before classifying.
 */
function classifyTextMatch(
  filter: string,
  text: string,
  foldText: (text: string) => string
): TileMatchQuality | undefined {
  const needle = foldText(filter.trim());
  if (needle.length === 0) return undefined;
  const haystack = foldText(text.trim());
  if (haystack === needle) return "exact";
  if (haystack.startsWith(needle)) return "prefix";
  if (startsLaterWord(needle, haystack)) return "word-prefix";
  if (haystack.includes(needle)) return "substring";
  return fuzzyTileMatch(needle, haystack) ? "fuzzy" : undefined;
}

/**
 * The best quality with which `filter` matches `label` or any of `aliases`, or
 * undefined when it matches none of them. An alias climbs the same ladder the
 * label does, so a partly typed alias reaches its tile exactly as a partly typed
 * label would. `foldText` normalizes the filter text and every matchable text
 * alike, so a query typed without a candidate's diacritics still reaches it.
 */
export function classifyTileMatch(
  filter: string,
  label: string,
  aliases: readonly string[],
  foldText: (text: string) => string
): TileMatchQuality | undefined {
  let best = classifyTextMatch(filter, label, foldText);
  for (const alias of aliases) {
    const quality = classifyTextMatch(filter, alias, foldText);
    if (quality === undefined) continue;
    if (best === undefined || tileMatchRank[quality] < tileMatchRank[best]) best = quality;
  }
  return best;
}

/**
 * The notation each core operator is also reachable by while typing, keyed by
 * tile id. A symbol is matching input only: it never reaches a chip, a placed
 * tile, or a sentence, all of which read the operator's own word.
 */
const operatorSymbolAliases: ReadonlyMap<string, readonly string[]> = new Map([
  [mkOperatorTileId(CoreOpId.Not), ["!"]],
  [mkOperatorTileId(CoreOpId.Add), ["+"]],
  [mkOperatorTileId(CoreOpId.Subtract), ["-"]],
  [mkOperatorTileId(CoreOpId.Multiply), ["*"]],
  [mkOperatorTileId(CoreOpId.Divide), ["/"]],
  [mkOperatorTileId(CoreOpId.GreaterThan), [">"]],
  [mkOperatorTileId(CoreOpId.GreaterThanOrEqualTo), [">="]],
  [mkOperatorTileId(CoreOpId.LessThan), ["<"]],
  [mkOperatorTileId(CoreOpId.LessThanOrEqualTo), ["<="]],
  [mkOperatorTileId(CoreOpId.EqualTo), ["=="]],
  [mkOperatorTileId(CoreOpId.NotEqualTo), ["!="]],
  [mkOperatorTileId(CoreOpId.Assign), ["="]],
]);

/**
 * True when `text` opens an operator's typing notation: it is one of those
 * notations, or the start of one. Empty text opens none. A single character
 * therefore passes exactly when some operator is typed with that character.
 */
export function isOperatorSymbolPrefix(text: string): boolean {
  if (text.length === 0) return false;
  for (const aliases of operatorSymbolAliases.values()) {
    for (const alias of aliases) {
      if (alias.startsWith(text)) return true;
    }
  }
  return false;
}

const noTileMatchAliases: readonly string[] = [];

/**
 * The alias texts `tileDef` is matched by while typing, alongside its chip's
 * label: an operator's typing notation, then the tile's own non-empty
 * `metadata.label`. Aliases are matching input only and never become chip
 * text, a placed tile, or a sentence word.
 */
function tileMatchAliases(tileDef: IBrainTileDef): readonly string[] {
  const symbols = operatorSymbolAliases.get(tileDef.tileId);
  const label = tileDef.metadata?.label;
  if (label === undefined || label === "") return symbols ?? noTileMatchAliases;
  return symbols === undefined ? [label] : [...symbols, label];
}

/**
 * The quality with which `candidate` matches `filter`, over its label and the
 * aliases its tile carries. An alias repeating the label the chip already
 * matches on is dropped, so a tile whose chip reads its own `metadata.label` is
 * matched once.
 */
function classifyCandidateMatch(
  filter: string,
  candidate: StripCandidate,
  foldText: (text: string) => string
): TileMatchQuality | undefined {
  const aliases = tileMatchAliases(candidate.tileDef).filter((alias) => alias !== candidate.label);
  return classifyTileMatch(filter, candidate.label, aliases, foldText);
}

/** The one candidate of `candidates` matching `filter` at `quality`, or undefined when they do not number one. */
function uniqueMatchAt(
  candidates: readonly StripCandidate[],
  filter: string,
  quality: TileMatchQuality,
  foldText: (text: string) => string
): StripCandidate | undefined {
  const matched = candidates.filter((candidate) => classifyCandidateMatch(filter, candidate, foldText) === quality);
  return matched.length === 1 ? matched[0] : undefined;
}

/** True when any candidate matches `filter` at `quality`. */
function hasMatchAt(
  candidates: readonly StripCandidate[],
  filter: string,
  quality: TileMatchQuality,
  foldText: (text: string) => string
): boolean {
  return candidates.some((candidate) => classifyCandidateMatch(filter, candidate, foldText) === quality);
}

/**
 * The candidates matching `filter` on their label or on an alias their tile
 * carries, best match first: exact texts, then prefixes, then substrings, then
 * fuzzy matches, with candidates of equal quality left in input order. An empty
 * filter matches everything, in input order. `foldText` normalizes the filter
 * text and every candidate text alike.
 */
export function filterStripCandidates(
  candidates: readonly StripCandidate[],
  filter: string,
  foldText: (text: string) => string
): StripCandidate[] {
  const trimmed = filter.trim();
  if (trimmed.length === 0) return [...candidates];
  const matched: { candidate: StripCandidate; rank: number; index: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const quality = classifyCandidateMatch(trimmed, candidates[i], foldText);
    if (quality === undefined) continue;
    matched.push({ candidate: candidates[i], rank: tileMatchRank[quality], index: i });
  }
  matched.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.index - b.index));
  return matched.map((entry) => entry.candidate);
}

/** The key the user pressed to commit the word in progress. */
export type CandidateCommitKey = "enter" | "space";

/**
 * The candidates of `visible` a commit key may place, in offering order. Text
 * opening with the `$` accelerator leaves every candidate eligible; text without
 * it leaves out the minted variables, which no key places. Empty when the
 * offering holds no candidate a key may place.
 */
function commitEligibleCandidates(visible: readonly StripCandidate[], filter: string): readonly StripCandidate[] {
  return parseStripFilter(filter).variableIntent
    ? visible
    : visible.filter((candidate) => candidate.origin.kind !== "minted-variable");
}

/**
 * The candidate the strip highlights while the cursor stands on no cell: the
 * first candidate of `visible` a commit key may place, which is the best match
 * once `visible` comes from {@link filterStripCandidates} and the offering's
 * leading candidate while no filter text narrows it. Undefined when no visible
 * candidate is one a key may place, which is what a typed word matching nothing
 * but a minted variable leaves.
 */
export function leadStripCandidate(visible: readonly StripCandidate[], filter: string): StripCandidate | undefined {
  return commitEligibleCandidates(visible, filter)[0];
}

/**
 * The candidate a commit key places, or undefined when the key must not
 * commit. Enter takes the top visible candidate, which is the best
 * match once `visible` comes from {@link filterStripCandidates}; Space takes an
 * exact label match, else a unique prefix match, else -- when no label starts
 * with the text at all -- a unique match on a later word of a label, so a word
 * of a multi-word form commits without the words ahead of it. Empty filter text
 * and text matching no candidate never commit.
 *
 * A minted variable is committed by a key only when the filter text declares
 * variable intent with the `$` accelerator, so a mistyped word never becomes a
 * variable; without it the mint is placed by tap or by highlighting its chip.
 */
export function decideCandidateCommit(
  visible: readonly StripCandidate[],
  filter: string,
  key: CandidateCommitKey,
  foldText: (text: string) => string
): StripCandidate | undefined {
  const intent = parseStripFilter(filter);
  if (intent.text.length === 0) return undefined;
  const eligible = commitEligibleCandidates(visible, filter);
  if (eligible.length === 0) return undefined;
  if (key === "enter") return eligible[0];
  const exact = eligible.find((candidate) => classifyCandidateMatch(intent.text, candidate, foldText) === "exact");
  if (exact) return exact;
  if (hasMatchAt(eligible, intent.text, "prefix", foldText)) {
    return uniqueMatchAt(eligible, intent.text, "prefix", foldText);
  }
  return uniqueMatchAt(eligible, intent.text, "word-prefix", foldText);
}

/** True when the user has typed text that matches no candidate; such text can never commit. */
export function isUnknownFilterText(visible: readonly StripCandidate[], filter: string): boolean {
  return filter.trim().length > 0 && visible.length === 0;
}

const numericLiteralPattern = /^-?(\d+(\.\d+)?|\.\d+)$/;

/** Filter text that is a number the user has not finished typing: a lone minus sign, or digits ending in the decimal point. */
const numberInProgressPattern = /^(-|-?\d+\.)$/;

/** How many digits `digits` carries after its decimal point, and zero when it has none. */
function decimalPlaces(digits: string): number {
  const dot = digits.indexOf(".");
  return dot === -1 ? 0 : digits.length - dot - 1;
}

/** The number `text` holds ahead of the trailing `suffix`, or undefined when it does not end that way. */
function numberBeforeSuffix(text: string, suffix: string): string | undefined {
  if (!text.endsWith(suffix) || text.length === suffix.length) return undefined;
  const digits = text.slice(0, text.length - suffix.length);
  return numericLiteralPattern.test(digits) ? digits : undefined;
}

/** A number the filter text names, together with the display format its typed suffix asks for. */
interface TypedNumberLiteral {
  /** The value placed, which reads back as the typed text under `displayFormat`. */
  readonly value: number;
  /** The format the value displays in: `Default` for bare digits. */
  readonly displayFormat: LiteralDisplayFormat;
}

/**
 * The format `value` reads back as `typed` in: `plain` when applying it to
 * `value` already gives `typed`, else `withPrecision` when applying that gives
 * `typed`, else `plain` for text neither format writes.
 */
function roundTripFormat(
  value: number,
  typed: string,
  plain: LiteralDisplayFormat,
  withPrecision: LiteralDisplayFormat
): LiteralDisplayFormat {
  if (applyDisplayFormat(value, plain) === typed) return plain;
  return applyDisplayFormat(value, withPrecision) === typed ? withPrecision : plain;
}

/**
 * The number and display format `filter` names, or undefined when the text is
 * not a complete number. A trailing specifier selects the format and the digits
 * ahead of it are read as that format's own reading, so the value placed is the
 * one that displays as the text typed: `s` reads seconds, `ms` reads
 * milliseconds of a value held in seconds, and `%` reads a percentage of a
 * fraction. Each format carries the precision the digits were typed with
 * whenever its plain form would round that precision away.
 */
function parseTypedNumberLiteral(filter: string): TypedNumberLiteral | undefined {
  const trimmed = filter.trim();
  if (numericLiteralPattern.test(trimmed)) {
    const value = Number(trimmed);
    const places = decimalPlaces(trimmed);
    return {
      value,
      displayFormat: roundTripFormat(value, trimmed, LiteralDisplayFormats.Default, fixedFormat(places)),
    };
  }
  const percent = numberBeforeSuffix(trimmed, "%");
  if (percent !== undefined) {
    return { value: Number(percent) / 100, displayFormat: percentFormat(decimalPlaces(percent)) };
  }
  const milliseconds = numberBeforeSuffix(trimmed, "ms");
  if (milliseconds !== undefined) {
    const value = Number(milliseconds) / 1000;
    const places = decimalPlaces(milliseconds);
    return {
      value,
      displayFormat: roundTripFormat(value, trimmed, LiteralDisplayFormats.TimeMs, timeMsFormat(places)),
    };
  }
  const seconds = numberBeforeSuffix(trimmed, "s");
  if (seconds !== undefined) {
    const value = Number(seconds);
    const places = decimalPlaces(seconds);
    return {
      value,
      displayFormat: roundTripFormat(value, trimmed, LiteralDisplayFormats.TimeSeconds, timeSecondsFormat(places)),
    };
  }
  return undefined;
}

/** The core literal factory producing `dataType` among `candidates`, or undefined when the armed position accepts no such literal. */
function findLiteralFactoryOfType(
  candidates: readonly StripCandidate[],
  dataType: TypeId
): BrainTileFactoryDef | undefined {
  for (const candidate of candidates) {
    const tileDef = candidate.tileDef;
    if (tileDef.kind !== "factory" || !isCoreLiteralFactoryTileId(tileDef.tileId)) continue;
    const factoryTileDef = tileDef as BrainTileFactoryDef;
    if (factoryTileDef.producedDataType === dataType) return factoryTileDef;
  }
  return undefined;
}

/** The core number-literal factory among `candidates`, or undefined when the armed position accepts no numeric literal. */
function findNumberLiteralFactory(candidates: readonly StripCandidate[]): BrainTileFactoryDef | undefined {
  return findLiteralFactoryOfType(candidates, CoreTypeIds.Number);
}

/**
 * The literal candidate minted from typed digits: present when `filter` is a
 * complete number, with or without a display-format specifier on it, and the
 * armed position accepts a numeric literal. The candidate's tile is a preview
 * def manufactured by the factory; committing it re-manufactures through the
 * catalog so the placed tile is registered. `labelOf` reads the preview, so a
 * formatted literal's chip carries its formatted value.
 */
export function mintNumberLiteralCandidate(
  candidates: readonly StripCandidate[],
  filter: string,
  labelOf: (tileDef: IBrainTileDef) => string
): StripCandidate | undefined {
  const typed = parseTypedNumberLiteral(filter);
  if (!typed) return undefined;
  const factoryTileDef = findNumberLiteralFactory(candidates);
  if (!factoryTileDef) return undefined;
  const { value, displayFormat } = typed;
  const preview = factoryTileDef.manufacture(factoryTileDef, { value, displayFormat });
  if (!preview) return undefined;
  return {
    key: `mint:${preview.tileId}`,
    tileDef: preview,
    label: labelOf(preview),
    group: "literal",
    viaConversion: false,
    origin: { kind: "minted-literal", factoryTileDef, value, displayFormat },
  };
}

/**
 * The core literal factory producing `dataType` that the position takes as it
 * is, leaving out any factory it reaches only through a conversion.
 */
function findDirectLiteralFactoryOfType(
  candidates: readonly StripCandidate[],
  dataType: TypeId
): BrainTileFactoryDef | undefined {
  return findLiteralFactoryOfType(
    candidates.filter((candidate) => !candidate.viaConversion),
    dataType
  );
}

/**
 * True when the armed position takes a literal of `dataType` as it stands,
 * through a literal factory of any provenance it offers directly. A position
 * that reaches the type only through a conversion takes none.
 */
export function positionTakesLiteralOfType(candidates: readonly StripCandidate[], dataType: TypeId): boolean {
  return candidates.some((candidate) => {
    const tileDef = candidate.tileDef;
    if (candidate.viaConversion || tileDef.kind !== "factory" || !isLiteralFactoryTileId(tileDef.tileId)) return false;
    return (tileDef as BrainTileFactoryDef).producedDataType === dataType;
  });
}

/**
 * True when the armed position takes a text literal as it is, so a typed quote
 * opens one there. A position that reaches text only through a conversion takes
 * none.
 */
export function offersTextLiteral(candidates: readonly StripCandidate[]): boolean {
  return findDirectLiteralFactoryOfType(candidates, CoreTypeIds.String) !== undefined;
}

/**
 * The literal candidate a text value open in the composer places: present when
 * the armed position takes a text literal as it is, for any `value` including
 * the empty one. The candidate's tile is a preview def manufactured by the
 * factory; committing it re-manufactures through the catalog so the placed tile
 * is registered. `labelOf` reads the preview, so the chip carries the reading
 * the placed value's sentence gives it.
 */
export function mintTextLiteralCandidate(
  candidates: readonly StripCandidate[],
  value: string,
  labelOf: (tileDef: IBrainTileDef) => string
): StripCandidate | undefined {
  const factoryTileDef = findDirectLiteralFactoryOfType(candidates, CoreTypeIds.String);
  if (!factoryTileDef) return undefined;
  const displayFormat = LiteralDisplayFormats.Default;
  const preview = factoryTileDef.manufacture(factoryTileDef, { value, displayFormat });
  if (!preview) return undefined;
  return {
    key: `mint:${preview.tileId}`,
    tileDef: preview,
    label: labelOf(preview),
    group: "literal",
    viaConversion: false,
    origin: { kind: "minted-literal", factoryTileDef, value, displayFormat },
  };
}

/** True when `candidates` already offers the tile `tileId`. */
function offersTile(candidates: readonly StripCandidate[], tileId: string): boolean {
  return candidates.some((candidate) => candidate.tileDef.tileId === tileId);
}

/**
 * True when `filter` is a number the user is partway through typing at a
 * position that accepts one: the next keystroke completes the number, so the
 * text is not yet text that names nothing.
 */
function isNumberInProgress(candidates: readonly StripCandidate[], filter: string): boolean {
  return numberInProgressPattern.test(filter.trim()) && findNumberLiteralFactory(candidates) !== undefined;
}

/**
 * The filter text split into the variable gesture and the text it filters by. A
 * leading `$` declares that the word being typed names a variable; it is an
 * input gesture only and never reaches a placed tile.
 */
export interface StripFilterIntent {
  /** True when the text opened with the `$` accelerator. */
  readonly variableIntent: boolean;
  /** The text the offering is filtered by: the text after `$`, or the whole text. */
  readonly text: string;
}

/** Split `filter` into its {@link StripFilterIntent}. */
export function parseStripFilter(filter: string): StripFilterIntent {
  const trimmed = filter.trim();
  if (!trimmed.startsWith("$")) return { variableIntent: false, text: trimmed };
  return { variableIntent: true, text: trimmed.slice(1).trim() };
}

/** True when `name` names a variable the create-variable path would accept. */
function isMintableVariableName(name: string): boolean {
  return name.trim().length > 0;
}

/** True when the candidate places an existing variable, as opposed to creating one. */
function isExistingVariableCandidate(candidate: StripCandidate): boolean {
  return candidate.tileDef.kind === "variable";
}

/**
 * The variable factories among `candidates`, one per type the armed position
 * accepts, in offering order. A type the oracle offers twice keeps its first
 * factory, and a factory reached only by a conversion carries that on the
 * candidate it was found on.
 */
function acceptedVariableFactories(candidates: readonly StripCandidate[]): StripCandidate[] {
  const byType = new Map<string, StripCandidate>();
  for (const candidate of candidates) {
    const tileDef = candidate.tileDef;
    if (tileDef.kind !== "factory" || !isVariableFactoryTileId(tileDef.tileId)) continue;
    const producedDataType = (tileDef as BrainTileFactoryDef).producedDataType;
    if (!producedDataType || byType.has(producedDataType)) continue;
    byType.set(producedDataType, candidate);
  }
  return [...byType.values()];
}

/**
 * True when `candidates` already offers a variable named `name` of type
 * `varType`. Names compare case-insensitively and are never search-folded, so
 * two names differing only by a diacritic name two variables.
 */
function offersVariable(candidates: readonly StripCandidate[], name: string, varType: string): boolean {
  const needle = name.trim().toLowerCase();
  return candidates.some((candidate) => {
    if (!isExistingVariableCandidate(candidate)) return false;
    const varTileDef = candidate.tileDef as BrainTileVariableDef;
    return varTileDef.varType === varType && varTileDef.varName.trim().toLowerCase() === needle;
  });
}

/**
 * The variable candidates minted from the typed word `name`: one per type the
 * armed position accepts, in the order the position offers those types, so the
 * minted type is always the oracle's own. A type that already holds a variable
 * of this name mints nothing, since that variable is the answer. Each
 * candidate's tile is a preview def manufactured by the factory; committing it
 * re-manufactures through the catalog so the placed tile is registered.
 */
export function mintVariableCandidates(
  candidates: readonly StripCandidate[],
  name: string,
  labelOf: (tileDef: IBrainTileDef) => string
): StripCandidate[] {
  const varName = name.trim();
  if (!isMintableVariableName(varName)) return [];
  const minted: StripCandidate[] = [];
  for (const factory of acceptedVariableFactories(candidates)) {
    const factoryTileDef = factory.tileDef as BrainTileFactoryDef;
    const producedDataType = factoryTileDef.producedDataType as string;
    if (offersVariable(candidates, varName, producedDataType)) continue;
    const preview = factoryTileDef.manufacture(factoryTileDef, { name: varName });
    if (!preview) continue;
    minted.push({
      key: `mint:var:${producedDataType}:${varName}`,
      tileDef: preview,
      label: labelOf(preview),
      group: "variable",
      viaConversion: factory.viaConversion,
      origin: { kind: "minted-variable", factoryTileDef, varName },
    });
  }
  return minted;
}

/**
 * `matches` with `mints` spliced in behind the exact and prefix matches that
 * lead it, so a name that is also the start of an existing variable's name
 * offers that variable first and the new one right after it.
 */
function demoteMintsBehindMatches(
  matches: readonly StripCandidate[],
  mints: readonly StripCandidate[],
  name: string,
  foldText: (text: string) => string
): StripCandidate[] {
  if (mints.length === 0) return [...matches];
  let at = 0;
  while (at < matches.length) {
    const quality = classifyCandidateMatch(name, matches[at], foldText);
    if (quality !== "exact" && quality !== "prefix") break;
    at++;
  }
  return [...matches.slice(0, at), ...mints, ...matches.slice(at)];
}

/** What the strip offers for one filter text over the position's ranked candidates. */
export interface StripOffering {
  /** Every candidate the position offers, minted entries included, before the filter narrows it. */
  readonly offered: readonly StripCandidate[];
  /** The candidates the filter text leaves, best match first, with the minted entries in their ranked place. */
  readonly visible: readonly StripCandidate[];
  /** True when the filter text names nothing the strip can place, as opposed to naming nothing yet. */
  readonly isUnknown: boolean;
}

/**
 * The offering `filter` leaves of the ranked `candidates`, with the candidates
 * the typed text mints merged into it:
 *
 * - typed digits mint a literal, which commits like any other candidate; a
 *   literal the position already offers is that one chip, and the mint adds
 *   nothing to it
 * - a number the user is partway through typing mints no variable and is not
 *   unknown either, since the text has yet to name anything; the candidates it
 *   matches are offered as they always are, so a lone `-` reaches the minus
 *   operator where that operator is valid
 * - a typed word that matches nothing mints a variable per accepted type, which
 *   the unknown state stands alongside because only a tap or a highlighted
 *   chip commits it
 * - text opening with `$` scopes the offering to the existing variables matching
 *   the rest of the text, plus a mint of every accepted type the name is free at
 *
 * `foldText` normalizes the typed text and every candidate text alike, so a word
 * typed without a candidate's diacritics matches it and mints nothing of its
 * own; `$` still mints the typed name, which stays its own variable.
 */
export function resolveStripOffering(
  candidates: readonly StripCandidate[],
  filter: string,
  labelOf: (tileDef: IBrainTileDef) => string,
  foldText: (text: string) => string
): StripOffering {
  const intent = parseStripFilter(filter);
  const numberInProgress = !intent.variableIntent && isNumberInProgress(candidates, intent.text);
  const literalMint = intent.variableIntent ? undefined : mintNumberLiteralCandidate(candidates, intent.text, labelOf);
  const offered =
    literalMint && !offersTile(candidates, literalMint.tileDef.tileId) ? [literalMint, ...candidates] : [...candidates];
  const scope = intent.variableIntent ? offered.filter(isExistingVariableCandidate) : offered;
  const matches = filterStripCandidates(scope, intent.text, foldText);
  const mints =
    !numberInProgress && (intent.variableIntent || matches.length === 0)
      ? mintVariableCandidates(candidates, intent.text, labelOf)
      : [];
  return {
    offered: [...offered, ...mints],
    visible: demoteMintsBehindMatches(matches, mints, intent.text, foldText),
    isUnknown:
      !numberInProgress && !(intent.variableIntent && mints.length > 0) && isUnknownFilterText(matches, filter),
  };
}

/**
 * The layer a candidate's tile is defined at, nearest first:
 *
 * - `application` -- the host application's own platform tiles, plus the tiles
 *   compiled from the active project's TypeScript
 * - `library` -- tiles compiled from an installed library
 * - `core` -- the language's built-in tiles: pages, timeouts, operators,
 *   control flow, and the variable and literal machinery
 */
export type CandidateProvenanceBand = "application" | "library" | "core";

const candidateProvenanceBandOrder: Record<CandidateProvenanceBand, number> = {
  application: 0,
  library: 1,
  core: 2,
};

/** Tile ids of the sensor and actuator tiles core registers for its built-in host actions. */
const coreHostActionTileIds: ReadonlySet<string> = new Set(
  Object.values(CoreHostActions).flatMap((action) => [mkSensorTileId(action.key), mkActuatorTileId(action.key)])
);

/** What {@link candidateProvenanceBand} resolves a tile's defining layer against. */
export interface CandidateProvenanceContext {
  /**
   * Namespace of the active project. Tiles compiled from the project's own
   * TypeScript carry it as their identity namespace. When omitted, no tile is
   * attributed to the project and every namespaced tile bands as `library`.
   */
  readonly projectNamespace?: string;
}

/**
 * The layer `tileDef` is defined at. A tile carrying an identity namespace is
 * compiled code, banded by whether that namespace is the active project's own.
 * A sensor or actuator without one is a core built-in when its tile id is one of
 * core's host actions, and an application platform tile otherwise. Every other
 * tile kind bands as `core`.
 */
export function candidateProvenanceBand(
  tileDef: IBrainTileDef,
  context: CandidateProvenanceContext
): CandidateProvenanceBand {
  const namespace = tileSourceNamespace(tileDef);
  if (namespace !== undefined) {
    return namespace === context.projectNamespace ? "application" : "library";
  }
  if (tileDef.kind === "sensor" || tileDef.kind === "actuator") {
    return coreHostActionTileIds.has(tileDef.tileId) ? "core" : "application";
  }
  return "core";
}

/**
 * Reorders and emphasizes the offering at an armed position. The strip's
 * default is {@link categoryPriorityCandidateRanker}. `provenance` supplies the
 * project identity a ranker needs to band candidates by defining layer; an
 * omitted context bands every namespaced tile as `library`.
 */
export type CandidateRanker = (
  candidates: readonly StripCandidate[],
  target: ArmedTileTarget | null,
  provenance?: CandidateProvenanceContext
) => readonly StripCandidate[];

/** A {@link CandidateRanker} that returns the candidates in oracle order, unchanged. */
export const identityCandidateRanker: CandidateRanker = (candidates) => candidates;

/**
 * The priority tiers {@link categoryPriorityCandidateRanker} orders by, best first:
 *
 * - `leading` -- the group a leading position opens with: sensors on the WHEN
 *   side, actuators on the DO side
 * - `content` -- every other tile that places concrete content, infix
 *   operators included
 * - `factory` -- create-variable factory tiles, which place a tile only after
 *   the new variable is named
 * - `structural` -- bare structure: grouping parens and prefix or postfix
 *   operators, which read as nothing until an operand joins them
 */
type CandidateRankTier = "leading" | "content" | "factory" | "structural";

const candidateRankTierOrder: Record<CandidateRankTier, number> = {
  leading: 0,
  content: 1,
  factory: 2,
  structural: 3,
};

/** True when the tile places bare structure: a grouping paren, or a prefix or postfix operator. */
function isBareStructuralTile(tileDef: IBrainTileDef): boolean {
  if (tileDef.kind === "controlFlow") return true;
  if (tileDef.kind !== "operator") return false;
  const fixity = (tileDef as BrainTileOperatorDef).op.parse.fixity;
  return fixity === "prefix" || fixity === "postfix";
}

/** True when no tile precedes the armed position on its side. */
function isLeadingPosition(target: ArmedTileTarget): boolean {
  if (target.mode !== "append") return (target.tileIndex ?? 0) === 0;
  const tileSet = target.side === RuleSide.When ? target.ruleDef.when() : target.ruleDef.do();
  return tileSet.tiles().size() === 0;
}

/** The group that leads the offering at `target`, or undefined when the position is not a leading one. */
function leadingGroupFor(target: ArmedTileTarget | null): TileCandidateGroup | undefined {
  if (!target || !isLeadingPosition(target)) return undefined;
  return target.side === RuleSide.When ? "sensor" : "actuator";
}

/** The tier `candidate` ranks in, given the group that leads the offering. */
function candidateRankTier(candidate: StripCandidate, leadingGroup: TileCandidateGroup | undefined): CandidateRankTier {
  if (isBareStructuralTile(candidate.tileDef)) return "structural";
  if (candidate.tileDef.kind === "factory" && candidate.group === "variable") return "factory";
  return candidate.group === leadingGroup ? "leading" : "content";
}

/**
 * The strip's default {@link CandidateRanker}: a pure, deterministic ordering
 * by category priority, then by provenance. Sensors lead an empty WHEN side and
 * actuators lead an empty DO side; bare structural tokens and create-variable
 * factories fall behind every concrete content tile. Inside one tier, the
 * nearest defining layer leads: application tiles, then library tiles, then core
 * built-ins. Candidates of one tier and band keep the oracle's relative order.
 */
export const categoryPriorityCandidateRanker: CandidateRanker = (candidates, target, provenance) => {
  const leadingGroup = leadingGroupFor(target);
  const context = provenance ?? {};
  const ranked = candidates.map((candidate, index) => ({
    candidate,
    tier: candidateRankTierOrder[candidateRankTier(candidate, leadingGroup)],
    band: candidateProvenanceBandOrder[candidateProvenanceBand(candidate.tileDef, context)],
    index,
  }));
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.band !== b.band) return a.band - b.band;
    return a.index - b.index;
  });
  return ranked.map((entry) => entry.candidate);
};

/**
 * How a candidate's chip is drawn:
 *
 * - `seated` -- a tile the position already holds, offered as it will be placed
 * - `minting` -- a variable the typed word creates, drawn as the new tile it makes
 */
export type CandidatePresentation = "seated" | "minting";

/** A candidate paired with the presentation its chip renders in. */
export interface CandidateEntry {
  readonly candidate: StripCandidate;
  readonly presentation: CandidatePresentation;
}

/** The presentation `candidate` renders in, keyed by where its tile came from. */
function candidatePresentation(candidate: StripCandidate): CandidatePresentation {
  return candidate.origin.kind === "minted-variable" ? "minting" : "seated";
}

/** Pair each candidate with its presentation, preserving order. */
export function toCandidateEntries(candidates: readonly StripCandidate[]): CandidateEntry[] {
  return candidates.map((candidate) => ({ candidate, presentation: candidatePresentation(candidate) }));
}

/** Heading of the subcategory holding the host application's own tiles. */
const kApplicationSubcategoryHeading = "Application";

/** Heading of the subcategory holding the language's built-in tiles. */
const kCoreSubcategoryHeading = "Core";

/** One provenance cluster of an open accordion section: the chips of a single defining layer. */
export interface CandidateSubcategory {
  /** Stable identity of the cluster within its section. */
  readonly key: string;
  /** The defining layer the cluster holds, as {@link candidateProvenanceBand} resolves it. */
  readonly band: CandidateProvenanceBand;
  /** Heading naming the cluster: an installed library's display name, or the layer's own name. */
  readonly heading: string;
  /** The chips of the cluster: those that fit directly, then those that fit by conversion. */
  readonly entries: readonly CandidateEntry[];
}

/** The entries that fit directly, in input order, followed by those that fit by conversion. */
function directEntriesFirst(entries: readonly CandidateEntry[]): CandidateEntry[] {
  return [
    ...entries.filter((entry) => !entry.candidate.viaConversion),
    ...entries.filter((entry) => entry.candidate.viaConversion),
  ];
}

/**
 * Arrange one section's chips into provenance clusters, in display order: the
 * application's own tiles first, then one cluster per installed library ordered
 * by display name, then the core built-ins. A cluster holds its direct chips in
 * the input order, followed by its via-conversion chips. Only layers with a chip
 * produce a cluster, so a single-provenance section arranges into one cluster
 * and a filtered-out layer disappears. An entry whose namespace names no
 * installed library files under the core cluster.
 */
export function arrangeCandidateSubcategories(
  entries: readonly CandidateEntry[],
  provenance: CandidateProvenanceContext,
  libraries: readonly TileSourceLibrary[] | undefined
): CandidateSubcategory[] {
  const byLibrary = groupTilesByLibrary(entries, (entry) => entry.candidate.tileDef, libraries);
  const application: CandidateEntry[] = [];
  const core: CandidateEntry[] = [];
  for (const entry of byLibrary.unattributed) {
    const band = candidateProvenanceBand(entry.candidate.tileDef, provenance);
    (band === "application" ? application : core).push(entry);
  }
  const clusters: CandidateSubcategory[] = [];
  if (application.length > 0) {
    clusters.push({
      key: "application",
      band: "application",
      heading: kApplicationSubcategoryHeading,
      entries: directEntriesFirst(application),
    });
  }
  for (const cluster of byLibrary.clusters) {
    clusters.push({
      key: `library:${cluster.library.coordinate}`,
      band: "library",
      heading: cluster.library.name,
      entries: directEntriesFirst(cluster.items),
    });
  }
  if (core.length > 0) {
    clusters.push({
      key: "core",
      band: "core",
      heading: kCoreSubcategoryHeading,
      entries: directEntriesFirst(core),
    });
  }
  return clusters;
}

/** Band key of the strip's leading cross-category row of chips. */
export const kBestNextBandKey = "best";

/** One rendered row of candidate chips: the best-next row, or one open accordion section. */
export interface StripOptionBand {
  /** Identity of the band, unique among the bands of one render. */
  readonly key: string;
  /** The command chips the band leads with, before the tiles it offers. */
  readonly commands?: readonly StripCommand[];
  /** The chips the band renders, in display order. */
  readonly entries: readonly CandidateEntry[];
}

/** One rendered chip, addressable by the active-descendant highlight. */
export interface StripOption {
  /** DOM id of the chip element, unique within one strip. */
  readonly optionId: string;
  /** Band the chip renders in. */
  readonly bandKey: string;
  /** Key of what the chip runs: a candidate's, or a command's. */
  readonly candidateKey: string;
}

/**
 * Encode `value` so it is safe in a DOM id: every character outside
 * `[A-Za-z0-9]` becomes an underscore followed by its four-digit hex code
 * point. Distinct inputs always encode to distinct output.
 */
function encodeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, (char) => `_${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** DOM id of the chip that offers `candidateKey` in the band `bandKey` of the strip `stripId`. */
export function stripOptionId(stripId: string, bandKey: string, candidateKey: string): string {
  return `${stripId}-${encodeIdPart(bandKey)}-${encodeIdPart(candidateKey)}`;
}

/**
 * DOM id of the element the band `bandKey` renders its chips into: the
 * `role="listbox"` container while the band shows its chips, and the collapsed
 * placeholder an accordion header points `aria-controls` at while it is closed.
 */
export function stripBandPanelId(stripId: string, bandKey: string): string {
  return `${stripId}-panel-${encodeIdPart(bandKey)}`;
}

/**
 * DOM id of the heading naming the subcategory `subcategoryKey` inside the band
 * `bandKey`, which the subcategory's group points `aria-labelledby` at.
 */
export function stripSubcategoryHeadingId(stripId: string, bandKey: string, subcategoryKey: string): string {
  return `${stripId}-${encodeIdPart(bandKey)}-sub-${encodeIdPart(subcategoryKey)}`;
}

/**
 * DOM id of the accordion heading naming the section `sectionKey`, which the
 * cursor takes the keyboard to when it stands on that heading.
 */
export function stripSectionHeadingId(stripId: string, sectionKey: string): string {
  return `${stripId}-heading-${encodeIdPart(sectionKey)}`;
}

/**
 * Every chip the strip renders, in the order the highlight walks them: the
 * best-next row first, then the chips of each open section in band order. A
 * band's command chips lead its tiles.
 */
export function visibleStripOptions(stripId: string, bands: readonly StripOptionBand[]): StripOption[] {
  const options: StripOption[] = [];
  for (const band of bands) {
    for (const command of band.commands ?? []) {
      options.push({
        optionId: stripOptionId(stripId, band.key, command.key),
        bandKey: band.key,
        candidateKey: command.key,
      });
    }
    for (const entry of band.entries) {
      options.push({
        optionId: stripOptionId(stripId, band.key, entry.candidate.key),
        bandKey: band.key,
        candidateKey: entry.candidate.key,
      });
    }
  }
  return options;
}

/** The option `activeOptionId` addresses, or undefined when no rendered chip carries that id. */
export function activeStripOption(
  options: readonly StripOption[],
  activeOptionId: string | undefined
): StripOption | undefined {
  if (activeOptionId === undefined) return undefined;
  return options.find((option) => option.optionId === activeOptionId);
}

/**
 * The band key of the option `activeOptionId` addresses, or undefined when no
 * rendered chip carries that id.
 */
export function bandOfStripOption(
  options: readonly StripOption[],
  activeOptionId: string | undefined
): string | undefined {
  return activeStripOption(options, activeOptionId)?.bandKey;
}

/**
 * Where the strip's one cursor stands over the offering's grid:
 *
 * - `chip` -- a candidate chip, addressed by the DOM id its band's listbox
 *   points `aria-activedescendant` at
 * - `heading` -- the accordion heading of a section, named by its section key,
 *   which holds the keyboard itself
 */
export type StripCursor =
  | { readonly kind: "chip"; readonly optionId: string }
  | { readonly kind: "heading"; readonly sectionKey: string };

/** The cursor standing on the chip `optionId`. */
function chipCursor(optionId: string): StripCursor {
  return { kind: "chip", optionId };
}

/** True when both cursors stand on the same cell of the grid. */
function sameStripCursor(left: StripCursor, right: StripCursor): boolean {
  if (left.kind === "chip") return right.kind === "chip" && left.optionId === right.optionId;
  return right.kind === "heading" && left.sectionKey === right.sectionKey;
}

/** The chip `cursor` stands on, or undefined when it stands on a heading or nowhere. */
function cursorOptionId(cursor: StripCursor | undefined): string | undefined {
  return cursor?.kind === "chip" ? cursor.optionId : undefined;
}

/**
 * The element the active-descendant highlight is anchored on:
 *
 * - `typing` -- the filter box, which the user is typing into
 * - `browsing` -- the listbox of the band whose chips the user is walking
 */
export type StripHighlightMode = "typing" | "browsing";

/** The element DOM focus belongs on while the cursor rests where it does. */
export type StripFocusTarget =
  | { readonly kind: "input" }
  | { readonly kind: "band"; readonly bandKey: string }
  | { readonly kind: "heading"; readonly sectionKey: string };

const inputFocusTarget: StripFocusTarget = { kind: "input" };

/**
 * Where DOM focus belongs while the cursor stands at `cursor` in `mode`. A
 * cursor on a heading puts focus on that heading. Typing mode otherwise keeps
 * focus in the filter box; browsing mode follows the cursor to the listbox of
 * the band rendering its chip, and falls back to the filter box when the
 * offering no longer renders that chip.
 */
export function decideStripFocusTarget(
  options: readonly StripOption[],
  cursor: StripCursor | undefined,
  mode: StripHighlightMode
): StripFocusTarget {
  if (cursor?.kind === "heading") return { kind: "heading", sectionKey: cursor.sectionKey };
  if (mode === "typing") return inputFocusTarget;
  const bandKey = bandOfStripOption(options, cursorOptionId(cursor));
  return bandKey === undefined ? inputFocusTarget : { kind: "band", bandKey };
}

/**
 * The chip the strip draws as highlighted: the chip `cursor` stands on, and
 * while `cursor` stands on no cell at all the chip offering `leadCandidateKey`.
 * Undefined while the cursor stands on a heading, and whenever no rendered chip
 * carries the id or the candidate key asked for.
 */
export function highlightedStripOption(
  options: readonly StripOption[],
  cursor: StripCursor | undefined,
  leadCandidateKey: string | undefined
): StripOption | undefined {
  if (cursor !== undefined) return cursor.kind === "chip" ? activeStripOption(options, cursor.optionId) : undefined;
  if (leadCandidateKey === undefined) return undefined;
  return options.find((option) => option.candidateKey === leadCandidateKey);
}

/**
 * The cell the highlight rests on while the cursor stands on none: the chip
 * offering `leadCandidateKey`. Undefined when no lead candidate is asked for and
 * whenever no rendered chip offers it.
 */
export function leadStripCursor(
  options: readonly StripOption[],
  leadCandidateKey: string | undefined
): StripCursor | undefined {
  const option = highlightedStripOption(options, undefined, leadCandidateKey);
  return option === undefined ? undefined : chipCursor(option.optionId);
}

/**
 * True when pressing `key` enters or edits the filter text, so the keystroke
 * belongs in the filter box: any single printable character, or Backspace.
 */
export function isStripFilterTypingKey(key: string): boolean {
  return key === "Backspace" || key.length === 1;
}

/**
 * The cursor's step along the rendered chip sequence: `delta` 1 steps toward
 * the end of the offering and -1 toward its start, crossing the visual wraps the
 * chips are drawn in. From a cursor standing on no chip -- nowhere, or on a
 * heading -- stepping forward takes the first chip and stepping back the last.
 * Neither end wraps: a step off the last chip or off the first returns
 * undefined, as does a step where no chip is rendered.
 */
export function moveStripCursorAlongChips(
  options: readonly StripOption[],
  cursor: StripCursor | undefined,
  delta: 1 | -1
): StripCursor | undefined {
  if (options.length === 0) return undefined;
  const optionId = cursorOptionId(cursor);
  const current = options.findIndex((option) => option.optionId === optionId);
  if (current === -1) return chipCursor(delta === 1 ? options[0].optionId : options[options.length - 1].optionId);
  const next = current + delta;
  return next < 0 || next >= options.length ? undefined : chipCursor(options[next].optionId);
}

/** Where one cell of the offering's grid sits, measured from the strip's rendered layout. */
export interface StripCellGeometry {
  /** Where the cursor stands when it lands on this cell. */
  readonly cursor: StripCursor;
  /** Left edge of the cell. */
  readonly left: number;
  /** Rendered width of the cell. */
  readonly width: number;
  /** Top edge of the cell. */
  readonly top: number;
}

/**
 * How far two cells' top edges may differ and still count as the same wrapped
 * row, in the units the geometry is measured in.
 */
const kStripRowTolerance = 8;

/**
 * The cells grouped into the grid's rows, topmost row first and each row
 * ordered left to right. Chips sharing a top edge wrap into one row, and a
 * heading holds a row of its own.
 */
function stripGridRows(geometry: readonly StripCellGeometry[]): StripCellGeometry[][] {
  const ordered = geometry.map((cell, index) => ({ cell, index }));
  ordered.sort((a, b) => (a.cell.top !== b.cell.top ? a.cell.top - b.cell.top : a.index - b.index));
  const rows: StripCellGeometry[][] = [];
  let rowTop = 0;
  for (const entry of ordered) {
    const row = rows[rows.length - 1];
    const joinsRow =
      row !== undefined &&
      entry.cell.top - rowTop <= kStripRowTolerance &&
      entry.cell.cursor.kind === "chip" &&
      row[0].cursor.kind === "chip";
    if (!joinsRow) {
      rows.push([entry.cell]);
      rowTop = entry.cell.top;
      continue;
    }
    row.push(entry.cell);
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left);
  return rows;
}

/** The horizontal center of a measured cell. */
function stripCellCenter(cell: StripCellGeometry): number {
  return cell.left + cell.width / 2;
}

/**
 * The cursor's step between the grid's rows: `delta` 1 steps to the row below
 * and -1 to the row above, taking the cell of that row whose horizontal center
 * is nearest the cursor's own and the leading cell of two equally near ones.
 * Rows are read from `geometry`, so the step crosses band and section
 * boundaries wherever the layout puts one row under another, and it comes to
 * rest on a heading as readily as on a chip. Nothing wraps: a step off either
 * end of the grid returns undefined, as does a step in an empty grid. A cursor
 * standing on no cell of `geometry` stands above the grid, so stepping forward
 * takes its first cell and stepping back leaves nothing.
 */
export function moveStripCursorBetweenRows(
  geometry: readonly StripCellGeometry[],
  cursor: StripCursor | undefined,
  delta: 1 | -1
): StripCursor | undefined {
  if (geometry.length === 0) return undefined;
  const active = cursor === undefined ? undefined : geometry.find((cell) => sameStripCursor(cell.cursor, cursor));
  if (!active) return delta === 1 ? geometry[0].cursor : undefined;
  const rows = stripGridRows(geometry);
  const rowIndex = rows.findIndex((row) => row.some((cell) => sameStripCursor(cell.cursor, active.cursor)));
  const target = rows[rowIndex + delta];
  if (target === undefined) return undefined;
  const center = stripCellCenter(active);
  let nearest = target[0];
  let nearestDistance = Math.abs(stripCellCenter(nearest) - center);
  for (const cell of target) {
    const distance = Math.abs(stripCellCenter(cell) - center);
    if (distance < nearestDistance) {
      nearest = cell;
      nearestDistance = distance;
    }
  }
  return nearest.cursor;
}

/** What Escape does while the strip is open. */
export type StripEscapeAction = "clear-filter" | "dismiss";

/**
 * Escape's action for the given filter text: typed text is cleared first, and
 * a second Escape on empty text closes the strip.
 */
export function decideStripEscape(filter: string): StripEscapeAction {
  return filter.length > 0 ? "clear-filter" : "dismiss";
}
