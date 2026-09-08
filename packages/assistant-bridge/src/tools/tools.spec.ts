import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkLiteralFactoryTileId } from "@wendoo/core/brain";
import type { BrainTileLiteralDef } from "@wendoo/core/brain/tiles";
import { catalogDigest } from "../catalog/digest.js";
import { ARGS_TRUNCATION_MARKER, CATALOG_TEXT_LIMITS, sanitizeArgsText } from "../catalog/sanitize.js";
import { CatalogScope } from "../catalog/scope.js";
import {
  createTargetAdapter,
  FAKE_INPUT_KIND,
  FAKE_LONG_UNIT,
  FAKE_SUBJECT,
  FAKE_SWATCH_LITERAL_FACTORY_ID,
  ruleIdAt,
} from "../testing/index.js";
import { executeToolCall } from "./dispatch.js";
import { proposeEdit, resolveRunEntry } from "./propose-edit.js";
import type { CatalogTile } from "./read-catalog.js";
import { catalogTiles, readCatalog } from "./read-catalog.js";
import { readProject } from "./read-project.js";
import { suggestTiles } from "./suggest-tiles.js";
import { maxBatchCommands, toolDefinitions } from "./tool-schemas.js";
import type { AuthoringWorkspace } from "./workspace.js";
import { createAuthoringWorkspace } from "./workspace.js";

/** Tiles the fake target's brains are authored from. */
const tiles = {
  sensor: "tile.sensor->sensor.fake.signal",
  actuator: "tile.actuator->actuator.fake.emit",
  asyncActuator: "tile.actuator->actuator.fake.chime",
  modifier: "tile.modifier->modifier:fake.loudly",
  parameter: "tile.parameter->parameter:fake.strength",
  numberFactory: "tile.lit.factory->number",
  variableFactory: "tile.var.factory->number",
} as const;

/** A workspace over the fake target, one empty rule ready on its first page. */
function workspace(): AuthoringWorkspace {
  return createAuthoringWorkspace(createTargetAdapter(), "fake brain");
}

/** Author `WHEN the signal is on DO emit loudly at strength 7` into the document's one rule. */
function authorSignalRule(ws: AuthoringWorkspace): void {
  const when = proposeEdit(ws, {
    op: "placeTiles",
    ruleId: ruleIdAt(ws.brainDef, "0/0"),
    side: "when",
    tileIds: [tiles.sensor],
  });
  assert.equal(when.ok, true, JSON.stringify(when));
  const doSide = proposeEdit(ws, {
    op: "placeTiles",
    ruleId: ruleIdAt(ws.brainDef, "0/0"),
    side: "do",
    tileIds: [tiles.actuator, tiles.modifier, tiles.parameter, { tileId: tiles.numberFactory, value: 7 }],
  });
  assert.equal(doSide.ok, true, JSON.stringify(doSide));
}

