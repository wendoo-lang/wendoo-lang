import type { ProjectTile } from "@wendoo/assistant-bridge";
import type {
  ConversationAssistantEntry,
  ConversationEntry,
  ConversationRecord,
  ConversationTurnEnding,
} from "@wendoo/assistant-relay";
import { ConversationTurnFailureCode, NarrationRole, RelayTurnEndCode } from "@wendoo/assistant-relay";
import { RuleTriggerMode } from "@wendoo/core/brain";
import { kBrainDeskFill } from "@wendoo/ui/brain-editor/brain-desk";
import type { RenderMarkdownReference } from "@wendoo/ui/markdown/SafeMarkdown";
import { SafeMarkdown } from "@wendoo/ui/markdown/SafeMarkdown";
import { MarkdownReferenceForm } from "@wendoo/ui/markdown/safe-markdown-tokens";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { namedToolActivity } from "./conversation/activity";
import type {
  BuildBlock,
  ConversationBlock,
  NarrationBlock,
  OfferBlock,
  ReceiptBlock,
  ReceiptRule,
  RunBlock,
  SnagBlock,
  TranscriptContext,
} from "./conversation/blocks";
import { ConversationBlockKind, conversationBlocks, transcriptContext } from "./conversation/blocks";
import type { BrainPlaces } from "./conversation/brain-places";
import { BrainPlacesProvider, useBrainPlaces } from "./conversation/brain-places";
import type { EditSide } from "./conversation/edit-story";
import { exportTranscript } from "./conversation/export";
import { LibraryCard } from "./conversation/LibraryCard";
import type { LibraryOffers } from "./conversation/library-offers";
import { LibraryOffersProvider } from "./conversation/library-offers";
import type { RunCell, RunCellCall, RunEvidence, RunMarker } from "./conversation/run";
import { RunActivity, RunMarkerKind } from "./conversation/run";
import type { StandingState } from "./conversation/standing";
import { answerless, standingHolds, standingState } from "./conversation/standing";
import { ReferenceChip, TileChip } from "./conversation/TileChip";
import type { BrainSurface, TileLook } from "./conversation/tile-visuals";
import { BrainSurfaceProvider, unresolvedTileLook, useCallLooks, useTileLooks } from "./conversation/tile-visuals";
import type { PendingAsk, TurnDoing } from "./session/machine";
import { AssistantStatus } from "./session/machine";

/** What the conversation surface shows, and the controls it hands back. */
export interface ConversationViewProps {
  /** The name of the entity whose brain is open, as the host reads it from the document. */
  name: string;
  status: AssistantStatus;
  /** The conversation shown, absent before the host has named a brain. */
  record: ConversationRecord | undefined;
  /** What stands in the intent box. */
  intent: string;
  onIntentChange: (text: string) => void;
  /** Send {@link ConversationViewProps.intent}. Called only while the box holds something and no turn runs. */
  onSend: () => void;
  /**
   * What the person has typed while the running turn holds the floor, waiting
   * its turn, in the order they typed it. Absent stands nothing waiting.
   */
  pending?: readonly PendingAsk[] | undefined;
  /**
   * Take the waiting ask `id` names back, called when the person taps the
   * bubble it stands in. Absent leaves every waiting bubble untappable.
   */
  onCancelAsk?: ((id: string) => void) | undefined;
  /**
   * Take the waiting ask `id` names now, called when the person taps the control
   * standing beside its bubble: it jumps the queue and the running turn is
   * stopped for it. Absent leaves every waiting bubble's control unavailable.
   */
  onSendNow?: ((id: string) => void) | undefined;
  /** Ask the running turn to stop. */
  onStop: () => void;
  /** Open the session again after it failed; the retry control stands only when given. */
  onRetry?: (() => void) | undefined;
  /** Put the last thing the person asked for again; a broken-off turn offers it only when given. */
  onAskAgain?: (() => void) | undefined;
  /**
   * Hand the keyboard to whatever stands around the panel, called as it leaves
   * the intent box. Answers whether anything took it; the panel lands the
   * keyboard on itself when nothing did, and whenever this is not given.
   */
  onLeaveIntent?: (() => boolean) | undefined;
  /**
   * How many times the person themselves opened the panel. Each new count lands
   * the keyboard in the intent box. Absent for an open the person did not ask
   * for, which lands the keyboard nowhere.
   */
  opensByPerson?: number | undefined;
  /**
   * The brain the tiles the assistant names are drawn against. Absent while the
   * host stands none, which reads every tile by the word the conversation
   * carried, with no icon and no hue of its own.
   */
  brainSurface?: BrainSurface | undefined;
  /**
   * Where the rules and pages the assistant names stand, and how to show one.
   * Absent while the host stands no editor, which numbers rules from what the
   * conversation itself has seen and leaves every reference untappable.
   */
  brainPlaces?: BrainPlaces | undefined;
  /**
   * The shelf the libraries the assistant offers are drawn against, and the
   * host's own install a tap on one runs. Absent leaves every offer inert.
   */
  libraryOffers?: LibraryOffers | undefined;
  /**
   * Send `text` as the person's own next ask, called when they tap one of the
   * answers a question offers. Absent leaves those answers untappable.
   */
  onAnswer?: ((text: string) => void) | undefined;
  /**
   * What the running turn is at -- the tool call the model is writing, or the
   * batch most recently served. The presence mark says it beside the dots
   * while the turn runs; absent says nothing.
   */
  doing?: TurnDoing | undefined;
}

/** Pixels of slack at the foot of the transcript that still count as being at the bottom. */
const bottomSlackPx = 24;

/** Milliseconds the mark that the conversation went to the clipboard stands for. */
const copiedMarkMs = 1200;

/** Animation offsets of the presence mark's dots, in the order they are drawn. */
const presenceDotDelays = ["0ms", "160ms", "320ms"] as const;

/**
 * The bubble every line of the assistant's own voice is drawn in: its narration,
 * its note about how a turn ended, and its presence mark.
 */
const assistantBubbleClasses = "max-w-[85%] self-start rounded-[14px] rounded-bl-[4px] bg-brain-ink/8 px-3 py-2";

/** The bubble what the person asked is drawn in, standing at the side of the transcript they speak from. */
const askBubbleClasses = "max-w-[85%] self-end rounded-[14px] rounded-br-[4px] bg-primary/20 px-3 py-2";

/** How much of itself an ask still waiting for its turn keeps on screen. */
const waitingAskClasses = "opacity-60";

/** The surface every block that is not the assistant's own voice is drawn on. */
const cardClasses = "w-full self-start rounded-[14px] border border-border bg-brain-ink/5 px-3 py-2";

/** How much of itself a block a later one stands in the place of keeps on screen. */
const supersededClasses = "opacity-60";

/**
 * The roles the transcript draws on a card of their own. The rest of what the
 * assistant says stands in its speaking bubble.
 */
const cardedRoles: readonly string[] = [
  NarrationRole.Plan,
  NarrationRole.Pivot,
  NarrationRole.Diagnosis,
  NarrationRole.Note,
  NarrationRole.Ask,
];

/** Pixels a rule is indented per rule it stands under. */
const ruleIndentPx = 16;

/** The gradient a rule is drawn on. */
const ruleCardFill = "linear-gradient(55deg, var(--color-brain-rule-from) 0%, var(--color-brain-rule-to) 100%)";

