import { List, type ReadonlyBitSet, type ReadonlyList, type UniqueSet } from "@wendoo/core";
import { type IBrainTileDef, type ITileCatalog, RuleSide } from "@wendoo/core/brain";
import { buildInsertionContext, suggestTiles, type TileSuggestion } from "@wendoo/core/brain/language-service";
import type { BrainRuleDef } from "@wendoo/core/brain/model";
import { manufactureLiteralTile, manufactureVariableTile } from "@wendoo/core/brain/tiles";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ArmedTileTarget, useArmedTargetActions } from "../ArmedTargetContext";
import { useBrainEditorConfig, useLocalizer } from "../BrainEditorContext";
import {
  arrangeCandidateSubcategories,
  buildStripCandidates,
  type CandidateCommitKey,
  type CandidateEntry,
  type CandidateSection,
  type CandidateSubcategory,
  categoryPriorityCandidateRanker,
  decideCandidateCommit,
  groupStripCandidates,
  mintTextLiteralCandidate,
  offersTextLiteral,
  positionTakesLiteralOfType,
  resolveStripOffering,
  type StripCandidate,
  shouldOrderPagesFirst,
  toCandidateEntries,
} from "../candidate-strip-model";
import { takenLiteralNamesAround } from "../literal-naming";
import { literalForkSeed, type StripCommand, StripCommandKinds, stripCommands } from "../strip-commands";
import { type LiteralValueEditor, literalValueEditor } from "../tile-menu-model";
import { resolveTileVisual } from "../tile-visual-utils";

/** How many candidates the flat best-next row offers before the accordion takes over. */
export const kBestNextCandidateCount = 6;

/** Inputs {@link useCandidateStrip} resolves the offering from. */
export interface UseCandidateStripOptions {
  /** The rule owning the armed target. */
  ruleDef: BrainRuleDef;
  /** The armed target the offering is computed for; null offers nothing. */
  target: ArmedTileTarget | null;
  /** The catalogs the offering is drawn from, host catalogs plus the brain's own. */
  catalogs: ReadonlyList<ITileCatalog>;
  availableCapabilities?: ReadonlyBitSet;
  availableOutputKeys?: UniqueSet<string>;
  /** The rule's revision, from `ruleRevisions`; re-queries the oracle when it changes. */
  revision: string;
  /** Called after each placement the strip completes, whichever commit path made it. */
  onCommitted?: () => void;
  /**
   * Opens the value editor on the literal the armed position stands on, which
   * the offering's edit command runs.
   */
  onEditLiteral: (editor: LiteralValueEditor, side: RuleSide, tileIndex: number) => void;
}

/** One accordion section of the offering: the whole group, plus the entries matching the filter. */
export interface CandidateStripSection extends Omit<CandidateSection, "candidates"> {
  /**
   * The section's matching entries arranged into provenance clusters. Empty when
   * the filter excludes the whole group.
   */
  readonly subcategories: readonly CandidateSubcategory[];
  /**
   * The section's candidates that match the current filter, in the order the
   * subcategories render them, so the keyboard walks the chips as they are drawn.
   */
  readonly entries: readonly CandidateEntry[];
  /** How many candidates the group holds regardless of the filter. */
  readonly totalCount: number;
}

/** The offering at the armed position plus the filter and commit surface the strip renders. */
export interface CandidateStripState {
  /** The leading cross-category entries, capped at {@link kBestNextCandidateCount}. */
  readonly bestNext: readonly CandidateEntry[];
  /** The filtered offering partitioned into accordion sections. */
  readonly sections: readonly CandidateStripSection[];
  /** The current filter text; every keystroke narrows the offering. */
  readonly filter: string;
  /**
   * True while the armed position offers at least one tile, filter text aside;
   * the strip's panel stands only while it is. False while nothing is armed,
   * and at a position the oracle offers nothing at.
   */
  readonly offeringOpen: boolean;
  /** True when the filter text names nothing the strip can place, as opposed to naming nothing yet. */
  readonly isUnknown: boolean;
  /**
   * The commands the armed position offers over the literal it stands on, in
   * the order they lead the offering's leading row.
   */
  readonly commands: readonly StripCommand[];
  /** Run `command`, which opens the value editor it names. */
  runCommand(command: StripCommand): void;
  /** True when the armed position accepts a text literal, so a typed quote opens one. */
  readonly acceptsTextLiteral: boolean;
  /**
   * The candidate a text value of `value` places at the armed position, or
   * undefined when the position accepts no text literal.
   */
  textLiteralCandidate(value: string): StripCandidate | undefined;
  setFilter(next: string): void;
  /** Place `candidate` at the armed position through the target's selection callback. */
  commit(candidate: StripCandidate): void;
  /** Place the candidate with `candidateKey`, ignoring keys absent from the offering. */
  commitByKey(candidateKey: string): void;
  /** The candidate a commit key places, or undefined when the key must not commit. */
  candidateFromKey(key: CandidateCommitKey): StripCandidate | undefined;
}

