import { RuleSide } from "@wendoo/core/brain";
import { tileSentenceWord } from "@wendoo/core/brain/language-service";
import type { BrainRuleDef } from "@wendoo/core/brain/model";
import type { BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import type { Localizer } from "@wendoo/core/localization";
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  ChevronDown,
  type LucideIcon,
  Plus,
  Replace,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { staticAssetUrl } from "../asset-url";
import { adjustColor, readableInk, saturateColor } from "../lib/color";
import type { ArmedTileTarget } from "./ArmedTargetContext";
import { resolveTypeDisplayName } from "./action-arg-tiles";
import { useBrainEditorConfig, useLocalizer } from "./BrainEditorContext";
import {
  type CandidateEntry,
  decideStripFocusTarget,
  highlightedStripOption,
  kBestNextBandKey,
  leadStripCandidate,
  leadStripCursor,
  type StripCandidate,
  type StripCellGeometry,
  type StripCursor,
  type StripFocusTarget,
  type StripHighlightMode,
  type StripOptionBand,
  stripBandPanelId,
  stripOptionId,
  stripSectionHeadingId,
  stripSubcategoryHeadingId,
  tileCandidateGroupNames,
  toCandidateEntries,
  visibleStripOptions,
} from "./candidate-strip-model";
import { type CaretPosition, caretRun } from "./caret-run";
import {
  type ComposerInputFacts,
  type ComposerInputState,
  type ComposerInputToken,
  composerHeadingToken,
  composerTokenForKey,
  composerTrayToken,
  consumesKey,
  reduceComposerInput,
} from "./composer-input-model";
import { type EditPointPosition, kEditPointPositions } from "./edit-point";
import { deriveEditorMode, type EditorMode } from "./editor-mode";
import { decideHistoryShortcut } from "./history-shortcut";
import type { CandidateStripSection, CandidateStripState } from "./hooks/useCandidateStrip";
import { kPageGridCellAttribute, pageGridCellKey, type RuleMoveDirection } from "./page-grid-model";
import { kSentenceTypeClasses } from "./sentence-type";
import { type StripCommand, type StripCommandKind, StripCommandKinds } from "./strip-commands";
import { tileSourceNamespace } from "./tile-library-groups";
import { kDefaultTileHue, resolveTileVisual, tileBorderColor } from "./tile-visual-utils";

/** Drag payload format carrying a candidate key from a chip to the armed slot. */
export const kCandidateDragMimeType = "application/x-wendoo-candidate";

/**
 * Attribute marking an element the offering's grid cursor can rest the keyboard
 * on: a band's listbox, or a section's accordion heading.
 */
const kStripCellAttribute = "data-strip-cell";

/**
 * Attribute a popup the strip's own controls open must carry, valued empty:
 * a menu, and a dialog such a menu opens. The keyboard moving into a marked
 * popup counts as staying in the strip, so the offering underneath it stays
 * open and the control the popup was opened from keeps rendering.
 */
export const kStripPopupAttribute = "data-strip-popup";

/** Attribute marking the offering panel itself, valued empty. */
const kStripPanelAttribute = "data-strip-panel";

/**
 * Attribute marking the filter box, valued by where it is read from: `sentence`
 * for the box a rule's sentence line hosts, `tray` for the one the panel stands.
 */
const kStripFilterAttribute = "data-strip-filter";

/** The elements the strip stands, as one selector. */
const kStripElements = `[${kStripFilterAttribute}],[${kStripPanelAttribute}],[${kStripPopupAttribute}]`;

/** Surface the offering panel stands on, a step above the rule cards it holds. */
const stripPanelStyle = {
  background: "var(--color-brain-panel)",
  boxShadow: "inset 0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 24px var(--color-brain-desk-shade)",
};

/** Surface a candidate section stands on, the same fill a rule card carries. */
const sectionCardStyle = {
  background: "linear-gradient(55deg, var(--color-brain-rule-from) 0%, var(--color-brain-rule-to) 100%)",
};

/** Heading of a provenance subcategory: the accordion header's type, one step quieter. */
const subcategoryHeadingClasses = "w-full px-0.5 text-[11px] font-semibold uppercase tracking-wider text-brain-ink/45";

/** Ring drawn around the band whose chips the keyboard is currently walking. */
const browsedBandClasses =
  "rounded-lg focus:outline-none focus:ring-2 focus:ring-brain-accent focus:ring-offset-2 focus:ring-offset-brain-desk-to";

/**
 * Right padding the panel's topmost row keeps, so the close button laid over the
 * panel's corner covers nothing the user can reach.
 */
const kCornerReserveClass = "pr-11";

/**
 * The panel's position row, at least as tall as the tallest control it can hold
 * and kept at that height whichever controls the armed position shows.
 */
const kPositionRowClasses = "flex min-h-12 shrink-0 items-center gap-x-2 gap-y-1";

/**
 * Added to the position row while it stands the armed position's controls: below
 * `sm` the row wraps, standing the caret's place on the line above them, and
 * from `sm` up it holds them all on one line.
 */
const kPositionRowWrapClasses = "flex-wrap sm:flex-nowrap";

/**
 * The caret's place, read as the row's standing text. It asks for a whole line,
 * which a wrapping row gives it and a row holding one line trims back to what
 * the controls leave, never narrowing past its own minimum. It clips what will
 * not fit, so a longer place name moves nothing standing after it.
 */
const kPositionNameClasses =
  "min-w-20 grow basis-full truncate text-xs font-semibold uppercase tracking-wider text-brain-ink/45 sm:basis-0";

/**
 * Context tag the offering's own prose is looked up under, which reads the
 * caret's announcements, the removal control's name, and the filter box's name
 * as the one surface they stand on.
 */
const kOfferingPhraseContext = "tile-offering";

/**
 * What a press inside the offering panel may hand the keyboard to: the panel's
 * own controls, the filter box it stands in its tray row, and the band listboxes
 * the offering's cursor rests on. Everything else the panel draws is chrome.
 */
const kPanelKeyboardTargets = "button, input, [tabindex]";

/** The accordion an open text value shows: none, since only its own chip is offered. */
const noSections: readonly CandidateStripSection[] = [];

/** The commands an open text value offers: none. */
const noCommands: readonly StripCommand[] = [];

/** The run of a strip armed at nothing, which stands on no rule at all. */
const noCaretRun: readonly CaretPosition[] = [];

/**
 * How a reveal moves the view: animated, or in one step for a user who has asked
 * for reduced motion.
 */
function revealBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Scroll the armed position back into view, moving each scrollport as little as
 * it allows, and settle the offering panel `strip` under it. The armed position
 * is the control the page-grid cell `cellKey` names inside the card of rule
 * `ruleId`; a card standing no such control settles on the card instead. A
 * `cellKey` or `ruleId` of undefined arms nothing and moves nothing, as does a
 * `ruleId` the document no longer holds a card for.
 */
function revealArmedPosition(strip: HTMLElement | null, ruleId: string | undefined, cellKey: string | undefined): void {
  if (strip === null || cellKey === undefined || ruleId === undefined) return;
  const card = document.querySelector(`[data-rule-id="${ruleId}"]`);
  if (card === null) return;
  const behavior = revealBehavior();
  strip.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
  const armed = card.querySelector(`[${kPageGridCellAttribute}="${cellKey}"]`);
  (armed ?? card).scrollIntoView({ block: "nearest", inline: "nearest", behavior });
}

/**
 * Scroll the filter box into view, moving each scrollport the least distance
 * that leaves the whole box visible. A box already fully visible moves nothing.
 */
function revealFilterInput(input: HTMLElement | null): void {
  input?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: revealBehavior() });
}

/**
 * The chip bands in display order: the best-next row when it holds a chip or a
 * command, then every section `isOpen` accepts, in section order. The commands
 * lead the best-next row.
 */
function buildStripBands(
  commands: readonly StripCommand[],
  bestNext: readonly CandidateEntry[],
  sections: readonly CandidateStripSection[],
  isOpen: (sectionKey: string) => boolean
): StripOptionBand[] {
  const list: StripOptionBand[] = [];
  if (bestNext.length > 0 || commands.length > 0) {
    list.push({ key: kBestNextBandKey, commands, entries: bestNext });
  }
  for (const section of sections) {
    if (isOpen(section.key)) list.push({ key: section.key, entries: section.entries });
  }
  return list;
}

