/**
 * Tests for the persisted brain JSON codec: identifiers that can carry a
 * project namespace serialize as structured references (namespace absent for
 * the owning project, present for foreign ones) and re-mint fully qualified
 * runtime ids on load.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { coreModule, createWendooEnvironment, List } from "@wendoo/core";
import {
  type BrainServices,
  mkLiteralTileId,
  mkOperatorTileId,
  mkOutputTileId,
  mkVariableTileId,
  RuleTriggerMode,
} from "@wendoo/core/brain";
import { __test__appendTile, __test__createBrainServices } from "@wendoo/core/brain/__test__";
import {
  BrainDef,
  BrainJsonCodecErrorCode,
  decodePersistedBrainJson,
  deserializePersistedBrainJson,
  encodePersistedBrainJson,
  type PersistedBrainJson,
  type PersistedTileRef,
} from "@wendoo/core/brain/model";
import {
  BrainTileAccessorDef,
  BrainTileActuatorDef,
  BrainTileLiteralDef,
  BrainTileMissingDef,
  BrainTileModifierDef,
  BrainTileOutputDef,
  BrainTileParameterDef,
  BrainTileSensorDef,
  BrainTileVariableDef,
} from "@wendoo/core/brain/tiles";
import {
  CoreOpId,
  CoreTypeIds,
  linkedBrainProgramToBytes,
  mkCallDef,
  mkPrivateArgId,
  mkUserActionKey,
  type TypeId,
} from "@wendoo/core/runtime";

const NS = "p1";
const FOREIGN_NS = "acme/widgets";

let services: BrainServices;
let posTypeId: TypeId;
let foreignPosTypeId: TypeId;
let modeTypeId: TypeId;

before(() => {
  services = __test__createBrainServices();
  const registry = services.runtime.types;
  posTypeId = registry.reserveStructType(`${NS}:/pos.ts::Position`);
  registry.finalizeStructType(posTypeId, {
    fields: List.from([
      { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 },
      { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
    ]),
  });
  foreignPosTypeId = registry.reserveStructType(`${FOREIGN_NS}:/pos.ts::Position`);
  registry.finalizeStructType(foreignPosTypeId, {
    fields: List.from([{ name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
  });
  modeTypeId = registry.withOwner("dynamic", () =>
    registry.addEnumType(`${NS}:/mode.ts::Mode`, {
      symbols: List.from([
        { key: "fast", label: "Fast", value: "fast" },
        { key: "slow", label: "Slow", value: "slow" },
      ]),
      defaultKey: "fast",
    })
  );
});

function userSensor(namespace: string, actionId: string): BrainTileSensorDef {
  const key = mkUserActionKey(namespace, "sensor", actionId);
  return new BrainTileSensorDef(
    key,
    {
      key,
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    },
    { userIdentity: { namespace, actionId } }
  );
}

function userActuator(namespace: string, actionId: string): BrainTileActuatorDef {
  const key = mkUserActionKey(namespace, "actuator", actionId);
  return new BrainTileActuatorDef(
    key,
    { key, kind: "actuator", callDef: mkCallDef({ type: "bag", items: [] }), isAsync: false },
    { userIdentity: { namespace, actionId } }
  );
}

function platformSensor(sensorId: string): BrainTileSensorDef {
  return new BrainTileSensorDef(sensorId, {
    key: sensorId,
    kind: "sensor",
    callDef: mkCallDef({ type: "bag", items: [] }),
    isAsync: false,
    outputType: CoreTypeIds.Number,
  });
}

/** Build a brain whose first rule's WHEN side holds `tiles`, registering each tile for later resolution. */
function brainWith(
  tiles: readonly (
    | BrainTileSensorDef
    | BrainTileActuatorDef
    | BrainTileParameterDef
    | BrainTileModifierDef
    | BrainTileAccessorDef
    | BrainTileOutputDef
    | BrainTileLiteralDef
    | BrainTileMissingDef
  )[]
): BrainDef {
  const brainDef = BrainDef.emptyBrainDef(services, "Codec Brain");
  const rule = brainDef.pages().get(0)!.children().get(0)!;
  for (const tile of tiles) {
    services.edit.tiles.registerTileDef(tile);
    __test__appendTile(rule.when(), tile);
  }
  return brainDef;
}