describe("the bridge tools over a real target", () => {
  test("offers every tool the model may call, in a stable order", () => {
    const names = toolDefinitions.map((definition) => definition.name);

    assert.deepEqual(names, [...names].sort());
    assert.deepEqual(names, [
      "compile",
      "offer_libraries",
      "propose_edit",
      "read_catalog",
      "read_libraries",
      "read_project",
      "simulate",
      "suggest_tiles",
    ]);
  });

  test("offers the target's own sensor at the start of a WHEN side", () => {
    const ws = workspace();
    const offering = suggestTiles(ws, { mode: "insert", ruleId: ruleIdAt(ws.brainDef, "0/0"), side: "when" });

    assert.ok("exact" in offering, JSON.stringify(offering));
    assert.ok(offering.exact.some((tile) => tile.tileId === tiles.sensor));
  });

  test("lands a whole expression as one undoable edit and reads it back", () => {
    const ws = workspace();

    authorSignalRule(ws);

    const project = readProject(ws);
    const rule = project.pages[0]?.rules[0];
    assert.deepEqual(
      rule?.when.map((tile) => tile.tileId),
      [tiles.sensor]
    );
    assert.equal(rule?.do.length, 4);
    assert.equal(ws.history.undoDepth(), 2, "one history entry per accepted run");
  });

  test("leaves the document untouched when an edit is rejected", () => {
    const ws = workspace();

    const rejected = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "when",
      tileId: tiles.actuator,
    });

    assert.equal(rejected.ok, false);
    assert.deepEqual(readProject(ws).pages[0]?.rules[0]?.when, []);
    assert.equal(ws.history.undoDepth(), 0);
  });

  test("names a manufactured tile by the label it carries, never by its id", () => {
    const ws = workspace();

    const minted = proposeEdit(ws, {
      op: "placeTiles",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "when",
      tileIds: [
        { tileId: tiles.variableFactory, name: "hunger" },
        "tile.op->gt",
        { tileId: tiles.numberFactory, value: 3 },
      ],
    });

    assert.equal(minted.ok, true, JSON.stringify(minted));
    const when = readProject(ws).pages[0]?.rules[0]?.when ?? [];
    for (const tile of when) {
      assert.notEqual(tile.label, tile.tileId, `${tile.tileId} reads by a label`);
    }
    const labels = when.map((tile) => tile.label);
    assert.ok(labels.includes("hunger"), "the minted variable reads by its name");
    assert.ok(labels.includes("3"), "the minted literal reads by its value");
  });

  test("mints a literal as a single placeTile lands it", () => {
    const ws = workspace();
    const placed = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "do",
      tileId: tiles.asyncActuator,
    });
    assert.equal(placed.ok, true, JSON.stringify(placed));

    const minted = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "do",
      tileId: { tileId: tiles.numberFactory, value: 50, displayFormat: "percent" },
    });

    assert.equal(minted.ok, true, JSON.stringify(minted));
    assert.equal(ws.brainDef.catalog().has("tile.literal->number:<number>->50[percent]"), true);
    assert.equal(readProject(ws).pages[0]?.rules[0]?.do.at(-1)?.tileId, "tile.literal->number:<number>->50[percent]");
  });

  test("mints a literal as a replaceTile swaps one value for another", () => {
    const ws = workspace();
    authorSignalRule(ws);
    const position = (readProject(ws).pages[0]?.rules[0]?.do.length ?? 0) - 1;

    const swapped = proposeEdit(ws, {
      op: "replaceTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "do",
      position,
      tileId: { tileId: tiles.numberFactory, value: 30 },
    });

    assert.equal(swapped.ok, true, JSON.stringify(swapped));
    assert.equal(readProject(ws).pages[0]?.rules[0]?.do.at(-1)?.tileId, "tile.literal->number:<number>->30");
    assert.equal(ws.brainDef.catalog().has("tile.literal->number:<number>->30"), true);
  });

  test("reports a factory named without the input it mints from, minting nothing", () => {
    const ws = workspace();

    const refused = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "when",
      tileId: tiles.numberFactory,
    });

    assert.deepEqual(refused, { ok: false, error: "invalid_mint_input", named: tiles.numberFactory });
    assert.deepEqual(readProject(ws).pages[0]?.rules[0]?.when, []);
  });

  test("drops a tile a rejected single-tile edit minted", () => {
    const ws = workspace();
    const placed = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "when",
      tileId: tiles.sensor,
    });
    assert.equal(placed.ok, true, JSON.stringify(placed));

    const rejected = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "when",
      tileId: { tileId: tiles.numberFactory, value: 12 },
    });

    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    assert.equal(
      ws.brainDef.catalog().has("tile.literal->number:<number>->12"),
      false,
      "the rejected edit took its minting back"
    );
    assert.equal(ws.history.undoDepth(), 1, "only the accepted placement is in the history");
  });

  test("carries manufactured tiles into the catalog and the digest by their labels", () => {
    const ws = workspace();
    proposeEdit(ws, {
      op: "placeTiles",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "when",
      tileIds: [{ tileId: "tile.var.factory->boolean", name: "hunger" }],
    });

    const view = readCatalog(ws, { filter: "hunger" });
    const listed = catalogTiles(view);
    const digest = catalogDigest(listed);

    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.label, "hunger");
    assert.deepEqual(
      view.groups.map((group) => group.scope),
      [CatalogScope.Document],
      "a minted variable is the document's own tile"
    );
    assert.ok(
      digest.text.split("\n").some((line) => (JSON.parse(line) as CatalogTile).label === "hunger"),
      digest.text
    );
  });

  test("reads an anonymous argument out as the value type it takes, never as a tile to place", () => {
    const chime = catalogTiles(readCatalog(workspace(), {})).find((tile) => tile.tileId === tiles.asyncActuator);

    assert.ok(chime, tiles.asyncActuator);
    assert.equal(chime.args, "any-order(optional(count:number:<number>=derived[0..4 drop]))");
  });

  test("reads a slot's unit, default and bounds out as structure beside its tile", () => {
    const emit = catalogTiles(readCatalog(workspace(), {})).find((tile) => tile.tileId === tiles.actuator);

    assert.ok(emit, tiles.actuator);
    assert.ok(emit.args?.includes("=1[0..1 clamp]"), emit.args);
  });

  test("cuts a slot's unit to its limit, so author text inside the args string is bounded", () => {
    const emit = catalogTiles(readCatalog(workspace(), {})).find((tile) => tile.tileId === tiles.actuator);

    const cut = sanitizeArgsText(FAKE_LONG_UNIT, CATALOG_TEXT_LIMITS.argUnit);
    assert.equal(cut.length, CATALOG_TEXT_LIMITS.argUnit);
    assert.ok(cut.endsWith(ARGS_TRUNCATION_MARKER), cut);
    assert.ok(!cut.includes("["), "a cut inside the args string carries no bracket");
    assert.ok(emit?.args?.includes(`(${cut})=`), emit?.args);
    assert.ok(!emit?.args?.includes(FAKE_LONG_UNIT), "the full author unit does not reach the args string");
  });

  test("reads an anonymous slot declaring no name out under the `value` fallback", () => {
    const ring = catalogTiles(readCatalog(workspace(), {})).find(
      (tile) => tile.tileId === "tile.actuator->actuator.fake.ring"
    );

    assert.ok(ring?.args?.includes("value:number"), ring?.args);
  });

  test("leaves a slot name inside its limit exactly as the author wrote it", () => {
    const chime = catalogTiles(readCatalog(workspace(), {})).find((tile) => tile.tileId === tiles.asyncActuator);

    assert.ok(chime?.args?.includes("count:"), chime?.args);
  });

  test("lists an argument tile only where some action names it as a tile to place", () => {
    const listed = catalogTiles(readCatalog(workspace(), {})).map((tile) => tile.tileId);

    assert.ok(listed.includes(tiles.modifier), "the modifier the emit grammar names is placeable");
    assert.ok(listed.includes(tiles.parameter), "the named parameter the emit grammar names is placeable");
    assert.ok(
      !listed.includes("tile.parameter->anon.number"),
      "the anonymous slot's type carrier is no tile a document may hold"
    );
  });

  test("compiles and rehearses the authored brain through name-and-JSON dispatch", async () => {
    const ws = workspace();
    authorSignalRule(ws);

    const compiled = await executeToolCall(ws, "compile", {});
    const simulated = await executeToolCall(ws, "simulate", {
      scenario: { seed: 20260805, subject: FAKE_SUBJECT },
      thinks: 60,
    });

    assert.deepEqual(compiled.payload, { ok: true, diagnostics: [] });
    const summary = (simulated.payload as { ok: boolean; summary: { rules: unknown[]; dispatchTotals: string[] } })
      .summary;
    assert.equal(summary.rules.length, 1);
    assert.ok(
      summary.dispatchTotals.some((entry) => entry.startsWith("actuator.fake.emit(")),
      summary.dispatchTotals.join(" ")
    );
  });

  test("distinguishes calls of one action by the arguments they carried", async () => {
    const ws = workspace();
    authorSignalRule(ws);

    const simulated = await executeToolCall(ws, "simulate", {
      scenario: { seed: 20260805, subject: FAKE_SUBJECT },
      thinks: 20,
    });

    const { dispatchTotals } = (simulated.payload as { summary: { dispatchTotals: string[] } }).summary;
    assert.ok(
      dispatchTotals.some((entry) => entry.includes("loudly=") && entry.includes("strength=7")),
      dispatchTotals.join(" ")
    );
  });

  test("refuses a call it does not serve and a call whose input does not fit", async () => {
    const ws = workspace();

    const unknown = await executeToolCall(ws, "read_trace", {});
    const invalid = await executeToolCall(ws, "suggest_tiles", {
      mode: "insert",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "sideways",
    });

    assert.equal(unknown.isError, true);
    assert.deepEqual(unknown.payload, { error: "unknown_tool", detail: "read_trace" });
    assert.equal(invalid.isError, true);
    assert.equal((invalid.payload as { error: string }).error, "invalid_input");
  });

  test("refuses a batch over the command cap before any command runs", async () => {
    const ws = workspace();
    const before = readProject(ws);

    const refused = await executeToolCall(ws, "propose_edit", {
      op: "batch",
      commands: Array.from({ length: maxBatchCommands + 1 }, () => ({ op: "addRule", pageIndex: 0 })),
    });

    assert.equal(refused.isError, true);
    assert.equal((refused.payload as { error: string }).error, "invalid_input");
    assert.match((refused.payload as { detail: string }).detail, /commands/);
    assert.deepEqual(readProject(ws), before, "the document is untouched");
  });

  test("reads back the bound a call ran into, so an oversize call knows its size", async () => {
    const ws = workspace();

    const refused = await executeToolCall(ws, "propose_edit", {
      op: "batch",
      commands: Array.from({ length: maxBatchCommands + 1 }, () => ({ op: "addRule", pageIndex: 0 })),
    });

    assert.match((refused.payload as { detail: string }).detail, new RegExp(String(maxBatchCommands)));
  });

  test("reports a scenario naming a subject the target does not offer", async () => {
    const ws = workspace();
    authorSignalRule(ws);

    const simulated = await executeToolCall(ws, "simulate", {
      scenario: { seed: 1, subject: "nobody" },
      thinks: 5,
    });

    assert.deepEqual(simulated.payload, {
      ok: false,
      error: "unknown_subject",
      named: "nobody",
      subjects: [FAKE_SUBJECT],
    });
  });

  test("reports a scenario scripting input kinds the target does not read", async () => {
    const ws = workspace();
    authorSignalRule(ws);

    const simulated = await executeToolCall(ws, "simulate", {
      scenario: {
        seed: 1,
        subject: FAKE_SUBJECT,
        inputs: [
          { kind: "no-such-kind", at: 0, value: true },
          { kind: "another-missing-kind", at: 2, value: 40 },
          { kind: "no-such-kind", at: 3, value: false },
        ],
      },
      thinks: 5,
    });

    assert.deepEqual(simulated.payload, {
      ok: false,
      error: "unknown_input_kind",
      named: ["no-such-kind", "another-missing-kind"],
      kinds: [FAKE_INPUT_KIND],
    });
  });
});