/**
 * The dialog container the editor's rules stand in, or null while the document
 * holds no page grid. This element takes the keyboard whenever nothing inside
 * the dialog holds it: as the dialog opens, and whenever the element that held
 * it is removed with nothing left to hand the keyboard back to.
 */
function editorDialogRoot(): Element | null {
  return document.querySelector(`[${kPageGridCellAttribute}]`)?.closest("[role='dialog']") ?? null;
}

/**
 * True when the keyboard has landed nowhere: on no element at all, on the
 * document body, or on the editor's own dialog container. Every other element
 * is holding the keyboard, and is left holding it.
 */
export function keyboardIsUnheld(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === editorDialogRoot();
}

/**
 * True when `element` is one of the strip's own: its filter box, anything the
 * offering panel holds, or anything inside a popup one of the panel's controls
 * opened, which a portal puts outside the panel's subtree. Null is nobody's.
 */
export function isCandidateStripElement(element: Element | null): boolean {
  return element !== null && element.closest(kStripElements) !== null;
}

/**
 * True when the keyboard stands on one of the strip's own elements, which is
 * where the strip serves its own keys. Reads the live document, so it answers
 * for whichever strip is armed.
 */
export function keyboardIsInCandidateStrip(): boolean {
  return isCandidateStripElement(document.activeElement);
}

/**
 * DOM id of the element `target` names in the strip `stripId`, or undefined for
 * the filter box, which the strip holds a ref to instead.
 */
function stripFocusTargetId(stripId: string, target: StripFocusTarget): string | undefined {
  if (target.kind === "input") return undefined;
  return target.kind === "band"
    ? stripBandPanelId(stripId, target.bandKey)
    : stripSectionHeadingId(stripId, target.sectionKey);
}

/**
 * The filter box in the place it is read from, with the quote marks an open text
 * value reads between drawn on either side of it. The wrapper and the input's
 * place inside it do not change with `quoteMark`, so a text value opens and
 * closes around the same input element and leaves the line it sits in as it is.
 *
 * @param input the filter box itself
 * @param quoteMark the mark drawn on both sides of the box, or undefined while
 * no text value is open
 * @param inSentence true when the field sits in a rule's sentence line, where it
 * runs inline with the words; false when it sits in the strip's own tray row
 * @param isEmpty true while the box holds no text, which drops the space a
 * sentence field otherwise keeps from the word before it
 */
export function filterFieldWithQuotes(
  input: ReactNode,
  quoteMark: ReactNode | undefined,
  inSentence: boolean,
  isEmpty = false
): ReactElement {
  return (
    <span
      className={
        inSentence ? (isEmpty ? "whitespace-nowrap" : "ml-1 whitespace-nowrap") : "flex min-w-0 flex-1 items-center"
      }
    >
      {quoteMark}
      {input}
      {quoteMark}
    </span>
  );
}

interface CandidateChipProps {
  entry: CandidateEntry;
  side: RuleSide;
  /** DOM id the active-descendant highlight addresses this chip by. */
  optionId: string;
  /** True while the keyboard highlight rests on this chip. */
  isActive: boolean;
  onCommit: (candidate: StripCandidate) => void;
  libraryName?: string;
}

/**
 * One candidate as a word-chip: the tile's icon and its label, with the tile's
 * library attribution and any conversion carried in the accessible name. A
 * minting candidate is drawn as an outline of the variable it creates, named by
 * the typed word and badged with the type the armed position expects.
 */
function CandidateChip({ entry, side, optionId, isActive, onCommit, libraryName }: CandidateChipProps) {
  const editorConfig = useBrainEditorConfig();
  const { candidate } = entry;
  const isMinting = entry.presentation === "minting";
  const visual = resolveTileVisual(editorConfig, candidate.tileDef);
  const baseColor = (side === RuleSide.When ? visual.colorDef?.when : visual.colorDef?.do) || kDefaultTileHue;
  const iconUrl = visual.iconUrl || staticAssetUrl("assets/brain/icons/question_mark.svg");
  const mintedTypeName = isMinting
    ? resolveTypeDisplayName((candidate.tileDef as BrainTileVariableDef).varType, {
        dataTypeNames: editorConfig.dataTypeNames,
        getTypeName: (typeId) => editorConfig.brainServices?.runtime.types.get(typeId)?.name,
      })
    : undefined;
  const description = [
    isMinting
      ? `make ${candidate.label} a new ${mintedTypeName} variable`
      : `${candidate.tileDef.kind} tile: ${candidate.label}`,
    libraryName ? `from ${libraryName}` : undefined,
    candidate.viaConversion ? "fits by converting the value" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  const outlineColor = adjustColor(saturateColor(baseColor, 0.5), 0.2);

  return (
    <button
      type="button"
      role="option"
      id={optionId}
      aria-selected={isActive}
      tabIndex={-1}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(kCandidateDragMimeType, candidate.key);
        event.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => onCommit(candidate)}
      style={{
        background: isMinting ? "color-mix(in srgb, var(--color-brain-ink) 8%, transparent)" : baseColor,
        borderColor: isMinting ? outlineColor : tileBorderColor(baseColor),
        borderStyle: candidate.viaConversion ? "dashed" : "solid",
        color: isMinting ? "var(--color-brain-ink)" : readableInk(baseColor),
      }}
      className={`inline-flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-full border-2 px-3 py-1.5 shadow-sm transition-[filter,transform] hover:brightness-110 active:scale-95 ${
        candidate.viaConversion ? "opacity-80" : ""
      } ${isActive ? "ring-2 ring-brain-ink ring-offset-2 ring-offset-brain-desk-to brightness-110" : ""}`}
      aria-label={description}
      data-presentation={entry.presentation}
      data-candidate-key={candidate.key}
      data-via-conversion={candidate.viaConversion ? "true" : undefined}
    >
      {isMinting ? (
        <Plus className="h-5 w-5 shrink-0" style={{ color: outlineColor }} aria-hidden="true" />
      ) : (
        <img src={iconUrl} alt="" aria-hidden="true" className="h-6 w-6 shrink-0 object-contain" />
      )}
      <span className="truncate font-mono text-sm font-semibold">{candidate.label}</span>
      {isMinting && (
        <span
          aria-hidden="true"
          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: "color-mix(in srgb, var(--color-brain-ink) 14%, transparent)", color: outlineColor }}
        >
          {mintedTypeName}
        </span>
      )}
    </button>
  );
}

/** How each command chip reads to assistive technology. */
const stripCommandNames: Record<StripCommandKind, string> = {
  [StripCommandKinds.Edit]: "edit this value",
  [StripCommandKinds.Duplicate]: "duplicate this value",
};

/** The word each command chip carries. */
const stripCommandWords: Record<StripCommandKind, string> = {
  [StripCommandKinds.Edit]: "edit",
  [StripCommandKinds.Duplicate]: "duplicate",
};

/** The glyph each command chip carries: a pencil for editing, stacked sheets for duplicating. */
function StripCommandIcon({ kind }: { kind: StripCommandKind }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === StripCommandKinds.Edit ? (
        <path d="M11.5 2.5 L13.5 4.5 L5.5 12.5 L2.8 13.2 L3.5 10.5 Z" />
      ) : (
        <>
          <rect x="5" y="5" width="9" height="9" rx="1.5" />
          <path d="M11 3 H4 A1.5 1.5 0 0 0 2.5 4.5 V11.5" />
        </>
      )}
    </svg>
  );
}

interface CommandChipProps {
  command: StripCommand;
  /** DOM id the active-descendant highlight addresses this chip by. */
  optionId: string;
  /** True while the keyboard highlight rests on this chip. */
  isActive: boolean;
  onRun: (command: StripCommand) => void;
}

/**
 * One command as a chip leading the offering: the command's glyph and its word,
 * drawn in the app's secondary fill.
 */
