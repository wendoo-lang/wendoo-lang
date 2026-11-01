/**
 * Pins the structure the conversation surface renders for each state a session
 * can be in: which card each thing a turn did is drawn as and in what order,
 * how edits gather into a receipt per page, how repeated refusals collapse into
 * one snag, what a rehearsal's timeline is cut into and what marks it, how a
 * dirty build reads, that what a turn only looked at draws nothing, which turns
 * stand folded to their header, where the account of what a conversation kept
 * stands, what marks a turn that did not simply finish, when the assistant's
 * presence stands at the live edge and what it says it is doing there, which
 * asks stand waiting their turn below it, which of them take a tap back and
 * which take a tap that hurries them to the front,
 * which control the intent box stands beside, what a lost
 * session offers, which lines read markup in what they carry, which opens
 * of the panel land the keyboard in the intent box, how a library the
 * assistant offers is drawn against the shelf standing behind it, and that a
 * library it merely names in its words offers nothing.
 *
 * It pins too how what the assistant said reads against the work it stands beside:
 * which of its runs stand on cards of their own and which in its bubble, which
 * plan dims once another takes its place, which rehearsal a verdict marks, how a
 * diagnosis becomes the note that answered it, and how a snag takes the words
 * said about it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LibraryShelfEntry } from "@wendoo/assistant-bridge";
import { LibraryOfferUnknownCode, LibraryOfferVerdict } from "@wendoo/assistant-bridge";
import type {
  ConversationEntry,
  ConversationRecord,
  ConversationToolCall,
  ConversationTurnEnding,
  ConversationTurnStep,
} from "@wendoo/assistant-relay";
import {
  CONVERSATION_RECORD_VERSION,
  ConversationTurnFailureCode,
  NarrationJudgment,
  NarrationRole,
  RelayTurnEndCode,
} from "@wendoo/assistant-relay";
import type { IBrainTileDef, ITileCatalog } from "@wendoo/core/brain";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationViewProps } from "./ConversationView";
import { ConversationView, intentKeyAction, landKeyboardInIntent } from "./ConversationView";
import type { BrainPlaces } from "./conversation/brain-places";
import type { LibraryOffers } from "./conversation/library-offers";
import type { BrainSurface } from "./conversation/tile-visuals";
import { AssistantStatus } from "./session/machine";

/** The brain every record in this file belongs to. */
const brainId = "brain-a";

/** A record holding `entries` for {@link brainId}. */
function record(entries: readonly ConversationEntry[]): ConversationRecord {
  return { version: CONVERSATION_RECORD_VERSION, brainId, entries };
}

/** One tile as every payload naming it reports it. */
interface NamedTile {
  readonly tileId: string;
  readonly label: string;
}

/** One page as an accepted edit reports the page it landed on. */
interface NamedPage {
  readonly pageId: string;
  readonly pageIndex: number;
  readonly name: string;
}

/** The two pages the edits in this file land on. */
const wandering: NamedPage = { pageId: "page-wandering", pageIndex: 0, name: "Wandering" };
const scared: NamedPage = { pageId: "page-scared", pageIndex: 1, name: "Scared" };

/** Tiles the edits in this file place, each under the word it reads by. */
const seeTile: NamedTile = { tileId: "tile.sensor->see", label: "see" };
const moveTile: NamedTile = { tileId: "tile.actuator->move", label: "move" };

/** An edit placing `tiles` on the `do` side of `ruleId`, landing on `page` when one is given. */
function placedOn(page: NamedPage | undefined, ruleId: string, tiles: readonly NamedTile[]): ConversationToolCall {
  return {
    name: "propose_edit",
    input: { op: "placeTiles", ruleId, side: "do", tileIds: tiles.map((tile) => tile.tileId) },
    outcome: {
      kind: "ok",
      payload: {
        ok: true,
        historyDepth: 1,
        ...(page ? { onPage: page } : {}),
        rule: { ruleId, when: [], do: tiles, children: [] },
      },
    },
  };
}

/** An edit nesting a new rule `ruleId` under `parentRuleId`, landing on `page`. */
function nestedUnder(page: NamedPage, parentRuleId: string, ruleId: string): ConversationToolCall {
  return {
    name: "propose_edit",
    input: { op: "addChildRule", parentRuleId },
    outcome: {
      kind: "ok",
      payload: { ok: true, historyDepth: 1, onPage: page, rule: { ruleId, when: [], do: [], children: [] } },
    },
  };
}

/** An edit switching `ruleId` to `trigger` on `page`, leaving the rule holding no tiles. */
function switchedTo(page: NamedPage, ruleId: string, trigger: string): ConversationToolCall {
  return {
    name: "propose_edit",
    input: { op: "setRuleTrigger", ruleId, trigger },
    outcome: {
      kind: "ok",
      payload: { ok: true, historyDepth: 1, onPage: page, rule: { ruleId, trigger, when: [], do: [], children: [] } },
    },
  };
}

/** An edit the editor refused, under the diagnostic that refused it and the tile it named. */
function refusedFor(tileId: string): ConversationToolCall {
  return {
    name: "propose_edit",
    input: { op: "placeTiles", ruleId: "rule-1", side: "when", tileIds: [tileId] },
    outcome: { kind: "ok", payload: { ok: false, code: 12, params: { ruleId: "rule-1", tileId } } },
  };
}

/** A refused edit, which stands as a snag however often it repeats. */
const refusedEdit = refusedFor(seeTile.tileId);

/** An applied edit, which stands as a receipt on the page it landed on. */
const appliedEdit = placedOn(wandering, "rule-1", [moveTile]);

/** A clean build, which verifies the receipts standing when it ran. */
const cleanBuild: ConversationToolCall = {
  name: "compile",
  input: {},
  outcome: { kind: "ok", payload: { ok: true, diagnostics: [] } },
};

/** One stretch of a rehearsal, as an account reports it. */
function span(from: number, thinks: number, think: Record<string, unknown>): Record<string, unknown> {
  return { from, thinks, think: { fired: [], when: [], dispatched: [], ...think } };
}

/** The scenario every rehearsal in this file is asked for, unless one asks for its own. */
const scenario = { scenario: { seed: 1, subject: "herbivore" }, thinks: 20 };

/** A rehearsal that ran and came back reporting `summary`, over the scenario `input` asked for. */
function rehearsed(summary: Record<string, unknown>, input: unknown = scenario): ConversationToolCall {
  return {
    name: "simulate",
    input,
    outcome: {
      kind: "ok",
      payload: {
        ok: true,
        summary: {
          runId: "run-1",
          thinks: 20,
          rules: [],
          dispatchTotals: [],
          spans: [span(0, 20, { fired: ["rule-1"], when: ["rule-1=true"] })],
          spansTruncated: false,
          identity: ["0 00000001"],
          world: { initialPopulation: 1, finalPopulation: 1, brainsExecuted: 1 },
          ...summary,
        },
      },
    },
  };
}

/** A rehearsal the target refused to stage, under the code that stopped it. */
function rehearsalRefused(error: string): ConversationToolCall {
  return {
    name: "simulate",
    input: { scenario: { seed: 1, subject: "ghost" }, thinks: 10 },
    outcome: { kind: "ok", payload: { ok: false, error, named: "ghost", subjects: ["herbivore"] } },
  };
}

/** A build that came back dirty, reporting `diagnostics`. */
function dirtyBuild(diagnostics: readonly Record<string, unknown>[]): ConversationToolCall {
  return { name: "compile", input: {}, outcome: { kind: "ok", payload: { ok: false, diagnostics } } };
}

/** The one thing a dirty build in this file reports, unless it reports its own. */
const droppedTile = { code: 1016, severity: "error", ruleId: "rule-1", params: {} };

/** A catalog read, which reads as looking at something. */
const catalogRead: ConversationToolCall = {
  name: "read_catalog",
  input: {},
  outcome: { kind: "ok", payload: { tiles: [], total: 0 } },
};

/** A catalog read naming what each of `tiles` reads by. */
function catalogNaming(tiles: readonly NamedTile[]): ConversationToolCall {
  return {
    name: "read_catalog",
    input: { filter: "all" },
    outcome: { kind: "ok", payload: { tiles, total: tiles.length } },
  };
}

/** Render the view over `overrides`, with a resting session everywhere else. */
function render(overrides: Partial<ConversationViewProps> = {}): string {
  const props: ConversationViewProps = {
    name: "Herbivore Brain",
    status: AssistantStatus.Ready,
    record: undefined,
    intent: "",
    onIntentChange: () => {},
    onSend: () => {},
    onStop: () => {},
    onRetry: undefined,
    onAskAgain: undefined,
    ...overrides,
  };
  return renderToStaticMarkup(<ConversationView {...props} />);
}

/** A record where the person asked for something and the assistant's turn ended on `ending`. */
function asked(ending: ConversationTurnEnding): ConversationRecord {
  return record([
    { kind: "user", text: "make me hide" },
    { kind: "assistant", steps: [], ending },
  ]);
}

/** Every match of `pattern` in `markup`. */
function countOf(markup: string, pattern: RegExp): number {
  return markup.match(new RegExp(pattern, "g"))?.length ?? 0;
}

