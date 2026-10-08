import { List } from "@wendoo/core";
import {
  type IBrainTileDef,
  type ITileCatalog,
  type LiteralDisplayFormat,
  RuleSide,
  RuleTriggerMode,
} from "@wendoo/core/brain";
import type { TypecheckResult } from "@wendoo/core/brain/compiler";
import { availableTriggerModes } from "@wendoo/core/brain/language-service";
import type { BrainCommand, BrainCommandHistory, BrainRuleDef, RulePlacement } from "@wendoo/core/brain/model";
import {
  AddTileCommand,
  DeleteRuleCommand,
  InsertRuleCommand,
  InsertTileCommand,
  PasteRulesCommand,
  PasteTileBeforeCommand,
  RemoveTileCommand,
  ReplaceTileCommand,
} from "@wendoo/core/brain/model";
import { CircleAlert, Plus } from "lucide-react";
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  type ArmedTargetEntry,
  type ArmedTileTarget,
  armedTargetForRule,
  isAppendTargetForRule,
  type LiteralCreationSeed,
  useArmedTargetActions,
  useArmedTargetController,
} from "./ArmedTargetContext";
import { BrainBadge } from "./BrainBadge";
import {
  kCandidateDragMimeType,
  type StripComposerBinding,
  type StripEditPointBinding,
  type StripRuleBinding,
  useCandidateStripSurface,
} from "./BrainCandidateStrip";
import { useBrainEditorConfig, useLocalizer } from "./BrainEditorContext";
import { BrainRuleSentence } from "./BrainRuleSentence";
import { BrainTileEditor } from "./BrainTileEditor";
import { BrainTileMenuButton } from "./BrainTileMenu";
import { CreateLiteralDialog } from "./CreateLiteralDialog";
import { CreateVariableDialog } from "./CreateVariableDialog";
import { type CaretPosition, caretEditIntent, caretOnRun, caretRun, composerEntryCaret } from "./caret-run";
import { decideSentenceCellEntry } from "./composer-input-model";
import { armEditPoint, type EditPointArming, type EditPointPosition, editPointPositionOf } from "./edit-point";
import { kGrabbedRuleMarkerLayer, kRuleChromeLayer, kRuleContentLayer } from "./editor-layers";
import { useCandidateStrip } from "./hooks/useCandidateStrip";
import { useRuleCapabilities, useRuleOutputKeys } from "./hooks/useRuleCapabilities";
import { composeAfterTileCreation, useTileSelection } from "./hooks/useTileSelection";
import { literalNameBase, literalWord, takenLiteralNamesAround, unusedNumberedName } from "./literal-naming";
import { usePageGrid } from "./PageGridContext";
import {
  decidePageGridGrab,
  decidePageGridOperation,
  kPageGridCellAttribute,
  type PageGridCell,
  type PageGridOperation,
  type PageGridSubject,
  pageGridCellAfterComposing,
  pageGridCellKey,
  type RuleMoveDirection,
} from "./page-grid-model";
import { type PageGridSelectionShape, pageGridSelectionProps } from "./page-grid-selection";
import { useRuleDragController } from "./RuleDragContext";
import { useRulePickup } from "./RulePickupContext";
import { useRuleSelection } from "./RuleSelectionContext";
import { copyRuleToClipboard, deserializeAllRulesFromClipboard, hasRuleInClipboard } from "./rule-clipboard";
import {
  kRuleMoveMarkerCorners,
  kRuleMoveMarkerShape,
  ruleMoveMarkerOverlaySize,
  ruleMoveMarkerOverlayViewBox,
  ruleMoveMarkerPath,
} from "./rule-move-marker";
import { canEndSideExpression } from "./sentence-composer";
import { kSentenceTypeClasses } from "./sentence-type";
import {
  applyBrokenTileBadges,
  buildNodeMap,
  computeTileBadges,
  computeTriggerBadge,
  type TileBadge,
} from "./tile-badges";
import {
  copyTileToClipboard,
  hasTileInClipboard,
  importTileFromClipboard,
  peekTileInClipboard,
} from "./tile-clipboard";
import { editLiteralValue, type LiteralValueEditor } from "./tile-menu-model";
import { positionOffersTile, sideOffersAppendedTile } from "./tile-offering";
import { triggerModeLabel, triggerSwitchName, triggerSwitchState } from "./trigger-mode";

/** Surface, hover, ink, and border of the rule row's round pills: the rule handle and each side's add-tile button. */
const pillChromeClasses = "bg-brain-pill hover:bg-brain-pill-hover text-brain-pill-ink border-2 border-brain-pill-edge";

/**
 * The properties a round pill animates: its hover growth, its surface, its edge,
 * its ink, and the outward step its focus outline takes. The outline's colour is
 * not among them, so the focus mark paints at its own colour on the first frame.
 */
const pillTransitionClasses = "transition-[scale,background-color,border-color,color,outline-offset] duration-150";

/**
 * The whole look of a round `+` button -- shape, size, chrome, hover growth and
 * glyph centring. Every control that adds something wears it: each side's
 * add-tile button, and the page's add-rule button.
 */
export const kAddButtonClasses = `relative rounded-full w-9 h-9 ${pillChromeClasses} hover:scale-105 ${pillTransitionClasses} font-semibold cursor-pointer flex items-center justify-center`;

/**
 * Shape, spacing and shadow of a capsule at the head of a rule side. Its fill
 * and edge are supplied by the call site.
 *
 * The height is the tile height, held whatever the row it stands in holds, and
 * the capsule centres itself in a taller row.
 */
const kCapsuleClasses =
  "px-2 py-1 border-2 rounded-md rounded-l-2xl flex h-24 self-center items-center justify-center shadow-sm relative overflow-hidden";

/**
 * How a capsule's stacked-upright letters are set, in the ink the capsule
 * around them carries. The uppercasing is the locale's own, applied to
 * whichever word the capsule stands.
 */
const kCapsuleLettersClasses = "font-semibold text-sm uppercase";

/** The fill, edge and ink of a capsule reading in the `when` mode, which the DO capsule wears. */
const kWhenCapsuleChrome = "bg-brain-capsule border-brain-capsule-edge text-brain-capsule-ink";

/**
 * The leading each stacked letter carries along the capsule's vertical inline
 * axis, which is what `mx-*` sets under the capsule's vertical writing mode.
 * Every letter carries the same, so the word's rows are evenly spaced.
 */
const kCapsuleLetterLeading = "mx-0.75";

/**
 * The hover and press growth of a switchable capsule, worn by the box holding
 * the capsule and its badge so the two grow as one. The transition stops under
 * reduced motion.
 */
const kTriggerSwitchBoxClasses =
  "transition-transform duration-100 motion-reduce:transition-none hover:scale-105 active:scale-95";

/**
 * The pressable affordance the trigger switch wears over a static capsule: the
 * pointer, and the transition its fill and edge take as the mode changes, which
 * stops under reduced motion.
 */
const kTriggerSwitchClasses =
  "cursor-pointer transition-[background-color,border-color] duration-150 motion-reduce:transition-none";

/**
 * The badge marking a capsule whose mode its rule's position rejects, wearing
 * the treatment a tile's error badge wears.
 */