/**
 * Query the suggestion oracle for the armed position and expose the filter and
 * commit surface the inline candidate strip renders. Committing routes through
 * the armed target's selection callback, so the placement runs the same command
 * and factory-deferral path the caller armed with. A minted candidate is
 * manufactured and registered first, so what reaches that callback is always a
 * catalog tile. In append mode the target is re-armed after each placement so
 * composition continues at the next position.
 *
 * {@link CandidateStripState.offeringOpen} is read off that same query rather
 * than held: the offering stands exactly where the armed position offers a tile,
 * so a position the oracle offers nothing at never opens one, and a placement or
 * a move that leaves the position offering nothing closes the one standing.
 */
export function useCandidateStrip({
  ruleDef,
  target,
  catalogs,
  availableCapabilities,
  availableOutputKeys,
  revision,
  onCommitted,
  onEditLiteral,
}: UseCandidateStripOptions): CandidateStripState {
  const editorConfig = useBrainEditorConfig();
  const { brainServices } = editorConfig;
  const armedTarget = useArmedTargetActions();
  const [filter, setFilter] = useState("");
  const [commitCounter, setCommitCounter] = useState(0);

  // Re-arming for a different position starts a fresh word in progress.
  // biome-ignore lint/correctness/useExhaustiveDependencies: target is an intentional trigger signal
  useEffect(() => {
    setFilter("");
  }, [target]);

  // Every chip carries its tile's resolved label, which is also the text the filter matches.
  const labelOf = useCallback(
    (tileDef: IBrainTileDef) => resolveTileVisual(editorConfig, tileDef).label,
    [editorConfig]
  );

  // Matching normalizes the typed text and every candidate text through the
  // active locale's search fold.
  const localizer = useLocalizer();
  const foldText = useCallback((text: string) => localizer.foldForSearch(text), [localizer]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and commitCounter are intentional re-query signals
  const { candidates, pagesFirst } = useMemo(() => {
    if (!target) return { candidates: [] as StripCandidate[], pagesFirst: false };
    const tileSet = target.side === RuleSide.When ? ruleDef.when() : ruleDef.do();
    const isInsert = target.mode === "insert";
    const isReplace = target.mode === "replace";
    const existingTiles = isInsert ? tileSet.tiles().slice(0, target.tileIndex ?? 0) : tileSet.tiles();
    const replaceTileIndex = isReplace ? target.tileIndex : undefined;
    const context = buildInsertionContext({
      side: target.side,
      expr: isInsert ? undefined : tileSet.expr(),
      replaceTileIndex,
      availableCapabilities,
      availableOutputKeys,
      ruleDef,
      existingTiles,
    });
    const result = brainServices
      ? suggestTiles(context, catalogs, brainServices)
      : { exact: List.empty<TileSuggestion>(), withConversion: List.empty<TileSuggestion>() };
    return {
      candidates: buildStripCandidates(result, labelOf),
      pagesFirst: shouldOrderPagesFirst(existingTiles.toArray(), replaceTileIndex),
    };
  }, [
    ruleDef,
    target,
    availableCapabilities,
    availableOutputKeys,
    catalogs,
    brainServices,
    labelOf,
    revision,
    commitCounter,
  ]);

  // The offering stands exactly where the armed position offers a tile, read off
  // the same query the chips are built from. A host that supplies no brain
  // services cannot be asked, so its offering stands open.
  const offeringOpen = target !== null && (brainServices === undefined || candidates.length > 0);

  const ranked = useMemo(
    () => categoryPriorityCandidateRanker(candidates, target, { projectNamespace: editorConfig.projectNamespace }),
    [candidates, target, editorConfig.projectNamespace]
  );

  const offering = useMemo(
    () => resolveStripOffering(ranked, filter, labelOf, foldText),
    [ranked, filter, labelOf, foldText]
  );
  const { offered, visible } = offering;

  const bestNext = useMemo(() => toCandidateEntries(visible.slice(0, kBestNextCandidateCount)), [visible]);
  const sections = useMemo(() => {
    const matchesByGroup = new Map(
      groupStripCandidates(visible, pagesFirst).map((section) => [section.key, section.candidates])
    );
    const provenance = { projectNamespace: editorConfig.projectNamespace };
    return groupStripCandidates(offered, pagesFirst).map((section) => {
      const subcategories = arrangeCandidateSubcategories(
        toCandidateEntries(matchesByGroup.get(section.key) ?? []),
        provenance,
        editorConfig.libraries
      );
      return {
        key: section.key,
        group: section.group,
        subcategories,
        entries: subcategories.flatMap((subcategory) => subcategory.entries),
        totalCount: section.candidates.length,
      };
    });
  }, [offered, visible, pagesFirst, editorConfig.projectNamespace, editorConfig.libraries]);

  // The tile the offering's commands act on: the one being replaced, and the
  // one an edit point's insert positions turn about.
  const anchorTileIndex = target?.anchorTileIndex ?? (target?.mode === "replace" ? target.tileIndex : undefined);
  const anchorTileDef =
    target !== null && anchorTileIndex !== undefined
      ? ruleDef.side(target.side).tiles().at(anchorTileIndex)
      : undefined;
  const anchorEditor = useMemo(
    () =>
      anchorTileDef === undefined
        ? undefined
        : literalValueEditor(
            anchorTileDef,
            editorConfig.customLiteralTypes,
            brainServices?.edit.tiles,
            ruleDef.brain()?.catalog()
          ),
    [anchorTileDef, editorConfig.customLiteralTypes, brainServices, ruleDef]
  );
  const commands = useMemo(() => {
    if (target === null) return [];
    return stripCommands({
      mode: target.mode,
      standsOnLiteral: anchorEditor !== undefined,
      literalIsEditable: anchorEditor?.editable === true,
      positionTakesType:
        anchorEditor !== undefined && positionTakesLiteralOfType(candidates, anchorEditor.literalDef.valueType),
    });
  }, [target, anchorEditor, candidates]);

  const runCommand = useCallback(
    (command: StripCommand) => {
      if (target === null || anchorEditor === undefined || anchorTileIndex === undefined) return;
      if (command.kind === StripCommandKinds.Edit) {
        onEditLiteral(anchorEditor, target.side, anchorTileIndex);
        return;
      }
      const taken = takenLiteralNamesAround(
        editorConfig.tileCatalogs,
        ruleDef.brain()?.catalog(),
        anchorEditor.literalDef.valueType
      );
      target.onTileSelected(anchorEditor.factory, literalForkSeed(anchorEditor.literalDef, taken));
    },
    [target, anchorEditor, anchorTileIndex, onEditLiteral, editorConfig.tileCatalogs, ruleDef]
  );

  const commit = useCallback(
    (candidate: StripCandidate) => {
      if (!target) return;
      let tileDef = candidate.tileDef;
      if (candidate.origin.kind === "minted-literal") {
        const registered = manufactureLiteralTile(
          candidate.origin.factoryTileDef,
          ruleDef.brain()?.catalog(),
          candidate.origin.value,
          candidate.origin.displayFormat
        );
        if (!registered) return;
        tileDef = registered;
      } else if (candidate.origin.kind === "minted-variable") {
        const registered = manufactureVariableTile(
          candidate.origin.factoryTileDef,
          ruleDef.brain()?.catalog(),
          candidate.origin.varName
        );
        if (!registered) return;
        tileDef = registered;
      }
      const completed = target.onTileSelected(tileDef);
      setFilter("");
      if (!completed) return;
      onCommitted?.();
      setCommitCounter((count) => count + 1);
      // Appending continues at the next grammar position: re-arm the same
      // target so the strip re-queries the oracle and stays open. Insert and
      // replace complete with the placement.
      if (target.mode === "append") armedTarget.arm(target);
    },
    [ruleDef, target, armedTarget, onCommitted]
  );

  const commitByKey = useCallback(
    (candidateKey: string) => {
      const candidate = visible.find((entry) => entry.key === candidateKey);
      if (candidate) commit(candidate);
    },
    [visible, commit]
  );

  const candidateFromKey = useCallback(
    (key: CandidateCommitKey) => decideCandidateCommit(visible, filter, key, foldText),
    [visible, filter, foldText]
  );

  const acceptsTextLiteral = useMemo(() => offersTextLiteral(ranked), [ranked]);
  const textLiteralCandidate = useCallback(
    (value: string) => mintTextLiteralCandidate(ranked, value, labelOf),
    [ranked, labelOf]
  );

  return {
    bestNext,
    sections,
    commands,
    runCommand,
    filter,
    offeringOpen,
    isUnknown: offering.isUnknown,
    acceptsTextLiteral,
    textLiteralCandidate,
    setFilter,
    commit,
    commitByKey,
    candidateFromKey,
  };
}