/** The attributes marking each line the transcript laid out, in the order they were rendered. */
function laidOutLines(markup: string): string[] {
  const marks = markup.match(/data-assistant-(?:narration|ending|presence)(?!-)(?:="[^"]*")?/g) ?? [];
  return marks.map((mark) => mark.replace(/^data-assistant-/, "").replace(/="true"$/, ""));
}

/** The kind of every card the transcript drew, in the order they were rendered. */
function cardKinds(markup: string): string[] {
  return [...markup.matchAll(/data-assistant-card="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/** Every value `attribute` was rendered with, in the order they were rendered. */
function valuesOf(markup: string, attribute: string): string[] {
  return [...markup.matchAll(new RegExp(`${attribute}="([^"]*)"`, "g"))].map((match) => match[1] ?? "");
}

/** Every cell of a run's timeline, as the span standing for it was rendered. */
function cellSpans(markup: string): string[] {
  return [...markup.matchAll(/<span[^>]*data-assistant-cell-activity[^>]*>/g)].map((match) => match[0]);
}

/** The words hung beside every cell of a run's timeline, in the order the cells stand. */
function cellNoteWords(markup: string): string[] {
  const notes = markup.matchAll(
    /<span[^>]*data-assistant-cell-activity[^>]*><span[^>]*data-assistant-cell-note[^>]*>([^<]*)<\/span><\/span>/g
  );
  return [...notes].map((match) => match[1] ?? "");
}

/** `value` as it stands in the markup, where a tile id's own characters are escaped. */
function escaped(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The kind of every bubble the transcript drew, in the order they were rendered. */
function bubbleKinds(markup: string): string[] {
  return [...markup.matchAll(/data-assistant-bubble="([^"]*)"/g)].map((match) => match[1] ?? "");
}

/** The kind of bubble the line marked `mark` is drawn inside, or `undefined` where no bubble holds it. */
function bubbleAround(markup: string, mark: string): string | undefined {
  return new RegExp(`data-assistant-bubble="([^"]*)"[^>]*>\\s*<[^>]*\\b${mark}\\b`).exec(markup)?.[1];
}

/** What the ending line marked `code` reads as, for comparing one ending against another. */
function endingNote(markup: string, code: string): string {
  const note = new RegExp(`data-assistant-ending="${code}"[^>]*>([^<]*)<`).exec(markup)?.[1];
  assert.ok(note !== undefined, `the view marks the ending ${code}`);
  return note;
}

/** The send control's own tag, which carries whether it takes a click. */
function sendControl(markup: string): string {
  const tag = /<button[^>]*data-assistant-send[^>]*>/.exec(markup)?.[0];
  assert.ok(tag, "the view stands a send control");
  return tag;
}

describe("a conversation with nothing in it", () => {
  test("invites the person to say what the entity should do", () => {
    const markup = render();

    assert.match(markup, /data-assistant-resting/);
    assert.doesNotMatch(markup, /data-assistant-entry/);
  });

  test("stands a send control that takes nothing while the box is empty", () => {
    assert.match(sendControl(render()), /\sdisabled=""/);
    assert.doesNotMatch(sendControl(render({ intent: "make me hide" })), /\sdisabled=""/);
  });
});

describe("the control that copies the conversation", () => {
  /** The export control's own tag, which carries whether it takes a click. */
  function exportControl(markup: string): string {
    const tag = /<button[^>]*data-assistant-export[^>]*>/.exec(markup)?.[0];
    assert.ok(tag, "the view stands an export control");
    return tag;
  }

  test("stands in the surface header, beside the entity's name", () => {
    const header = /<header[^>]*>[\s\S]*?<\/header>/.exec(render())?.[0] ?? "";

    assert.match(header, /data-assistant-entity/);
    assert.match(header, /data-assistant-export/);
  });

  test("takes nothing while the host has named no brain, and stands ready once one is named", () => {
    assert.match(exportControl(render()), /\sdisabled=""/);
    assert.doesNotMatch(exportControl(render({ record: record([]) })), /\sdisabled=""/);
  });

  test("rests unmarked until the conversation has been taken", () => {
    assert.deepEqual(valuesOf(render({ record: record([]) }), "data-assistant-export"), ["ready"]);
  });
});

describe("a conversation with turns in it", () => {
  test("renders what the person said and what the assistant narrated", () => {
    const markup = render({
      record: record([
        { kind: "user", text: "I want you to run away" },
        { kind: "assistant", steps: [{ kind: "narration", text: "I will watch for them first." }] },
      ]),
    });

    assert.match(markup, /data-assistant-entry="user"/);
    assert.match(markup, /data-assistant-entry="assistant"/);
    assert.match(markup, /data-assistant-narration/);
    assert.doesNotMatch(markup, /data-assistant-resting/);
  });

  test("stands what the person asked in its own kind of container, apart from what the assistant said", () => {
    const markup = render({
      record: record([
        { kind: "user", text: "I want you to run away" },
        { kind: "assistant", steps: [{ kind: "narration", text: "I will watch for them first." }] },
      ]),
    });

    assert.deepEqual(bubbleKinds(markup), ["ask", "entity"]);
    assert.equal(bubbleAround(markup, "data-assistant-narration"), "entity");
  });

  test("draws each run of narration in a container of its own", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "narration", text: "Starting with the seeing part." },
            { kind: "toolCall", call: catalogRead },
            { kind: "narration", text: "That one does not belong there." },
          ],
        },
      ]),
    });

    assert.deepEqual(laidOutLines(markup), ["narration", "narration"]);
    assert.deepEqual(bubbleKinds(markup), ["entity", "entity"]);
  });

  test("shows a run's headline and folds the longer form it came with beneath it", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [{ kind: "narration", text: "It never fired.", body: "A child waits for its parent." }],
        },
      ]),
    });

    assert.match(markup, /data-assistant-narration(?!-)/);
    assert.match(markup, /data-assistant-fold="narration"/);
    assert.match(markup, /data-assistant-narration-body/);
  });

  test("folds nothing under a run that came with no longer form", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "narration", text: "It never fired." }] }]),
    });

    assert.doesNotMatch(markup, /data-assistant-fold="narration"/);
    assert.doesNotMatch(markup, /data-assistant-narration-body/);
  });

  test("marks a run with the role and judgment it carries, and leaves an unplaced run unmarked", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "narration", text: "Two ways of being.", role: NarrationRole.Plan },
            { kind: "narration", text: "It hid.", role: NarrationRole.Verdict, judgment: NarrationJudgment.Succeeded },
            { kind: "narration", text: "Anything else." },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-narration-role"), [NarrationRole.Plan, NarrationRole.Verdict]);
    assert.deepEqual(valuesOf(markup, "data-assistant-judgment"), [NarrationJudgment.Succeeded]);
    assert.deepEqual(cardKinds(markup), ["narration", "narration", "narration"]);
  });

  test("stands the work a turn did where it did it, among the narration around it", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "narration", text: "Starting with the seeing part." },
            { kind: "toolCall", call: appliedEdit },
            { kind: "narration", text: "That one does not belong there." },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["narration", "receipt", "narration"]);
  });
});

describe("the edits a turn landed", () => {
  test("gathers the edits on each page into a receipt of its own, named by that page", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
            { kind: "toolCall", call: placedOn(scared, "rule-2", [seeTile]) },
            { kind: "toolCall", call: placedOn(wandering, "rule-3", [seeTile]) },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["receipt", "receipt"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-receipt-page"), [wandering.pageId, scared.pageId]);
    assert.deepEqual(valuesOf(markup, "data-assistant-receipt-edits"), ["2", "1"]);
  });

  test("shows each rule it left standing as its tiles, a rule nested under another standing in from it", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
            { kind: "toolCall", call: nestedUnder(wandering, "rule-1", "rule-2") },
            { kind: "toolCall", call: placedOn(wandering, "rule-2", [seeTile]) },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-rule"), ["rule-1", "rule-2"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-rule-depth"), ["0", "1"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-tile"), [escaped(moveTile.tileId), escaped(seeTile.tileId)]);
    assert.equal(countOf(markup, /data-assistant-side="do"/), 2);
  });

  test("reads the trigger mode off each rule, defaulting a rule the payload gave none", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
            { kind: "toolCall", call: switchedTo(wandering, "rule-2", "otherwise") },
            { kind: "toolCall", call: switchedTo(wandering, "rule-3", "then") },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-rule-trigger"), ["when", "otherwise", "then"]);
  });

  test("stands the mode capsule of a rule armed by its mode alone, where a when rule with no tiles draws none", () => {
    const bare = render({
      record: record([
        { kind: "assistant", steps: [{ kind: "toolCall", call: switchedTo(wandering, "rule-1", "then") }] },
      ]),
    });
    const whenRule = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
            { kind: "toolCall", call: nestedUnder(wandering, "rule-1", "rule-2") },
          ],
        },
      ]),
    });

    assert.equal(countOf(bare, /data-assistant-side="when"/), 1, "a bare THEN stands as its capsule");
    assert.equal(countOf(whenRule, /data-assistant-side="when"/), 0, "an empty WHEN band draws nothing");
  });

  test("gives a rule armed by its mode alone a reading, where a bare when rule has none", () => {
    const readingOf = (markup: string) => /data-assistant-rule="[^"]*"[^>]*aria-label="([^"]*)"/.exec(markup)?.[1];

    const bare = render({
      record: record([
        { kind: "assistant", steps: [{ kind: "toolCall", call: switchedTo(wandering, "rule-1", "then") }] },
      ]),
    });
    const whenRule = render({
      record: record([
        { kind: "assistant", steps: [{ kind: "toolCall", call: switchedTo(wandering, "rule-1", "when") }] },
      ]),
    });

    assert.ok((readingOf(bare)?.length ?? 0) > 0, bare);
    assert.equal(readingOf(whenRule), "");
  });

  test("opens to one row per editor command, under the op the command named", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: appliedEdit }] }]),
    });

    assert.match(markup, /<details[^>]*data-assistant-fold="edits"/);
    assert.deepEqual(valuesOf(markup, "data-assistant-step"), ["placeTiles"]);
  });

  test("gathers an edit that named no page all the same, with no page to name", () => {
    const markup = render({
      record: record([
        { kind: "assistant", steps: [{ kind: "toolCall", call: placedOn(undefined, "rule-1", [moveTile]) }] },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["receipt"]);
    assert.doesNotMatch(markup, /data-assistant-receipt-page/);
  });

  test("sorts the commands of one batch by the page each of them landed on", () => {
    const batch: ConversationToolCall = {
      name: "propose_edit",
      input: {
        op: "batch",
        commands: [
          { op: "placeTiles", ruleId: "rule-1", side: "do", tileIds: [moveTile.tileId] },
          { op: "addRule", pageIndex: 1 },
        ],
      },
      outcome: {
        kind: "ok",
        payload: {
          ok: true,
          historyDepth: 1,
          results: [
            { onPage: wandering, rule: { ruleId: "rule-1", when: [], do: [moveTile], children: [] } },
            { onPage: scared, rule: { ruleId: "rule-9", when: [], do: [], children: [] } },
          ],
        },
      },
    };

    const markup = render({ record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: batch }] }]) });

    assert.deepEqual(valuesOf(markup, "data-assistant-receipt-page"), [wandering.pageId, scared.pageId]);
    assert.deepEqual(valuesOf(markup, "data-assistant-receipt-edits"), ["1", "1"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-step"), ["placeTiles", "addRule"]);
  });

  test("stops showing a rule the turn took back out, and still tells that it went", () => {
    const removed: ConversationToolCall = {
      name: "propose_edit",
      input: { op: "deleteRule", ruleId: "rule-1" },
      outcome: {
        kind: "ok",
        payload: {
          ok: true,
          historyDepth: 2,
          onPage: wandering,
          removed: "rule",
          rule: { ruleId: "rule-1", when: [], do: [moveTile], children: [] },
        },
      },
    };

    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
            { kind: "toolCall", call: removed },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-rule"), []);
    assert.deepEqual(valuesOf(markup, "data-assistant-receipt-edits"), ["2"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-step"), ["placeTiles", "deleteRule"]);
  });

  test("a clean build marks every receipt the turn had opened by then", () => {
    const built: readonly ConversationTurnStep[] = [
      { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
      { kind: "toolCall", call: placedOn(scared, "rule-2", [seeTile]) },
      { kind: "toolCall", call: cleanBuild },
    ];

    const markup = render({ record: record([{ kind: "assistant", steps: built }]) });
    const unbuilt = render({ record: record([{ kind: "assistant", steps: built.slice(0, 2) }]) });

    assert.equal(countOf(markup, /data-assistant-compiles="ok"/), 2);
    assert.equal(countOf(unbuilt, /data-assistant-compiles="ok"/), 0);
  });
});

describe("the edits the editor refused", () => {
  test("stands one snag naming the code it was refused under and the tile it was about", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: refusedEdit }] }]),
    });

    assert.deepEqual(cardKinds(markup), ["snag"]);
    assert.match(markup, /data-assistant-snag="12"/);
    assert.match(markup, new RegExp(`data-assistant-snag-tile="${escaped(seeTile.tileId)}"`));
    assert.match(markup, /data-assistant-snag-rule="rule-1"/);
  });

  test("collapses every proposal asking the very same thing, however much narration falls between", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: refusedEdit },
            { kind: "toolCall", call: refusedEdit },
            { kind: "narration", text: "Let me try somewhere else." },
            { kind: "toolCall", call: refusedEdit },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["snag", "narration"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-snag-repeats"), ["3"]);
  });

  test("keeps proposals asking for different things apart", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: refusedEdit },
            { kind: "toolCall", call: refusedFor(moveTile.tileId) },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["snag", "snag"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-snag-repeats"), ["1", "1"]);
  });

  test("names the tile in the word an earlier payload gave it", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: catalogNaming([seeTile]) },
            { kind: "toolCall", call: refusedEdit },
          ],
        },
      ]),
    });

    assert.match(markup, new RegExp(`data-assistant-tile-word[^>]*>${seeTile.label}<`));
  });

  test("opens to what the rejecting diagnostic reported", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: refusedEdit }] }]),
    });

    assert.match(markup, /<details[^>]*data-assistant-fold="diagnostic"/);
    assert.deepEqual(valuesOf(markup, "data-assistant-diag-param"), ["ruleId", "tileId"]);
  });
});