describe("the name and the format a mint carries", () => {
  /** Tile id of the fake target's literal factory minting values of their own identity. */
  const swatchFactory = mkLiteralFactoryTileId(FAKE_SWATCH_LITERAL_FACTORY_ID);

  /** Every display format the grammar names, in the spellings a mint may carry. */
  const displayFormats = [
    "default",
    "percent",
    "percent:1",
    "fixed:2",
    "thousands",
    "time_seconds",
    "time_seconds:3",
    "time_ms",
    "time_ms:1",
  ];

  test("lists a minted literal in the document scope under the name it was given", () => {
    const ws = workspace();

    const minted = proposeEdit(ws, {
      op: "placeTiles",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "when",
      tileIds: [
        { tileId: tiles.variableFactory, name: "hunger" },
        "tile.op->gt",
        { tileId: tiles.numberFactory, value: 3, name: "threshold" },
      ],
    });

    assert.equal(minted.ok, true, JSON.stringify(minted));
    const listed = catalogTiles(readCatalog(ws, { filter: "threshold" }));
    assert.deepEqual(
      listed.map((tile) => tile.label),
      ["threshold"]
    );
    assert.deepEqual(
      readCatalog(ws, { filter: "threshold" }).groups.map((group) => group.scope),
      [CatalogScope.Document]
    );
  });

  test("names a minted literal that carries an identity of its own", () => {
    const ws = workspace();

    const minted = resolveRunEntry(ws, { tileId: swatchFactory, value: "carmine", name: "rock" });

    assert.ok(!("ok" in minted), "the named mint resolves to a tile");
    assert.equal((minted as BrainTileLiteralDef).displayName, "rock");
    assert.deepEqual(
      catalogTiles(readCatalog(ws, { filter: "rock" })).map((tile) => tile.tileId),
      [minted.tileId]
    );
  });

  test("refuses a mint of a literal of its own identity that carries no name", () => {
    const ws = workspace();
    const held = ws.brainDef.catalog().getAll().size();

    const refused = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "do",
      tileId: { tileId: swatchFactory, value: "carmine" },
    });

    assert.deepEqual(refused, { ok: false, error: "unnamed_literal", named: swatchFactory });
    assert.equal(ws.brainDef.catalog().getAll().size(), held, "the refused mint left the document catalog as it was");
  });

  test("refuses a display format the grammar does not name, minting nothing", () => {
    const ws = workspace();
    const held = ws.brainDef.catalog().getAll().size();

    const refused = proposeEdit(ws, {
      op: "placeTile",
      ruleId: ruleIdAt(ws.brainDef, "0/0"),
      side: "do",
      tileId: { tileId: tiles.numberFactory, value: 50, displayFormat: "percent:x" },
    });

    assert.deepEqual(refused, { ok: false, error: "invalid_display_format", named: "percent:x" });
    assert.equal(ws.brainDef.catalog().getAll().size(), held, "the refused mint left the document catalog as it was");
  });

  test("mints under every display format the grammar names", () => {
    for (const displayFormat of displayFormats) {
      const ws = workspace();
      const placed = proposeEdit(ws, {
        op: "placeTile",
        ruleId: ruleIdAt(ws.brainDef, "0/0"),
        side: "do",
        tileId: tiles.asyncActuator,
      });
      assert.equal(placed.ok, true, JSON.stringify(placed));

      const minted = proposeEdit(ws, {
        op: "placeTile",
        ruleId: ruleIdAt(ws.brainDef, "0/0"),
        side: "do",
        tileId: { tileId: tiles.numberFactory, value: 2, displayFormat },
      });

      assert.equal(minted.ok, true, `${displayFormat}: ${JSON.stringify(minted)}`);
    }
  });
});