/**
 * How bright a stretch of a run reads, by what the brain was doing over it, as
 * the share of the panel's accent it is drawn in.
 */
const activityWeight: Record<RunActivity, number> = {
  quiet: 0.16,
  watching: 0.36,
  waiting: 0.58,
  acting: 0.92,
};

/** How tall a stretch of a run stands in the timeline, by what the brain was doing over it. */
const activityHeight: Record<RunActivity, string> = {
  quiet: "30%",
  watching: "52%",
  waiting: "72%",
  acting: "100%",
};

/** Hues the states of a run are drawn in, spread around the panel's own accent. */
const identityHues = 24;

/** The hue a state is drawn in, as degrees around the panel's accent. */
function identityTurn(identity: string | undefined): number {
  if (identity === undefined) return 0;
  const hashed = Number.parseInt(identity, 16);
  return Number.isNaN(hashed) ? 0 : (hashed % identityHues) * (360 / identityHues);
}

/** The fill one stretch of a run is drawn in: its state as a hue, what it did as a weight. */
function cellFill(cell: RunCell): string {
  return `oklch(from var(--color-brain-accent) l c calc(h + ${identityTurn(cell.identity)}) / ${activityWeight[cell.activity]})`;
}

/** The step a state is drawn at, which the same state comes back to whenever a run returns to it. */
function identityStep(identity: string | undefined): number {
  return identity === undefined ? 0 : identityTurn(identity) / (360 / identityHues);
}

/**
 * A block drawn as a card: the glance layer the reader takes in without
 * choosing to, and whatever fold stands beneath it.
 */
function Card({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <div data-assistant-card={kind} className={`${cardClasses} flex flex-col gap-1.5`}>
      {children}
    </div>
  );
}

/**
 * The chevron a fold's expander ends with: pointing right while the fold is
 * closed, down while it stands open. Rotation keys on the summary's own open
 * details, so nested folds each turn their own chevron.
 */
function FoldChevron() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-3 shrink-0 transition-transform [details[open]>summary_&]:rotate-90"
    >
      <path
        d="M6 4l4 4-4 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A disclosure the reader opens to read the long form of the block it sits in.
 * Whether it stands open is held by the element itself.
 */
function Fold({ kind, summary, children }: { kind: string; summary: string; children: ReactNode }) {
  return (
    <details data-assistant-fold={kind} className="text-xs text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1 pointer-coarse:min-h-11 pointer-coarse:py-2">
        {summary}
        <FoldChevron />
      </summary>
      <div className="mt-1 flex flex-col gap-0.5 border-border border-l pl-2">{children}</div>
    </details>
  );
}

/** The number a rule stands at on its page, drawn as a pill. */
function LinePill({ line }: { line: number }) {
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-brain-pill-edge bg-brain-pill font-semibold text-[11px] text-brain-pill-ink"
      aria-hidden="true"
    >
      {line}
    </span>
  );
}

/** The word the trigger band's capsule stands for each mode. */
const triggerCapWords: Record<RuleTriggerMode, string> = {
  [RuleTriggerMode.When]: "WHEN",
  [RuleTriggerMode.Otherwise]: "ELSE",
  [RuleTriggerMode.Then]: "THEN",
};

/** The fill, rim, and letters the DO band's capsule wears. */
const doCapChrome = "bg-brain-capsule border-brain-capsule-edge text-brain-capsule-ink";

/** The fill, rim, and letters the trigger band's capsule wears for each mode. */
const triggerCapChrome: Record<RuleTriggerMode, string> = {
  [RuleTriggerMode.When]: doCapChrome,
  [RuleTriggerMode.Otherwise]:
    "bg-brain-capsule-otherwise border-brain-capsule-otherwise-edge text-brain-capsule-otherwise-ink",
  [RuleTriggerMode.Then]: "bg-brain-capsule-then border-brain-capsule-then-edge text-brain-capsule-then-ink",
};

/** Everything a side capsule wears but its fill, rim, and letter colors. */
const capsuleClasses =
  "inline-flex shrink-0 items-center rounded-sm rounded-l-md border px-1 py-px font-semibold text-[10px] tracking-wide";

/** The compact capsule opening one side of a rule, reading the trigger mode's word or DO. */
function SideCap({ word, chrome }: { word: string; chrome: string }) {
  return (
    <span className={`${capsuleClasses} ${chrome}`} aria-hidden="true">
      {word}
    </span>
  );
}

/**
 * One side of a rule: the capsule opening it, and the tiles standing on it,
 * wrapping as one band. A band holding no tiles draws nothing unless
 * `standsEmpty`, which stands it on its capsule alone.
 */
function RuleBand({
  side,
  word,
  chrome,
  standsEmpty,
  tiles,
  looks,
}: {
  side: EditSide;
  word: string;
  chrome: string;
  /** Draw the band on its capsule alone when it holds no tiles. */
  standsEmpty: boolean;
  tiles: readonly ProjectTile[];
  looks: readonly TileLook[];
}) {
  if (tiles.length === 0 && !standsEmpty) return null;
  return (
    <span data-assistant-side={side} className="flex flex-wrap items-center gap-1">
      <SideCap word={word} chrome={chrome} />
      {tiles.map((tile, at) => (
        <TileChip key={`${tile.tileId}-${at}`} tileId={tile.tileId} look={looks[at] as TileLook} />
      ))}
    </span>
  );
}

/** How the trigger mode reads aloud, ahead of the tiles gating the rule. */
const triggerReadings: Record<RuleTriggerMode, string> = {
  [RuleTriggerMode.When]: "when",
  [RuleTriggerMode.Otherwise]: "otherwise",
  [RuleTriggerMode.Then]: "then",
};

/**
 * How a rule reads aloud, for a reader who is given the whole line at once. A
 * rule in a mode other than `when` opens on the mode's word, whether or not it
 * carries any WHEN-side tiles.
 */
function ruleReading(trigger: RuleTriggerMode, when: readonly TileLook[], done: readonly TileLook[]): string {
  const words = (looks: readonly TileLook[]): string => looks.map((look) => look.label).join(", ");
  const mode = triggerReadings[trigger];
  const parts: string[] = [];
  if (when.length > 0) parts.push(`${mode} ${words(when)}`);
  else if (trigger !== RuleTriggerMode.When) parts.push(mode);
  if (done.length > 0) parts.push(`do ${words(done)}`);
  return parts.join(", ");
}

/**
 * One rule a receipt shows, standing in as far as the rules it is nested under:
 * its number where the conversation has seen the page it stands on, and one
 * wrapping band of chips per side, each opened by that side's capsule.
 */