describe("what a turn only looked at", () => {
  test("stands no line of its own anywhere in the transcript", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: catalogRead },
            { kind: "toolCall", call: refusedEdit },
            { kind: "toolCall", call: appliedEdit },
          ],
        },
      ]),
    });

    assert.doesNotMatch(markup, /data-assistant-activity/);
    assert.deepEqual(cardKinds(markup), ["snag", "receipt"]);
  });

  test("draws nothing for a turn that only looked", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: catalogRead },
            { kind: "toolCall", call: catalogNaming([seeTile]) },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), []);
    assert.doesNotMatch(markup, /data-assistant-lookups/);
    assert.doesNotMatch(markup, /data-assistant-step=/);
  });
});

describe("the folds a card opens", () => {
  test("every one is a native disclosure, which the keyboard reaches and works unaided", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: catalogRead },
            { kind: "toolCall", call: refusedEdit },
            { kind: "toolCall", call: appliedEdit },
          ],
        },
      ]),
    });

    const folds = countOf(markup, /data-assistant-fold=/);
    assert.equal(folds, 2);
    assert.equal(countOf(markup, /<details[^>]*data-assistant-fold=/), folds);
    assert.equal(countOf(markup, /<summary/), folds);
  });
});

describe("markup in what is said", () => {
  test("reads the assistant's narration as the markdown subset, under the mark the line carries", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [{ kind: "narration", text: "**Two** things:\n\n- one `here`\n- and *another*" }],
        },
      ]),
    });

    assert.match(markup, /data-assistant-narration/);
    assert.match(markup, /<strong[^>]*>Two<\/strong>/);
    assert.match(markup, /<ul[^>]*>/);
    assert.equal(countOf(markup, /<li[^>]*>/), 2);
    assert.match(markup, /<code[^>]*>here<\/code>/);
    assert.match(markup, /<em[^>]*>another<\/em>/);
  });

  test("leaves what the person typed literal, whatever markup it holds", () => {
    const markup = render({
      record: record([{ kind: "user", text: "**not loud** and <b>not this</b> and `not typed`" }]),
    });

    assert.match(markup, /data-assistant-entry="user"/);
    assert.match(markup, /\*\*not loud\*\*/);
    assert.match(markup, /&lt;b&gt;/);
    assert.doesNotMatch(markup, /<strong/);
    assert.doesNotMatch(markup, /<code/);
    assert.doesNotMatch(markup, /<b>/);
  });
});

describe("how a turn ended", () => {
  test("says nothing about a turn that simply finished", () => {
    const finished = record([
      {
        kind: "assistant",
        steps: [{ kind: "narration", text: "Done." }],
        ending: { kind: "end", code: RelayTurnEndCode.Complete },
      },
    ]);

    assert.doesNotMatch(render({ record: finished }), /data-assistant-ending/);
  });

  test("marks every abnormal ending with the code it ended on", () => {
    const abnormal = [
      RelayTurnEndCode.Stopped,
      RelayTurnEndCode.Truncated,
      RelayTurnEndCode.Failed,
      RelayTurnEndCode.LeaseExhausted,
    ] as const;

    for (const code of abnormal) {
      const markup = render({ record: record([{ kind: "assistant", steps: [], ending: { kind: "end", code } }]) });
      assert.match(markup, new RegExp(`data-assistant-ending="${code}"`), code);
    }

    for (const code of Object.values(ConversationTurnFailureCode)) {
      const cut = record([{ kind: "assistant", steps: [], ending: { kind: "failure", code } }]);
      assert.match(render({ record: cut }), new RegExp(`data-assistant-ending="${code}"`), code);
    }
  });

  test("says something of its own about each way a turn was cut short", () => {
    const codes = Object.values(ConversationTurnFailureCode);

    const notes = codes.map((code) => {
      const cut = record([{ kind: "assistant", steps: [], ending: { kind: "failure", code } }]);
      return endingNote(render({ record: cut }), code);
    });

    for (const [at, note] of notes.entries()) assert.ok(note.length > 0, codes[at]);
    assert.equal(new Set(notes).size, codes.length, "no two failures read alike");
  });

  test("says how a turn ended in the same kind of container the assistant speaks in", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [{ kind: "narration", text: "Looking." }],
          ending: { kind: "end", code: RelayTurnEndCode.Truncated },
        },
      ]),
    });

    assert.deepEqual(bubbleKinds(markup), ["entity", "entity"]);
    assert.equal(bubbleAround(markup, "data-assistant-ending"), bubbleAround(markup, "data-assistant-narration"));
  });

  test("offers to be asked again where the assistant broke off mid-answer, and nowhere else", () => {
    const truncated: ConversationTurnEnding = { kind: "end", code: RelayTurnEndCode.Truncated };
    const invites: readonly ConversationTurnEnding[] = [
      truncated,
      { kind: "failure", code: ConversationTurnFailureCode.ToolServingFailed },
    ];
    const declines: readonly ConversationTurnEnding[] = [
      { kind: "end", code: RelayTurnEndCode.Complete },
      { kind: "end", code: RelayTurnEndCode.Stopped },
      { kind: "end", code: RelayTurnEndCode.Failed },
      { kind: "failure", code: ConversationTurnFailureCode.NotConnected },
      { kind: "failure", code: ConversationTurnFailureCode.Disconnected },
    ];

    for (const ending of invites) {
      const markup = render({ record: asked(ending), onAskAgain: () => {} });
      assert.match(markup, /<button[^>]*data-assistant-ask-again/, ending.code);
    }
    for (const ending of declines) {
      const markup = render({ record: asked(ending), onAskAgain: () => {} });
      assert.doesNotMatch(markup, /data-assistant-ask-again/, ending.code);
    }
    assert.doesNotMatch(render({ record: asked(truncated) }), /data-assistant-ask-again/);
  });
});

describe("the assistant's presence while a turn runs", () => {
  const running = record([
    { kind: "user", text: "make me hide" },
    { kind: "assistant", steps: [{ kind: "narration", text: "Looking." }] },
  ]);

  test("stands at the end of the transcript while the turn is open, in a container of the assistant's own", () => {
    const markup = render({ status: AssistantStatus.TurnActive, record: running });
    const lines = laidOutLines(markup);

    assert.match(markup, /data-assistant-presence/);
    assert.equal(lines[lines.length - 1], "presence");
    assert.deepEqual(bubbleKinds(markup), ["ask", "entity", "entity"]);
  });

  test("is gone once the turn is over, however it ended", () => {
    const ended = record([
      { kind: "user", text: "make me hide" },
      {
        kind: "assistant",
        steps: [{ kind: "narration", text: "Looking." }],
        ending: { kind: "end", code: RelayTurnEndCode.Complete },
      },
    ]);

    assert.doesNotMatch(render({ status: AssistantStatus.Ready, record: ended }), /data-assistant-presence/);
    assert.doesNotMatch(render({ status: AssistantStatus.Connecting, record: running }), /data-assistant-presence/);
    assert.doesNotMatch(render(), /data-assistant-presence/);
  });

  test("says what the turn is having served, beside the dots, under the tool it named", () => {
    const markup = render({
      status: AssistantStatus.TurnActive,
      record: running,
      doing: { kind: "serving", tools: ["read_project"] },
    });
    const said = markup.match(/data-assistant-presence-doing="read_project"[^>]*>([^<]*)</);

    assert.ok(said, "the mark carries the tool being served");
    assert.ok((said[1] ?? "").length > 0, "and says something of it beside the dots");
  });

  test("says nothing beside the dots while the turn is at nothing", () => {
    for (const doing of [undefined, { kind: "serving", tools: [] } as const]) {
      const markup = render({ status: AssistantStatus.TurnActive, record: running, doing });

      assert.match(markup, /data-assistant-presence/);
      assert.doesNotMatch(markup, /data-assistant-presence-doing/);
    }
  });

  test("says the turn is planning, beside the dots, between anything nameable", () => {
    const markup = render({
      status: AssistantStatus.TurnActive,
      record: running,
      doing: { kind: "planning" },
    });
    const said = markup.match(/data-assistant-presence-doing="planning"[^>]*>([^<]*)</);

    assert.ok(said, "the mark carries the planning state");
    assert.ok((said[1] ?? "").length > 0, "and says something of it beside the dots");
  });

  test("says nothing of what was served once the turn is over", () => {
    const markup = render({
      status: AssistantStatus.Ready,
      record: running,
      doing: { kind: "serving", tools: ["read_project"] },
    });

    assert.doesNotMatch(markup, /data-assistant-presence/);
  });

  test("carries the tool being written, and the count each progress tick brings", () => {
    const markup = render({
      status: AssistantStatus.TurnActive,
      record: running,
      doing: { kind: "writing", tool: "propose_edit", chars: 4312 },
    });
    const said = markup.match(/data-assistant-presence-doing="propose_edit"[^>]*>([^<]*)</);

    assert.match(markup, /data-assistant-presence-written="4312"/);
    assert.ok(said, "the mark carries the tool being written");
    assert.ok((said[1] ?? "").length > 0, "and says something of it beside the dots");
  });

  test("carries a count the ticks move, so the same tool does not stand still", () => {
    const at = (chars: number): string =>
      render({
        status: AssistantStatus.TurnActive,
        record: running,
        doing: { kind: "writing", tool: "propose_edit", chars },
      });

    assert.notEqual(at(2400), at(9600), "two counts of the same tool read differently");
  });

  test("carries no count for a call nothing has arrived for yet", () => {
    const markup = render({
      status: AssistantStatus.TurnActive,
      record: running,
      doing: { kind: "writing", tool: "propose_edit", chars: 0 },
    });

    assert.match(markup, /data-assistant-presence-doing="propose_edit"/);
    assert.match(markup, /data-assistant-presence-written="0"/);
  });
});