function whenRefs(persisted: PersistedBrainJson): readonly PersistedTileRef[] {
  return persisted.pages[0].rules[0].when;
}

function whenTileIds(brainDef: BrainDef): string[] {
  const tiles = brainDef.pages().get(0)!.children().get(0)!.when().tiles();
  const ids: string[] = [];
  tiles.forEach((tile) => {
    ids.push(tile.tileId);
  });
  return ids;
}

function roundTrip(brainDef: BrainDef, loadNamespace: string): BrainDef {
  const persisted = JSON.parse(JSON.stringify(encodePersistedBrainJson(brainDef, NS)));
  return deserializePersistedBrainJson(persisted, loadNamespace, services);
}

describe("persisted brain JSON codec", () => {
  test("a rule's trigger mode survives the persisted round trip", () => {
    const brainDef = brainWith([platformSensor("platform.scan")]);
    brainDef.pages().get(0)!.children().get(0)!.setTrigger(RuleTriggerMode.Otherwise);

    const loaded = roundTrip(brainDef, NS);
    assert.equal(loaded.pages().get(0)!.children().get(0)!.trigger(), RuleTriggerMode.Otherwise);
  });

  test("own action tile ids serialize structured with the namespace absent", () => {
    const brainDef = brainWith([userSensor(NS, "abc123"), userActuator(NS, "abc123")]);
    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), [
      { k: "action", area: "sensor", id: "abc123", ns: undefined },
      { k: "action", area: "actuator", id: "abc123", ns: undefined },
    ]);
    assert.deepEqual(whenTileIds(roundTrip(brainDef, NS)), [
      `tile.sensor->${NS}:user.sensor.abc123`,
      `tile.actuator->${NS}:user.actuator.abc123`,
    ]);
  });

  test("a brain saved in one project re-qualifies its own tile ids under the loading namespace", () => {
    const coordinate = "owner/repo";
    const brainDef = brainWith([userSensor(NS, "abc123")]);
    const persisted = JSON.parse(JSON.stringify(encodePersistedBrainJson(brainDef, NS)));

    // The action registers under the coordinate namespace when its project is
    // mounted as an extension.
    services.edit.tiles.registerTileDef(userSensor(coordinate, "abc123"));
    const mounted = deserializePersistedBrainJson(persisted, coordinate, services);
    const tile = mounted.pages().get(0)!.children().get(0)!.when().tiles().get(0)!;
    assert.equal(tile.tileId, `tile.sensor->${coordinate}:user.sensor.abc123`);
    assert.equal(tile.kind, "sensor");
  });

  test("foreign action tile ids carry their namespace and are preserved", () => {
    const brainDef = brainWith([userSensor(FOREIGN_NS, "def456")]);
    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), [{ k: "action", area: "sensor", id: "def456", ns: FOREIGN_NS }]);
    assert.deepEqual(whenTileIds(roundTrip(brainDef, "p2")), [`tile.sensor->${FOREIGN_NS}:user.sensor.def456`]);
  });

  test("platform tile ids stay plain strings", () => {
    const brainDef = brainWith([platformSensor("platform.scan")]);
    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), ["tile.sensor->platform.scan"]);
    assert.deepEqual(whenTileIds(roundTrip(brainDef, "p2")), ["tile.sensor->platform.scan"]);
  });

  test("private arg tile ids serialize as arg refs", () => {
    const param = new BrainTileParameterDef(mkPrivateArgId(NS, "abc123", "speed"), CoreTypeIds.Number, {
      userArg: { namespace: NS, actionId: "abc123", argName: "speed" },
    });
    const modifier = new BrainTileModifierDef(mkPrivateArgId(FOREIGN_NS, "abc123", "fast"), {
      userArg: { namespace: FOREIGN_NS, actionId: "abc123", argName: "fast" },
    });
    const brainDef = brainWith([param, modifier]);
    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), [
      { k: "arg", area: "parameter", action: "abc123", name: "speed", ns: undefined },
      { k: "arg", area: "modifier", action: "abc123", name: "fast", ns: FOREIGN_NS },
    ]);
    assert.deepEqual(whenTileIds(roundTrip(brainDef, NS)), [
      `tile.parameter->${NS}:user.abc123.speed`,
      `tile.modifier->${FOREIGN_NS}:user.abc123.fast`,
    ]);
  });

  test("anonymous struct parameter tiles serialize the keying type name", () => {
    const anonStruct = new BrainTileParameterDef(`anon.${NS}:/pos.ts::Position`, posTypeId, {
      anonType: { namespace: NS, localName: "/pos.ts::Position" },
    });
    const anonNumber = new BrainTileParameterDef("anon.number", CoreTypeIds.Number, {
      anonType: { localName: "number" },
    });
    const brainDef = brainWith([anonStruct, anonNumber]);
    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), [
      { k: "anon", name: "/pos.ts::Position", ns: undefined },
      "tile.parameter->anon.number",
    ]);
    assert.deepEqual(whenTileIds(roundTrip(brainDef, "p2")), [
      "tile.parameter->anon.p2:/pos.ts::Position",
      "tile.parameter->anon.number",
    ]);
  });

  test("accessor tile ids serialize their struct type recursively", () => {
    const own = new BrainTileAccessorDef(posTypeId, "x", CoreTypeIds.Number);
    const foreign = new BrainTileAccessorDef(foreignPosTypeId, "x", CoreTypeIds.Number);
    const registry = services.runtime.types;
    const nullablePos = registry.addNullableType(posTypeId);
    const nullable = new BrainTileAccessorDef(nullablePos, "x", CoreTypeIds.Number);
    const listOfPos = registry.instantiate("List", List.from([posTypeId]));
    const list = new BrainTileAccessorDef(listOfPos, "size", CoreTypeIds.Number);
    const brainDef = brainWith([own, foreign, nullable, list]);

    const persisted = encodePersistedBrainJson(brainDef, NS);
    const named = { k: "named", t: "struct", name: "/pos.ts::Position", ns: undefined };
    assert.deepEqual(whenRefs(persisted), [
      { k: "accessor", type: named, field: "x" },
      { k: "accessor", type: { k: "named", t: "struct", name: "/pos.ts::Position", ns: FOREIGN_NS }, field: "x" },
      { k: "accessor", type: { k: "nullable", base: named }, field: "x" },
      { k: "accessor", type: { k: "list", el: named }, field: "size" },
    ]);
    assert.deepEqual(whenTileIds(roundTrip(brainDef, "p2")), [
      "tile.accessor->struct:<p2:/pos.ts::Position>->x",
      `tile.accessor->struct:<${FOREIGN_NS}:/pos.ts::Position>->x`,
      "tile.accessor->struct:<p2:/pos.ts::Position?>->x",
      "tile.accessor->list:<List<struct:<p2:/pos.ts::Position>>>->size",
    ]);
  });

  test("output tile ids serialize the embedded type and the scoped output name", () => {
    const own = new BrainTileOutputDef(posTypeId, "stick", { namespace: NS });
    const foreign = new BrainTileOutputDef(foreignPosTypeId, "stick", { namespace: FOREIGN_NS });
    const platform = new BrainTileOutputDef(CoreTypeIds.Number, "heading");
    const brainDef = brainWith([own, foreign, platform]);

    assert.equal(own.tileId, mkOutputTileId(posTypeId, `${NS}:stick`));
    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), [
      {
        k: "out",
        type: { k: "named", t: "struct", name: "/pos.ts::Position", ns: undefined },
        name: "stick",
        ns: undefined,
      },
      {
        k: "out",
        type: { k: "named", t: "struct", name: "/pos.ts::Position", ns: FOREIGN_NS },
        name: "stick",
        ns: FOREIGN_NS,
      },
      "tile.out->number:<number>.heading",
    ]);
    assert.deepEqual(whenTileIds(roundTrip(brainDef, "p2")), [
      "tile.out->struct:<p2:/pos.ts::Position>.p2:stick",
      `tile.out->struct:<${FOREIGN_NS}:/pos.ts::Position>.${FOREIGN_NS}:stick`,
      "tile.out->number:<number>.heading",
    ]);
  });

  test("a literal catalog entry serializes its value type structurally and preserves its label", () => {
    const label = `text with markers <${NS}:/ and :user. inside`;
    const literal = new BrainTileLiteralDef(modeTypeId, "fast", { valueLabel: label }, services);
    const brainDef = brainWith([literal]);
    brainDef.catalog().registerTileDef(literal);

    const persisted = encodePersistedBrainJson(brainDef, NS);
    const literalEntry = persisted.catalog.find((entry) => entry.kind === "literal");
    assert.deepEqual(literalEntry, {
      version: 2,
      kind: "literal",
      valueType: { k: "named", t: "enum", name: "/mode.ts::Mode", ns: undefined },
      value: "fast",
      valueLabel: label,
      displayFormat: "default",
    });
    assert.deepEqual(whenRefs(persisted), [
      {
        k: "literal",
        type: { k: "named", t: "enum", name: "/mode.ts::Mode", ns: undefined },
        label,
        format: undefined,
      },
    ]);

    const restored = roundTrip(brainDef, NS);
    assert.deepEqual(whenTileIds(restored), [literal.tileId]);
    const restoredEntry = restored.catalog().get(literal.tileId) as BrainTileLiteralDef;
    assert.ok(restoredEntry);
    assert.equal(restoredEntry.valueLabel, label);
    assert.equal(restoredEntry.valueType, modeTypeId);
  });

  test("a named literal catalog entry carries its name through the persisted document", () => {
    const literal = new BrainTileLiteralDef(modeTypeId, "fast", { valueLabel: "fast", displayName: "quick" }, services);
    const brainDef = brainWith([literal]);
    brainDef.catalog().registerTileDef(literal);

    const persisted = encodePersistedBrainJson(brainDef, NS);
    const literalEntry = persisted.catalog.find((entry) => entry.kind === "literal");
    assert.equal(literalEntry?.kind === "literal" ? literalEntry.displayName : undefined, "quick");

    const restoredEntry = roundTrip(brainDef, NS).catalog().get(literal.tileId) as BrainTileLiteralDef;
    assert.equal(restoredEntry.displayName, "quick");
    assert.equal(restoredEntry.metadata?.language?.form, "quick");
  });

  test("a unique-identity literal keeps its own tile id through the persisted document", () => {
    const literal = new BrainTileLiteralDef(
      modeTypeId,
      "fast",
      { uniqueId: "litIdentityA", displayName: "quick" },
      services
    );
    const brainDef = brainWith([literal]);
    brainDef.catalog().registerTileDef(literal);

    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), [literal.tileId], "its id carries no namespace, so it persists as itself");
    assert.deepEqual(
      persisted.catalog.find((entry) => entry.kind === "literal"),
      {
        version: 2,
        kind: "literal",
        valueType: { k: "named", t: "enum", name: "/mode.ts::Mode", ns: undefined },
        value: "fast",
        valueLabel: "litIdentityA",
        displayFormat: "default",
        displayName: "quick",
        uniqueId: "litIdentityA",
      }
    );

    const restored = roundTrip(brainDef, NS);
    assert.deepEqual(whenTileIds(restored), [literal.tileId]);
    const restoredEntry = restored.catalog().get(literal.tileId) as BrainTileLiteralDef;
    assert.equal(restoredEntry.uniqueId, "litIdentityA");
    assert.equal(restoredEntry.displayName, "quick");
    assert.equal(restoredEntry.value, "fast");
  });

  test("variable catalog entries serialize their type and re-mint their tile id from uniqueId", () => {
    const own = new BrainTileVariableDef(mkVariableTileId("v1"), "own", posTypeId, "v1");
    const foreign = new BrainTileVariableDef(mkVariableTileId("v2"), "foreign", foreignPosTypeId, "v2");
    const brainDef = BrainDef.emptyBrainDef(services, "Var Brain");
    brainDef.catalog().registerTileDef(own);
    brainDef.catalog().registerTileDef(foreign);

    const persisted = encodePersistedBrainJson(brainDef, NS);
    const variables = persisted.catalog.filter((entry) => entry.kind === "variable");
    assert.deepEqual(variables, [
      {
        version: 1,
        kind: "variable",
        varName: "own",
        varType: { k: "named", t: "struct", name: "/pos.ts::Position", ns: undefined },
        uniqueId: "v1",
      },
      {
        version: 1,
        kind: "variable",
        varName: "foreign",
        varType: { k: "named", t: "struct", name: "/pos.ts::Position", ns: FOREIGN_NS },
        uniqueId: "v2",
      },
    ]);

    const restored = roundTrip(brainDef, "p2");
    const restoredOwn = restored.catalog().get(mkVariableTileId("v1")) as BrainTileVariableDef;
    const restoredForeign = restored.catalog().get(mkVariableTileId("v2")) as BrainTileVariableDef;
    assert.equal(restoredOwn.varType, "struct:<p2:/pos.ts::Position>");
    assert.equal(restoredForeign.varType, `struct:<${FOREIGN_NS}:/pos.ts::Position>`);
  });

  test("a variable whose type is not registered keeps its persisted type ref", () => {
    const persisted = {
      version: 1,
      id: "brain00000000001",
      name: "Ghost Brain",
      catalog: [
        {
          version: 1,
          kind: "variable",
          varName: "ghost",
          varType: { k: "named", t: "struct", name: "/x.ts::Gone", ns: "ghost/ext" },
          uniqueId: "v9",
        },
      ],
      pages: [],
    };
    const brainDef = deserializePersistedBrainJson(persisted, NS, services);
    const restored = brainDef.catalog().get(mkVariableTileId("v9")) as BrainTileVariableDef;
    assert.equal(restored.varType, "struct:<ghost/ext:/x.ts::Gone>");

    const reEncoded = encodePersistedBrainJson(brainDef, NS);
    const entry = reEncoded.catalog.find((candidate) => candidate.kind === "variable");
    assert.ok(entry && entry.kind === "variable");
    assert.deepEqual(entry.varType, { k: "named", t: "struct", name: "/x.ts::Gone", ns: "ghost/ext" });
  });

  test("an unresolved tile keeps its persisted identity across load and save", () => {
    const persisted = {
      version: 1,
      id: "brain00000000002",
      name: "Missing Brain",
      catalog: [
        {
          version: 2,
          kind: "page",
          pageId: "page000000000001",
        },
      ],
      pages: [
        {
          version: 2,
          pageId: "page000000000001",
          name: "Page 1",
          rules: [
            {
              version: 1,
              when: [{ k: "action", area: "sensor", id: "zzz999", ns: "ghost/ext" }],
              do: [{ k: "action", area: "actuator", id: "own999" }],
              children: [],
            },
          ],
        },
      ],
    };
    const brainDef = deserializePersistedBrainJson(persisted, NS, services);
    const rule = brainDef.pages().get(0)!.children().get(0)!;
    const foreignTile = rule.when().tiles().get(0)!;
    assert.equal(foreignTile.kind, "missing");
    assert.equal(foreignTile.tileId, "tile.sensor->ghost/ext:user.sensor.zzz999");
    const ownTile = rule.do().tiles().get(0)!;
    assert.equal(ownTile.kind, "missing");
    assert.equal(ownTile.tileId, `tile.actuator->${NS}:user.actuator.own999`);

    const reEncoded = encodePersistedBrainJson(brainDef, NS);
    const ruleJson = reEncoded.pages[0].rules[0];
    assert.deepEqual(ruleJson.when, [{ k: "action", area: "sensor", id: "zzz999", ns: "ghost/ext" }]);
    assert.deepEqual(ruleJson.do, [{ k: "action", area: "actuator", id: "own999" }]);

    // A clone carries the preserved identities with it.
    const cloneEncoded = encodePersistedBrainJson(brainDef.clone(), NS);
    assert.deepEqual(cloneEncoded.pages[0].rules[0].when, [
      { k: "action", area: "sensor", id: "zzz999", ns: "ghost/ext" },
    ]);
  });

  test("a missing catalog entry keeps its persisted tile ref", () => {
    const persisted = {
      version: 1,
      id: "brain00000000003",
      name: "Missing Catalog Brain",
      catalog: [
        {
          version: 1,
          kind: "missing",
          tileId: { k: "action", area: "sensor", id: "abc123" },
          originalKind: "sensor",
          label: "scan",
        },
      ],
      pages: [],
    };
    const decoded = decodePersistedBrainJson(persisted, NS);
    const decodedEntry = decoded.json.catalog.get(0)!;
    assert.equal(decodedEntry.kind, "missing");
    assert.equal(decodedEntry.tileId, `tile.sensor->${NS}:user.sensor.abc123`);

    // A missing def registered in the brain catalog (as the paste flow does)
    // re-encodes with its preserved ref.
    const brainDef = deserializePersistedBrainJson(persisted, NS, services);
    brainDef
      .catalog()
      .registerTileDef(new BrainTileMissingDef(`tile.sensor->${NS}:user.sensor.abc123`, "sensor", "scan"));
    const reEncoded = encodePersistedBrainJson(brainDef, NS);
    const entry = reEncoded.catalog.find((candidate) => candidate.kind === "missing");
    assert.ok(entry && entry.kind === "missing");
    assert.deepEqual(entry.tileId, { k: "action", area: "sensor", id: "abc123" });
  });

  test("re-encoding a decoded brain is byte-stable", () => {
    const literal = new BrainTileLiteralDef(modeTypeId, "slow", { valueLabel: "slow" }, services);
    const brainDef = brainWith([
      userSensor(NS, "abc123"),
      userSensor(FOREIGN_NS, "def456"),
      new BrainTileAccessorDef(posTypeId, "x", CoreTypeIds.Number),
      literal,
    ]);
    brainDef.catalog().registerTileDef(literal);

    const first = JSON.parse(JSON.stringify(encodePersistedBrainJson(brainDef, NS)));
    const second = encodePersistedBrainJson(deserializePersistedBrainJson(first, NS, services), NS);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });

  test("a plain id position carrying the owning namespace fails loudly", () => {
    const rogue = new BrainTileSensorDef(`${NS}:user.sensor.rogue`, {
      key: `${NS}:user.sensor.rogue`,
      kind: "sensor",
      callDef: mkCallDef({ type: "bag", items: [] }),
      isAsync: false,
      outputType: CoreTypeIds.Number,
    });
    const brainDef = brainWith([rogue]);
    assert.throws(
      () => encodePersistedBrainJson(brainDef, NS),
      new RegExp(BrainJsonCodecErrorCode.SelfNamespaceInPlainId)
    );
  });

  test("a missing tile with an unknown foreign id and no preserved ref stays a plain string", () => {
    const missing = new BrainTileMissingDef("tile.sensor->ghost/ext:user.sensor.paste1", "sensor", "paste1");
    const brainDef = brainWith([missing]);
    const persisted = encodePersistedBrainJson(brainDef, NS);
    assert.deepEqual(whenRefs(persisted), ["tile.sensor->ghost/ext:user.sensor.paste1"]);
  });

  test("a missing tile carrying the owning namespace without a preserved ref fails loudly", () => {
    const missing = new BrainTileMissingDef(`tile.sensor->${NS}:user.sensor.gone1`, "sensor", "gone1");
    const brainDef = brainWith([missing]);
    assert.throws(
      () => encodePersistedBrainJson(brainDef, NS),
      new RegExp(BrainJsonCodecErrorCode.SelfNamespaceInPlainId)
    );
  });

  test("decode rejects malformed tile ids and unknown ref kinds", () => {
    assert.throws(
      () =>
        decodePersistedBrainJson(
          {
            version: 1,
            name: "Bad",
            catalog: [],
            pages: [
              {
                version: 2,
                pageId: "p",
                name: "P",
                rules: [{ version: 1, when: ["not-a-tile-id"], do: [], children: [] }],
              },
            ],
          },
          NS
        ),
      new RegExp(BrainJsonCodecErrorCode.InvalidTileId)
    );
    assert.throws(
      () =>
        decodePersistedBrainJson(
          {
            version: 1,
            name: "Bad",
            catalog: [],
            pages: [
              {
                version: 2,
                pageId: "p",
                name: "P",
                rules: [{ version: 1, when: [{ k: "nope" }], do: [], children: [] }],
              },
            ],
          },
          NS
        ),
      new RegExp(BrainJsonCodecErrorCode.InvalidPersistedRef)
    );
  });
});