function RuleCard({ rule, context }: { rule: ReceiptRule; context: TranscriptContext }) {
  const look = useTileLooks();
  const when = rule.when.map((tile) => look(tile.tileId, "when") ?? unresolvedTileLook(tile.label));
  const done = rule.do.map((tile) => look(tile.tileId, "do") ?? unresolvedTileLook(tile.label));
  const line = context.ruleLines.get(rule.ruleId);
  return (
    <div
      data-assistant-rule={rule.ruleId}
      data-assistant-rule-depth={rule.depth}
      data-assistant-rule-trigger={rule.trigger}
      role="img"
      aria-label={ruleReading(rule.trigger, when, done)}
      style={{ marginLeft: rule.depth * ruleIndentPx, background: ruleCardFill }}
      className="flex items-start gap-1.5 rounded-lg border border-border px-1.5 py-1 text-sm shadow-sm"
    >
      {line !== undefined && (
        <span className="flex h-5 items-center">
          <LinePill line={line} />
        </span>
      )}
      <span className="flex min-w-0 flex-col gap-0.5">
        <RuleBand
          side="when"
          word={triggerCapWords[rule.trigger]}
          chrome={triggerCapChrome[rule.trigger]}
          standsEmpty={rule.trigger !== RuleTriggerMode.When}
          tiles={rule.when}
          looks={when}
        />
        <RuleBand side="do" word="DO" chrome={doCapChrome} standsEmpty={false} tiles={rule.do} looks={done} />
      </span>
    </div>
  );
}

/**
 * Draws each thing the assistant names in its own words as the chip its surface
 * stands for it: a tile as its own chip, a rule as its number, and a page as its
 * name. A rule is numbered from the document the host stands where there is one,
 * and from what the conversation itself has seen where there is not; a chip the
 * host can show is one the person can tap. A reference to something neither has
 * ever seen is left to the unresolved form the renderer falls back to.
 */
function useReferenceRenderer(context: TranscriptContext): RenderMarkdownReference {
  const look = useTileLooks();
  const places = useBrainPlaces();
  return useCallback(
    (span) => {
      if (span.form === MarkdownReferenceForm.Tile) {
        const word = context.labels.get(span.id);
        const found = look(span.id) ?? (word === undefined ? undefined : unresolvedTileLook(word));
        return found === undefined ? undefined : <TileChip tileId={span.id} look={found} />;
      }
      if (span.form === MarkdownReferenceForm.Page) {
        const page = context.pages.get(span.id);
        if (page === undefined) return undefined;
        const show = places === undefined ? undefined : () => places.reveal({ pageId: span.id });
        return <ReferenceChip form={span.form} id={span.id} label={page.name} onActivate={show} />;
      }
      const placed = places?.locateRule(span.id);
      const line = placed?.line ?? context.ruleLines.get(span.id);
      if (line === undefined) return undefined;
      const show =
        placed === undefined || places === undefined
          ? undefined
          : () => places.reveal({ pageId: placed.pageId, ruleId: span.id });
      return <ReferenceChip form={span.form} id={span.id} label={`rule ${line}`} onActivate={show} />;
    },
    [look, places, context]
  );
}

/** What the edits gathered on one page left standing, and the story of how they got there. */
function ReceiptView({ block, context }: { block: ReceiptBlock; context: TranscriptContext }) {
  return (
    <Card kind={ConversationBlockKind.Receipt}>
      <div
        data-assistant-glance
        {...(block.page ? { "data-assistant-receipt-page": block.page.pageId } : {})}
        data-assistant-receipt-edits={block.story.length}
        {...(block.compiles ? { "data-assistant-compiles": "ok" } : {})}
        className="flex flex-col gap-1.5"
      >
        <p className="text-card-foreground text-sm">{block.page ? block.page.name : "In your rules"}</p>
        {block.rules.map((rule) => (
          <RuleCard key={rule.ruleId} rule={rule} context={context} />
        ))}
      </div>
      {block.story.length > 0 && (
        <Fold kind="edits" summary={`${block.story.length} edits`}>
          {block.story.map((row, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a story only ever appends, so a row keeps its position
            <p key={`edit-${at}`} data-assistant-step={row.op}>
              {row.text}
              {row.side && ` (${row.side})`}
            </p>
          ))}
        </Fold>
      )}
    </Card>
  );
}

/**
 * One way a proposal was refused, and how many proposals asked for that very
 * thing. The assistant's own words about the refusal stand as the line the card
 * reads as where it said any; the fixed line stands where it has not.
 */
function SnagView({ block, context }: { block: SnagBlock; context: TranscriptContext }) {
  const look = useTileLooks();
  const renderReference = useReferenceRenderer(context);
  return (
    <Card kind={ConversationBlockKind.Snag}>
      <div
        data-assistant-glance
        data-assistant-snag={block.code}
        data-assistant-snag-repeats={block.repeats}
        {...(block.ruleId ? { "data-assistant-snag-rule": block.ruleId } : {})}
        {...(block.tileId ? { "data-assistant-snag-tile": block.tileId } : {})}
        {...(block.caption === undefined ? {} : { "data-assistant-snag-captioned": "true" })}
        className="flex flex-wrap items-center gap-1.5 text-card-foreground text-sm"
      >
        {block.caption === undefined ? (
          <>
            <span>Hit a wall:</span>
            {block.tileId && (
              <TileChip
                tileId={block.tileId}
                look={look(block.tileId, "do") ?? unresolvedTileLook(block.tileLabel ?? block.tileId)}
              />
            )}
            <span>does not fit there.</span>
          </>
        ) : (
          <span className="grow">
            <SafeMarkdown text={block.caption} renderReference={renderReference} />
          </span>
        )}
        {block.repeats > 1 && <span className="text-muted-foreground text-xs">{`(x${block.repeats})`}</span>}
      </div>
      <Fold kind="diagnostic" summary="what the editor said">
        {block.captionBody !== undefined && <div data-assistant-snag-caption-body>{block.captionBody}</div>}
        {Object.entries(block.params).map(([key, value]) => (
          <p key={key} data-assistant-diag-param={key}>
            {`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`}
          </p>
        ))}
      </Fold>
    </Card>
  );
}

/** The word a page reads by at the position a run named it, and its position when nothing named it. */
function pageWord(at: number, context: TranscriptContext): string {
  return context.pageNames.get(at) ?? `page ${at}`;
}

/** The hairline a marker draws on the timeline, echoed beside its words. */
function MarkerTick() {
  return <span aria-hidden="true" className="mr-1.5 inline-block h-3 w-0.5 translate-y-0.5 bg-brain-ink/70" />;
}

/** What one marker on a run's timeline stands for, for the reader. */
function markerText(marker: RunMarker, context: TranscriptContext): string {
  if (marker.kind === RunMarkerKind.Page) {
    const entered = pageWord(marker.toPage ?? 0, context);
    return marker.fromPage === undefined ? `to ${entered}` : `${pageWord(marker.fromPage, context)} -> ${entered}`;
  }
  return `${marker.inputKind ?? ""} = ${marker.inputValue ?? ""}`;
}

/** The thinks one stretch of a run covers, as the fold names them. */
function cellThinks(cell: RunCell): string {
  return cell.thinks === 1 ? `think ${cell.from}` : `thinks ${cell.from}-${cell.from + cell.thinks - 1}`;
}

/** The words a run's timeline reads the things one of its stretches names by. */
interface CellWords {
  /** The word a rule reads by. */
  readonly rule: (ruleId: string) => string;
  /** The words one host call reads by. */
  readonly call: (made: RunCellCall) => string;
  /** Whether a call did something to the world, which a call the host says only reads did not. */
  readonly acted: (made: RunCellCall) => boolean;
}

/**
 * How the things a stretch of a run names read: a rule as the number it stands
 * at, a call as the word of the tile it is made by followed by the words it was
 * called with. A rule neither the host nor the conversation places reads as a
 * rule with no number of its own, and a call the host stands no tile for reads
 * by the key the run named it by and counts as having done something.
 */