describe("the asks waiting their turn", () => {
  /** The conversation a waiting ask stands under: one ask answered by a turn still running. */
  const running = record([
    { kind: "user", text: "make me hide" },
    { kind: "assistant", steps: [{ kind: "narration", text: "Looking." }] },
  ]);

  /** The asks waiting in the tests below, in the order they were typed. */
  const waiting = [
    { id: "ask-0", text: "and jump" },
    { id: "ask-1", text: "then hide again" },
  ];

  test("stands each waiting ask after the running turn, in the order they were typed", () => {
    const markup = render({ status: AssistantStatus.TurnActive, record: running, pending: waiting });
    const bubbles = bubbleKinds(markup);

    assert.deepEqual(valuesOf(markup, "data-assistant-pending"), ["ask-0", "ask-1"]);
    assert.deepEqual(bubbles, ["ask", "entity", "entity", "ask", "ask"]);
    assert.ok(
      markup.indexOf("data-assistant-presence") < markup.indexOf('data-assistant-pending="ask-0"'),
      "a waiting ask stands below the turn still running"
    );
  });

  test("takes a tap where the host takes one back, and none where it does not", () => {
    /** The control the ask `id` waits in. */
    const bubble = (markup: string, id: string): string => {
      const tag = new RegExp(`<button[^>]*data-assistant-pending="${id}"[^>]*>`).exec(markup)?.[0];
      assert.ok(tag, `the view stands a control for ${id}`);
      return tag;
    };

    const taken = render({
      status: AssistantStatus.TurnActive,
      record: running,
      pending: waiting,
      onCancelAsk: () => {},
    });
    const inert = render({ status: AssistantStatus.TurnActive, record: running, pending: waiting });

    assert.doesNotMatch(bubble(taken, "ask-0"), /\sdisabled=""/);
    assert.match(bubble(inert, "ask-0"), /\sdisabled=""/);
  });

  test("stands nothing waiting where the host stands none", () => {
    for (const markup of [render({ status: AssistantStatus.TurnActive, record: running }), render()]) {
      assert.doesNotMatch(markup, /data-assistant-pending/);
      assert.doesNotMatch(markup, /data-assistant-send-now/);
    }
  });

  test("stands the control that hurries an ask along with the bubble it belongs to", () => {
    const markup = render({
      status: AssistantStatus.TurnActive,
      record: running,
      pending: waiting,
      onSendNow: () => {},
    });
    const marks = [...markup.matchAll(/data-assistant-(send-now|pending)="([^"]*)"/g)].map(
      (match) => `${match[1]}:${match[2]}`
    );

    assert.deepEqual(marks, ["send-now:ask-0", "pending:ask-0", "send-now:ask-1", "pending:ask-1"]);
  });

  test("takes a tap that hurries an ask along where the host takes one, and none where it does not", () => {
    /** The control standing beside the ask `id`. */
    const control = (markup: string, id: string): string => {
      const tag = new RegExp(`<button[^>]*data-assistant-send-now="${id}"[^>]*>`).exec(markup)?.[0];
      assert.ok(tag, `the view stands a control for ${id}`);
      return tag;
    };

    const taken = render({
      status: AssistantStatus.TurnActive,
      record: running,
      pending: waiting,
      onSendNow: () => {},
    });
    const inert = render({ status: AssistantStatus.TurnActive, record: running, pending: waiting });

    assert.doesNotMatch(control(taken, "ask-0"), /\sdisabled=""/);
    assert.match(control(inert, "ask-0"), /\sdisabled=""/);
  });

  test("stands the ask once across the handoff from waiting to recorded", () => {
    const held = render({ status: AssistantStatus.TurnActive, record: running, pending: [waiting[0]!] });
    const recorded = render({
      status: AssistantStatus.TurnActive,
      record: record([...running.entries, { kind: "user", text: waiting[0]!.text }]),
      pending: [],
    });

    assert.equal(countOf(held, /data-assistant-pending/), 1);
    assert.equal(countOf(held, /data-assistant-entry="user"/), 1, "the waiting ask is in no record entry of its own");
    assert.equal(countOf(recorded, /data-assistant-pending/), 0, "nothing waits once the record carries it");
    assert.equal(countOf(recorded, /data-assistant-entry="user"/), 2);
    assert.equal(countOf(held, new RegExp(waiting[0]!.text)), 1);
    assert.equal(countOf(recorded, new RegExp(waiting[0]!.text)), 1, "the ask reads once, not twice");
  });

  test("says nothing about an empty conversation while an ask waits in it", () => {
    const markup = render({ status: AssistantStatus.TurnActive, record: record([]), pending: [waiting[0]!] });

    assert.doesNotMatch(markup, /data-assistant-resting/);
    assert.equal(countOf(markup, /data-assistant-pending/), 1);
  });
});

describe("a session that is not simply ready", () => {
  test("shows a running turn a stop and no send", () => {
    const markup = render({ status: AssistantStatus.TurnActive, intent: "wait" });

    assert.match(markup, /<button[^>]*data-assistant-stop/);
    assert.doesNotMatch(markup, /data-assistant-send/);
  });

  test("says the session is waking while it opens, and offers nothing to retry", () => {
    const markup = render({ status: AssistantStatus.Connecting });

    assert.match(markup, /data-assistant-connection="connecting"/);
    assert.doesNotMatch(markup, /data-assistant-retry/);
  });

  test("offers a retry once the session has failed", () => {
    const markup = render({ status: AssistantStatus.Failed, onRetry: () => {} });

    assert.match(markup, /data-assistant-connection="failed"/);
    assert.match(markup, /<button[^>]*data-assistant-retry/);
  });

  test("offers no retry for a failure the host gave no way back from", () => {
    assert.doesNotMatch(render({ status: AssistantStatus.Failed }), /data-assistant-retry/);
  });
});

describe("a key pressed in the intent box", () => {
  test("plain Enter sends what is typed", () => {
    assert.equal(intentKeyAction("Enter", false, false, "make a heart"), "send");
  });

  test("Shift+Enter falls through to the newline it types", () => {
    assert.equal(intentKeyAction("Enter", true, false, "make a heart"), "pass");
  });

  test("an Enter mid-composition belongs to the composition", () => {
    assert.equal(intentKeyAction("Enter", false, true, "make a heart"), "pass");
  });

  test("Enter during a running turn still sends, queueing the ask for its own turn", () => {
    assert.equal(intentKeyAction("Enter", false, false, "make a heart"), "send");
  });

  test("Enter over whitespace is swallowed, not sent", () => {
    assert.equal(intentKeyAction("Enter", false, false, "   "), "swallow");
  });

  test("any other key falls through to typing", () => {
    assert.equal(intentKeyAction("a", false, false, "make a heart"), "pass");
  });

  test("Escape leaves the box rather than closing anything", () => {
    assert.equal(intentKeyAction("Escape", false, false, "make a heart"), "leave");
  });

  test("Escape leaves an empty box just the same", () => {
    assert.equal(intentKeyAction("Escape", false, false, ""), "leave");
  });

  test("Escape leaves the box while a turn is running too", () => {
    assert.equal(intentKeyAction("Escape", false, false, "make a heart"), "leave");
  });

  test("an Escape mid-composition belongs to the composition", () => {
    assert.equal(intentKeyAction("Escape", false, true, "make a heart"), "pass");
  });
});

/** An intent box standing in no document, recording every way it was asked to take the keyboard. */
function boxTakingKeyboard(): { box: HTMLTextAreaElement; takes: FocusOptions[] } {
  const takes: FocusOptions[] = [];
  const box = {
    focus: (options?: FocusOptions) => {
      takes.push(options ?? {});
    },
  } as unknown as HTMLTextAreaElement;
  return { box, takes };
}

const viewSource = readFileSync(fileURLToPath(new URL("./ConversationView.tsx", import.meta.url)), "utf8");

describe("the keyboard when the panel is opened", () => {
  test("an open the person asked for lands the keyboard in the intent box, scrolling nothing to do it", () => {
    const { box, takes } = boxTakingKeyboard();

    landKeyboardInIntent(box, 1);

    assert.deepEqual(takes, [{ preventScroll: true }]);
  });

  test("an open the person did not ask for lands the keyboard nowhere", () => {
    const { box, takes } = boxTakingKeyboard();

    landKeyboardInIntent(box, undefined);

    assert.deepEqual(takes, []);
  });

  test("the box the view stands is the one an open lands the keyboard in, once per open counted", () => {
    assert.match(viewSource, /landKeyboardInIntent\(intentBox\.current,\s*opensByPerson\)/);
    assert.match(viewSource, /\},\s*\[opensByPerson\]\)/);
  });
});