function CommandChip({ command, optionId, isActive, onRun }: CommandChipProps) {
  return (
    <button
      type="button"
      role="option"
      id={optionId}
      aria-selected={isActive}
      aria-label={stripCommandNames[command.kind]}
      tabIndex={-1}
      onClick={() => onRun(command)}
      data-strip-command={command.kind}
      className={`inline-flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-full border-2 border-secondary-foreground/20 bg-secondary px-3 py-1.5 text-secondary-foreground shadow-sm transition-[filter,transform] hover:brightness-110 active:scale-95 ${
        isActive ? "ring-2 ring-brain-ink ring-offset-2 ring-offset-brain-desk-to brightness-110" : ""
      }`}
    >
      <StripCommandIcon kind={command.kind} />
      <span className="truncate font-mono text-sm font-semibold">{stripCommandWords[command.kind]}</span>
    </button>
  );
}

/**
 * What composing in a rule's sentence line needs: the rule being composed, the
 * caret the composition stands at, the sentence-only key behaviours, and the
 * arming its words and carets take. Supplied for a target armed from the
 * sentence, which hands the filter input to the rule's sentence line; a target
 * armed from a `+` button or a placed tile leaves the input in the panel's own
 * tray row.
 */
export interface StripComposerBinding {
  /** The caret the composition stands at, which the input reads its place from. */
  readonly caretPosition: CaretPosition;
  /** True while composition sits on the DO side of a typed pivot. */
  readonly pivoted: boolean;
  /** True when the tiles of the armed side may end as they stand. Read after each placement. */
  canEndArmedSide(): boolean;
  /** True when the rule holds no tiles on either side. */
  isRuleEmpty(): boolean;
  /** How many tiles the rule's DO side holds. */
  doTileCount(): number;
  /**
   * The element this composition's own newest placement stands at, while that
   * placement is still the history's newest undoable entry; undefined otherwise.
   * Read after each placement.
   */
  ownNewestPlacement(): CaretPosition | undefined;
  /** Undo the composition's own last commit, removing the tile it placed. */
  undoOwnLastCommit(): void;
  /** Put an empty rule after the composed rule and carry composing on in it. */
  insertRuleAfter(): void;
}

/**
 * The edits the strip makes to the rule it is armed on. Supplied for every
 * target armed on a position of that rule, whether or not the rule is being
 * composed; a strip given none of it edits nothing.
 */
export interface StripRuleBinding {
  /**
   * Move editing to `position`, which re-queries the offering there and leaves
   * it on the surface the arming began on: a position armed from the sentence
   * carries on being composed there, and one armed from the tile row keeps the
   * filter box in the offering's own tray row.
   */
  placeCaret(position: CaretPosition): void;
  /** Remove the tile the element `position` stands at. */
  deleteTile(position: CaretPosition): void;
  /**
   * Take the armed rule one step in `direction`, leaving it where it stands when
   * the page refuses that step. The arming, the caret, and the word in progress
   * are untouched.
   */
  moveRule(direction: RuleMoveDirection): void;
  /**
   * Key of the page-grid cell the keyboard returns to once the arming ends: the
   * cell the caret came to rest at for a composed rule, and the cell the page's
   * selection rests on for every other arming, which after a removal is the cell
   * standing in the place the removed tile vacated. Called on every render of
   * the armed rule.
   */
  exitCellKey(): string;
}

/**
 * The tile the armed position stands on: the element `target` replaces, and
 * undefined where the position addresses no placed tile -- a position standing
 * in a gap, and one whose tile index is past the end of its side.
 */
function armedElement(target: ArmedTileTarget | null): CaretPosition | undefined {
  if (target === null || target.mode !== "replace" || target.tileIndex === undefined) return undefined;
  if (target.tileIndex >= target.ruleDef.side(target.side).tiles().size()) return undefined;
  return { kind: "element", side: target.side, tileIndex: target.tileIndex };
}

/**
 * Key of the page-grid cell standing at the position the armed `target`
 * addresses: the tile a position resting on or before a tile stands at, and the
 * side's add-tile control for a position past that side's last tile. Undefined
 * while nothing is armed.
 */
function armedCaretCellKey(target: ArmedTileTarget | null): string | undefined {
  const position = armedCaretPosition(target);
  if (target === null || position === undefined) return undefined;
  const ruleId = target.ruleDef.ruleId();
  const tileCount = target.ruleDef.side(position.side).tiles().size();
  return pageGridCellKey(
    position.tileIndex < tileCount
      ? { kind: "tile", ruleId, side: position.side, tileIndex: position.tileIndex }
      : { kind: "append", ruleId, side: position.side }
  );
}

/**
 * The position the armed `target` addresses, read as a caret: the caret a target
 * armed from the sentence carries, and otherwise the element or gap the tray's
 * arming stands at. Undefined while nothing is armed.
 */
function armedCaretPosition(target: ArmedTileTarget | null): CaretPosition | undefined {
  if (target === null) return undefined;
  if (target.caret !== undefined) return target.caret;
  if (target.mode !== "append" && target.tileIndex !== undefined) {
    return { kind: target.mode === "replace" ? "element" : "gap", side: target.side, tileIndex: target.tileIndex };
  }
  return { kind: "gap", side: target.side, tileIndex: target.ruleDef.side(target.side).tiles().size() };
}

/**
 * How the caret's place reads: what typing there does, named against the tile
 * the caret rests on or stands next to. A caret on a tile replaces it, a caret
 * with a tile after it inserts before that tile, and a caret past the last tile
 * of its side inserts after that tile. A caret on a side holding no tiles has no
 * tile to name itself against, and reads as the first word it will place.
 */
function caretPositionName(position: CaretPosition, ruleDef: BrainRuleDef, localizer: Localizer): string {
  const tiles = ruleDef.side(position.side).tiles();
  const count = tiles.size();
  if (position.tileIndex < count) {
    const word = tileSentenceWord(tiles.get(position.tileIndex), localizer);
    const source = position.kind === "element" ? "replacing {word}" : "inserting before {word}";
    return localizer.tr(source, { word }, kOfferingPhraseContext);
  }
  if (count > 0) {
    const word = tileSentenceWord(tiles.get(count - 1), localizer);
    return localizer.tr("inserting after {word}", { word }, kOfferingPhraseContext);
  }
  return localizer.tr("inserting first", undefined, kOfferingPhraseContext);
}

/**
 * The pivot a strip shows for an edit point opened on a placed tile: which of
 * the tile's three positions the offering is being asked for, and how to ask
 * for another.
 */
export interface StripEditPointBinding {
  /** The position the edit point stands at. */
  readonly position: EditPointPosition;
  /** Arm the edit point at `position`, which re-queries the offering there. */
  arm(position: EditPointPosition): void;
  /**
   * The control opening the menu of the tile the edit point stands on, which
   * the position row stands at its end. A tile whose menu offers nothing
   * supplies none.
   */
  readonly menu: ReactNode;
}

/**
 * How each pivot position reads: the word the strip's header stands where it
 * fits, and the control's accessible name wherever the header shows a glyph in
 * the word's place.
 */
const editPointPivotLabels: Record<EditPointPosition, string> = {
  before: "insert before",
  replace: "replace",
  after: "insert after",
};

/**
 * The glyph each pivot position carries in the narrow header, drawn relative to
 * the tile the edit point stands on: an arrow leaving that tile to the side the
 * new tile lands on, and the replacement mark for taking its place.
 */
const editPointPivotIcons: Record<EditPointPosition, LucideIcon> = {
  before: ArrowLeftFromLine,
  replace: Replace,
  after: ArrowRightFromLine,
};

/** What {@link useCandidateStripSurface} builds its surface from. */
export interface CandidateStripSurfaceOptions {
  /** The offering and commit surface for the armed position. */
  state: CandidateStripState;
  /** The armed target the offering was resolved for; its side selects the chip colors. Null arms nothing. */
  target: ArmedTileTarget | null;
  /** DOM id of the offering panel, so the arming control can point `aria-controls` at it. */
  id?: string;
  /** Called when the user dismisses the strip without placing a tile. */
  onDismiss: () => void;
  /** Hands the filter input to the rule's sentence line, at the caret it carries. */
  composer?: StripComposerBinding;
  /** The edits the strip makes to the rule the armed position stands on. */
  rule?: StripRuleBinding;
  /** The position pivot, for a target armed on a placed tile. */
  editPoint?: StripEditPointBinding;
}