function useCellWords(context: TranscriptContext): CellWords {
  const look = useCallLooks();
  const places = useBrainPlaces();
  return useMemo<CellWords>(
    () => ({
      rule: (ruleId) => {
        const line = places?.locateRule(ruleId)?.line ?? context.ruleLines.get(ruleId);
        return line === undefined ? "a rule" : `rule ${line}`;
      },
      call: (made) => [look(made.action)?.label ?? made.action, ...made.args].join(" "),
      acted: (made) => look(made.action)?.acts !== false,
    }),
    [look, places, context]
  );
}

/** What one stretch of a run did, as the words of the rules and calls behind it. */
function cellDoing(cell: RunCell, words: CellWords): string[] {
  const named = (ruleIds: readonly string[]): string => ruleIds.map((ruleId) => words.rule(ruleId)).join(", ");
  if (cell.activity === RunActivity.Quiet) return ["nothing to do"];
  const doing: string[] = [cell.activity];
  if (cell.activity === RunActivity.Watching && cell.held.length > 0) {
    doing.push(`${named(cell.held)} stayed false`);
  }
  if (cell.activity === RunActivity.Waiting && cell.waiting.length > 0) {
    doing.push(`${named(cell.waiting)} waiting to hear back`);
  }
  if (cell.activity === RunActivity.Acting) {
    const acted = cell.calls.filter((made) => words.acted(made));
    if (cell.fired.length > 0) {
      doing.push(cell.fired.map((ruleId) => `${words.rule(ruleId)} x${cell.thinks}`).join(", "));
    }
    if (acted.length > 0) doing.push(acted.map((made) => `${words.call(made)} x${made.count}`).join(", "));
  }
  return doing;
}

/**
 * What one stretch of a run says about itself to a reader who cannot see the
 * timeline: the thinks it covers, what the brain was doing over them, and the
 * rules and calls that made it that. A stretch the run changed state at closes
 * with the channels that changed, named and never valued.
 */
function cellReading(cell: RunCell, words: CellWords): string {
  const covered = cell.thinks === 1 ? cellThinks(cell) : `${cellThinks(cell)} (${cell.thinks})`;
  const changed =
    cell.changed === undefined
      ? []
      : [cell.changed.length === 0 ? "something about it changed" : `${cell.changed.join(", ")} changed`];
  return [covered, ...cellDoing(cell, words), ...changed].join(" - ");
}

/**
 * The edge a cell's note is hung from, as the Tailwind utility standing for it:
 * the note reaches inward from the timeline's near edge, so a stretch in the
 * first half of a run carries its words to the right and one in the second half
 * carries them to the left.
 */
function cellNoteSide(cell: RunCell, run: RunEvidence): string {
  return cell.from * 2 < run.thinks ? "left-0" : "right-0";
}

/**
 * The timeline of a run: one cell per stretch of thinks doing one thing in one
 * state, and one tick per marker, reading out what landed there on hover. A
 * cell shows the thinks it covers on rest and reads out by the fuller words of
 * what it did, so what it says on hover and what it says to a screen reader
 * deliberately differ.
 */