describe("the rehearsals a turn ran", () => {
  test("stands each rehearsal as a card of its own, out of the look-ups fold", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: rehearsed({}) }] }]),
    });

    assert.deepEqual(cardKinds(markup), ["run"]);
    assert.match(markup, /data-assistant-run-state="ran"/);
    assert.doesNotMatch(markup, /data-assistant-lookups/);
  });

  test("cuts the timeline into one cell per stretch, keeping the thinks each stretch covers", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            {
              kind: "toolCall",
              call: rehearsed({
                spans: [
                  span(0, 4, { when: ["rule-1=false"] }),
                  span(4, 16, { fired: ["rule-1"], when: ["rule-1=true"], dispatched: ["actuator.move()=1@rule-1"] }),
                ],
              }),
            },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-cell-thinks"), ["4", "16"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-cell-activity"), ["watching", "acting"]);
    assert.match(markup, /data-assistant-timeline="20"/);
  });

  test("reads a gate's own sensor call as watching, and a rule that reached no gate as acting", () => {
    const gateReads = rehearsed({
      spans: [span(0, 20, { when: ["rule-1=false"], dispatched: ["sensor.see(a carnivore=1)=1@rule-1"] })],
    });
    const ungated = rehearsed({ spans: [span(0, 20, { dispatched: ["actuator.move()=1@rule-9"] })] });
    const parked = rehearsed({ spans: [span(0, 20, { waiting: ["rule-1"] })] });
    const idle = rehearsed({ spans: [span(0, 20, {})] });

    const activityOf = (call: ConversationToolCall): string[] =>
      valuesOf(
        render({ record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call }] }]) }),
        "data-assistant-cell-activity"
      );

    assert.deepEqual(activityOf(gateReads), ["watching"]);
    assert.deepEqual(activityOf(ungated), ["acting"]);
    assert.deepEqual(activityOf(parked), ["waiting"]);
    assert.deepEqual(activityOf(idle), ["quiet"]);
  });

  test("cuts a stretch again where the run changed state, bringing a state it returns to back", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            {
              kind: "toolCall",
              call: rehearsed({
                thinks: 3,
                spans: [span(0, 3, { fired: ["rule-1"], when: ["rule-1=true"] })],
                identity: ["0 00000001", "1 00000002", "2 00000001"],
              }),
            },
          ],
        },
      ]),
    });

    const steps = valuesOf(markup, "data-assistant-cell-identity");
    assert.equal(steps.length, 3, "one cell per state the run stood in");
    assert.equal(steps[0], steps[2], "the state it came back to reads as the state it started in");
    assert.notEqual(steps[0], steps[1]);
    assert.deepEqual(valuesOf(markup, "data-assistant-cell-thinks"), ["1", "1", "1"]);
  });

  test("hangs the thinks every cell covers beside it, and reads out by more than it shows", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            {
              kind: "toolCall",
              call: rehearsed({
                thinks: 24,
                spans: [
                  span(0, 4, {}),
                  span(4, 6, { when: ["rule-1=false"] }),
                  span(10, 8, {
                    fired: ["rule-1"],
                    when: ["rule-1=true"],
                    dispatched: ["actuator.move(away from=1,it)=1@rule-1"],
                  }),
                  span(18, 6, { waiting: ["rule-1"] }),
                ],
                identity: ["0 00000001", "10 00000002"],
                state: ["0 energy=8", "10 energy=3"],
              }),
            },
          ],
        },
      ]),
    });

    const cells = cellSpans(markup);
    const notes = cellNoteWords(markup);
    assert.equal(cells.length, 4, "one cell per stretch, each of a different activity");
    assert.equal(notes.length, cells.length, "every cell carries the note standing beside it");
    let from = 0;
    cells.forEach((cell, at) => {
      const thinks = Number(/data-assistant-cell-thinks="(\d+)"/.exec(cell)?.[1]);
      const note = notes[at] ?? "";
      assert.deepEqual(
        [...note.matchAll(/\d+/g)].map((match) => Number(match[0])),
        thinks === 1 ? [from] : [from, from + thinks - 1],
        "the note names the thinks the cell covers, and nothing besides"
      );
      const reading = /aria-label="([^"]+)"/.exec(cell)?.[1];
      assert.ok(reading, `every cell tells the reader what it stands for: ${cell}`);
      assert.ok(reading.startsWith(note), "what it reads out by opens with the thinks it shows");
      assert.ok(reading.length > note.length, "a reader who cannot see the cell hears more than it shows");
      assert.doesNotMatch(cell, /title=/, "the words stand in the panel's own note, not the browser's tooltip");
      from += thinks;
    });
  });

  test("keeps what a state channel reported out of what the timeline says, naming only the channel", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            {
              kind: "toolCall",
              call: rehearsed({
                thinks: 12,
                spans: [span(0, 12, { fired: ["rule-1"], when: ["rule-1=true"] })],
                identity: ["0 00000001", "6 00000002"],
                state: ["0 display=0000000000", "6 display=0900009000"],
              }),
            },
          ],
        },
      ]),
    });

    assert.ok(
      cellSpans(markup).some((cell) => /aria-label="[^"]*display[^"]*"/.test(cell)),
      "the cell the channel changed at names the channel"
    );
    assert.doesNotMatch(markup, /0900009000/);
  });

  test("leaves the cells of a run that logged no state carrying none", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: rehearsed({ identity: [] }) }] }]),
    });

    assert.match(markup, /data-assistant-cell-activity/);
    assert.doesNotMatch(markup, /data-assistant-cell-identity/);
  });

  test("marks the page the brain moved to and the percepts the scenario delivered, in think order", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            {
              kind: "toolCall",
              call: rehearsed(
                {
                  spans: [span(0, 5, { when: ["rule-1=false"] }), span(5, 15, { when: ["rule-1=true"], page: "0->1" })],
                },
                {
                  scenario: {
                    seed: 1,
                    subject: "herbivore",
                    inputs: [{ kind: "carnivore-ahead", at: 2, value: 60 }],
                  },
                  thinks: 20,
                }
              ),
            },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-marker"), ["input", "page"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-marker-at"), ["2", "5"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-marker-kind"), ["carnivore-ahead"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-marker-page"), ["1"]);
  });

  test("says so where the record of a run stops before the run did", () => {
    const cut = rehearsed({ thinks: 400, spansTruncated: true, spans: [span(0, 30, { when: ["rule-1=true"] })] });

    const markup = render({ record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: cut }] }]) });

    assert.match(markup, /data-assistant-run-truncated="true"/);
    assert.match(markup, /data-assistant-timeline-cut="370"/);
  });

  test("says a run stopped short of the thinks it was asked for, and says nothing when it did not", () => {
    const short = rehearsed({ thinks: 6 });
    const whole = rehearsed({});

    assert.match(
      render({ record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: short }] }]) }),
      /data-assistant-run-asked="20"/
    );
    assert.doesNotMatch(
      render({ record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: whole }] }]) }),
      /data-assistant-run-asked/
    );
  });

  test("opens to the stretch-by-stretch record and what the run dispatched in all", () => {
    const call = rehearsed({ dispatchTotals: ["actuator.move(wandering=1)=17", "sensor.see()=20"] });

    const markup = render({ record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call }] }]) });

    assert.equal(countOf(markup, /data-assistant-fold="run"/), 1);
    assert.deepEqual(valuesOf(markup, "data-assistant-run-step"), ["acting"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-dispatch-count"), ["17", "20"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-dispatch"), [
      escaped("actuator.move(wandering=1)"),
      escaped("sensor.see()"),
    ]);
  });

  test("keeps a rehearsal that never ran as a card carrying the code that stopped it, with no timeline", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: rehearsalRefused("unknown_subject") }] }]),
    });

    assert.deepEqual(cardKinds(markup), ["run"]);
    assert.match(markup, /data-assistant-run-state="blocked"/);
    assert.match(markup, /data-assistant-run-blocked="unknown_subject"/);
    assert.doesNotMatch(markup, /data-assistant-timeline=/);
    assert.doesNotMatch(markup, /data-assistant-lookups/);
  });

  test("keeps a rehearsal the bridge could not serve out of the look-ups fold too", () => {
    const unserved: ConversationToolCall = {
      name: "simulate",
      input: scenario,
      outcome: { kind: "ok", payload: { error: "invalid_input", detail: "thinks: too_small" }, isError: true },
    };

    const markup = render({ record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: unserved }] }]) });

    assert.deepEqual(cardKinds(markup), ["run"]);
    assert.match(markup, /data-assistant-run-blocked="invalid_input"/);
  });

  test("stands the newest run full and folds every run it stands after to a line of its own", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: rehearsed({ runId: "run-1" }) },
            { kind: "toolCall", call: rehearsed({ runId: "run-2", thinks: 12 }) },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["run", "run"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-run"), ["run-1", "run-2"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-run-superseded"), ["true"]);
    assert.equal(countOf(markup, /data-assistant-fold="run"/), 2, "a superseded run still opens to its record");
    assert.equal(countOf(markup, /data-assistant-fold="earlier-run"/), 1, "only the run stood after folds to a line");
  });
});