const kTriggerBadgeClasses = `absolute -top-1.5 -right-1.5 ${kRuleChromeLayer} flex items-center justify-center rounded-full w-6 h-6 shadow-md border pointer-events-auto bg-destructive border-destructive text-destructive-foreground`;

/** The fill, edge and ink each trigger mode's capsule is painted in. */
const triggerModeChrome: Record<RuleTriggerMode, string> = {
  [RuleTriggerMode.When]: kWhenCapsuleChrome,
  [RuleTriggerMode.Otherwise]:
    "bg-brain-capsule-otherwise border-brain-capsule-otherwise-edge text-brain-capsule-otherwise-ink",
  [RuleTriggerMode.Then]: "bg-brain-capsule-then border-brain-capsule-then-edge text-brain-capsule-then-ink",
};

/**
 * The badge `ruleDef`'s trigger switch carries from the typecheck result its
 * WHEN side holds, and undefined while that side has never been checked.
 */
function storedTriggerBadge(ruleDef: BrainRuleDef): TileBadge | undefined {
  const result = ruleDef.when().typecheckResult() as TypecheckResult | undefined;
  return result === undefined ? undefined : computeTriggerBadge(result.whenParseResult);
}

/** `word` as one upright span per character, which reads down a vertical capsule. */
function stackedLetters(word: string): React.ReactNode[] {
  return [...word].map((character, index) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: a letter's place in the word is its identity
      key={index}
      className={`inline-block rotate-270 ${kCapsuleLetterLeading}`}
    >
      {character}
    </span>
  ));
}

/** How far one step of nesting stands a rule card in, in CSS pixels. */
const kRuleIndentStep = 32;

/** The invitation the sentence line of a rule holding no tiles reads. */
const kComposerEntryPrompt = "Type what should happen...";

/** What a paste is refused with where the copied tile does not belong at the position. */
const kTilePasteRefusal = "That tile does not fit here";

/** What each clipboard verb reports having done, by the kind of subject it acted on. */
const kClipboardReports = {
  copy: { rule: "Rule copied", tile: "Tile copied" },
  cut: { rule: "Rule cut", tile: "Tile cut" },
  paste: { rule: "Rule pasted", tile: "Tile pasted" },
} as const;

/**
 * How `verb` reports what it did to `subject`. The end of a side reports as a
 * tile, which is what a paste there places.
 */
function clipboardReport(verb: keyof typeof kClipboardReports, subject: PageGridSubject): string {
  return kClipboardReports[verb][subject.kind === "rule" ? "rule" : "tile"];
}

/** The command that places `tileDef` where `arming` addresses on `side` of `ruleDef`. */
function editPointCommand(
  arming: EditPointArming,
  ruleDef: BrainRuleDef,
  side: RuleSide,
  tileDef: IBrainTileDef
): BrainCommand {
  switch (arming.mode) {
    case "append":
      return new AddTileCommand(ruleDef, side, tileDef);
    case "insert":
      return new InsertTileCommand(ruleDef, side, arming.tileIndex, tileDef);
    case "replace":
      return new ReplaceTileCommand(ruleDef, side, arming.tileIndex, tileDef);
  }
}

/** The placed literal a rule's value-editor dialog stands open on. */
interface LiteralEditTarget {
  /** The value editor that literal offers. */
  readonly editor: LiteralValueEditor;
  /** The side of the rule holding it. */
  readonly side: RuleSide;
  /** Its place among the tiles of that side, counting from zero. */
  readonly tileIndex: number;
}

/** The up-pointing wedge a rule handle's movement marker is drawn as, in the overlay's user space. */
const kRuleMoveMarkerPath = ruleMoveMarkerPath(kRuleMoveMarkerShape);

/** The side, in pixels, of the square overlay the four wedges are drawn in. */
const kRuleMoveMarkerOverlaySize = ruleMoveMarkerOverlaySize(kRuleMoveMarkerShape);

/** The user space that overlay maps to, centred on the handle at one unit per pixel. */
const kRuleMoveMarkerOverlayViewBox = ruleMoveMarkerOverlayViewBox(kRuleMoveMarkerShape);

/** Degrees {@link kRuleMoveMarkerPath} turns about the handle's centre to point each way a rule can move. */
const kRuleMoveMarkerRotations: Record<RuleMoveDirection, number> = {
  up: 0,
  indent: 90,
  down: 180,
  outdent: 270,
};

/** One placement a rule's own composition made: the command it ran, and the element it stands at. */
interface ComposerCommit {
  readonly command: BrainCommand;
  readonly position: CaretPosition;
}

interface BrainRuleEditorProps {
  ruleDef: BrainRuleDef;
  depth?: number;
  lineNumber: number;
  /** How many rules the page reads in all, which the handle names this rule's place among. */
  ruleCount: number;
  /**
   * Everything this rule derives its reading, its capabilities and its offering
   * from, spelled by `ruleRevisions`. A card recomputes all three exactly when
   * this changes.
   */
  revision: string;
  commandHistory: BrainCommandHistory;
}

interface BrainRuleEditorCardProps extends BrainRuleEditorProps {
  /**
   * The target armed on this rule, or null while the editor's arming stands on
   * another rule or on nothing. Every other rule is handed the same null, so an
   * arming renders the two cards it names and no other.
   */
  stripTarget: ArmedTileTarget | null;
}