describe("persisted brain JSON codec -- text literal content", () => {
  /** Namespace the documents below are saved and read under. */
  const SOURCE_NS = "project";

  /** Texts whose plain literal tile id would read as namespace content under {@link SOURCE_NS}. */
  const NAMESPACE_LIKE_TEXTS = [
    "http://example.com",
    "my project: robot",
    ":user.",
    ":/",
    "project:",
    "project:project:",
    "trailing project:",
    "x:/y:user.z",
    ":/:/",
    "project::user.:/",
  ];

  /** Texts carrying no namespace content: their literal tile id persists as a plain string. */
  const PLAIN_TEXTS = [
    "",
    "hello",
    ":",
    "::",
    ":leading",
    "trailing:",
    ":user",
    "user.",
    "projects",
    "project :",
    "a->b",
    "tile.literal->x",
    "[percent]",
    "\\",
    "%",
    "%3A%2F",
    'quote " and backslash \\',
    "unicode \u00e9 \u{1F680}",
  ];

  const environment = createWendooEnvironment({ modules: [coreModule()] });
  const envServices = (environment as unknown as { brainServices: BrainServices }).brainServices;

  /**
   * A brain whose one rule assigns a text literal of `text` to a text
   * variable, with the literal and the variable held in the brain's catalog
   * as an authored document holds them.
   */
  function textBrain(text: string): { brainDef: BrainDef; literal: BrainTileLiteralDef } {
    const brainDef = BrainDef.emptyBrainDef(envServices, "Text Brain");
    const variable = new BrainTileVariableDef(mkVariableTileId("textVar1"), "message", CoreTypeIds.String, "textVar1");
    const literal = new BrainTileLiteralDef(CoreTypeIds.String, text, {}, envServices);
    brainDef.catalog().registerTileDef(variable);
    brainDef.catalog().registerTileDef(literal);
    const assign = envServices.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign))!;
    const rule = brainDef.pages().get(0)!.children().get(0)!;
    rule.do().appendTile(variable);
    rule.do().appendTile(assign);
    rule.do().appendTile(literal);
    return { brainDef, literal };
  }

  /** The literal's reference on the DO side of the brain's first rule. */
  function literalRef(persisted: PersistedBrainJson): PersistedTileRef {
    return persisted.pages[0].rules[0].do[2];
  }

  /** Source text as an app persists it: the encoded document, indented by two spaces. */
  function saved(brainDef: BrainDef): string {
    return JSON.stringify(encodePersistedBrainJson(brainDef, SOURCE_NS), null, 2);
  }

  function reopened(source: string): BrainDef {
    return environment.deserializeBrainJsonFromPlain(JSON.parse(source), SOURCE_NS) as BrainDef;
  }

  for (const text of NAMESPACE_LIKE_TEXTS) {
    test(`a text literal of ${JSON.stringify(text)} serializes as a structured literal ref`, () => {
      const { brainDef, literal } = textBrain(text);
      const persisted = encodePersistedBrainJson(brainDef, SOURCE_NS);
      assert.deepEqual(literalRef(persisted), {
        k: "literal",
        type: CoreTypeIds.String,
        label: text,
        format: undefined,
      });
      assert.equal(literal.tileId, mkLiteralTileId(CoreTypeIds.String, text));
    });
  }

  for (const text of PLAIN_TEXTS) {
    test(`a text literal of ${JSON.stringify(text)} keeps its plain literal tile id`, () => {
      const { brainDef, literal } = textBrain(text);
      const persisted = encodePersistedBrainJson(brainDef, SOURCE_NS);
      assert.equal(literalRef(persisted), mkLiteralTileId(CoreTypeIds.String, text));
      assert.equal(literalRef(persisted), literal.tileId);
    });
  }

  for (const text of [...NAMESPACE_LIKE_TEXTS, ...PLAIN_TEXTS]) {
    test(`a text literal of ${JSON.stringify(text)} round-trips, compiles, and re-serializes stably`, () => {
      const { brainDef, literal } = textBrain(text);
      const first = saved(brainDef);
      const loaded = reopened(first);

      const loadedTile = loaded.pages().get(0)!.children().get(0)!.do().tiles().get(2)!;
      assert.equal(loadedTile.kind, "literal");
      assert.equal(loadedTile.tileId, literal.tileId);
      assert.equal((loadedTile as BrainTileLiteralDef).value, text);
      assert.equal((loadedTile as BrainTileLiteralDef).valueLabel, text);

      const result = environment.linkBrain(loaded);
      assert.ok(result.program, "the reopened brain links");
      assert.ok(result.program.program.constantPools.strings.toArray().includes(text));
      linkedBrainProgramToBytes(result.program, {
        profileId: 1,
        precision: "f64",
        typeRegistry: envServices.runtime.types,
      });

      assert.equal(saved(loaded), first);
      assert.equal(saved(reopened(saved(loaded))), first);
    });
  }

  test("a text literal saved under another namespace reads back as the same literal", () => {
    const { brainDef, literal } = textBrain("my project: robot");
    const persisted = JSON.parse(JSON.stringify(encodePersistedBrainJson(brainDef, SOURCE_NS)));
    const loaded = environment.deserializeBrainJsonFromPlain(persisted, "owner/repo") as BrainDef;
    const loadedTile = loaded.pages().get(0)!.children().get(0)!.do().tiles().get(2)!;
    assert.equal(loadedTile.kind, "literal");
    assert.equal(loadedTile.tileId, literal.tileId);
  });

  test("a document holding a plain literal tile id reads back byte-stable", () => {
    const literalId = mkLiteralTileId(CoreTypeIds.String, "trailing:");
    const source = JSON.stringify(
      {
        version: 1,
        id: "brain00000000004",
        name: "Text Brain",
        catalog: [
          {
            version: 2,
            kind: "literal",
            valueType: CoreTypeIds.String,
            value: "trailing:",
            valueLabel: "trailing:",
            displayFormat: "default",
          },
          { version: 2, kind: "page", pageId: "page000000000004", label: "Page 1" },
        ],
        pages: [
          {
            version: 2,
            pageId: "page000000000004",
            name: "Page 1",
            rules: [{ version: 1, when: [literalId], do: [], children: [], ruleId: "rule000000000004" }],
          },
        ],
      },
      null,
      2
    );
    const loaded = reopened(source);
    assert.equal(loaded.pages().get(0)!.children().get(0)!.when().tiles().get(0)!.tileId, literalId);
    assert.equal(saved(loaded), source);
  });
});