describe("what the assistant said, read against the work it stands beside", () => {
  test("draws the runs that carry the shape of the work on cards, and the rest in its bubble", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "narration", text: "Two pages.", role: NarrationRole.Plan },
            { kind: "narration", text: "Why did it not fire?", role: NarrationRole.Diagnosis },
            { kind: "narration", text: "It hid.", role: NarrationRole.Verdict, judgment: NarrationJudgment.Succeeded },
            { kind: "narration", text: "Let me look." },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["narration", "narration", "narration", "narration"]);
    assert.deepEqual(bubbleKinds(markup), ["entity", "entity"], "only the unshaped runs keep the bubble");
  });

  test("dims every plan the turn stood after, leaving the newest one plain", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "narration", text: "Two pages.", role: NarrationRole.Plan },
            { kind: "narration", text: "Working on it." },
            { kind: "narration", text: "One page after all.", role: NarrationRole.Pivot },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-narration-role"), [NarrationRole.Plan, NarrationRole.Pivot]);
    assert.deepEqual(valuesOf(markup, "data-assistant-plan-superseded"), ["true"]);
  });

  test("dims no plan of a turn the conversation stood after, whose plan was carried out", () => {
    const plan: ConversationTurnStep = { kind: "narration", text: "Two pages.", role: NarrationRole.Plan };
    const markup = render({
      record: record([
        { kind: "user", text: "make me hide" },
        { kind: "assistant", steps: [plan], ending: { kind: "end", code: RelayTurnEndCode.Complete } },
        { kind: "user", text: "now make me run" },
        { kind: "assistant", steps: [plan] },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-plan-superseded"), []);
  });

  test("gives a verdict's judgment to the rehearsal it stood after, and keeps the words it was said in", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: rehearsed({ runId: "run-1" }) },
            {
              kind: "narration",
              text: "It hid every time.",
              role: NarrationRole.Verdict,
              judgment: NarrationJudgment.Succeeded,
            },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-run-judgment"), [NarrationJudgment.Succeeded]);
    assert.deepEqual(cardKinds(markup), ["run", "narration"], "the verdict keeps a card of its own");
  });

  test("gives each rehearsal the verdict that followed it, and none to one no verdict reached", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: rehearsed({ runId: "run-1" }) },
            { kind: "narration", text: "Not yet.", role: NarrationRole.Verdict, judgment: NarrationJudgment.Failed },
            { kind: "toolCall", call: rehearsed({ runId: "run-2" }) },
            { kind: "toolCall", call: rehearsed({ runId: "run-3" }) },
            { kind: "narration", text: "There.", role: NarrationRole.Verdict, judgment: NarrationJudgment.Succeeded },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-run"), ["run-1", "run-2", "run-3"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-run-judgment"), [
      NarrationJudgment.Failed,
      NarrationJudgment.Succeeded,
    ]);
  });

  test("marks no rehearsal from a verdict standing before the turn ran one", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "narration", text: "It hid.", role: NarrationRole.Verdict, judgment: NarrationJudgment.Succeeded },
            { kind: "toolCall", call: rehearsed({ runId: "run-1" }) },
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-run-judgment"), []);
  });

  test("turns the diagnosis into the note that answered it, where the diagnosis stood", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            {
              kind: "narration",
              text: "Why did it not fire?",
              body: "Both rules fired.",
              role: NarrationRole.Diagnosis,
            },
            { kind: "toolCall", call: appliedEdit },
            {
              kind: "narration",
              text: "A child waits for its parent.",
              body: "So it needed its own rule.",
              role: NarrationRole.Note,
            },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["narration", "receipt"], "the note joined the card the diagnosis opened");
    assert.deepEqual(valuesOf(markup, "data-assistant-narration-role"), [NarrationRole.Note]);
    assert.deepEqual(valuesOf(markup, "data-assistant-note-from"), [NarrationRole.Diagnosis]);
    const story = /data-assistant-narration-body[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
    for (const kept of ["Why did it not fire?", "Both rules fired.", "So it needed its own rule."]) {
      assert.ok(story.includes(kept), `the fold keeps ${JSON.stringify(kept)}`);
    }
  });

  test("opens a card of its own for a note no diagnosis went looking for", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [{ kind: "narration", text: "A child waits for its parent.", role: NarrationRole.Note }],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["narration"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-note-from"), []);
  });

  test("gives a snag the words the assistant said about it, in place of the line it reads as", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: refusedEdit },
            {
              kind: "narration",
              text: "That tile only asks a question, so it cannot do anything.",
              body: "I moved it to the other side.",
              role: NarrationRole.Snag,
            },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["snag"], "the snag's words joined the snag");
    assert.deepEqual(valuesOf(markup, "data-assistant-snag-captioned"), ["true"]);
    assert.match(markup, /data-assistant-snag-caption-body/);
  });

  test("leaves a snag no words reached reading as the line it always did", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "toolCall", call: refusedEdit }] }]),
    });

    assert.deepEqual(cardKinds(markup), ["snag"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-snag-captioned"), []);
    assert.deepEqual(valuesOf(markup, "data-assistant-snag-tile"), [escaped(seeTile.tileId)]);
  });
});

describe("a build that came back dirty", () => {
  test("stands as a card of its own, out of the look-ups fold, counting what stops the build", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            {
              kind: "toolCall",
              call: dirtyBuild([droppedTile, { code: 3002, severity: "warning", ruleId: "rule-1", params: {} }]),
            },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["build"]);
    assert.match(markup, /data-assistant-build-errors="1"/);
    assert.deepEqual(valuesOf(markup, "data-assistant-build-diag"), ["1016", "3002"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-build-severity"), ["error", "warning"]);
    assert.doesNotMatch(markup, /data-assistant-lookups/);
  });

  test("counts builds that came back reporting the very same things as one card", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: dirtyBuild([droppedTile]) },
            { kind: "toolCall", call: dirtyBuild([droppedTile]) },
            { kind: "toolCall", call: dirtyBuild([{ code: 1015, severity: "error", ruleId: "rule-2", params: {} }]) },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["build", "build"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-build-repeats"), ["2", "1"]);
  });

  test("leaves a clean build ticking the receipts standing, saying nothing of its own", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: appliedEdit },
            { kind: "toolCall", call: cleanBuild },
            { kind: "toolCall", call: dirtyBuild([droppedTile]) },
          ],
        },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["receipt", "build"]);
    assert.equal(countOf(markup, /data-assistant-compiles="ok"/), 1, "the tick a clean build left stands");
  });
});

describe("the turns a conversation stands after", () => {
  test("folds every turn but the newest to a header the keyboard opens", () => {
    const markup = render({
      record: record([
        { kind: "user", text: "make me hide" },
        {
          kind: "assistant",
          steps: [{ kind: "toolCall", call: appliedEdit }],
          ending: { kind: "end", code: RelayTurnEndCode.Complete },
        },
        { kind: "user", text: "now run away" },
        { kind: "assistant", steps: [{ kind: "narration", text: "On it." }] },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-turn"), ["folded", "latest"]);
    assert.equal(countOf(markup, /<details[^>]*data-assistant-fold="turn"/), 1);
    assert.equal(countOf(markup, /data-assistant-fold="turn"/), 1);
  });

  test("leaves a lone turn standing full", () => {
    const markup = render({
      record: record([
        { kind: "user", text: "make me hide" },
        { kind: "assistant", steps: [{ kind: "narration", text: "On it." }] },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-turn"), ["latest"]);
    assert.doesNotMatch(markup, /data-assistant-fold="turn"/);
  });

  test("keeps every block of a folded turn behind its header", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: appliedEdit },
            { kind: "toolCall", call: rehearsed({}) },
          ],
          ending: { kind: "end", code: RelayTurnEndCode.Complete },
        },
        { kind: "assistant", steps: [{ kind: "narration", text: "On it." }] },
      ]),
    });

    assert.deepEqual(cardKinds(markup), ["receipt", "run", "narration"]);
    assert.equal(countOf(markup, /<summary/), 3, "the turn's own header, its edits fold, and its run fold");
  });
});

describe("where a conversation got to when a turn left no answer", () => {
  const kept: readonly ConversationTurnStep[] = [
    { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
    { kind: "toolCall", call: cleanBuild },
    { kind: "toolCall", call: rehearsed({}) },
  ];

  test("stands an account of what is kept above the note on every ending that left none", () => {
    const answerless = [
      RelayTurnEndCode.Stopped,
      RelayTurnEndCode.Truncated,
      RelayTurnEndCode.Failed,
      RelayTurnEndCode.LeaseExhausted,
    ] as const;

    for (const code of answerless) {
      const markup = render({ record: record([{ kind: "assistant", steps: kept, ending: { kind: "end", code } }]) });
      assert.match(markup, /data-assistant-card="gotto"/, code);
      assert.match(markup, /data-assistant-gotto-rules="1"/, code);
    }
    for (const code of Object.values(ConversationTurnFailureCode)) {
      const cut = record([{ kind: "assistant", steps: kept, ending: { kind: "failure", code } }]);
      assert.match(render({ record: cut }), /data-assistant-card="gotto"/, code);
    }
  });

  test("says nothing of the kind about a turn that simply finished", () => {
    const finished = record([
      { kind: "assistant", steps: kept, ending: { kind: "end", code: RelayTurnEndCode.Complete } },
    ]);

    assert.doesNotMatch(render({ record: finished }), /data-assistant-card="gotto"/);
  });

  test("stands above the note about how the turn ended, not below it", () => {
    const stopped = record([
      { kind: "assistant", steps: kept, ending: { kind: "end", code: RelayTurnEndCode.Stopped } },
    ]);

    const markup = render({ record: stopped });
    assert.ok(
      markup.indexOf('data-assistant-card="gotto"') < markup.indexOf("data-assistant-ending="),
      "the account of what is kept comes first"
    );
  });

  test("carries what every turn left standing, including the turns folded away", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [{ kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) }],
          ending: { kind: "end", code: RelayTurnEndCode.Complete },
        },
        {
          kind: "assistant",
          steps: [{ kind: "toolCall", call: placedOn(scared, "rule-2", [seeTile]) }],
          ending: { kind: "end", code: RelayTurnEndCode.Truncated },
        },
      ]),
    });

    assert.match(markup, /data-assistant-gotto-rules="2"/);
    assert.match(markup, /data-assistant-gotto-pages="2"/);
    assert.deepEqual(valuesOf(markup, "data-assistant-gotto-page"), [wandering.pageId, scared.pageId]);
  });

  test("takes a rule a later turn deleted back out of what is kept", () => {
    const removed: ConversationToolCall = {
      name: "propose_edit",
      input: { op: "deleteRule", ruleId: "rule-1" },
      outcome: {
        kind: "ok",
        payload: {
          ok: true,
          historyDepth: 2,
          onPage: wandering,
          removed: "rule",
          rule: { ruleId: "rule-1", when: [], do: [], children: [] },
        },
      },
    };
    const entries: readonly ConversationEntry[] = [
      {
        kind: "assistant",
        steps: [
          { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
          { kind: "toolCall", call: placedOn(scared, "rule-2", [seeTile]) },
        ],
        ending: { kind: "end", code: RelayTurnEndCode.Complete },
      },
      {
        kind: "assistant",
        steps: [{ kind: "toolCall", call: removed }],
        ending: { kind: "end", code: RelayTurnEndCode.Stopped },
      },
    ];

    const kept = render({ record: record(entries) });
    const before = render({
      record: record([{ ...entries[0], ending: { kind: "end", code: RelayTurnEndCode.Stopped } } as ConversationEntry]),
    });

    assert.match(before, /data-assistant-gotto-rules="2"/, "both rules stand before the delete");
    assert.match(kept, /data-assistant-gotto-rules="1"/);
    assert.deepEqual(valuesOf(kept, "data-assistant-gotto-page"), [scared.pageId]);
  });

  test("says nothing at all when a turn that left no answer kept nothing either", () => {
    const nothing = record([
      { kind: "assistant", steps: [], ending: { kind: "failure", code: ConversationTurnFailureCode.NotConnected } },
    ]);

    const markup = render({ record: nothing });
    assert.doesNotMatch(markup, /data-assistant-card="gotto"/);
    assert.match(markup, /data-assistant-ending="not_connected"/);
  });

  test("counts the ways the editor refused a proposal that nothing took back", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: refusedEdit },
            { kind: "toolCall", call: refusedEdit },
            { kind: "toolCall", call: refusedFor(moveTile.tileId) },
            { kind: "toolCall", call: appliedEdit },
          ],
          ending: { kind: "end", code: RelayTurnEndCode.Truncated },
        },
      ]),
    });

    assert.match(markup, /data-assistant-gotto-snags="2"/);
  });
});