/** The two pieces of the candidate strip, each rendered where the rule card puts it. */
export interface CandidateStripSurface {
  /**
   * The filter input for the rule's sentence line to host, at the caret the
   * composer names. Undefined without a {@link StripComposerBinding}, which
   * leaves the input in the panel's own tray row.
   */
  readonly composerInput: ReactNode | undefined;
  /** True while the input holds text the caret's position will take. */
  readonly pending: boolean;
  /**
   * How many times the keyboard has come back to the sentence from the
   * offering. Every new value is one return, which the line flashes the caret's
   * place for; the count itself carries no meaning.
   */
  readonly landingCount: number;
  /** The offering panel, or null while the offering is closed. */
  readonly panel: ReactNode;
  /**
   * The context this arming stands the keyboard in. Undefined while nothing is
   * armed, which is the page's mode to report.
   */
  readonly mode: EditorMode | undefined;
}

/**
 * The candidate strip: the tiles valid at the armed position, offered as
 * word-chips that commit on tap, with a filter box that commits the top match on
 * Enter and an exact or unique-prefix match on Space. Filter text that
 * matches no candidate is shown as unknown and cannot commit; where the position
 * accepts a variable, that text also offers a chip per accepted type that mints
 * the variable, placed by tap or by highlighting it. Text opening with `$` names
 * a variable outright: the offering scopes to the variables matching the rest of
 * the text plus the mint, which the commit keys then place.
 *
 * Returns the two pieces the rule card places: the filter input its sentence line
 * hosts, and the offering panel, which stands while `state.offeringOpen` and is
 * null otherwise. A null `target` arms nothing and yields neither.
 *
 * A position the armed side offers no tile at stands no panel: none opens there,
 * and one standing closes as soon as a placement or a move of the caret leaves
 * the position offering nothing. A position armed from the tray is disarmed with
 * it, since the panel is all the tray stands; one armed from the sentence keeps
 * its box and its caret, which still deletes and still takes typed text.
 *
 * Where the position accepts a text literal, a double quote opens a text value:
 * the filter box holds the value between rendered quotes, the offering narrows to
 * the one chip that places it, and the closing quote, Enter, or a tap on that
 * chip places it. While the value is open every typed character is content,
 * Backspace edits it and leaves the value once it is empty, and Escape abandons
 * it.
 *
 * Where the position pivot stands, the panel also offers the removal of the tile
 * the armed position stands on, which takes that tile out in one undoable step
 * and leaves editing in the gap it vacated, as deleting it from the keyboard
 * does, and the control opening that tile's own menu. A position armed at a
 * caret in the rule's sentence offers no removal, and neither does one standing
 * on no placed tile. Delete takes the same tile out from the keyboard, for as
 * long as the tray's filter box stands closed.
 *
 * In the tray the panel opens on its chips: the filter box holds the keyboard
 * but is not shown until the position row's search control shows it, or until
 * something is typed into it, which shows it in narrowing the offering. A box
 * out of sight asks for no on-screen keyboard, so arming by touch offers chips
 * to tap with nothing laid over them, while a physical keyboard types into it
 * either way.
 *
 * The filter box is an ARIA combobox over the rendered chips: the arrow keys
 * walk one cursor across the offering, Enter commits the chip it stands on, and
 * Escape clears typed text before closing the strip. Before any arrow key the
 * highlight rests on the first chip a commit key may place, which is the
 * offering's leading chip while nothing is typed and the best match once text
 * narrows it, so what Enter places is always the chip drawn as selected. The
 * offering is one grid of
 * rows -- the chips as they wrap, and a group heading between one section and
 * the next. Up and down step between those rows, taking the cell nearest the
 * cursor's own center, and neither end wraps: up from the first row leaves the
 * offering for the sentence, flashing the caret's place there, and down from the
 * last stands where it is. Left and
 * right step along the chips once the cursor stands on one, stopping at the last
 * chip and at the first. Until then they belong to the caret, save in the tray,
 * which stands at none: there they step from the chip already highlighted, so
 * one press moves that highlight along its row. On a group heading
 * they open and close that group instead: right opens it, left closes it, and a
 * closed group draws no chip, so the row below its heading is the next heading.
 *
 * The cursor is anchored on whichever element holds the keyboard: the filter
 * box while typing narrows the offering, the band's own listbox while its chips
 * are browsed, and a heading itself. Typing or committing hands the keyboard
 * back to the filter box. The cursor lasts as long as the keyboard stays on the
 * element it is anchored on: the keyboard leaving the offering, and the offering
 * closing, both release it, and left and right are the caret's again. The chips
 * are reached by the arrow keys rather than by Tab, which moves on past them;
 * the keyboard leaving the strip altogether closes the offering behind it.
 *
 * With a {@link StripComposerBinding} the same input renders inside the rule's
 * sentence line, where the caret the binding carries is what the keyboard edits
 * at. Left and Right step it one position along the rule's run and Home and End
 * take that run's ends; a text cursor standing inside typed text keeps the key
 * for itself. Left off the start of typed text abandons it and steps back, while
 * Right off its end places it exactly as Space would and comes to rest past the
 * tile placed, refusing the key where that text names nothing to place. Four
 * more keys apply as well. A comma places the word in progress as Space would
 * and then moves composition to the DO side, from any point the WHEN expression
 * may end at; where it may not, or where the word in progress resolves to
 * nothing, the comma does nothing. A period places the word in progress the same
 * way and then ends composition on the rule, from any point the armed side may
 * end at, closing the strip and leaving the sentence to read itself; it places
 * no tile of its own, and Enter ends composition on those same terms wherever
 * the offering leaves no chip highlighted for it to place. Backspace with no
 * word in progress takes back the comma, and then
 * deletes the tile the caret rests on or stands behind, as Delete deletes the
 * one it stands in front of.
 */