function BrainRuleEditorCard({
  ruleDef,
  depth = 0,
  lineNumber,
  ruleCount,
  revision,
  commandHistory,
  stripTarget,
}: BrainRuleEditorCardProps) {
  const { brainServices, tileCatalogs, isBrokenTile, customLiteralTypes, dataTypeNames } = useBrainEditorConfig();
  const localizer = useLocalizer();
  // The cells this rule stands in the page's selection grid.
  const pageGrid = usePageGrid();
  const ruleId = ruleDef.ruleId();
  // The rule the page holds picked up.
  const rulePickup = useRulePickup();
  const isGrabbed = rulePickup.pickup?.ruleId === ruleId;
  const grabbedDirections = isGrabbed ? rulePickup.pickup?.directions : undefined;
  const dragController = useRuleDragController();
  const isDragging = dragController.draggingRuleId === ruleDef.ruleId();
  // A press on the handle starts drag tracking and nothing else. The controller
  // applies a movement threshold, so a press that releases without moving is
  // left as the plain press it was, and the keyboard lands on the handle as it
  // would on any button, which selects it.
  const handleHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      dragController.beginDrag(ruleDef, event);
    },
    [dragController, ruleDef]
  );
  const armedTarget = useArmedTargetActions();
  const appendTarget = isAppendTargetForRule(stripTarget, ruleDef) ? stripTarget : null;
  const stripId = useId();
  const [isDirty, setIsDirty] = useState(ruleDef.isDirty());
  const [whenBadges, setWhenBadges] = useState<Map<number, TileBadge>>(new Map());
  // The badge the trigger switch carries, read from the same typecheck result
  // the WHEN side's tile badges are read from, and opened at whatever that side
  // already holds so a first render carries it.
  const [triggerBadge, setTriggerBadge] = useState<TileBadge | undefined>(() => storedTriggerBadge(ruleDef));
  const [doBadges, setDoBadges] = useState<Map<number, TileBadge>>(new Map());

  const availableCapabilities = useRuleCapabilities(ruleDef, revision);
  const availableOutputKeys = useRuleOutputKeys(ruleDef, revision);

  // Every catalog this rule places from: the host's, plus the tiles the brain
  // minted for itself.
  const catalogs = useMemo(() => {
    const list = tileCatalogs ? List.from<ITileCatalog>(tileCatalogs) : List.empty<ITileCatalog>();
    const localCatalog = ruleDef.brain()?.catalog();
    if (localCatalog) list.push(localCatalog);
    return list.asReadonly();
  }, [ruleDef, tileCatalogs]);

  // Whether a tile may follow what each side already holds. A host that supplies
  // no services cannot be asked, so both ends stand open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an intentional trigger signal
  const appendable = useMemo(() => {
    const offers = (side: RuleSide) =>
      brainServices === undefined ||
      sideOffersAppendedTile({
        ruleDef,
        side,
        catalogs,
        services: brainServices,
        availableCapabilities,
        availableOutputKeys,
      });
    return { whenSide: offers(RuleSide.When), doSide: offers(RuleSide.Do) };
  }, [ruleDef, revision, catalogs, brainServices, availableCapabilities, availableOutputKeys]);

  // The caret this rule's composition stands at, carried by the target armed
  // from the sentence. A rule holds it exactly while it is being composed.
  const armedCaret = stripTarget?.entry === "sentence" ? stripTarget.caret : undefined;
  // The rule changes under the caret from surfaces the composer does not drive --
  // the tile menu's Delete, the toolbar's Undo, a paste -- so the armed position
  // is read against the run the rule holds now before anything renders from it.
  const composerCaret = armedCaret === undefined ? undefined : caretOnRun(caretRun(ruleDef), armedCaret);

  // Composition from the sentence line: the placements this rule's own composer
  // made, newest last, each with the element it stands at, so deleting the last
  // of them can take that command back while it is still the history's newest
  // entry.
  const isComposing = composerCaret !== undefined;

  // The cell of this rule the page's selection rests on, undefined while it
  // rests on another rule's.
  const selectedCell = useRuleSelection();

  // Where this rule was last edited, which composition opens at again: the
  // composer's caret while composing, and otherwise the tile the page's
  // selection rests on.
  const heldCaretRef = useRef<CaretPosition | undefined>(undefined);
  useEffect(() => {
    if (composerCaret !== undefined) heldCaretRef.current = composerCaret;
    else if (selectedCell?.kind === "tile") {
      heldCaretRef.current = { kind: "element", side: selectedCell.side, tileIndex: selectedCell.tileIndex };
    }
  }, [composerCaret, selectedCell]);

  const ownCommitsRef = useRef<ComposerCommit[]>([]);
  // The commits span one composition, so the WHEN->DO pivot keeps them; leaving
  // the sentence line for any other target drops them.
  useEffect(() => {
    if (!isComposing) ownCommitsRef.current = [];
  }, [isComposing]);
  const recordComposerCommit = useCallback(() => {
    if (composerCaret === undefined) return;
    // The commit ran its command a moment ago: the newest entry is that command,
    // and the tile it placed stands at the caret it was armed from.
    const command = commandHistory.peekUndo();
    if (!command) return;
    ownCommitsRef.current.push({
      command,
      position: { kind: "element", side: composerCaret.side, tileIndex: composerCaret.tileIndex },
    });
  }, [composerCaret, commandHistory]);

  // The literal the offering's edit command is editing the value of, and the
  // element the keyboard came from, which takes it back as the dialog closes.
  const [literalEdit, setLiteralEdit] = useState<LiteralEditTarget | undefined>(undefined);
  const literalEditOpenerRef = useRef<HTMLElement | null>(null);
  const openLiteralEditor = useCallback((editor: LiteralValueEditor, side: RuleSide, tileIndex: number) => {
    literalEditOpenerRef.current = document.activeElement as HTMLElement | null;
    setLiteralEdit({ editor, side, tileIndex });
  }, []);

  const candidateStrip = useCandidateStrip({
    ruleDef,
    target: stripTarget,
    catalogs,
    availableCapabilities,
    availableOutputKeys,
    revision,
    onCommitted: recordComposerCommit,
    onEditLiteral: openLiteralEditor,
  });

  // The side whose add-tile button has the strip's panel standing under it.
  const offeredAppendSide = candidateStrip.offeringOpen ? appendTarget?.side : undefined;

  // Composition reaches the DO side only through the typed pivot, so an armed
  // DO side on the sentence line is the pivot the user typed. The comma stays
  // visible until a word stands behind it, after which the sentence reads its
  // own clause comma.
  const isPivoted = isComposing && stripTarget?.side === RuleSide.Do;

  // The latest render's caret-arming call.
  const placeCaretFromRef = useRef<(position: CaretPosition, entry: ArmedTargetEntry) => void>(() => {});
  // The gap past the tile the caret's arming last placed, recorded as that
  // placement runs. Read once, by the completion of a creation the placement
  // waited on.
  const placedCaretRef = useRef<CaretPosition | undefined>(undefined);

  /**
   * A tile named in a create dialog has been placed. Composition carries on
   * where a tile picked from the offering leaves it: the gap past the tile
   * placed is armed, which re-queries the offering there and hands the keyboard
   * back to the composer's box as the dialog closes. A placement made anywhere
   * but in a rule's sentence ends the selection.
   */
  const handleTileCreated = useCallback(() => {
    const placed = placedCaretRef.current;
    placedCaretRef.current = undefined;
    const caret = composeAfterTileCreation(stripTarget?.entry, placed);
    if (caret === undefined) {
      armedTarget.disarm();
      return;
    }
    placeCaretFromRef.current(caret, "sentence");
  }, [armedTarget, stripTarget]);

  // Use the tile selection hook
  const {
    showCreateVariableDialog,
    variableDialogTitle,
    showCreateLiteralDialog,
    literalDialogTitle,
    literalType,
    literalSeed,
    handleTileSelected: handleTileSelectedWithVariable,
    handleVariableNameSubmit,
    handleVariableDialogClose,
    handleLiteralValueSubmit,
    handleLiteralDialogClose,
    handleCreateDialogCloseAutoFocus,
  } = useTileSelection({
    ruleDef,
    onComplete: armedTarget.disarm,
    onCreated: handleTileCreated,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an intentional trigger signal
  useEffect(() => {
    const readDirty = () => setIsDirty(ruleDef.isDirty());
    readDirty();
    return ruleDef.events().on("rule_dirtyChanged", readDirty);
  }, [ruleDef, revision]);

  // Compute tile badges from typecheck results, then overlay broken-tile badges
  // (an action tile whose definition failed to compile), which take precedence
  // over any per-rule diagnostic on the same tile.
  const updateBadgesForSide = useCallback(
    (side: RuleSide, typecheckResult: unknown) => {
      const result = typecheckResult as TypecheckResult | undefined;
      let badges: Map<number, TileBadge>;
      if (!result) {
        badges = new Map();
      } else {
        const sideParseResult = side === RuleSide.When ? result.whenParseResult : result.doParseResult;
        const nodeMap = buildNodeMap(sideParseResult);
        const typeDiags = result.typeInfo.diags.toArray().filter((d) => nodeMap.has(d.nodeId));
        badges = computeTileBadges(sideParseResult, typeDiags, nodeMap);
      }
      if (isBrokenTile) {
        const tiles = (side === RuleSide.When ? ruleDef.when() : ruleDef.do()).tiles().toArray();
        applyBrokenTileBadges(tiles, badges, isBrokenTile);
      }
      if (side === RuleSide.When) {
        setWhenBadges(badges);
        setTriggerBadge(result === undefined ? undefined : computeTriggerBadge(result.whenParseResult));
      } else setDoBadges(badges);
    },
    [ruleDef, isBrokenTile]
  );

  useEffect(() => {
    const whenTileSet = ruleDef.when();
    const doTileSet = ruleDef.do();

    const unsubWhen = whenTileSet.events().on("tileSet_typechecked", (data) => {
      updateBadgesForSide(RuleSide.When, data.typecheckResult);
    });
    const unsubDo = doTileSet.events().on("tileSet_typechecked", (data) => {
      updateBadgesForSide(RuleSide.Do, data.typecheckResult);
    });

    // Badges derive from the stored full typecheck result. A rule with no
    // stored result yet (e.g. freshly deserialized or pasted) is typechecked
    // now; typecheck() is a no-op for rules that are clean and already checked.
    if (!whenTileSet.typecheckResult() || !doTileSet.typecheckResult()) {
      ruleDef.typecheck();
    }
    updateBadgesForSide(RuleSide.When, whenTileSet.typecheckResult());
    updateBadgesForSide(RuleSide.Do, doTileSet.typecheckResult());

    return () => {
      unsubWhen();
      unsubDo();
    };
  }, [ruleDef, updateBadgesForSide]);

  /**
   * Places the copied rules beside this one, on the side `placement` names, and
   * reports whether any rule was placed.
   */
  const pasteRules = (placement: RulePlacement): boolean => {
    let placedCount = 0;
    const command = new PasteRulesCommand(ruleDef, placement, (destBrain) => {
      const rules = List.from(deserializeAllRulesFromClipboard(destBrain, tileCatalogs, brainServices));
      placedCount = rules.size();
      return rules;
    });
    commandHistory.executeCommand(command);
    return placedCount > 0;
  };

  const armAppendTarget = useCallback(
    (side: RuleSide) => {
      armedTarget.arm({
        ruleDef,
        side,
        mode: "append",
        entry: "tray",
        onTileSelected: (tileDef: IBrainTileDef, seed?: LiteralCreationSeed) =>
          handleTileSelectedWithVariable(
            tileDef,
            (tile) => {
              const command = new AddTileCommand(ruleDef, side, tile);
              commandHistory.executeCommand(command);
            },
            seed
          ),
      });
    },
    [armedTarget, ruleDef, handleTileSelectedWithVariable, commandHistory]
  );

  const handleAppendTileClick = (side: RuleSide) => () => armAppendTarget(side);

  // The edit point on a placed tile: one arming per pivot position, each asking
  // the oracle its own question and each placing with its own command. The entry
  // selects the mode the position is edited in: a tap on the tile takes the
  // tray, a tap on the tile's word or on a word boundary takes the sentence.
  const armTileEditPoint = useCallback(
    (side: RuleSide, anchorTileIndex: number, position: EditPointPosition, entry: ArmedTargetEntry) => {
      const arming = armEditPoint(position, anchorTileIndex, ruleDef.side(side).tiles().size());
      armedTarget.arm({
        ruleDef,
        side,
        mode: arming.mode,
        tileIndex: arming.mode === "append" ? undefined : arming.tileIndex,
        anchorTileIndex,
        entry,
        onTileSelected: (tileDef: IBrainTileDef, seed?: LiteralCreationSeed) =>
          handleTileSelectedWithVariable(
            tileDef,
            (tile) => {
              commandHistory.executeCommand(editPointCommand(arming, ruleDef, side, tile));
            },
            seed
          ),
      });
    },
    [armedTarget, ruleDef, handleTileSelectedWithVariable, commandHistory]
  );

  /**
   * Arm the caret at `position`: the position names the edit, and the command
   * that edit runs places the chosen tile. `entry` is the surface the edit is
   * made on, which decides where the strip stands its filter box -- inline in
   * the rule's sentence, or in the offering's own tray row.
   */
  const placeCaretFrom = useCallback(
    (position: CaretPosition, entry: ArmedTargetEntry) => {
      const side = position.side;
      const intent = caretEditIntent(position, ruleDef.side(side).tiles().size());
      const arming: EditPointArming =
        intent.mode === "append" ? { mode: "append" } : { mode: intent.mode, tileIndex: position.tileIndex };
      armedTarget.arm({
        ruleDef,
        side,
        mode: intent.mode,
        tileIndex: intent.mode === "append" ? undefined : intent.tileIndex,
        caret: position,
        entry,
        onTileSelected: (tileDef: IBrainTileDef, seed?: LiteralCreationSeed) =>
          handleTileSelectedWithVariable(
            tileDef,
            (tile) => {
              commandHistory.executeCommand(editPointCommand(arming, ruleDef, side, tile));
              // The tile stands where the arming addressed, except for an append,
              // which stands it at the side's new end.
              placedCaretRef.current = {
                kind: "gap",
                side,
                tileIndex: arming.mode === "append" ? ruleDef.side(side).tiles().size() : arming.tileIndex + 1,
              };
            },
            seed
          ),
      });
    },
    [armedTarget, ruleDef, handleTileSelectedWithVariable, commandHistory]
  );
  placeCaretFromRef.current = placeCaretFrom;

  // The caret placed from the sentence, which composes the rule there.
  const placeSentenceCaret = useCallback(
    (position: CaretPosition) => placeCaretFrom(position, "sentence"),
    [placeCaretFrom]
  );

  // The character a printable key pressed on the entry point starts the word in
  // progress with, held until the arming that key asked for has landed and the
  // strip has started its own fresh word.
  const seedCharacterRef = useRef<string | undefined>(undefined);
  const setStripFilter = candidateStrip.setFilter;
  useEffect(() => {
    const seed = seedCharacterRef.current;
    if (seed === undefined || !isComposing) return;
    seedCharacterRef.current = undefined;
    setStripFilter(seed);
  }, [isComposing, setStripFilter]);

  /**
   * Compose the rule's sentence, standing the caret where this rule was last
   * edited and starting the word in progress with `seed`.
   */
  const enterSentence = (seed: string | undefined) => {
    seedCharacterRef.current = seed;
    placeSentenceCaret(composerEntryCaret(caretRun(ruleDef), heldCaretRef.current));
  };

  /**
   * A key pressed while the selection rests on the rule's sentence composes it:
   * Space and Enter with nothing typed, and a printable character with that
   * character starting the word in progress. Every other key is left alone,
   * with its default intact.
   */
  const handleSentenceCellKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const entry = decideSentenceCellEntry(event.key, event.metaKey || event.ctrlKey || event.altKey);
    if (entry === undefined) return;
    event.preventDefault();
    enterSentence(entry.seed);
  };

  // An insertion asks the rule it made to be composed; that rule's own card
  // takes the request up once as it renders and gives it back.
  const ruleToCompose = pageGrid?.ruleToCompose;
  const composeRule = pageGrid?.composeRule;
  const enterSentenceRef = useRef(enterSentence);
  enterSentenceRef.current = enterSentence;
  useEffect(() => {
    if (ruleToCompose !== ruleId || composeRule === undefined) return;
    composeRule(undefined);
    enterSentenceRef.current(undefined);
  }, [ruleToCompose, ruleId, composeRule]);

  /**
   * True when the copied tile belongs at `tileIndex` of `side`, which the
   * suggestion oracle answers. A host supplying no services cannot be asked, so
   * every position of such a rule stands open. False as well while the clipboard
   * holds no tile.
   */
  const clipboardTileFits = (side: RuleSide, tileIndex: number): boolean => {
    const tileDef = peekTileInClipboard();
    if (tileDef === undefined) return false;
    if (brainServices === undefined) return true;
    return positionOffersTile({
      ruleDef,
      side,
      tileIndex,
      tileDef,
      catalogs,
      services: brainServices,
      availableCapabilities,
      availableOutputKeys,
    });
  };

  /**
   * Places the copied tile at `tileIndex` of `side`, refusing where the oracle
   * does not offer it there and doing nothing while the clipboard holds no tile.
   * Reports whether a tile was placed.
   */
  const pasteTileAt = (side: RuleSide, tileIndex: number): boolean => {
    if (!hasTileInClipboard()) return false;
    if (!clipboardTileFits(side, tileIndex)) {
      toast.error(kTilePasteRefusal);
      return false;
    }
    let placed = false;
    commandHistory.executeCommand(
      new PasteTileBeforeCommand(ruleDef, side, tileIndex, (destBrain) => {
        const tileDef = importTileFromClipboard(destBrain, brainServices);
        placed = tileDef !== undefined;
        return tileDef;
      })
    );
    return placed;
  };

  /** Puts `subject` on its own clipboard, reporting whether it took anything. */
  const copySubject = (subject: PageGridSubject): boolean => {
    if (subject.kind === "rule") {
      copyRuleToClipboard(ruleDef);
      return true;
    }
    if (subject.kind !== "tile") return false;
    const tileDef = ruleDef.side(subject.side).tiles().at(subject.tileIndex);
    if (!tileDef) return false;
    copyTileToClipboard(tileDef, ruleDef.brain());
    return true;
  };

  /** Takes `subject` out of the page, ending any arming standing on this rule. */
  const removeSubject = (subject: PageGridSubject): void => {
    if (subject.kind === "side-end") return;
    if (stripTarget !== null) armedTarget.disarm();
    commandHistory.executeCommand(
      subject.kind === "rule"
        ? new DeleteRuleCommand(ruleDef)
        : new RemoveTileCommand(ruleDef, subject.side, subject.tileIndex)
    );
  };

  /**
   * Places what is on the clipboard past `subject`, or at the end of the side it
   * names, and reports whether anything was placed.
   */
  const pasteAfterSubject = (subject: PageGridSubject): boolean => {
    if (subject.kind === "rule") {
      return hasRuleInClipboard() && pasteRules("after");
    }
    const side = subject.side;
    return pasteTileAt(side, subject.kind === "tile" ? subject.tileIndex + 1 : ruleDef.side(side).tiles().size());
  };

  /** Puts an empty rule after this one and asks the page for it to be composed. */
  const insertRuleAfter = (): void => {
    const command = new InsertRuleCommand(ruleDef, "after");
    commandHistory.executeCommand(command);
    const inserted = command.insertedRule();
    if (inserted !== undefined) composeRule?.(inserted.ruleId());
  };

  /**
   * Runs `operation` on this rule. Each clipboard verb announces what it did;
   * a copy that takes nothing and a paste that places nothing announce nothing.
   */
  const performOperation = (operation: PageGridOperation): void => {
    switch (operation.verb) {
      case "delete":
        removeSubject(operation.subject);
        return;
      case "copy":
        if (copySubject(operation.subject)) toast.success(clipboardReport("copy", operation.subject));
        return;
      case "cut":
        if (!copySubject(operation.subject)) return;
        removeSubject(operation.subject);
        toast.success(clipboardReport("cut", operation.subject));
        return;
      case "paste":
        if (pasteAfterSubject(operation.subject)) toast.success(clipboardReport("paste", operation.subject));
        return;
      case "insert-rule":
        insertRuleAfter();
        return;
    }
  };

  // A caret read back onto the run stands somewhere else than the target was
  // armed at; arming that target again moves the offering, and the command a
  // placement runs, to the tiles the rule holds now.
  useEffect(() => {
    if (composerCaret !== undefined && composerCaret !== armedCaret) placeSentenceCaret(composerCaret);
  });

  // The strip's position pivot, present only for a target armed on a placed tile
  // from the tray. The tile the pivot turns about is the one whose menu the row
  // stands the control for.
  const editPointAnchor = stripTarget?.anchorTileIndex;
  const anchorTileDef =
    stripTarget !== null && editPointAnchor !== undefined
      ? ruleDef.side(stripTarget.side).tiles().at(editPointAnchor)
      : undefined;
  const editPoint: StripEditPointBinding | undefined =
    stripTarget !== null && editPointAnchor !== undefined && !isComposing
      ? {
          position: editPointPositionOf(stripTarget, editPointAnchor),
          arm: (position: EditPointPosition) => armTileEditPoint(stripTarget.side, editPointAnchor, position, "tray"),
          menu: anchorTileDef && (
            <BrainTileMenuButton
              tileDef={anchorTileDef}
              side={stripTarget.side}
              tileIndex={editPointAnchor}
              ruleDef={ruleDef}
              commandHistory={commandHistory}
            />
          ),
        }
      : undefined;

  const undoOwnLastCommit = useCallback((): void => {
    commandHistory.undo();
    ownCommitsRef.current.pop();
  }, [commandHistory]);

  const deleteTileAt = useCallback(
    (position: CaretPosition): void => {
      commandHistory.executeCommand(new RemoveTileCommand(ruleDef, position.side, position.tileIndex));
    },
    [commandHistory, ruleDef]
  );

  // The composition's own newest placement is takeable only while the command it
  // ran is still the history's newest entry; anything else done to the document
  // since leaves the tile to be removed like any other.
  const ownNewestPlacement = useCallback((): CaretPosition | undefined => {
    const own = ownCommitsRef.current[ownCommitsRef.current.length - 1];
    return own !== undefined && commandHistory.peekUndo() === own.command ? own.position : undefined;
  }, [commandHistory]);

  const ruleHasTiles = () => !ruleDef.when().tiles().isEmpty() || !ruleDef.do().tiles().isEmpty();

  const composer: StripComposerBinding | undefined =
    stripTarget !== null && composerCaret !== undefined
      ? {
          caretPosition: composerCaret,
          pivoted: isPivoted,
          canEndArmedSide: () =>
            canEndSideExpression((stripTarget.side === RuleSide.Do ? ruleDef.do() : ruleDef.when()).tiles(), localizer),
          isRuleEmpty: () => !ruleHasTiles(),
          doTileCount: () => ruleDef.do().tiles().size(),
          ownNewestPlacement,
          undoOwnLastCommit,
          insertRuleAfter,
        }
      : undefined;

  // Every edit the strip makes stays on the surface its arming began on: one
  // made in the sentence carries on there, and one made from the tile row leaves
  // the offering standing in its own tray.
  const rule: StripRuleBinding | undefined =
    stripTarget === null
      ? undefined
      : {
          placeCaret: (position) => placeCaretFrom(position, stripTarget.entry ?? "tray"),
          deleteTile: deleteTileAt,
          moveRule: (direction) => pageGrid?.moveRule(ruleId, direction),
          // Composition names the cell its caret rests at. Every other arming
          // takes the cell of this rule the selection rests on, which the grid
          // moves to whatever stands in a vanished cell's place, so a tile
          // removed from the tray leaves the keyboard where that tile stood,
          // and this rule's handle where the selection rests on no cell of it.
          exitCellKey: () =>
            pageGridCellKey(
              composerCaret !== undefined
                ? pageGridCellAfterComposing(ruleId, composerCaret)
                : (selectedCell ?? { kind: "handle", ruleId })
            ),
        };

  const handleTilePickerCancel = () => {
    armedTarget.disarm();
  };

  /**
   * The word the create-literal dialog's name field opens holding: the one a
   * seeded creation carries, and otherwise the first free default name of the
   * type being created. A type standing no name field takes none.
   */
  const openedLiteralName = (): string | undefined => {
    if (literalSeed !== undefined) return literalSeed.displayName;
    const customType = customLiteralTypes.find((candidate) => candidate.typeId === literalType);
    if (customType === undefined) return undefined;
    const taken = takenLiteralNamesAround(tileCatalogs, ruleDef.brain()?.catalog(), literalType);
    return unusedNumberedName(literalNameBase(literalType, customType, dataTypeNames), taken);
  };

  /** Puts the submitted value and name on the literal the value editor stands open on. */
  const handleLiteralEditSubmit = (value: unknown, _displayFormat?: LiteralDisplayFormat, displayName?: string) => {
    if (literalEdit === undefined) return;
    editLiteralValue({
      ruleDef,
      side: literalEdit.side,
      tileIndex: literalEdit.tileIndex,
      editor: literalEdit.editor,
      value,
      displayName,
      commandHistory,
    });
    setLiteralEdit(undefined);
  };

  // Hands the keyboard back to the chip the value editor was opened from. A
  // chip no longer rendering leaves the hand-back to the dialog's own
  // restoration.
  const handleLiteralEditCloseAutoFocus = (event: Event) => {
    const returnTo = literalEditOpenerRef.current;
    literalEditOpenerRef.current = null;
    if (returnTo === null || !returnTo.isConnected) return;
    event.preventDefault();
    returnTo.focus({ preventScroll: true });
  };

  // The strip's two pieces: the input this rule's sentence hosts while it is
  // composed, and the offering panel laid over the rules below this one.
  const strip = useCandidateStripSurface({
    id: stripId,
    state: candidateStrip,
    target: stripTarget,
    onDismiss: handleTilePickerCancel,
    composer,
    rule,
    editPoint,
  });

  // Reports the context this rule's armed strip holds the keyboard in to the
  // armed target. An unarmed strip names no mode and reports nothing.
  const reportArmedMode = armedTarget.reportMode;
  const stripMode = strip.mode;
  useEffect(() => {
    if (stripMode !== undefined) reportArmedMode(stripMode);
  }, [stripMode, reportArmedMode]);

  // This rule's card, which the offering it stands is placed against.
  const cardRef = useRef<HTMLDivElement | null>(null);
  const offeringRail = pageGrid?.offeringRail ?? null;
  const offeringStands = strip.panel !== null;
  // The box the offering stands in, placed against the rail.
  const offeringBoxRef = useRef<HTMLDivElement | null>(null);
  // Stands the offering box below the rail by the distance from the rail down to
  // the bottom edge of this card. Both edges move together as the page scrolls,
  // so this distance reads the same at every scroll offset. The distance lands
  // on the box within the layout phase that measured it, so the offering stands
  // at its own height for the whole of the commit that raised it -- before any
  // effect scrolls to it or takes the keyboard into it. Does nothing until the
  // card, the box and the rail all stand.
  const measureOffering = useCallback(() => {
    const card = cardRef.current;
    const box = offeringBoxRef.current;
    if (card === null || box === null || offeringRail === null) return;
    box.style.top = `${card.getBoundingClientRect().bottom - offeringRail.getBoundingClientRect().top}px`;
  }, [offeringRail]);
  useLayoutEffect(() => {
    if (offeringStands) measureOffering();
  });
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!offeringStands || card === null) return;
    const observer = new ResizeObserver(measureOffering);
    observer.observe(card);
    return () => observer.disconnect();
  }, [offeringStands, measureOffering]);

  // Dropping a candidate chip on the armed rule places it at the armed
  // position, the same placement tapping the chip performs.
  const handleCandidateDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!stripTarget || !event.dataTransfer.types.includes(kCandidateDragMimeType)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleCandidateDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!stripTarget) return;
    const candidateKey = event.dataTransfer.getData(kCandidateDragMimeType);
    if (!candidateKey) return;
    event.preventDefault();
    candidateStrip.commitByKey(candidateKey);
  };

  const indentStyle = { marginLeft: `${depth * kRuleIndentStep}px` } as CSSProperties;
  const hasTiles = ruleHasTiles();
  // An empty rule reads no sentence of its own, so its line is the invitation to
  // compose one, standing at the only caret position such a rule has.
  const showComposerEntry = !stripTarget && !hasTiles;
  // A card with nothing below its tile row keeps a compact fixed height.
  const hasBodyBelowTiles = hasTiles || showComposerEntry || isComposing;

  // The rule's cells are registered with the page for as long as it renders them.
  const registerRule = pageGrid?.registerRule;
  const currentCellKey = selectedCell === undefined ? undefined : pageGridCellKey(selectedCell);
  const whenTileCount = ruleDef.when().tiles().size();
  const doTileCount = ruleDef.do().tiles().size();
  // The mode arming this rule, and whether its position admits another one. A
  // rule with nothing above it at its own level takes `when` alone.
  const triggerMode = ruleDef.trigger();
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is an intentional trigger signal
  const triggerState = useMemo(
    () => triggerSwitchState(ruleDef.trigger(), availableTriggerModes(ruleDef)),
    [ruleDef, revision]
  );
  // A capsule whose rule's own mode is the sole admitted one offers no choice
  // and stands no cell; every other state cycles, a mode the position rejects
  // included.
  const triggerSwitchable = triggerState !== "fixed";
  // The line stands for a rule reading a sentence, one being composed, and one
  // inviting a sentence; a rule holding no tiles and armed from the tray shows
  // none of the three.
  const hasSentence = hasTiles || isComposing || showComposerEntry;
  const cellDescriptor = useMemo(
    () => ({
      ruleId,
      whenTileCount,
      doTileCount,
      whenAppendable: appendable.whenSide,
      doAppendable: appendable.doSide,
      triggerSwitchable,
      hasSentence,
    }),
    [ruleId, whenTileCount, doTileCount, appendable.whenSide, appendable.doSide, triggerSwitchable, hasSentence]
  );
  useEffect(() => registerRule?.(cellDescriptor), [registerRule, cellDescriptor]);

  /** How the rule's sentence row reads, whichever of its two controls stands there. */
  const sentenceCellName = `Rule ${lineNumber} sentence`;

  /**
   * The grid attributes `cell` renders, painted in `shape` where the page's
   * selection rests on it. Undefined for a rule standing outside a page grid.
   */
  const cellProps = (cell: PageGridCell, shape: PageGridSelectionShape) => {
    if (pageGrid === undefined) return undefined;
    const key = pageGridCellKey(cell);
    const selected = key === currentCellKey;
    return {
      [kPageGridCellAttribute]: key,
      tabIndex: selected ? 0 : -1,
      ...pageGridSelectionProps(shape, selected),
    };
  };

  // True while the page's selection rests on this rule's sentence, which is
  // filled with the accent in place of the hover wash.
  const sentenceCellSelected = currentCellKey === pageGridCellKey({ kind: "sentence", ruleId });

  /**
   * A key pressed on the rule handle. Enter and a space pick the rule up, after
   * which the arrow keys move it; both keep their default from the handle
   * whether or not they pick anything up, so a space never scrolls the page.
   */
  const handleHandleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (isGrabbed) return;
    const withCommand = event.metaKey || event.ctrlKey;
    const grabs = decidePageGridGrab({ kind: "handle", ruleId }, { key: event.key, withCommand, placement: "on-cell" });
    if (grabs) pageGrid?.grabRule(ruleId);
  };

  /**
   * A key pressed on the trigger-mode switch. Enter and a space take its mode
   * one step forward and are consumed; every other key, the arrows included, is
   * left to the page's own selection.
   */
  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    pageGrid?.cycleTrigger(ruleId);
  };

  /**
   * A key pressed while the page's selection rests on one of this rule's cells:
   * Delete takes the cell's subject out, the clipboard keys copy, cut and paste
   * it, and the insertion chord puts a new rule after this one and composes it.
   * A key pressed on a control the cell holds belongs to that control.
   */
  const handleCardKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (selectedCell === undefined) return;
    // A held rule reads its keys as moves; nothing operates on it until it is
    // set down.
    if (rulePickup.pickup !== null) return;
    const target = event.target as HTMLElement;
    const operation = decidePageGridOperation(selectedCell, {
      key: event.key,
      withCommand: event.metaKey || event.ctrlKey,
      placement: target.getAttribute(kPageGridCellAttribute) === currentCellKey ? "on-cell" : "inside-cell",
    });
    if (operation === undefined) return;
    event.preventDefault();
    performOperation(operation);
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: changing to li requires restructuring BrainPageEditor */}
      <div
        ref={cardRef}
        className={`flex flex-col p-2 sm:p-3 mb-1 rounded-xl border border-border shadow-(--shadow-brain-rule) hover:shadow-md transition-shadow w-fit relative${hasBodyBelowTiles ? "" : " h-30"}${isDragging ? ` ${kRuleChromeLayer}` : ""}`}
        style={{
          ...indentStyle,
          background: `${isGrabbed ? "linear-gradient(0deg, rgb(255 255 255 / 0.14), rgb(255 255 255 / 0.14)), " : ""}linear-gradient(55deg, var(--color-brain-rule-from) 0%, var(--color-brain-rule-to) 100%)`,
          opacity: isDragging ? 0.85 : undefined,
          transform: isDragging ? "scale(1.02)" : undefined,
          transition: isDragging ? "none" : "transform 120ms ease, opacity 120ms ease",
        }}
        data-rule-id={ruleDef.ruleId()}
        role="listitem"
        aria-label={`Rule ${lineNumber}${isDirty ? " (modified)" : ""}`}
        onDragOver={handleCandidateDragOver}
        onDrop={handleCandidateDrop}
        onKeyDown={handleCardKeyDown}
      >
        <div className="flex flex-1 gap-1">
          {/* this button is the rule handle */}
          <button
            type="button"
            className={`relative rounded-full self-center h-9 w-9 ${pillChromeClasses} hover:scale-105 ${pillTransitionClasses} font-semibold text-lg ${isDragging ? "cursor-grabbing" : "cursor-grab"}${isGrabbed ? ` ${kGrabbedRuleMarkerLayer}` : ""}`}
            data-rule-handle={ruleDef.ruleId()}
            aria-label={`Rule ${lineNumber} of ${ruleCount}, handle${isDirty ? ", unsaved changes" : ""}`}
            onPointerDown={handleHandlePointerDown}
            onKeyDown={handleHandleKeyDown}
            {...cellProps({ kind: "handle", ruleId }, "circle")}
          >
            {lineNumber}
            {isDirty && (
              <span
                className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-brain-amber border border-brain-ink"
                title="Has unsaved changes"
                aria-hidden="true"
              />
            )}
            {grabbedDirections && grabbedDirections.length > 0 && (
              <svg
                className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{ width: kRuleMoveMarkerOverlaySize, height: kRuleMoveMarkerOverlaySize }}
                viewBox={kRuleMoveMarkerOverlayViewBox}
                aria-hidden="true"
              >
                {grabbedDirections.map((direction) => (
                  <path
                    key={direction}
                    d={kRuleMoveMarkerPath}
                    transform={`rotate(${kRuleMoveMarkerRotations[direction]} 100 100)`}
                    className="fill-brain-pill stroke-brain-pill"
                    strokeWidth={kRuleMoveMarkerCorners}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    paintOrder="stroke fill"
                  />
                ))}
              </svg>
            )}
          </button>
          {/* The trigger-mode capsule, standing at the head of the WHEN side. A
              capsule offering a choice of mode is the switch that cycles it and
              stands the rule's trigger cell; one offering none is a static
              marker, as the DO capsule is. */}
          {triggerState === "fixed" ? (
            // biome-ignore lint/a11y/useSemanticElements: changing to fieldset requires restructuring tile layout
            <div
              className={`ml-2 ${triggerModeChrome[triggerMode]} ${kCapsuleClasses}`}
              style={{ writingMode: "vertical-rl" }}
              role="group"
              aria-label="When condition tiles"
            >
              <span className={`${kCapsuleLettersClasses} cursor-default`} aria-hidden="true">
                {stackedLetters(triggerModeLabel(triggerMode, localizer))}
              </span>
            </div>
          ) : (
            <div className={`relative ml-2 self-center ${kTriggerSwitchBoxClasses}`}>
              {triggerBadge && (
                <BrainBadge className={kTriggerBadgeClasses} message={triggerBadge.message}>
                  <CircleAlert className="w-4 h-4" />
                </BrainBadge>
              )}
              <button
                type="button"
                className={`${kCapsuleClasses} ${triggerModeChrome[triggerMode]} ${kTriggerSwitchClasses}`}
                style={{ writingMode: "vertical-rl" }}
                aria-label={triggerSwitchName(triggerMode, triggerState, localizer)}
                onClick={() => pageGrid?.cycleTrigger(ruleId)}
                onKeyDown={handleTriggerKeyDown}
                {...cellProps({ kind: "trigger", ruleId }, "capsule")}
              >
                <span className={kCapsuleLettersClasses} aria-hidden="true">
                  {stackedLetters(triggerModeLabel(triggerMode, localizer))}
                </span>
              </button>
            </div>
          )}
          {ruleDef
            .when()
            .tiles()
            .toArray()
            .map((tileDef, idx) => (
              <BrainTileEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: tiles have no stable IDs
                key={idx}
                tileDef={tileDef}
                tileIndex={idx}
                side={RuleSide.When}
                ruleDef={ruleDef}
                commandHistory={commandHistory}
                badge={whenBadges.get(idx)}
                stripTarget={stripTarget}
                armEditPoint={(position) => armTileEditPoint(RuleSide.When, idx, position, "tray")}
              />
            ))}
          {/* + Add tile button for when side. It stands mid-row, so a WHEN side
              the oracle offers nothing at keeps the button's footprint and hides
              the button in it: nothing right of it moves, and the control is
              unclickable, unfocusable, and unannounced. */}
          <div className="flex items-center">
            <button
              type="button"
              className={`${kAddButtonClasses}${appendable.whenSide ? "" : " invisible"}`}
              data-append-tile={RuleSide.When}
              onClick={handleAppendTileClick(RuleSide.When)}
              aria-label="Add tile to when condition"
              aria-expanded={offeredAppendSide === RuleSide.When}
              aria-controls={offeredAppendSide === RuleSide.When ? stripId : undefined}
              {...(appendable.whenSide
                ? cellProps({ kind: "append", ruleId, side: RuleSide.When }, "circle")
                : { tabIndex: -1 })}
            >
              <Plus className={`h-4 w-4 relative ${kRuleContentLayer}`} aria-hidden="true" />
            </button>
          </div>
          {/* Do tiles */}{" "}
          {/* biome-ignore lint/a11y/useSemanticElements: changing to fieldset requires restructuring tile layout */}{" "}
          <div
            className={`ml-3 ${kWhenCapsuleChrome} ${kCapsuleClasses}`}
            style={{ writingMode: "vertical-rl" }}
            role="group"
            aria-label="Do action tiles"
          >
            <span className={`${kCapsuleLettersClasses} cursor-default`} aria-hidden="true">
              {stackedLetters("Do")}
            </span>
          </div>
          {ruleDef
            .do()
            .tiles()
            .toArray()
            .map((tileDef, idx) => (
              <BrainTileEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: tiles have no stable IDs
                key={idx}
                tileDef={tileDef}
                tileIndex={idx}
                side={RuleSide.Do}
                ruleDef={ruleDef}
                commandHistory={commandHistory}
                badge={doBadges.get(idx)}
                stripTarget={stripTarget}
                armEditPoint={(position) => armTileEditPoint(RuleSide.Do, idx, position, "tray")}
              />
            ))}
          {/* + Add tile button for do side */}
          {appendable.doSide && (
            <div className="flex items-center">
              <button
                type="button"
                className={kAddButtonClasses}
                data-append-tile={RuleSide.Do}
                onClick={handleAppendTileClick(RuleSide.Do)}
                aria-label="Add tile to do action"
                aria-expanded={offeredAppendSide === RuleSide.Do}
                aria-controls={offeredAppendSide === RuleSide.Do ? stripId : undefined}
                {...cellProps({ kind: "append", ruleId, side: RuleSide.Do }, "circle")}
              >
                <Plus className={`h-4 w-4 relative ${kRuleContentLayer}`} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
        <BrainRuleSentence
          ruleDef={ruleDef}
          revision={revision}
          composerInput={strip.composerInput}
          caretPosition={composerCaret}
          pending={strip.pending}
          landingCount={strip.landingCount}
          pivotComma={isPivoted && ruleDef.do().tiles().size() === 0}
          placeCaret={placeSentenceCaret}
          cellName={sentenceCellName}
          onCellKeyDown={handleSentenceCellKeyDown}
        />
        {showComposerEntry && (
          <button
            type="button"
            onClick={() => enterSentence(undefined)}
            onKeyDown={handleSentenceCellKeyDown}
            data-sentence-composer-entry={ruleDef.ruleId()}
            aria-label={`${sentenceCellName}, empty. ${kComposerEntryPrompt}`}
            {...cellProps({ kind: "sentence", ruleId }, "line")}
            className={`relative ${kRuleContentLayer} mt-1.5 ml-11 flex min-h-8 cursor-text items-center rounded-sm px-1 text-left ${kSentenceTypeClasses} text-brain-ink/45 italic transition-colors hover:text-brain-ink/70${sentenceCellSelected ? "" : " hover:bg-brain-ink/5"}`}
          >
            {kComposerEntryPrompt}
          </button>
        )}
        {/* The box the offering stands in: the page's rail holds it, pinned
            sideways against the scrollport and inset to the rules list's
            content edge, at the height this card's bottom edge stands at. It
            stays this card's own child in the React tree, so what it raises --
            a chip dropped on it, a key pressed in it -- reaches the card's
            handlers. A rule standing outside a page has no rail to hand its
            offering to, and reads it at the foot of its own card. */}
        {offeringRail === null
          ? strip.panel
          : offeringStands &&
            createPortal(
              <div ref={offeringBoxRef} className="absolute inset-x-2 sm:inset-x-4">
                {strip.panel}
              </div>,
              offeringRail
            )}
        {showCreateVariableDialog && (
          <CreateVariableDialog
            isOpen={showCreateVariableDialog}
            title={variableDialogTitle}
            onOpenChange={(open) => {
              if (!open) handleVariableDialogClose();
            }}
            onCloseAutoFocus={handleCreateDialogCloseAutoFocus}
            onSubmit={handleVariableNameSubmit}
          />
        )}
        {showCreateLiteralDialog && (
          <CreateLiteralDialog
            isOpen={showCreateLiteralDialog}
            title={literalDialogTitle}
            literalType={literalType}
            initialValue={literalSeed?.value}
            initialName={openedLiteralName()}
            onOpenChange={(open) => {
              if (!open) handleLiteralDialogClose();
            }}
            onCloseAutoFocus={handleCreateDialogCloseAutoFocus}
            onSubmit={handleLiteralValueSubmit}
          />
        )}
        {literalEdit && (
          <CreateLiteralDialog
            isOpen
            title="Edit Value"
            literalType={literalEdit.editor.literalDef.valueType}
            initialValue={literalEdit.editor.literalDef.value}
            initialName={literalWord(literalEdit.editor.literalDef)}
            onOpenChange={(open) => {
              if (!open) setLiteralEdit(undefined);
            }}
            onCloseAutoFocus={handleLiteralEditCloseAutoFocus}
            onSubmit={handleLiteralEditSubmit}
          />
        )}
      </div>
    </>
  );
}