describe("a question the assistant puts to the person", () => {
  /** A record whose turn ends on a question asking `text` and offering `body` under it. */
  function questioned(body?: string, text = "Want it to call out when it flees?"): ConversationRecord {
    return record([
      {
        kind: "assistant",
        steps: [
          { kind: "narration", text: "It hid.", role: NarrationRole.Verdict, judgment: NarrationJudgment.Succeeded },
          {
            kind: "narration",
            text,
            ...(body === undefined ? {} : { body }),
            role: NarrationRole.Ask,
          },
        ],
      },
    ]);
  }

  /** The tag of every answer the transcript offered, which carries whether it takes a click. */
  function answerControls(markup: string): string[] {
    return [...markup.matchAll(/<button[^>]*data-assistant-answer[^>]*>/g)].map((match) => match[0]);
  }

  /** The tag of every chip leaving a question where it stands, which carries whether it takes a click. */
  function leaveControls(markup: string): string[] {
    return [...markup.matchAll(/<button[^>]*data-assistant-leave[^>]*>/g)].map((match) => match[0]);
  }

  /** Matches the attribute standing a chip down, never the classes naming how it then reads. */
  const standsDown = /\sdisabled=""/;

  test("stands the question on a card of its own, after the verdict it follows", () => {
    const markup = render({ record: questioned("- Yes please\n- No thanks"), onAnswer: () => {} });

    assert.deepEqual(valuesOf(markup, "data-assistant-narration-role"), ["verdict", "ask"]);
    assert.deepEqual(cardKinds(markup), ["narration", "narration"]);
    assert.equal(bubbleAround(markup, "data-assistant-answers"), undefined, "the question never stands in a bubble");
  });

  test("offers each list-marked line standing under the question as an answer, and folds none of it away", () => {
    const markup = render({ record: questioned("- Yes please\n\n- No thanks"), onAnswer: () => {} });

    assert.deepEqual(valuesOf(markup, "data-assistant-answers"), ["2"]);
    assert.equal(answerControls(markup).length, 2);
    assert.doesNotMatch(markup, /data-assistant-fold="narration"/);
  });

  test("says the plain lines under the question on the card, and offers only the list-marked ones", () => {
    const markup = render({
      record: questioned("A box keeps a value between thinks.\n\nWhat should it keep?\n- A count\n- A score"),
      onAnswer: () => {},
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-answers"), ["2"]);
    assert.equal(answerControls(markup).length, 2);
    assert.match(markup, /data-assistant-ask-said/);
    assert.match(markup, /data-assistant-answer[^>]*>A count</);
    assert.doesNotMatch(markup, /data-assistant-answer[^>]*>A box keeps/);
    assert.doesNotMatch(markup, /data-assistant-fold="narration"/);
  });

  test("offers the answers that followed the question with no blank line between", () => {
    const markup = render({
      record: questioned(undefined, "Want it to call out when it flees?\n- Yes please\n- No thanks"),
      onAnswer: () => {},
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-answers"), ["2"]);
    assert.match(
      markup,
      /data-assistant-narration="true"[^>]*><p[^>]*>Want it to call out when it flees\?<\/p><\/div>/
    );
    assert.match(markup, /data-assistant-answer[^>]*>Yes please</);
    assert.match(markup, /data-assistant-answer[^>]*>No thanks</);
  });

  test("reads an answer without the list marker its line opened with", () => {
    const markup = render({ record: questioned("- Yes please\n2. No thanks"), onAnswer: () => {} });

    assert.match(markup, /data-assistant-answer[^>]*>Yes please</);
    assert.match(markup, /data-assistant-answer[^>]*>No thanks</);
  });

  test("stands a question that offered nothing beside the chip that leaves it", () => {
    const markup = render({ record: questioned(), onAnswer: () => {} });

    assert.deepEqual(valuesOf(markup, "data-assistant-answers"), ["0"]);
    assert.equal(answerControls(markup).length, 0);
    assert.equal(leaveControls(markup).length, 1);
  });

  test("stands the chip that leaves the question beside every question, however many answers it offered", () => {
    const markup = render({ record: questioned("- Yes please\n- No thanks"), onAnswer: () => {} });

    assert.equal(leaveControls(markup).length, 1);
  });

  test("stands no chip that leaves anything beside a run that asked nothing", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [{ kind: "narration", text: "Done.", role: NarrationRole.Note }] }]),
      onAnswer: () => {},
    });

    assert.deepEqual(leaveControls(markup), []);
  });

  test("leaves every chip under the question untakeable while a turn is running", () => {
    const markup = render({
      record: questioned("- Yes please\n- No thanks"),
      onAnswer: () => {},
      status: AssistantStatus.TurnActive,
    });

    for (const control of [...answerControls(markup), ...leaveControls(markup)]) assert.match(control, standsDown);
  });

  test("leaves every chip under the question untakeable where the host takes no answer", () => {
    const markup = render({ record: questioned("- Yes please\n- No thanks") });

    for (const control of [...answerControls(markup), ...leaveControls(markup)]) assert.match(control, standsDown);
  });

  test("takes an answer while the turn is done and the host takes one", () => {
    const markup = render({ record: questioned("- Yes please\n- No thanks"), onAnswer: () => {} });

    const controls = [...answerControls(markup), ...leaveControls(markup)];
    assert.equal(controls.length, 3);
    for (const control of controls) assert.doesNotMatch(control, standsDown);
  });

  test("folds a question of an older turn away with the turn it belongs to", () => {
    const markup = render({
      record: record([
        ...questioned("- Yes please").entries,
        { kind: "user", text: "yes please" },
        { kind: "assistant", steps: [{ kind: "narration", text: "Done." }] },
      ]),
      onAnswer: () => {},
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-turn"), ["folded", "latest"]);
  });
});