export function useCandidateStripSurface({
  state,
  target,
  id,
  onDismiss,
  composer,
  rule,
  editPoint,
}: CandidateStripSurfaceOptions): CandidateStripSurface {
  const side = target?.side ?? RuleSide.When;
  const armedRule = target?.ruleDef;
  const armedTile = armedElement(target);
  const armedCellKey = armedCaretCellKey(target);
  const editorConfig = useBrainEditorConfig();
  const localizer = useLocalizer();
  const inputRef = useRef<HTMLInputElement>(null);
  // True when the filter box held the keyboard as its element was detached.
  const inputHeldKeyboard = useRef(false);
  const containerRef = useRef<HTMLElement>(null);

  /**
   * Holds the filter box's element, and keeps the keyboard on the box across a
   * render that stands a new element in its place: the box moves along the
   * sentence line with the caret, and the element it is rebuilt as takes the
   * keyboard back within that same commit, so the keyboard is never left
   * standing on the document for anything else to pick up.
   *
   * A box that did not hold the keyboard, and a keyboard some other element has
   * since taken, are both left alone.
   */
  const bindInput = useCallback((element: HTMLInputElement | null) => {
    if (element === null) {
      inputHeldKeyboard.current = document.activeElement === inputRef.current;
      inputRef.current = null;
      return;
    }
    inputRef.current = element;
    if (inputHeldKeyboard.current && document.activeElement === document.body) {
      element.focus({ preventScroll: true });
    }
    inputHeldKeyboard.current = false;
  }, []);
  const generatedId = useId();
  const stripId = id ?? generatedId;
  const candidatesId = `${stripId}-candidates`;
  const statusId = `${stripId}-status`;
  const unknownId = `${stripId}-unknown`;
  const hintId = `${stripId}-hint`;
  const filterId = `${stripId}-filter`;
  const [openSectionKey, setOpenSectionKey] = useState<string | null>(null);
  const [cursor, setCursor] = useState<StripCursor | undefined>(undefined);
  const [highlightMode, setHighlightMode] = useState<StripHighlightMode>("typing");
  const [status, setStatus] = useState("");
  const [commitTick, setCommitTick] = useState(0);
  const [landingCount, setLandingCount] = useState(0);
  const [openTextLiteral, setOpenTextLiteral] = useState<string | undefined>(undefined);
  // Whether the tray row stands its filter box open. The box is always
  // rendered and always holds the keyboard, so typing narrows the offering
  // whether or not the box is shown; this is what shows it.
  const [trayFilterOpen, setTrayFilterOpen] = useState(false);
  const placedLabelRef = useRef<string | null>(null);
  // The token a `reask` effect asked for, waiting for the render that carries
  // everything asked for before it.
  const reaskRef = useRef<ComposerInputToken | undefined>(undefined);
  const isFiltering = state.filter.trim().length > 0;
  const offeringOpen = state.offeringOpen;
  // Whether the filter box stands shown: the sentence hosts its box at the
  // caret, and the tray shows its own once the search control or typing opens
  // it.
  const boxIsShown = composer !== undefined || trayFilterOpen;
  // The context the keyboard stands in while this strip is armed.
  const armingMode: EditorMode = deriveEditorMode({
    arming: {
      entry: composer ? "sentence" : "tray",
      boxIsShown,
      textLiteralIsOpen: openTextLiteral !== undefined,
    },
  });
  // The mode this surface reports, undefined while nothing is armed.
  const mode: EditorMode | undefined = target === null ? undefined : armingMode;

  // A text value in progress is the whole offering: the one chip that places it.
  const pendingTextCandidate = useMemo(
    () => (openTextLiteral === undefined ? undefined : state.textLiteralCandidate(openTextLiteral)),
    [openTextLiteral, state]
  );
  const pendingTextEntries = useMemo(
    () => (pendingTextCandidate ? toCandidateEntries([pendingTextCandidate]) : []),
    [pendingTextCandidate]
  );
  const shownBestNext = openTextLiteral === undefined ? state.bestNext : pendingTextEntries;
  const shownSections = openTextLiteral === undefined ? state.sections : noSections;
  const shownCommands = openTextLiteral === undefined ? state.commands : noCommands;

  // The filter box takes the keyboard for every position the strip is armed at,
  // not only the first: a menu re-arming an open strip must move the keyboard
  // with the offering. The move waits a frame, so a menu handing focus back to
  // its trigger as it closes does not take it away again. Taking focus never
  // scrolls; the reveal effect below settles the view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: target is an intentional trigger signal
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [target]);

  // The tray's filter box stands closed as each arming begins, and keeps
  // whatever state the user left it in for as long as that arming lasts,
  // however many positions it moves between.
  useEffect(() => {
    if (target === null) setTrayFilterOpen(false);
  }, [target]);

  /** Show or hide the tray's filter box, leaving the keyboard in it either way. */
  const toggleTrayFilter = () => {
    setTrayFilterOpen((open) => !open);
    inputRef.current?.focus({ preventScroll: true });
  };

  // The cell the arming returns the keyboard to, as of the last render of the
  // armed rule.
  const exitCellKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    exitCellKeyRef.current = rule?.exitCellKey();
  });

  // The element a press has already picked out to take the keyboard, as named by
  // the blur that closed the strip. The closing reads it and puts it back to
  // null, so it stands for no longer than the one closing it was named for.
  const pickedUpKeyboardRef = useRef<HTMLElement | null>(null);

  // The keyboard comes back when the strip closes while nothing else holds it.
  // A keyboard some other element already holds -- the one Tab moved on to,
  // another rule's arming control -- is left where it is, and a press that has
  // already picked a cell of the page's selection grid out takes it there. The
  // arming otherwise takes it to its own exit cell: the cell a composed rule's
  // caret came to rest at, and the cell the page's selection rests on for every
  // other arming, which after a removal is the place the tile vacated. A cell
  // the page no longer stands leaves it to the control read as the rule became
  // armed, and a control the placement took away -- the add-tile button of a
  // side nothing may follow any more -- hands the keyboard to its rule's handle,
  // which every rule stands.
  const isArmed = target !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the armed rule is read once, as the strip becomes armed
  useEffect(() => {
    if (!isArmed) return;
    const armingControl = document.activeElement as HTMLElement | null;
    const armedRuleId = target?.ruleDef.ruleId();
    return () => {
      const pickedUp = pickedUpKeyboardRef.current;
      pickedUpKeyboardRef.current = null;
      if (!keyboardIsUnheld()) return;
      if (pickedUp?.isConnected === true) {
        pickedUp.focus({ preventScroll: true });
        return;
      }
      const exitCellKey = exitCellKeyRef.current;
      const exitCell =
        exitCellKey === undefined
          ? null
          : document.querySelector<HTMLElement>(`[${kPageGridCellAttribute}="${exitCellKey}"]`);
      if (exitCell !== null) {
        exitCell.focus({ preventScroll: true });
        return;
      }
      if (armingControl?.isConnected) {
        armingControl.focus({ preventScroll: true });
        return;
      }
      document.querySelector<HTMLElement>(`[data-rule-handle="${armedRuleId}"]`)?.focus({ preventScroll: true });
    };
  }, [isArmed]);

  // The offering appearing brings the filter box into view, which the panel can
  // open below the fold of. Its appearance is the whole trigger: nothing the box
  // goes on to show -- text typed into it, the caret moving, the panel changing
  // height as candidates are filtered -- brings the box into view again.
  useEffect(() => {
    if (!offeringOpen) return;
    revealFilterInput(inputRef.current);
  }, [offeringOpen]);

  // Every placement lays the rule out again, after which the position now armed
  // is brought back into view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: commitTick is an intentional trigger signal
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      revealArmedPosition(containerRef.current, armedRule?.ruleId(), armedCellKey)
    );
    return () => cancelAnimationFrame(frame);
  }, [commitTick]);

  const libraryNames = useMemo(
    () => new Map((editorConfig.libraries ?? []).map((library) => [library.coordinate, library.name])),
    [editorConfig.libraries]
  );
  const libraryNameFor = (candidate: StripCandidate) => {
    const namespace = tileSourceNamespace(candidate.tileDef);
    return namespace !== undefined ? libraryNames.get(namespace) : undefined;
  };

  // Filtering opens every group that still has a match; otherwise one group at a time.
  const openSectionKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const section of shownSections) {
      if (isFiltering ? section.entries.length > 0 : openSectionKey === section.key) keys.add(section.key);
    }
    return keys;
  }, [shownSections, isFiltering, openSectionKey]);

  const bands = useMemo(
    () => buildStripBands(shownCommands, shownBestNext, shownSections, (key) => openSectionKeys.has(key)),
    [shownCommands, shownBestNext, shownSections, openSectionKeys]
  );

  const options = useMemo(() => visibleStripOptions(stripId, bands), [stripId, bands]);
  const leadCandidateKey = useMemo(
    () =>
      leadStripCandidate(
        shownBestNext.map((entry) => entry.candidate),
        state.filter
      )?.key,
    [shownBestNext, state.filter]
  );
  const activeOption = highlightedStripOption(options, cursor, leadCandidateKey);
  const candidatesByKey = useMemo(() => {
    const map = new Map<string, StripCandidate>();
    for (const band of bands) {
      for (const entry of band.entries) map.set(entry.candidate.key, entry.candidate);
    }
    return map;
  }, [bands]);
  const commandsByKey = useMemo(() => {
    const map = new Map<string, StripCommand>();
    for (const command of shownCommands) map.set(command.key, command);
    return map;
  }, [shownCommands]);
  const matchCount = useMemo(
    () =>
      openTextLiteral === undefined
        ? shownSections.reduce((total, section) => total + section.entries.length, 0)
        : pendingTextEntries.length,
    [openTextLiteral, shownSections, pendingTextEntries]
  );

  // The chip the highlight rests on is brought into view, moving the rules list
  // as little as it allows. A chip already fully visible moves nothing.
  useEffect(() => {
    if (!activeOption) return;
    document.getElementById(activeOption.optionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOption]);

  const focusTarget = useMemo(
    () => decideStripFocusTarget(options, cursor, highlightMode),
    [options, cursor, highlightMode]
  );

  // Browsing keeps focus on the cell being walked, which an accordion header
  // renders only on the render after its arrow key. A band that stops rendering
  // the highlighted chip hands the keyboard back to the filter box. A band
  // listbox takes the keyboard without moving the view, the chip highlighted
  // inside it being what the step reveals; a heading, which is itself the cell
  // being walked, is revealed as it takes the keyboard.
  useEffect(() => {
    const cellId = stripFocusTargetId(stripId, focusTarget);
    if (cellId === undefined) {
      if (highlightMode !== "browsing") return;
      setHighlightMode("typing");
      inputRef.current?.focus();
      return;
    }
    const cell = document.getElementById(cellId);
    if (cell && document.activeElement !== cell) cell.focus({ preventScroll: focusTarget.kind === "band" });
  }, [focusTarget, highlightMode, stripId]);

  // The filter text and the commit tick drive the announcement even when the
  // offering itself is unchanged.
  // biome-ignore lint/correctness/useExhaustiveDependencies: state.filter and commitTick are intentional trigger signals
  useEffect(() => {
    if (!isArmed) return;
    const placed = placedLabelRef.current;
    placedLabelRef.current = null;
    if (placed !== null) {
      setStatus(`${placed} placed`);
      return;
    }
    setStatus(state.isUnknown ? "no tiles fit" : `${matchCount} ${matchCount === 1 ? "tile" : "tiles"}`);
  }, [isArmed, state.filter, state.isUnknown, matchCount, commitTick]);

  /**
   * Where every cell of the offering's grid sits right now, in viewport
   * coordinates and in reading order: the best-next chips, then each section's
   * heading followed by the chips it heads while it is open. A section the
   * filter leaves empty offers no cell, since its heading cannot be reached.
   */
  const measureCells = (): StripCellGeometry[] => {
    const measured: StripCellGeometry[] = [];
    const measure = (cellCursor: StripCursor, elementId: string) => {
      const element = document.getElementById(elementId);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      measured.push({ cursor: cellCursor, left: rect.left, width: rect.width, top: rect.top });
    };
    const measureChips = (bandKey: string, entries: readonly CandidateEntry[]) => {
      for (const entry of entries) {
        const optionId = stripOptionId(stripId, bandKey, entry.candidate.key);
        measure({ kind: "chip", optionId }, optionId);
      }
    };
    for (const command of shownCommands) {
      const optionId = stripOptionId(stripId, kBestNextBandKey, command.key);
      measure({ kind: "chip", optionId }, optionId);
    }
    measureChips(kBestNextBandKey, shownBestNext);
    for (const section of shownSections) {
      if (section.entries.length === 0) continue;
      measure({ kind: "heading", sectionKey: section.key }, stripSectionHeadingId(stripId, section.key));
      if (openSectionKeys.has(section.key)) measureChips(section.key, section.entries);
    }
    return measured;
  };

  const composerState = (): ComposerInputState => ({
    caret: composer?.caretPosition,
    armedSide: side,
    armedEntry: composer ? "sentence" : "tray",
    filter: state.filter,
    cursor,
    highlightMode,
    pivoted: composer?.pivoted ?? false,
    textLiteral: openTextLiteral,
  });

  // Every fact is read on demand: a token that asks nothing of the document
  // reads nothing of it.
  const composerFacts = (): ComposerInputFacts => ({
    mode: armingMode,
    get caretRun() {
      return armedRule === undefined ? noCaretRun : caretRun(armedRule);
    },
    get textCursor() {
      const input = inputRef.current;
      const start = input?.selectionStart ?? 0;
      return { start, end: input?.selectionEnd ?? start };
    },
    get armedSideCanEnd() {
      return composer?.canEndArmedSide() ?? false;
    },
    positionOffersTile: offeringOpen,
    get ruleIsEmpty() {
      return composer?.isRuleEmpty() ?? true;
    },
    get doTileCount() {
      return composer?.doTileCount() ?? 0;
    },
    get ownNewestPlacement() {
      return composer?.ownNewestPlacement();
    },
    get topCandidate() {
      return state.candidateFromKey("enter");
    },
    get spaceCandidate() {
      return state.candidateFromKey("space");
    },
    get highlightedCandidate() {
      return activeOption ? candidatesByKey.get(activeOption.candidateKey) : undefined;
    },
    get highlightedCommand() {
      return activeOption ? commandsByKey.get(activeOption.candidateKey) : undefined;
    },
    get leadCursor() {
      return leadStripCursor(options, leadCandidateKey);
    },
    acceptsTextLiteral: state.acceptsTextLiteral,
    pendingTextLiteral: pendingTextCandidate,
    options,
    get cellGeometry() {
      return measureCells();
    },
  });

  /**
   * Interpret one input through the composer's model and carry out what it asks
   * for, in the order it asks. True when the keystroke was consumed.
   */
  const dispatchInput = (token: ComposerInputToken | undefined, event?: KeyboardEvent<HTMLElement>): boolean => {
    if (token === undefined) return false;
    const { effects } = reduceComposerInput(composerState(), token, composerFacts());
    for (const effect of effects) {
      switch (effect.kind) {
        case "consume-key":
          event?.preventDefault();
          break;
        // Text given to the box shows it, so the tray's box opens for the
        // character that starts a word and for the quote that opens a value.
        case "set-filter":
          state.setFilter(effect.text);
          if (effect.text.length > 0) setTrayFilterOpen(true);
          break;
        case "set-text-literal":
          setOpenTextLiteral(effect.value);
          if (effect.value !== undefined) setTrayFilterOpen(true);
          break;
        case "highlight":
          setCursor(effect.cursor);
          setHighlightMode(effect.mode);
          break;
        case "open-section":
          setOpenSectionKey(effect.sectionKey);
          break;
        case "close-section":
          setOpenSectionKey((current) => (current === effect.sectionKey ? null : current));
          break;
        case "place-tile":
          state.commit(effect.candidate);
          break;
        case "run-command":
          state.runCommand(effect.command);
          break;
        case "announce-placement":
          placedLabelRef.current = effect.label;
          setCommitTick((tick) => tick + 1);
          break;
        case "move-focus": {
          const cellId = stripFocusTargetId(stripId, effect.target);
          if (cellId === undefined) inputRef.current?.focus(effect.keepScroll ? { preventScroll: true } : undefined);
          else document.getElementById(cellId)?.focus();
          break;
        }
        case "reask":
          reaskRef.current = effect.token;
          break;
        case "move-caret":
          rule?.placeCaret(effect.position);
          break;
        case "delete-tile":
          rule?.deleteTile(effect.position);
          break;
        case "undo-own-commit":
          composer?.undoOwnLastCommit();
          break;
        case "flash-caret":
          setLandingCount((count) => count + 1);
          break;
        case "close-strip":
          onDismiss();
          break;
        case "insert-rule":
          composer?.insertRuleAfter();
          break;
        case "move-rule":
          rule?.moveRule(effect.direction);
          break;
      }
    }
    return consumesKey(effects);
  };

  // A re-ask is taken once the render carrying everything asked for before it
  // has landed, so the token reads the document, the offering, and the word in
  // progress as that render leaves them.
  useEffect(() => {
    const token = reaskRef.current;
    if (token === undefined) return;
    reaskRef.current = undefined;
    dispatchInput(token);
  });

  // The offering closing releases the cursor. The tray stands nothing but the
  // offering, so a tray-armed position whose offering closed holds no element of
  // the strip at all and the keyboard has left it, which ends the arming; a
  // position armed from the sentence keeps the box the sentence hosts, and the
  // caret standing at it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: offeringOpen is an intentional trigger signal
  useEffect(() => {
    if (!offeringOpen) dispatchInput({ kind: "focus-lost", leftStrip: isArmed && composer === undefined });
  }, [offeringOpen]);

  const commitCandidate = (candidate: StripCandidate) => {
    dispatchInput({ kind: "candidate-tapped", candidate });
  };

  /**
   * A press on the panel's chrome, which acts without taking the keyboard from
   * whatever holds it. A press landing on one of the panel's own controls moves
   * the keyboard as it normally would.
   */
  const handlePanelMouseDown = (event: MouseEvent<HTMLElement>) => {
    const control = (event.target as HTMLElement).closest(kPanelKeyboardTargets);
    if (control === null || !event.currentTarget.contains(control)) event.preventDefault();
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dispatchInput({ kind: "escape" }, event);
  };

  // Escape is served here as well as on the panel, since the composer renders
  // this input outside the panel's subtree. A press the tray reads for itself --
  // the Delete that removes the tile the position was opened on -- is taken
  // first; every other press reads as it does anywhere in the box.
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const withCommand = event.metaKey || event.ctrlKey;
    // A press the mode reads as a history step is left to rise; every other
    // press is served here.
    const press = { key: event.key, withCommand, withShift: event.shiftKey };
    if (mode !== undefined && decideHistoryShortcut(mode, press) !== undefined) return;
    event.stopPropagation();
    const trayToken = mode === undefined ? undefined : composerTrayToken(event.key, mode, armedTile);
    dispatchInput(trayToken ?? composerTokenForKey(event.key, "filter", withCommand), event);
  };

  /**
   * The keys a focused band listbox serves while its chips are being browsed.
   * Tab is left to the browser, which takes it out of the offering, and typing
   * hands the keyboard back to the filter box with the keystroke intact.
   */
  const handleBandKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Escape belongs to the panel.
    if (event.key === "Escape") return;
    event.stopPropagation();
    dispatchInput(composerTokenForKey(event.key, "band", event.metaKey || event.ctrlKey), event);
  };

  /**
   * The keyboard leaving the element the cursor is anchored on, which releases
   * the cursor, and leaving the strip for another element of the document, which
   * ends composition as well. A move to another cell of the offering's grid
   * carries the same browse on, and releases nothing; a blur naming no element
   * gaining the keyboard leaves the strip as it stands. An element of the page's
   * selection grid named as gaining the keyboard is remembered, so the strip
   * closing hands it there rather than to the cell composition exits on.
   */
  const handleHighlightBlur = (event: FocusEvent<HTMLElement>) => {
    const gaining = event.relatedTarget as HTMLElement | null;
    if (gaining?.hasAttribute(kStripCellAttribute)) return;
    const leftStrip = gaining !== null && !isCandidateStripElement(gaining);
    if (leftStrip && gaining.closest(`[${kPageGridCellAttribute}]`) !== null) pickedUpKeyboardRef.current = gaining;
    dispatchInput({ kind: "focus-lost", leftStrip });
  };

  /** The wiring every band's listbox shares; each band adds its own accessible name. */
  const bandListboxProps = (bandKey: string) => ({
    id: stripBandPanelId(stripId, bandKey),
    tabIndex: -1,
    [kStripCellAttribute]: "",
    "aria-activedescendant":
      focusTarget.kind === "band" && focusTarget.bandKey === bandKey ? activeOption?.optionId : undefined,
    onKeyDown: handleBandKeyDown,
  });

  /** The command chips leading the offering, each addressed by the option id the highlight walks it by. */
  const renderCommandChips = (commands: readonly StripCommand[]) =>
    commands.map((command) => {
      const optionId = stripOptionId(stripId, kBestNextBandKey, command.key);
      return (
        <CommandChip
          key={command.key}
          command={command}
          optionId={optionId}
          isActive={activeOption?.optionId === optionId}
          onRun={state.runCommand}
        />
      );
    });

  /** The chips of one band, each addressed by the option id the highlight walks it by. */
  const renderChips = (bandKey: string, entries: readonly CandidateEntry[]) =>
    entries.map((entry) => {
      const optionId = stripOptionId(stripId, bandKey, entry.candidate.key);
      return (
        <CandidateChip
          key={entry.candidate.key}
          entry={entry}
          side={side}
          optionId={optionId}
          isActive={activeOption?.optionId === optionId}
          onCommit={commitCandidate}
          libraryName={libraryNameFor(entry.candidate)}
        />
      );
    });

  const renderSection = (section: CandidateStripSection) => {
    const hasMatches = section.entries.length > 0;
    const isOpen = openSectionKeys.has(section.key);
    const count = isFiltering ? section.entries.length : section.totalCount;
    const panelId = stripBandPanelId(stripId, section.key);
    const groupName = tileCandidateGroupNames[section.group];
    return (
      <div
        key={section.key}
        style={sectionCardStyle}
        className={`rounded-lg border border-brain-ink/10 ${hasMatches ? "" : "opacity-40"}`}
      >
        <button
          type="button"
          id={stripSectionHeadingId(stripId, section.key)}
          disabled={!hasMatches}
          tabIndex={-1}
          {...{ [kStripCellAttribute]: "" }}
          onClick={() => setOpenSectionKey(isOpen ? null : section.key)}
          onKeyDown={(event) => {
            if (dispatchInput(composerHeadingToken(event.key, section.key), event)) event.stopPropagation();
          }}
          aria-expanded={isOpen}
          aria-controls={panelId}
          className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-brain-ink/80 transition-colors hover:bg-brain-ink/5 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <span className="text-xs font-semibold uppercase tracking-wider">{groupName}</span>
          <span className="flex items-center gap-2">
            <span className="rounded-full bg-brain-ink/10 px-2 py-0.5 text-[11px] font-semibold text-brain-ink/70">
              {count}
            </span>
            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden="true" />
          </span>
        </button>
        {isOpen && hasMatches ? (
          <div
            role="listbox"
            {...bandListboxProps(section.key)}
            aria-label={groupName}
            className={`flex flex-wrap gap-2 px-3 pb-3 ${browsedBandClasses}`}
          >
            {section.subcategories.length === 1
              ? renderChips(section.key, section.subcategories[0].entries)
              : section.subcategories.map((subcategory) => {
                  const headingId = stripSubcategoryHeadingId(stripId, section.key, subcategory.key);
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a listbox owns option groups by role; a fieldset would add form semantics
                    <div
                      key={subcategory.key}
                      role="group"
                      aria-labelledby={headingId}
                      className="mt-1 flex w-full flex-wrap items-center gap-2 first:mt-0"
                    >
                      <div
                        id={headingId}
                        className={subcategory.band === "application" ? "sr-only" : subcategoryHeadingClasses}
                      >
                        {subcategory.heading}
                      </div>
                      {renderChips(section.key, subcategory.entries)}
                    </div>
                  );
                })}
          </div>
        ) : (
          <div id={panelId} hidden />
        )}
      </div>
    );
  };

  // The ids the filter box describes itself by. The browsing hint and the
  // unknown-text explanation are elements the panel renders.
  const describedBy = offeringOpen ? (state.isUnknown ? `${unknownId} ${hintId}` : hintId) : undefined;

  // How the filter box reads, which names the control that shows it as well.
  const filterName = localizer.tr("Filter tile candidates", undefined, kOfferingPhraseContext);

  // The text standing in the box: the open text value's content, or the word in
  // progress. An open text value counts as pending even while it is empty.
  const typedText = openTextLiteral ?? state.filter;
  const hasPendingText = typedText.length > 0 || openTextLiteral !== undefined;

  const filterInput = (
    <input
      ref={bindInput}
      id={filterId}
      type="text"
      role="combobox"
      aria-expanded={offeringOpen && options.length > 0}
      aria-controls={offeringOpen ? candidatesId : undefined}
      aria-activedescendant={offeringOpen && focusTarget.kind === "input" ? activeOption?.optionId : undefined}
      aria-autocomplete="list"
      // An on-screen keyboard rises over the box only once the box is shown.
      // A hidden box still holds the keyboard and still takes what a physical
      // keyboard types into it, `inputmode` governing on-screen keyboards
      // alone, so typing narrows the offering from a box out of sight without
      // a soft keyboard covering the offering it narrows.
      inputMode={boxIsShown ? "text" : "none"}
      value={typedText}
      onChange={(event) => dispatchInput({ kind: "text", text: event.target.value })}
      onKeyDown={handleKeyDown}
      // The sentence hosts this input outside the panel, whose own handler serves every element it holds.
      onBlur={composer ? handleHighlightBlur : undefined}
      placeholder={composer || openTextLiteral !== undefined ? "" : "Type or tap a tile"}
      aria-label={composer && armedRule ? caretPositionName(composer.caretPosition, armedRule, localizer) : filterName}
      aria-invalid={state.isUnknown}
      aria-describedby={describedBy}
      {...{ [kStripFilterAttribute]: composer ? "sentence" : "tray" }}
      className={
        composer
          ? `bg-transparent p-0 align-baseline ${kSentenceTypeClasses} outline-none ${
              hasPendingText
                ? `max-w-full border-b-2 px-1 italic field-sizing-content ${
                    state.isUnknown
                      ? "border-brain-amber text-brain-amber-ink"
                      : "border-brain-accent-ink/80 text-brain-ink"
                  }`
                : "w-0"
            }`
          : `h-10 min-w-0 flex-1 rounded-lg border-2 bg-brain-recess/40 px-3 font-mono text-sm pointer-coarse:text-base outline-none transition-colors placeholder:font-sans placeholder:text-brain-ink/55 ${
              state.isUnknown
                ? "border-brain-amber/50 text-brain-amber-ink focus:border-brain-amber"
                : "border-brain-ink/15 text-brain-ink focus:border-brain-accent"
            }`
      }
    />
  );

  // An open text value reads as the quoted text it will place, with the input
  // between the quotes the user typed and will type.
  const quoteMark = (
    <span
      aria-hidden="true"
      className={composer ? `${kSentenceTypeClasses} text-brain-ink/70 italic` : "font-mono text-sm text-brain-ink/70"}
    >
      "
    </span>
  );
  const filterField = filterFieldWithQuotes(
    filterInput,
    openTextLiteral === undefined ? undefined : quoteMark,
    composer !== undefined,
    !hasPendingText
  );

  const armedPosition = armedCaretPosition(target);
  const positionName = armedPosition && armedRule ? caretPositionName(armedPosition, armedRule, localizer) : undefined;

  // How the removal control reads: the word the sentence gives the tile it takes.
  const removalName =
    armedTile && armedRule
      ? localizer.tr(
          "Delete {word}",
          { word: tileSentenceWord(armedRule.side(armedTile.side).tiles().get(armedTile.tileIndex), localizer) },
          kOfferingPhraseContext
        )
      : undefined;

  // The panel fills whatever box it is rendered into, which is what stands it
  // across the rules list and under the armed rule.
  const panel = offeringOpen ? (
    <section
      ref={containerRef}
      id={stripId}
      {...{ [kStripPanelAttribute]: "" }}
      style={stripPanelStyle}
      className="relative mt-2 flex flex-col gap-3 rounded-xl p-3"
      aria-label="Tile candidates"
      onMouseDown={handlePanelMouseDown}
      onKeyDown={handlePanelKeyDown}
      onBlur={handleHighlightBlur}
    >
      <div
        data-strip-position-row=""
        className={`${kPositionRowClasses} ${kCornerReserveClass}${editPoint ? ` ${kPositionRowWrapClasses}` : ""}`}
      >
        <span className={kPositionNameClasses}>{positionName}</span>
        {editPoint && (
          <div className="flex min-w-0 grow basis-0 items-center gap-2 overflow-x-auto sm:grow-0 sm:basis-auto">
            {armedTile && (
              <button
                type="button"
                data-strip-delete=""
                aria-label={removalName}
                title={removalName}
                // The press acts without taking the keyboard from the box being typed in.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => dispatchInput({ kind: "delete-element", position: armedTile })}
                className="inline-flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-2 border-destructive/40 bg-destructive/15 text-destructive transition-colors hover:border-destructive hover:bg-destructive/30 hover:text-destructive-foreground"
              >
                <Trash2 className="h-5 w-5 shrink-0" aria-hidden="true" />
              </button>
            )}
            <div
              data-edit-point-pivot={editPoint.position}
              className="flex w-fit shrink-0 items-center gap-1 rounded-full border border-brain-ink/10 bg-brain-recess/30 p-1"
            >
              {kEditPointPositions.map((position) => {
                const isCurrent = position === editPoint.position;
                const pivotName = editPointPivotLabels[position];
                const PivotIcon = editPointPivotIcons[position];
                return (
                  <button
                    key={position}
                    type="button"
                    aria-pressed={isCurrent}
                    aria-label={pivotName}
                    data-edit-point-position={position}
                    onClick={() => editPoint.arm(position)}
                    className={`inline-flex min-h-9 min-w-9 cursor-pointer items-center justify-center rounded-full px-2 text-xs font-semibold whitespace-nowrap uppercase tracking-wider transition-colors sm:px-3 ${
                      isCurrent
                        ? "bg-brain-accent/90 text-brain-on-accent"
                        : "text-brain-ink/60 hover:bg-brain-ink/10 hover:text-brain-ink"
                    }`}
                  >
                    <PivotIcon className="h-4 w-4 shrink-0 sm:hidden" aria-hidden="true" />
                    <span className="hidden sm:inline">{pivotName}</span>
                  </button>
                );
              })}
            </div>
            {editPoint.menu}
          </div>
        )}
        {/* The control that shows the tray's filter box. */}
        {composer === undefined && (
          <button
            type="button"
            data-strip-search=""
            aria-label={filterName}
            title={filterName}
            aria-expanded={trayFilterOpen}
            aria-controls={filterId}
            // The press acts without taking the keyboard from the box it shows.
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleTrayFilter}
            className={`inline-flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border-2 transition-colors ${
              trayFilterOpen
                ? "border-brain-accent bg-brain-accent/20 text-brain-ink"
                : "border-brain-ink/15 bg-brain-recess/30 text-brain-ink/70 hover:border-brain-ink/40 hover:text-brain-ink"
            }`}
          >
            <Search className="h-5 w-5 shrink-0" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* The tray's box holds the keyboard whether or not it is shown, so typing
          narrows the offering from a closed box and shows it in doing so. */}
      {composer ? null : <div className={trayFilterOpen ? "flex items-center gap-2" : "sr-only"}>{filterField}</div>}

      <button
        type="button"
        onClick={onDismiss}
        onKeyDown={(event) => {
          if (dispatchInput(composerTokenForKey(event.key, "close", event.metaKey || event.ctrlKey), event))
            event.stopPropagation();
        }}
        aria-label="Close tile candidates"
        data-strip-close=""
        className="absolute top-1.5 right-1.5 flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg border-2 border-brain-ink/15 bg-brain-desk-to text-brain-ink/70 transition-colors hover:border-brain-ink/40 hover:text-brain-ink"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>

      <p id={hintId} className="sr-only">
        Arrow down to start browsing the tiles. Up and down move between rows, group headings included, and stop at the
        top and the bottom; left and right move along a row of tiles. On a group heading, arrow right opens that group
        and arrow left closes it, so arrow down moves on to the next heading while a group is closed and into its tiles
        once it is open. The first tile is highlighted to begin with, and the highlight follows what you type. Enter
        places the highlighted tile, as a space does. Arrow up from the first row leaves the tiles and returns to the
        sentence, and Tab leaves them altogether, closing them. Start the text with a dollar sign to name a variable,
        which Enter then places, creating it when no variable has that name. An operator symbol or a bracket ends the
        word before it and places that word, so a formula such as one plus three needs no spaces in it. Where a text
        value fits, a double quote starts one and the next double quote places it, as Enter does, with everything
        between them taken as the text, and nothing typed into it places a tile.
        {composer
          ? " Type a comma to end the when side and start typing what to do, and a period when the rule says what you want. With nothing typed, Backspace takes back the comma, and then the word you placed last."
          : ""}
      </p>

      <output id={statusId} aria-live="polite" className="sr-only">
        {status}
      </output>

      {state.isUnknown && (
        <p id={unknownId} className="text-xs font-semibold text-brain-amber-ink">
          No tile fits here by that name.
        </p>
      )}

      <div id={candidatesId} className="flex flex-col gap-3">
        {(shownBestNext.length > 0 || shownCommands.length > 0) && (
          <div
            role="listbox"
            {...bandListboxProps(kBestNextBandKey)}
            aria-label="Best next tiles"
            className={`flex flex-wrap gap-2 ${browsedBandClasses}`}
          >
            {renderCommandChips(shownCommands)}
            {renderChips(kBestNextBandKey, shownBestNext)}
          </div>
        )}

        {shownSections.length > 0 && (
          <div className="flex flex-col gap-1.5">{shownSections.map((section) => renderSection(section))}</div>
        )}
      </div>
    </section>
  ) : null;

  return { composerInput: composer ? filterField : undefined, pending: hasPendingText, landingCount, panel, mode };
}