const BrainRuleEditorMemoCard = memo(BrainRuleEditorCard);

BrainRuleEditorMemoCard.displayName = "BrainRuleEditorCard";

/**
 * Editable WHEN/DO rule row: the rule's handle, the tiles of each side with the
 * control that appends to it, and the sentence line the rule is composed on.
 * The handle is dragged to reorder and picked up from the keyboard, and the
 * page's selection keys operate on whichever of the rule's cells it rests on.
 *
 * Reads the editor's arming and hands the card only the part of it that names
 * this rule, so the card renders again only when one of its props changes,
 * `revision` and that arming among them, or when a context the card itself
 * reads publishes a new value. A page change that leaves this rule's revision
 * alone therefore costs it nothing, a move of the page's selection costs only
 * the two rules it passes between, and an arming -- including every step of a
 * caret being composed -- costs only the rule armed and the one it left.
 */
export function BrainRuleEditor(props: BrainRuleEditorProps) {
  const { target } = useArmedTargetController();
  // The strip serves every armed mode for this rule: the append flow armed on
  // the card, and the insert/replace flows armed by the rule's tile editors.
  const stripTarget = armedTargetForRule(target, props.ruleDef);
  return <BrainRuleEditorMemoCard {...props} stripTarget={stripTarget} />;
}