describe("the things the assistant names", () => {
  /** A catalog answering `get` from `defs`. */
  function catalogOf(defs: readonly IBrainTileDef[]): ITileCatalog {
    const held = new Map(defs.map((def) => [def.tileId, def]));
    return { get: (tileId: string) => held.get(tileId) } as unknown as ITileCatalog;
  }

  /** A tile definition carrying the visual the host reads it by. */
  function definition(tile: NamedTile, iconUrl: string, hue: string): IBrainTileDef {
    return {
      tileId: tile.tileId,
      kind: "sensor",
      metadata: { label: tile.label, iconUrl, colorDef: { when: hue, do: hue } },
    } as unknown as IBrainTileDef;
  }

  /** The brain the host stands: both tiles, each with its own icon and hue. */
  const surface: BrainSurface = {
    tileCatalogs: [
      catalogOf([definition(seeTile, "/icons/see.svg", "#AA94EB"), definition(moveTile, "/icons/move.svg", "#93A6EB")]),
    ],
  };

  /** A document read back, holding `ruleIds` on `page`. */
  function readProject(page: NamedPage, ruleIds: readonly string[]): ConversationToolCall {
    return {
      name: "read_project",
      input: {},
      outcome: {
        kind: "ok",
        payload: {
          brainName: "Herbivore",
          pages: [{ ...page, rules: ruleIds.map((ruleId) => ({ ruleId, when: [], do: [], children: [] })) }],
        },
      },
    };
  }

  /** A run of the assistant's own words, as the record holds one. */
  function said(text: string): ConversationTurnStep {
    return { kind: "narration", text };
  }

  test("draws each side of a rule as a band opened by that side's capsule", () => {
    const markup = render({
      record: record([
        {
          kind: "assistant",
          steps: [{ kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) }],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-side"), ["do"]);
    assert.match(markup, /bg-brain-capsule/);
    assert.match(markup, />DO</);
  });

  test("reads a tile by the word the conversation carried while the host stands no brain", () => {
    const markup = render({
      record: record([
        { kind: "assistant", steps: [{ kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) }] },
      ]),
    });

    assert.match(markup, new RegExp(`data-assistant-tile-word[^>]*>${moveTile.label}<`));
    assert.doesNotMatch(markup, /<img/);
  });

  test("draws a tile in its own icon and hue where the host stands the brain it belongs to", () => {
    const markup = render({
      brainSurface: surface,
      record: record([
        { kind: "assistant", steps: [{ kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) }] },
      ]),
    });

    assert.match(markup, /<img src="\/icons\/move.svg"/);
    assert.match(markup, /border-color:#93A6EB/);
  });

  test("numbers a rule whose page the conversation has read, and leaves one it has only seen edited unnumbered", () => {
    const read = render({
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: readProject(wandering, ["rule-0", "rule-1"]) },
            { kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) },
          ],
        },
      ]),
    });
    const unread = render({
      record: record([
        { kind: "assistant", steps: [{ kind: "toolCall", call: placedOn(wandering, "rule-1", [moveTile]) }] },
      ]),
    });

    assert.match(read, /bg-brain-pill/);
    assert.doesNotMatch(unread, /bg-brain-pill/);
  });

  test("draws a tile, a rule and a page the assistant named in its words as the chips standing for them", () => {
    const markup = render({
      brainSurface: surface,
      record: record([
        {
          kind: "assistant",
          steps: [
            { kind: "toolCall", call: readProject(wandering, ["rule-0", "rule-1"]) },
            said("my `tile:tile.sensor->see` saw it, `rule:rule-1` fired, and I went to `page:page-wandering`"),
          ],
        },
      ]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-tile"), [escaped(seeTile.tileId)]);
    assert.deepEqual(valuesOf(markup, "data-assistant-reference"), ["rule", "page"]);
    assert.deepEqual(valuesOf(markup, "data-assistant-reference-id"), ["rule-1", "page-wandering"]);
    assert.match(markup, new RegExp(`data-assistant-reference-word[^>]*>${wandering.name}<`));
  });

  test("leaves a reference to something the conversation has never seen as the id it names", () => {
    const markup = render({
      record: record([{ kind: "assistant", steps: [said("my `rule:rule-gone` fired")] }]),
    });

    assert.deepEqual(valuesOf(markup, "data-assistant-reference"), []);
    assert.match(markup, /<code[^>]*text-warning[^>]*>rule-gone<\/code>/);
  });

  /** A record naming a rule and a page the conversation has read the page of. */
  const namedBoth = record([
    {
      kind: "assistant",
      steps: [
        { kind: "toolCall", call: readProject(wandering, ["rule-0", "rule-1"]) },
        said("`rule:rule-1` fired, and I went to `page:page-wandering`"),
      ],
    },
  ]);

  /** Places standing `rule-1` at `line` on `wandering`, and nothing else anywhere. */
  function placing(line: number): BrainPlaces {
    return {
      locateRule: (ruleId: string) => (ruleId === "rule-1" ? { pageId: wandering.pageId, line } : undefined),
      reveal: () => {},
    };
  }

  /** The tag of every reference the transcript drew, which carries whether it takes a click. */
  function referenceControls(markup: string): string[] {
    return [...markup.matchAll(/<(?:button|span)[^>]*data-assistant-reference="[^>]*>/g)].map((match) => match[0]);
  }

  test("makes a rule and a page the host can show into things the person can tap", () => {
    const markup = render({ record: namedBoth, brainPlaces: placing(2) });

    for (const control of referenceControls(markup)) assert.match(control, /^<button/);
  });

  test("leaves every reference untappable while the host stands no editor", () => {
    const markup = render({ record: namedBoth });

    for (const control of referenceControls(markup)) assert.match(control, /^<span/);
  });

  test("numbers a rule from the document the host stands, over what the conversation read", () => {
    const markup = render({ record: namedBoth, brainPlaces: placing(7) });

    assert.match(markup, /data-assistant-reference-word[^>]*>rule 7</);
  });

  test("keeps the number the conversation read for a rule the standing document places nowhere", () => {
    const markup = render({
      record: namedBoth,
      brainPlaces: { locateRule: () => undefined, reveal: () => {} },
    });

    assert.match(markup, /data-assistant-reference-word[^>]*>rule 2</);
    assert.match(/<(?:button|span)[^>]*data-assistant-reference="rule"[^>]*>/.exec(markup)?.[0] ?? "", /^<span/);
  });
});

describe("the libraries the assistant offers", () => {
  /** The coordinates the shelf in this block holds. */
  const position = "example-org/lib-position";
  const flock = "example-org/lib-flock";
  const bundled = "example-org/lib-bundled";

  /** The shelf the host stands: two libraries published at a page of their own, and one bundled with the app. */
  const shelf: readonly LibraryShelfEntry[] = [
    {
      coordinate: position,
      name: "Position",
      version: "1.3.0",
      description: "Position sensing.",
      installed: false,
      sourceUrl: `https://github.com/${position}`,
    },
    {
      coordinate: flock,
      name: "Flock",
      version: "2.0.1",
      description: "Flocking.",
      installed: true,
      sourceUrl: `https://github.com/${flock}`,
    },
    { coordinate: bundled, name: "Bundled", version: "1.0.0", description: "Comes with the app.", installed: false },
  ];

  /** Offers over {@link shelf}, whose install answers that the project holds what it was asked for. */
  function offering(): LibraryOffers {
    return {
      entryFor: (coordinate) => shelf.find((entry) => entry.coordinate === coordinate),
      install: async () => true,
    };
  }

  /** A coordinate no shelf in this block holds. */
  const gone = "example-org/lib-gone";

  /** One call offering `coordinates`, answered listed for each of `listed` and unknown for the rest. */
  function offerCall(coordinates: readonly string[], listed: readonly string[]): ConversationToolCall {
    return {
      name: "offer_libraries",
      input: { coordinates },
      outcome: {
        kind: "ok",
        payload: {
          offers: coordinates.map((coordinate) =>
            listed.includes(coordinate)
              ? { coordinate, verdict: LibraryOfferVerdict.Listed }
              : {
                  coordinate,
                  verdict: LibraryOfferVerdict.Unknown,
                  code: LibraryOfferUnknownCode.NotShelved,
                  message: `nothing is shelved at "${coordinate}"`,
                }
          ),
        },
      },
    };
  }

  /** A record whose one turn offered `coordinates`, answered as the shelf standing behind it holds them. */
  function offered(coordinates: readonly string[]): ConversationRecord {
    const listed = coordinates.filter((coordinate) => shelf.some((entry) => entry.coordinate === coordinate));
    return record([{ kind: "assistant", steps: [{ kind: "toolCall", call: offerCall(coordinates, listed) }] }]);
  }

  /** A record whose one turn was answered that each of `coordinates` is listed, whatever a shelf holds now. */
  function offeredAsListed(coordinates: readonly string[]): ConversationRecord {
    return record([{ kind: "assistant", steps: [{ kind: "toolCall", call: offerCall(coordinates, coordinates) }] }]);
  }

  test("draws a library the assistant offered as the card offering it", () => {
    const markup = render({ record: offered([position]), libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library"), [position]);
    assert.deepEqual(valuesOf(markup, "data-assistant-library-state"), ["offerable"]);
    assert.match(markup, /data-assistant-library-version[^>]*>1\.3\.0</);
    assert.match(markup, /data-assistant-library-add/);
  });

  test("draws one card per library an offer listed, in the order it offered them", () => {
    const markup = render({ record: offered([bundled, position, flock]), libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library"), [bundled, position, flock]);
  });

  test("draws nothing at all for a coordinate the offer came back unknown for", () => {
    const markup = render({ record: offered([position, gone, flock]), libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library"), [position, flock]);
    assert.doesNotMatch(markup, new RegExp(gone));
  });

  test("draws one card for a library the same turn offered twice", () => {
    const twice = record([
      {
        kind: "assistant",
        steps: [
          { kind: "toolCall", call: offerCall([position], [position]) },
          { kind: "toolCall", call: offerCall([position, flock], [position, flock]) },
        ],
      },
    ]);

    assert.deepEqual(valuesOf(render({ record: twice, libraryOffers: offering() }), "data-assistant-library"), [
      position,
      flock,
    ]);
  });

  test("reads the shelf as it draws, so every card of a library just added stands added", () => {
    const twice = record([
      { kind: "assistant", steps: [{ kind: "toolCall", call: offerCall([position], [position]) }] },
      { kind: "user", text: "what else is there?" },
      { kind: "assistant", steps: [{ kind: "toolCall", call: offerCall([position], [position]) }] },
    ]);
    /** The same shelf once the project holds {@link position}, as an install leaves it. */
    const held: LibraryOffers = {
      entryFor: (coordinate) =>
        shelf
          .map((entry) => (entry.coordinate === position ? { ...entry, installed: true } : entry))
          .find((entry) => entry.coordinate === coordinate),
      install: async () => false,
    };

    assert.deepEqual(valuesOf(render({ record: twice, libraryOffers: offering() }), "data-assistant-library-state"), [
      "offerable",
      "offerable",
    ]);
    const after = render({ record: twice, libraryOffers: held });
    assert.deepEqual(valuesOf(after, "data-assistant-library-state"), ["installed", "installed"]);
    assert.doesNotMatch(after, /data-assistant-library-add/);
  });

  test("stands the offered cards at the end of the turn, under everything it said", () => {
    const answered = record([
      {
        kind: "assistant",
        steps: [
          { kind: "narration", text: "Nothing here senses that." },
          { kind: "toolCall", call: offerCall([position], [position]) },
          { kind: "narration", text: "This one does." },
        ],
      },
    ]);

    const markup = render({ record: answered, libraryOffers: offering() });

    assert.ok(
      markup.indexOf('data-assistant-library="') > markup.lastIndexOf("data-assistant-narration"),
      "the cards stand after the last thing the turn said"
    );
  });

  test("keeps a turn's offers standing once a later turn folds it", () => {
    const later = record([
      { kind: "assistant", steps: [{ kind: "toolCall", call: offerCall([position], [position]) }] },
      { kind: "user", text: "add it" },
      { kind: "assistant", steps: [{ kind: "narration", text: "It is in." }] },
    ]);

    const markup = render({ record: later, libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library"), [position]);
    assert.equal(markup, render({ record: later, libraryOffers: offering() }), "a second draw stands the same offer");
  });

  test("leaves a library named in the assistant's own words as plain text, offering nothing", () => {
    const named = record([
      { kind: "assistant", steps: [{ kind: "narration", text: `Something like \`library:${position}\` would.` }] },
    ]);

    const markup = render({ record: named, libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library"), []);
    assert.doesNotMatch(markup, /data-assistant-library-add/);
    assert.match(markup, new RegExp(`library:${position}`));
  });

  test("stands an offer the shelf no longer holds inert, with nothing to tap", () => {
    const markup = render({ record: offeredAsListed([gone]), libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library-state"), ["stale"]);
    assert.doesNotMatch(markup, /data-assistant-library-add/);
  });

  test("stands every offer inert while the host stands no shelf", () => {
    const markup = render({ record: offered([position]) });

    assert.deepEqual(valuesOf(markup, "data-assistant-library-state"), ["stale"]);
    assert.doesNotMatch(markup, /data-assistant-library-add/);
  });

  test("stands a library the project already holds as added, with nothing left to tap", () => {
    const markup = render({ record: offered([flock]), libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library-state"), ["installed"]);
    assert.doesNotMatch(markup, /data-assistant-library-add/);
  });

  test("opens the page of a library published at one in a tab of its own", () => {
    const markup = render({ record: offered([position]), libraryOffers: offering() });

    assert.match(markup, new RegExp(`data-assistant-library-open[^>]*href="https://github.com/${position}"`));
    assert.match(markup, /data-assistant-library-open[^>]*target="_blank"/);
  });

  test("leaves the reading of a library published nowhere of its own opening nothing", () => {
    const markup = render({ record: offered([bundled]), libraryOffers: offering() });

    assert.deepEqual(valuesOf(markup, "data-assistant-library"), [bundled]);
    assert.doesNotMatch(markup, /data-assistant-library-open/);
  });
});