function RunTimeline({ run, context }: { run: RunEvidence; context: TranscriptContext }) {
  const uncovered = Math.max(run.thinks - run.covered, 0);
  const words = useCellWords(context);
  return (
    <div data-assistant-timeline={run.thinks} className="relative flex h-4 w-full items-end gap-px">
      {run.cells.map((cell) => {
        const reading = cellReading(cell, words);
        return (
          <span
            key={`cell-${cell.from}`}
            data-assistant-cell-activity={cell.activity}
            data-assistant-cell-thinks={cell.thinks}
            {...(cell.identity === undefined ? {} : { "data-assistant-cell-identity": identityStep(cell.identity) })}
            role="img"
            aria-label={reading}
            style={{ flexGrow: cell.thinks, height: activityHeight[cell.activity], background: cellFill(cell) }}
            className="group/cell relative min-w-0.75 rounded-xs"
          >
            <span
              data-assistant-cell-note
              className={`absolute bottom-full ${cellNoteSide(cell, run)} mb-1 hidden group-hover/cell:block whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-white text-xs shadow-lg pointer-events-none`}
            >
              {cellThinks(cell)}
            </span>
          </span>
        );
      })}
      {uncovered > 0 && (
        <span
          data-assistant-timeline-cut={uncovered}
          style={{ flexGrow: uncovered }}
          className="h-full min-w-0.75 rounded-xs border border-border border-dashed"
        />
      )}
      {run.markers.map((marker, at) => {
        const reading = `think ${marker.at}: ${markerText(marker, context)}`;
        return (
          <span
            key={`tick-${marker.kind}-${marker.at}-${at}`}
            data-assistant-marker={marker.kind}
            data-assistant-marker-at={marker.at}
            {...(marker.inputKind ? { "data-assistant-marker-kind": marker.inputKind } : {})}
            {...(marker.toPage === undefined ? {} : { "data-assistant-marker-page": marker.toPage })}
            role="img"
            aria-label={reading}
            style={{ left: `${(marker.at / Math.max(run.thinks, 1)) * 100}%` }}
            className="group/tick absolute top-0 bottom-0 -ml-1 flex w-2 justify-center"
          >
            <span aria-hidden="true" className="h-full w-0.5 bg-brain-ink/70" />
            <span
              data-assistant-marker-note
              className={`absolute bottom-full ${marker.at * 2 < run.thinks ? "left-0" : "right-0"} mb-1 hidden group-hover/tick:block whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-white text-xs shadow-lg pointer-events-none`}
            >
              {reading}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * The lines a run's record reads out, in think order: one per stretch of the
 * run and one per timeline marker, a marker standing before the stretch it
 * lands at the start of.
 */
function recordRows(run: RunEvidence): ({ kind: "cell"; cell: RunCell } | { kind: "marker"; marker: RunMarker })[] {
  const ordered = [
    ...run.markers.map((marker) => ({ at: marker.at, tie: 0, row: { kind: "marker", marker } as const })),
    ...run.cells.map((cell) => ({ at: cell.from, tie: 1, row: { kind: "cell", cell } as const })),
  ];
  ordered.sort((a, b) => a.at - b.at || a.tie - b.tie);
  return ordered.map((entry) => entry.row);
}

/**
 * One rehearsal a turn asked for: the line it reads as with the verdict the
 * assistant gave it, what the run did, and the whole record of it under a
 * fold. A rehearsal a later one stands in the place of keeps only its line,
 * opening to the rest of itself when the reader asks.
 */
function RunView({ block, context }: { block: RunBlock; context: TranscriptContext }) {
  const { run } = block;
  const ran = run.blocked === undefined;
  const pageChanges = run.markers.filter((marker) => marker.kind === RunMarkerKind.Page).length;
  const line = (
    <div className="flex items-baseline gap-2">
      <p className="grow text-card-foreground text-sm">{ran ? "Rehearsal" : "Rehearsal (did not run)"}</p>
      {ran && <span className="shrink-0 text-muted-foreground text-xs">{`${run.thinks} thinks`}</span>}
    </div>
  );
  const evidence = (
    <>
      {ran && <RunTimeline run={run} context={context} />}
      <div className="flex flex-wrap gap-x-3 text-muted-foreground text-xs">
        {run.asked !== undefined && run.asked !== run.thinks && (
          <span>{`stopped after ${run.thinks} of ${run.asked}`}</span>
        )}
        {pageChanges > 0 && <span>{`${pageChanges} page changes`}</span>}
        {run.covered < run.thinks && <span>the record stops part way</span>}
        {run.excludedRules.length > 0 && <span>{`${run.excludedRules.length} rules left out`}</span>}
      </div>
    </>
  );
  const record = run.cells.length > 0 && (
    <Fold kind="run" summary="run details">
      {recordRows(run).map((row, at) =>
        row.kind === "cell" ? (
          <p key={`step-${row.cell.from}`} data-assistant-run-step={row.cell.activity}>
            {`${cellThinks(row.cell)}: ${row.cell.activity}`}
          </p>
        ) : (
          <p key={`mark-${row.marker.kind}-${row.marker.at}-${at}`} data-assistant-record-marker={row.marker.kind}>
            <MarkerTick />
            {`think ${row.marker.at}: ${markerText(row.marker, context)}`}
          </p>
        )
      )}
      {run.dispatchTotals.map((total) => {
        const split = total.lastIndexOf("=");
        const call = split === -1 ? total : total.slice(0, split);
        return (
          <p
            key={`total-${total}`}
            data-assistant-dispatch={call}
            data-assistant-dispatch-count={total.slice(split + 1)}
          >
            {total}
          </p>
        );
      })}
      {run.world && (
        <p data-assistant-run-world={run.world.brainsExecuted}>
          {`${run.world.brainsExecuted} brains ran, ${run.world.initialPopulation} standing at the start and ${run.world.finalPopulation} at the end`}
        </p>
      )}
    </Fold>
  );
  const glance = {
    "data-assistant-glance": true,
    "data-assistant-run": run.runId,
    "data-assistant-run-state": ran ? "ran" : "blocked",
    ...(run.blocked === undefined ? {} : { "data-assistant-run-blocked": run.blocked }),
    ...(block.superseded ? { "data-assistant-run-superseded": "true" } : {}),
    ...(block.judgment ? { "data-assistant-run-judgment": block.judgment } : {}),
    "data-assistant-run-thinks": run.thinks,
    ...(run.asked === undefined || run.asked === run.thinks ? {} : { "data-assistant-run-asked": run.asked }),
    ...(run.covered < run.thinks ? { "data-assistant-run-truncated": "true" } : {}),
  };

  if (block.superseded) {
    return (
      <Card kind={ConversationBlockKind.Run}>
        <div {...glance} className={supersededClasses}>
          <details data-assistant-fold="earlier-run">
            <summary className="flex cursor-pointer list-none items-center gap-1 pointer-coarse:min-h-11 pointer-coarse:py-2">
              <div className="min-w-0 grow">{line}</div>
              <FoldChevron />
            </summary>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {evidence}
              {record}
            </div>
          </details>
        </div>
      </Card>
    );
  }
  return (
    <Card kind={ConversationBlockKind.Run}>
      <div {...glance} className="flex flex-col gap-1.5">
        {line}
        {evidence}
      </div>
      {record}
    </Card>
  );
}

/** One way a build came back dirty, and everything the builder reported about it. */
function BuildView({ block }: { block: BuildBlock }) {
  return (
    <Card kind={ConversationBlockKind.Build}>
      <div
        data-assistant-glance
        data-assistant-build-errors={block.errors}
        data-assistant-build-repeats={block.repeats}
        className="flex flex-wrap items-center gap-1.5 text-card-foreground text-sm"
      >
        <span>It does not build yet.</span>
        {block.repeats > 1 && <span className="text-muted-foreground text-xs">{`(x${block.repeats})`}</span>}
      </div>
      <Fold kind="build" summary="what the builder said">
        {block.diagnostics.map((diagnostic, at) => (
          <p
            // biome-ignore lint/suspicious/noArrayIndexKey: a build reports its diagnostics in a fixed order
            key={`diag-${at}`}
            data-assistant-build-diag={diagnostic.code}
            data-assistant-build-severity={diagnostic.severity}
            {...(diagnostic.ruleId ? { "data-assistant-build-rule": diagnostic.ruleId } : {})}
          >
            {`${diagnostic.severity} ${diagnostic.code}${diagnostic.ruleId ? ` in ${diagnostic.ruleId}` : ""}`}
          </p>
        ))}
      </Fold>
    </Card>
  );
}

/**
 * Where the whole conversation got to, standing above the note about how a turn
 * that left no answer ended.
 */
function GotToView({ state, context }: { state: StandingState; context: TranscriptContext }) {
  return (
    <Card kind="gotto">
      <div
        data-assistant-glance
        data-assistant-gotto-rules={state.rules}
        data-assistant-gotto-pages={state.pages.length}
        data-assistant-gotto-snags={state.snags}
        {...(state.builds === undefined ? {} : { "data-assistant-gotto-builds": state.builds ? "ok" : "no" })}
        className="flex flex-col gap-1.5"
      >
        <p className="text-card-foreground text-sm">Here is what you have so far.</p>
        {state.pages.map((page, at) => (
          <div key={`standing-${page.page?.pageId ?? at}`} className="flex flex-col gap-1">
            <p
              {...(page.page ? { "data-assistant-gotto-page": page.page.pageId } : {})}
              className="text-muted-foreground text-xs"
            >
              {page.page ? page.page.name : "In your rules"}
            </p>
            {page.rules.map((rule) => (
              <RuleCard key={rule.ruleId} rule={rule} context={context} />
            ))}
          </div>
        ))}
        <div className="flex flex-wrap gap-x-3 text-muted-foreground text-xs">
          {state.builds !== undefined && <span>{state.builds ? "it builds" : "it does not build yet"}</span>}
          {state.lastRun && (
            <span>
              {state.lastRun.blocked === undefined
                ? `last run: ${state.lastRun.thinks} thinks`
                : "the last run did not happen"}
            </span>
          )}
          {state.snags > 0 && <span>{`${state.snags} things the editor would not take`}</span>}
        </div>
      </div>
    </Card>
  );
}

/** What tapping one of a question's answers does, and whether it can be tapped now. */
interface Answering {
  /** Send `text` as the person's own next ask. */
  readonly send: (text: string) => void;
  /** `true` while a turn is running, when nothing can be sent. */
  readonly busy: boolean;
}

const AnsweringContext = createContext<Answering | undefined>(undefined);

/** How one chip standing under a question is drawn, whatever taking it does. */
const questionChipClasses =
  "shrink-0 rounded-md border border-border px-2 py-1 text-xs disabled:cursor-not-allowed " +
  "disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/** How one answer a question offers is drawn. */
const answerChipClasses = `${questionChipClasses} text-card-foreground`;

/** How the chip that leaves a question where it stands is drawn. */
const leaveChipClasses = `${questionChipClasses} text-muted-foreground`;

/**
 * What a question puts under itself: the answers it offers, each a shortcut to
 * giving it, and after them the panel's own chip for leaving the question where
 * it stands. Taking that chip clears the row and sends nothing, leaving the
 * question itself standing in the transcript. Every chip in the row stands
 * unavailable while a turn is running, and wherever the host takes no answers at
 * all.
 */
function AnswerChips({ answers }: { answers: readonly string[] }) {
  const answering = useContext(AnsweringContext);
  const busy = answering === undefined || answering.busy;
  const [left, setLeft] = useState(false);
  if (left) return null;
  return (
    <div data-assistant-answers={answers.length} className="flex flex-wrap gap-1.5">
      {answers.map((answer, at) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: the answers are read from one run of words and never reorder
          key={`answer-${at}`}
          type="button"
          data-assistant-answer
          disabled={busy}
          onClick={answering === undefined ? undefined : () => answering.send(answer)}
          className={answerChipClasses}
        >
          {answer}
        </button>
      ))}
      <button
        type="button"
        data-assistant-leave
        disabled={busy}
        onClick={() => setLeft(true)}
        className={leaveChipClasses}
      >
        leave it as is
      </button>
    </div>
  );
}

/**
 * A run of the assistant's own words: the headline it opens with, and the
 * longer form under a fold where it had one. The runs that carry the shape of
 * the work -- the plan it means to follow, what it learned, and a question it
 * puts to the person -- stand on a card of their own; everything else stands in
 * the assistant's speaking bubble. A question shows its chips in place of a
 * fold.
 */
function NarrationCardView({ block, context }: { block: NarrationBlock; context: TranscriptContext }) {
  const renderReference = useReferenceRenderer(context);
  const carded = block.role !== undefined && cardedRoles.includes(block.role);
  const surface = carded ? `${cardClasses} flex flex-col gap-1.5` : assistantBubbleClasses;
  return (
    <div
      data-assistant-card={ConversationBlockKind.Narration}
      {...(carded ? {} : { "data-assistant-bubble": "entity" })}
      {...(block.role ? { "data-assistant-narration-role": block.role } : {})}
      {...(block.judgment ? { "data-assistant-judgment": block.judgment } : {})}
      {...(block.superseded ? { "data-assistant-plan-superseded": "true" } : {})}
      {...(block.converted ? { "data-assistant-note-from": NarrationRole.Diagnosis } : {})}
      className={block.superseded ? `${surface} ${supersededClasses}` : surface}
    >
      <div data-assistant-narration className="text-card-foreground text-sm">
        <SafeMarkdown text={block.text} renderReference={renderReference} />
      </div>
      {block.role === NarrationRole.Ask && block.said !== undefined && (
        <div data-assistant-ask-said className="text-card-foreground text-sm">
          <SafeMarkdown text={block.said} renderReference={renderReference} />
        </div>
      )}
      {block.role === NarrationRole.Ask && <AnswerChips answers={block.answers ?? []} />}
      {block.body !== undefined && (
        <Fold kind="narration" summary="the long story">
          <div data-assistant-narration-body>
            <SafeMarkdown text={block.body} renderReference={renderReference} />
          </div>
        </Fold>
      )}
    </div>
  );
}

/**
 * The libraries a turn offered, drawn as the cards they are added from, in the
 * order the turn offered them. The block stands at the end of the turn, after
 * everything the assistant said and did.
 */
function OfferView({ block }: { block: OfferBlock }) {
  return (
    <div data-assistant-offers={block.coordinates.length} className="flex w-full flex-col self-start">
      {block.coordinates.map((coordinate) => (
        <LibraryCard key={coordinate} coordinate={coordinate} />
      ))}
    </div>
  );
}

/** One block of a turn, drawn in the idiom its kind reads in. */
function BlockView({ block, context }: { block: ConversationBlock; context: TranscriptContext }) {
  switch (block.kind) {
    case ConversationBlockKind.Narration:
      return <NarrationCardView block={block} context={context} />;
    case ConversationBlockKind.Receipt:
      return <ReceiptView block={block} context={context} />;
    case ConversationBlockKind.Snag:
      return <SnagView block={block} context={context} />;
    case ConversationBlockKind.Run:
      return <RunView block={block} context={context} />;
    case ConversationBlockKind.Build:
      return <BuildView block={block} />;
    case ConversationBlockKind.Offer:
      return <OfferView block={block} />;
  }
}

/**
 * What a key pressed in the intent box does: send the intent, leave the box,
 * swallow the key, or fall through to typing.
 */
export type IntentKeyAction = "send" | "leave" | "swallow" | "pass";

/**
 * Resolve a keydown in the intent box. Enter sends -- while a turn is running
 * the send queues, waiting its own turn -- and Shift+Enter falls through to
 * the newline it types; an Enter mid-IME-composition belongs to the
 * composition. A plain Enter with nothing but whitespace to send is swallowed,
 * keeping Shift+Enter the one newline gesture.
 *
 * Escape leaves the box, keeping what is typed in it; an Escape
 * mid-IME-composition belongs to the composition, which cancels on it.
 */
export function intentKeyAction(key: string, shiftKey: boolean, isComposing: boolean, intent: string): IntentKeyAction {
  if (isComposing) return "pass";
  if (key === "Escape") return "leave";
  if (key !== "Enter" || shiftKey) return "pass";
  if (intent.trim().length === 0) return "swallow";
  return "send";
}

/**
 * Land the keyboard in `box` for an open the person asked for, leaving what
 * stands around the box scrolled where it is. `opens` counts the opens the
 * person asked for; an absent count is an open they did not ask for, which
 * lands the keyboard nowhere.
 */
export function landKeyboardInIntent(box: HTMLTextAreaElement | null, opens: number | undefined): void {
  if (opens === undefined) return;
  box?.focus({ preventScroll: true });
}

/** How a turn cut short before the service could end it reads, by what cut it. */
function failureNote(code: ConversationTurnFailureCode): string {
  switch (code) {
    case ConversationTurnFailureCode.NotConnected:
      return "I could not hear you just then.";
    case ConversationTurnFailureCode.Disconnected:
      return "I lost my connection, so I stopped there.";
    case ConversationTurnFailureCode.ToolServingFailed:
      return "Something went wrong while I was working, so I stopped there. Ask me again?";
  }
}

/** How a turn that did not simply finish reads, and `undefined` for one that did. */
function endingNote(ending: ConversationTurnEnding): string | undefined {
  if (ending.kind === "failure") return failureNote(ending.code);
  switch (ending.code) {
    case RelayTurnEndCode.Complete:
      return undefined;
    case RelayTurnEndCode.Stopped:
      return "I stopped there.";
    case RelayTurnEndCode.Truncated:
      return "I lost my train of thought. Ask me again?";
    case RelayTurnEndCode.Failed:
      return "I could not finish that one.";
    case RelayTurnEndCode.LeaseExhausted:
      return "I reached this session's usage limit, so I stopped there.";
  }
}

/** Whether `ending` is the assistant breaking off mid-answer, which offers to be asked again. */
function brokeOff(ending: ConversationTurnEnding): boolean {
  if (ending.kind === "failure") return ending.code === ConversationTurnFailureCode.ToolServingFailed;
  return ending.code === RelayTurnEndCode.Truncated;
}

/** How the session's own state reads while it is not simply ready. */
function connectionNote(status: AssistantStatus): string | undefined {
  if (status === AssistantStatus.Connecting) return "Waking up...";
  if (status === AssistantStatus.Failed) return "I cannot hear you right now.";
  return undefined;
}

/**
 * The tool a turn's activity is named by -- the one being written, or the first
 * of the batch being served -- and `undefined` for an activity naming none.
 */
function doingTool(doing: TurnDoing | undefined): string | undefined {
  if (doing === undefined || doing.kind === "planning") return undefined;
  return doing.kind === "writing" ? doing.tool : doing.tools[0];
}

/**
 * How far a tool call being written has got, in thousands of characters to one
 * decimal. A call nothing has yet arrived for reads as `undefined`.
 */
function writtenSoFar(doing: TurnDoing | undefined): string | undefined {
  if (doing?.kind !== "writing" || doing.chars === 0) return undefined;
  return `${(doing.chars / 1000).toFixed(1)}k`;
}

/**
 * The assistant's presence, standing at the live edge of a turn that is still
 * running: the bubble its next narration will arrive in, still forming, saying
 * what the turn is at beside the dots for as long as `doing` names something. A
 * tool call being written also says how much of it has been written. Nothing of
 * what it says is kept once the turn is over.
 */
function PresenceMark({ doing }: { doing: TurnDoing | undefined }) {
  const tool = doingTool(doing);
  const written = writtenSoFar(doing);
  return (
    <div
      data-assistant-bubble="entity"
      data-assistant-presence
      className={`${assistantBubbleClasses} flex items-center gap-1`}
      aria-hidden="true"
    >
      {presenceDotDelays.map((delay) => (
        <span
          key={delay}
          style={{ animationDelay: delay }}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none motion-reduce:opacity-50"
        />
      ))}
      {tool !== undefined && (
        <span
          data-assistant-presence-doing={tool}
          {...(doing?.kind === "writing" ? { "data-assistant-presence-written": doing.chars } : {})}
          className="ml-1 text-muted-foreground text-xs"
        >
          {namedToolActivity(tool).text}
          {written !== undefined && ` ${written}`}
        </span>
      )}
      {doing?.kind === "planning" && (
        <span data-assistant-presence-doing="planning" className="ml-1 text-muted-foreground text-xs">
          planning
        </span>
      )}
    </div>
  );
}

/** How many blocks of `kind` a turn laid out. */
function countKind(blocks: readonly ConversationBlock[], kind: ConversationBlockKind): number {
  return blocks.filter((block) => block.kind === kind).length;
}

/** What a folded turn says of itself: the work it left, counted by the kind of thing it is. */
function turnHeader(blocks: readonly ConversationBlock[]): string {
  const parts: string[] = [];
  const receipts = countKind(blocks, ConversationBlockKind.Receipt);
  const runs = countKind(blocks, ConversationBlockKind.Run);
  const snags = countKind(blocks, ConversationBlockKind.Snag);
  if (receipts > 0) parts.push(receipts === 1 ? "1 page changed" : `${receipts} pages changed`);
  if (runs > 0) parts.push(runs === 1 ? "1 run" : `${runs} runs`);
  if (snags > 0) parts.push(snags === 1 ? "1 snag" : `${snags} snags`);
  return parts.length === 0 ? "nothing changed" : parts.join(", ");
}

/** The note about how a turn ended, and the offer to be asked again where it broke off. */
function EndingView({
  ending,
  note,
  onAskAgain,
}: {
  ending: ConversationTurnEnding;
  note: string;
  onAskAgain?: (() => void) | undefined;
}) {
  return (
    <div className="flex w-full items-center gap-2">
      <div data-assistant-bubble="entity" className={assistantBubbleClasses}>
        <p data-assistant-ending={ending.code} className="text-sm text-muted-foreground italic">
          {note}
        </p>
      </div>
      {brokeOff(ending) && onAskAgain && (
        <button
          type="button"
          data-assistant-ask-again
          onClick={onAskAgain}
          className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-card-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * One of the assistant's turns: every block it laid out, where it got to when
 * it left no answer, and how it ended. A turn a later one stands after is folded to
 * its header until the reader opens it; the newest turn always stands open.
 */
function TurnView({
  entry,
  context,
  standing,
  folded,
  onAskAgain,
}: {
  entry: ConversationAssistantEntry;
  context: TranscriptContext;
  standing: StandingState;
  folded: boolean;
  onAskAgain?: (() => void) | undefined;
}) {
  const { ending } = entry;
  const note = ending ? endingNote(ending) : undefined;
  const blocks = conversationBlocks(entry.steps, context);
  const gotTo = ending && answerless(ending) && standingHolds(standing);
  const body = (
    <>
      {blocks.map((block, at) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a turn only ever appends, so a block keeps its position
        <BlockView key={`block-${at}`} block={block} context={context} />
      ))}
      {gotTo && <GotToView state={standing} context={context} />}
      {ending && note && <EndingView ending={ending} note={note} onAskAgain={onAskAgain} />}
    </>
  );

  if (!folded) {
    return (
      <div
        data-assistant-entry="assistant"
        data-assistant-turn="latest"
        className="flex w-full flex-col items-start gap-2"
      >
        {body}
      </div>
    );
  }
  return (
    <details
      data-assistant-entry="assistant"
      data-assistant-turn="folded"
      data-assistant-fold="turn"
      className="w-full"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground text-xs pointer-coarse:min-h-11 pointer-coarse:py-2">
        {turnHeader(blocks)}
        <FoldChevron />
      </summary>
      <div className="mt-2 flex w-full flex-col items-start gap-2">{body}</div>
    </details>
  );
}

/** One entry of the conversation: what the person said, or one of the assistant's turns. */
function EntryView({
  entry,
  context,
  standing,
  folded,
  onAskAgain,
}: {
  entry: ConversationEntry;
  context: TranscriptContext;
  standing: StandingState;
  folded: boolean;
  onAskAgain?: (() => void) | undefined;
}) {
  if (entry.kind === "user") {
    return (
      <p
        data-assistant-entry="user"
        data-assistant-bubble="ask"
        className={`${askBubbleClasses} text-sm text-foreground`}
      >
        {entry.text}
      </p>
    );
  }
  return <TurnView entry={entry} context={context} standing={standing} folded={folded} onAskAgain={onAskAgain} />;
}

/** The mark the send-now control carries: an arrow running past the line it jumps. */
function SendNowGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path d="M2.5 8h8" />
      <path d="M7.5 4.5 11 8l-3.5 3.5" />
      <path d="M13.5 3.5v9" />
    </svg>
  );
}

/**
 * One ask waiting its turn, drawn in the bubble the person speaks from and
 * dimmed for as long as it waits, with the control that takes it now standing
 * beside it. Tapping the bubble takes the ask back and tapping the control sends
 * it ahead of everything else waiting; each takes no tap where the host takes
 * none.
 */
function WaitingAskView({
  ask,
  onCancelAsk,
  onSendNow,
}: {
  ask: PendingAsk;
  onCancelAsk?: ((id: string) => void) | undefined;
  onSendNow?: ((id: string) => void) | undefined;
}) {
  return (
    <div className="flex w-full items-end justify-end gap-1">
      <button
        type="button"
        data-assistant-send-now={ask.id}
        disabled={onSendNow === undefined}
        onClick={onSendNow === undefined ? undefined : () => onSendNow(ask.id)}
        aria-label="Send this one now"
        title="Send this one now"
        className="flex shrink-0 items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
      >
        <SendNowGlyph />
      </button>
      <button
        type="button"
        data-assistant-pending={ask.id}
        data-assistant-bubble="ask"
        disabled={onCancelAsk === undefined}
        onClick={onCancelAsk === undefined ? undefined : () => onCancelAsk(ask.id)}
        className={`${askBubbleClasses} ${waitingAskClasses} text-left text-sm text-foreground pointer-coarse:min-h-11`}
      >
        {ask.text}
      </button>
    </div>
  );
}

/** The mark the export control carries: two leaves standing one behind the other, and a tick once taken. */
function ExportGlyph({ copied }: { copied: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      {copied ? (
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      ) : (
        <>
          <rect x="6" y="6" width="7.5" height="8.5" rx="1.5" />
          <path d="M10.5 3.5v-1a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1" />
        </>
      )}
    </svg>
  );
}

/**
 * The control that puts the whole conversation on the clipboard as the
 * diagnostic document {@link exportTranscript} writes, marking itself taken for
 * a moment once it lands. It stands unavailable while the host has named no
 * brain, and copies nothing where the surface it is drawn in reaches no
 * clipboard.
 */
function ExportControl({ record, name }: { record: ConversationRecord | undefined; name: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const mark = setTimeout(() => setCopied(false), copiedMarkMs);
    return () => clearTimeout(mark);
  }, [copied]);

  const copy = (): void => {
    if (record === undefined) return;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard === undefined) return;
    void clipboard
      .writeText(exportTranscript(record, name))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <button
      type="button"
      data-assistant-export={copied ? "copied" : "ready"}
      disabled={record === undefined}
      onClick={copy}
      aria-label="Copy this conversation"
      title="Copy this conversation"
      className="flex shrink-0 items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
    >
      <ExportGlyph copied={copied} />
    </button>
  );
}

/**
 * The Assistant's conversation surface: the entity whose brain is open, the
 * conversation it has had with the person, and the box the next thing to do is
 * typed into. It holds no state and starts nothing; the host drives it.
 *
 * The transcript follows its newest content unless the person has scrolled up,
 * which holds it where they left it until they scroll back down.
 */
export function ConversationView(props: ConversationViewProps) {
  const {
    name,
    status,
    record,
    intent,
    onIntentChange,
    onSend,
    pending,
    onCancelAsk,
    onSendNow,
    onStop,
    onRetry,
    onAskAgain,
    onLeaveIntent,
    opensByPerson,
    brainSurface,
    brainPlaces,
    libraryOffers,
    onAnswer,
    doing,
  } = props;
  const entries = record?.entries ?? [];
  const waiting = pending ?? [];
  const context = useMemo(() => transcriptContext(record), [record]);
  const standing = useMemo(() => standingState(record, context), [record, context]);
  const newestTurn = entries.reduce((at, entry, index) => (entry.kind === "assistant" ? index : at), -1);
  const running = status === AssistantStatus.TurnActive;
  const answering = useMemo(
    () => (onAnswer === undefined ? undefined : { send: onAnswer, busy: running }),
    [onAnswer, running]
  );
  const connection = connectionNote(status);
  const transcript = useRef<HTMLDivElement>(null);
  const followingBottom = useRef(true);
  const surface = useRef<HTMLDivElement>(null);
  const intentBox = useRef<HTMLTextAreaElement>(null);
  const latest = useRef({ running, intent, onSend, onLeaveIntent });
  latest.current = { running, intent, onSend, onLeaveIntent };

  // The intent box's keys are served at the window, whose capture pass runs
  // ahead of the document the editor listens for Escape on. A leaving press
  // goes no further, and offers the keyboard to whatever stands around the
  // panel before the panel's own surface takes it.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const box = intentBox.current;
      if (box === null || event.target !== box) return;
      const held = latest.current;
      const action = intentKeyAction(event.key, event.shiftKey, event.isComposing, held.intent);
      if (action === "pass") return;
      event.preventDefault();
      if (action === "send") held.onSend();
      if (action === "leave") {
        event.stopPropagation();
        if (held.onLeaveIntent?.() !== true) surface.current?.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  useEffect(() => {
    landKeyboardInIntent(intentBox.current, opensByPerson);
  }, [opensByPerson]);

  const noteScroll = (): void => {
    const element = transcript.current;
    if (!element) return;
    followingBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight <= bottomSlackPx;
  };

  useEffect(() => {
    const element = transcript.current;
    if (!element || !followingBottom.current) return;
    element.scrollTop = element.scrollHeight;
  });

  return (
    <BrainSurfaceProvider value={brainSurface}>
      <BrainPlacesProvider value={brainPlaces}>
        <LibraryOffersProvider value={libraryOffers}>
          <AnsweringContext.Provider value={answering}>
            <div
              ref={surface}
              tabIndex={-1}
              className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border outline-none"
              style={{ background: kBrainDeskFill }}
            >
              <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <span className="h-8 w-8 shrink-0 rounded-full border border-border bg-muted" aria-hidden="true" />
                <span data-assistant-entity className="grow truncate text-sm font-semibold text-card-foreground">
                  {name}
                </span>
                <ExportControl record={record} name={name} />
              </header>
              <div
                ref={transcript}
                onScroll={noteScroll}
                className="flex min-h-0 grow flex-col gap-3 overflow-y-auto px-3 py-4"
              >
                {entries.length === 0 && waiting.length === 0 ? (
                  <p data-assistant-resting className="text-sm text-muted-foreground">
                    Hi! What should we build?
                  </p>
                ) : (
                  entries.map((entry, at) => (
                    <EntryView
                      // biome-ignore lint/suspicious/noArrayIndexKey: a record only ever appends, so an entry keeps its position
                      key={`entry-${at}`}
                      entry={entry}
                      context={context}
                      standing={standing}
                      folded={at !== newestTurn}
                      onAskAgain={onAskAgain}
                    />
                  ))
                )}
                {running && <PresenceMark doing={doing} />}
                {waiting.map((ask) => (
                  <WaitingAskView key={ask.id} ask={ask} onCancelAsk={onCancelAsk} onSendNow={onSendNow} />
                ))}
              </div>
              {connection && (
                <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
                  <p data-assistant-connection={status} className="grow text-xs text-muted-foreground">
                    {connection}
                  </p>
                  {onRetry && (
                    <button
                      type="button"
                      data-assistant-retry
                      onClick={onRetry}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-card-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                    >
                      Try again
                    </button>
                  )}
                </div>
              )}
              <div className="flex shrink-0 items-end gap-2 border-t border-border p-2">
                <textarea
                  ref={intentBox}
                  data-assistant-intent
                  className="min-h-16 grow resize-none rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:text-base"
                  rows={2}
                  value={intent}
                  onChange={(event) => onIntentChange(event.target.value)}
                  aria-label="What we should build"
                  placeholder="Tell me your idea..."
                />
                {running ? (
                  <button
                    type="button"
                    data-assistant-stop
                    onClick={onStop}
                    className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-card-foreground pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    data-assistant-send
                    onClick={onSend}
                    disabled={intent.trim().length === 0}
                    className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
                  >
                    Send
                  </button>
                )}
              </div>
            </div>
          </AnsweringContext.Provider>
        </LibraryOffersProvider>
      </BrainPlacesProvider>
    </BrainSurfaceProvider>
  );
}
