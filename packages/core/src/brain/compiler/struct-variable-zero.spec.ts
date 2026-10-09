/**
 * A struct type's starting value: a type registered through `defineType` with
 * a `zero` seeds every variable of the type with a fresh copy of it -- at
 * program load, at every clear, and in every runtime built over the same
 * program -- so the variable is truthy and field-writable from its first
 * read, no two variables share a struct cell, and a field write never reaches
 * the program's pooled constant. A struct type declaring no zero keeps its
 * variables nil until written.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  coreModule,
  createHostActuator,
  createWendooEnvironment,
  List,
  type ReadonlyList,
  type WendooEnvironment,
  type WendooModule,
} from "@wendoo/core";
import type { IBrainTileDef } from "@wendoo/core/brain";
import { mkAccessorTileId, mkLiteralTileId, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  BrainRuntime,
  bag,
  CoreOpId,
  CoreParameterId,
  CoreTypeIds,
  isNumberValue,
  isStructValue,
  mkCallDef,
  mkClosedStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  NO_VARIABLE_INIT,
  type Program,
  param,
  type StructTypeDef,
  type StructValue,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  type TypeId,
  type Value,
  VOID_VALUE,
  variableInitAt,
} from "@wendoo/core/runtime";

const kSpotTypeId = mkTypeId(NativeType.Struct, "SeedSpot");
const kPlainTypeId = mkTypeId(NativeType.Struct, "SeedPlain");

const kSpotX = 0;
const kSpotY = 1;

/** Key of the `SeedSpot` literal at the origin, the value the type's zero holds. */
const kOriginKey = "origin";

function mkSpot(x: number, y: number): StructValue {
  return mkClosedStructValue(kSpotTypeId, List.from<Value>([mkNumberValue(x), mkNumberValue(y)]));
}

/** Tiles and recorded values one test environment carries. */
interface Authoring {
  readonly environment: WendooEnvironment;
  readonly brainDef: BrainDef;
  readonly rule: BrainRuleDef;
  readonly recorded: Value[];
  readonly record: IBrainTileDef;
  readonly spotX: IBrainTileDef;
  readonly origin: IBrainTileDef;
  readonly assign: IBrainTileDef;
}

/**
 * An environment registering `SeedSpot` (zero `{0, 0}`, an `origin` literal
 * holding the same value) and `SeedPlain` (no zero), plus an actuator
 * recording each number it receives, and an empty single-rule brain in it.
 */
function newBrain(): Authoring {
  const recorded: Value[] = [];
  const record = createHostActuator({
    key: "seed.record",
    actionId: TARGET_ACTION_ID_BASE,
    fnId: TARGET_FUNC_ID_BASE,
    callDef: mkCallDef(bag(param(CoreParameterId.AnonymousNumber, { name: "value", anonymous: true }))),
    fn: {
      exec: (_ctx, args: ReadonlyList<Value>): Value => {
        recorded.push(args.get(0));
        return VOID_VALUE;
      },
    },
  });
  const module: WendooModule = {
    id: "struct-variable-zero-spec-host",
    install(api): void {
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kSpotTypeId,
        name: "SeedSpot",
        atomId: 1024,
        fields: List.from([
          { name: "x", typeId: CoreTypeIds.Number, fieldIndex: kSpotX },
          { name: "y", typeId: CoreTypeIds.Number, fieldIndex: kSpotY },
        ]),
        accessors: true,
        zero: mkSpot(0, 0),
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kPlainTypeId,
        name: "SeedPlain",
        atomId: 1025,
        fields: List.from([{ name: "n", typeId: CoreTypeIds.Number, fieldIndex: 0 }]),
      });
      api.registerTile(
        new BrainTileLiteralDef(
          kSpotTypeId,
          mkSpot(0, 0),
          { valueLabel: kOriginKey, persist: false },
          api.brainServices
        )
      );
      api.registerHostActuator(record);
    },
  };
  const environment = createWendooEnvironment({ modules: [coreModule(), module] });
  const catalog = environment.brainServices.edit.tiles;
  const tile = (tileId: string): IBrainTileDef => {
    const found = catalog.get(tileId);
    assert.ok(found, `fixture tile ${tileId} is registered`);
    return found;
  };
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Seed Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  return {
    environment,
    brainDef,
    rule: page.children().get(0) as BrainRuleDef,
    recorded,
    record: record.tile,
    spotX: tile(mkAccessorTileId(kSpotTypeId, "x")),
    origin: tile(mkLiteralTileId(kSpotTypeId, kOriginKey)),
    assign: tile(mkOperatorTileId(CoreOpId.Assign)),
  };
}

/** A brain-scoped variable tile of `typeId`, registered in `brainDef`'s catalog. */
function variable(brainDef: BrainDef, name: string, typeId: TypeId): IBrainTileDef {
  const tile = new BrainTileVariableDef(`variable:seed.${name}`, name, typeId, `seed.${name}`);
  brainDef.catalog().registerTileDef(tile);
  return tile;
}

/** The number literal tile holding `value`. */
function number(authoring: Authoring, value: number): IBrainTileDef {
  return new BrainTileLiteralDef(CoreTypeIds.Number, value, {}, authoring.environment.brainServices);
}

/** Appends `tiles` to a rule side, in order. */
function append(side: ReturnType<BrainRuleDef["do"]>, ...tiles: IBrainTileDef[]): void {
  for (const tile of tiles) {
    __test__appendTile(side, tile);
  }
}

/** The `x` field of `value`, which must be a `SeedSpot` holding a number there. */
function xOf(value: Value | undefined): number {
  assert.ok(value !== undefined && isStructValue(value), "the variable holds a SeedSpot");
  const x = value.v?.at(kSpotX);
  assert.ok(x !== undefined && isNumberValue(x), "its x is a number");
  return x.v;
}

/** The pooled starting value of the slot named `name` in `program`. */
function pooledZeroOf(program: Program, name: string): Value {
  for (let i = 0; i < program.variableNames.size(); i++) {
    if (program.variableNames.get(i) !== name) continue;
    const initIdx = variableInitAt(program, i);
    assert.notEqual(initIdx, NO_VARIABLE_INIT, `slot '${name}' carries a starting value`);
    return program.constantPools.values.get(initIdx);
  }
  assert.fail(`no slot for variable '${name}'`);
}

/** Starts a brain over `brainDef` and runs one think step. */
function startAndThink(authoring: Authoring) {
  const brain = authoring.environment.createBrain(authoring.brainDef);
  brain.startup();
  brain.think(16);
  return brain;
}

describe("a struct type's starting value: registration", () => {
  test("defineType carries the zero onto the registered type", () => {
    const { environment } = newBrain();
    const typeDef = environment.brainServices.runtime.types.get(kSpotTypeId) as StructTypeDef;

    assert.equal(xOf(typeDef.zero), 0);
  });

  test("a type declaring no zero registers none", () => {
    const { environment } = newBrain();

    assert.equal(environment.brainServices.runtime.types.get(kPlainTypeId)?.zero, undefined);
  });

  test("a zero that is not a plain value of the type is refused", () => {
    const { environment } = newBrain();
    const types = environment.brainServices.runtime.types;
    const fields = List.from([{ name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 }]);

    assert.throws(() => types.addStructType("SeedWrongZero", { fields, zero: mkNumberValue(0) }));
    assert.throws(() => types.addStructType("SeedOtherZero", { fields, zero: mkSpot(0, 0) }));
  });
});

describe("a struct type's starting value: seeding", () => {
  test("a variable reads the zero from birth: truthy, its fields readable", () => {
    const authoring = newBrain();
    const spot = variable(authoring.brainDef, "spot", kSpotTypeId);
    append(authoring.rule.when(), spot);
    append(authoring.rule.do(), authoring.record, spot, authoring.spotX);

    startAndThink(authoring);

    assert.deepEqual(authoring.recorded, [mkNumberValue(0)], "the WHEN fired and read x = 0");
  });

  test("a field write lands from birth, with no assignment first", () => {
    const authoring = newBrain();
    const spot = variable(authoring.brainDef, "spot", kSpotTypeId);
    append(authoring.rule.do(), spot, authoring.spotX, authoring.assign, number(authoring, 5));
    const read = authoring.rule.appendNewRule()!;
    append(read.do(), authoring.record, spot, authoring.spotX);

    startAndThink(authoring);

    assert.deepEqual(authoring.recorded, [mkNumberValue(5)]);
  });

  test("two variables of the type never share a cell", () => {
    const authoring = newBrain();
    const first = variable(authoring.brainDef, "first", kSpotTypeId);
    const second = variable(authoring.brainDef, "second", kSpotTypeId);
    append(authoring.rule.do(), first, authoring.spotX, authoring.assign, number(authoring, 5));
    const read = authoring.rule.appendNewRule()!;
    append(read.do(), authoring.record, second, authoring.spotX);

    const brain = startAndThink(authoring);

    assert.deepEqual(authoring.recorded, [mkNumberValue(0)], "the sibling still reads 0");
    assert.equal(xOf(brain.getVariable("first")), 5);
    assert.notEqual(brain.getVariable("first"), brain.getVariable("second"));
  });

  test("a field write reaches neither the pooled zero nor a literal of the same value", () => {
    const authoring = newBrain();
    const spot = variable(authoring.brainDef, "spot", kSpotTypeId);
    append(authoring.rule.do(), spot, authoring.spotX, authoring.assign, number(authoring, 5));
    const read = authoring.rule.appendNewRule()!;
    append(read.do(), authoring.record, authoring.origin, authoring.spotX);

    const brain = startAndThink(authoring);
    const program = brain.getProgram();
    assert.ok(program, "the brain has a linked program");

    assert.deepEqual(authoring.recorded, [mkNumberValue(0)], "origin still reads x = 0");
    assert.equal(xOf(pooledZeroOf(program, "spot")), 0, "the pooled zero is unchanged");
    assert.notEqual(brain.getVariable("spot"), pooledZeroOf(program, "spot"));
  });

  test("a variable of a type declaring no zero stays nil until written", () => {
    const authoring = newBrain();
    const plain = variable(authoring.brainDef, "plain", kPlainTypeId);
    const spot = variable(authoring.brainDef, "spot", kSpotTypeId);
    append(authoring.rule.when(), plain);
    append(authoring.rule.do(), spot, authoring.spotX, authoring.assign, number(authoring, 5));

    const brain = startAndThink(authoring);

    assert.equal(brain.getVariable("plain"), undefined);
    assert.equal(xOf(brain.getVariable("spot")), 0, "the WHEN over the nil variable did not fire");
  });
});

describe("a struct type's starting value: reseeding", () => {
  test("clearing every variable restores a fresh copy of the zero", () => {
    const authoring = newBrain();
    const spot = variable(authoring.brainDef, "spot", kSpotTypeId);
    append(authoring.rule.do(), spot, authoring.spotX, authoring.assign, number(authoring, 5));

    const brain = startAndThink(authoring);
    const program = brain.getProgram();
    assert.ok(program, "the brain has a linked program");
    assert.equal(xOf(brain.getVariable("spot")), 5);

    brain.clearVariables();
    const firstSeed = brain.getVariable("spot");
    assert.equal(xOf(firstSeed), 0);
    assert.notEqual(firstSeed, pooledZeroOf(program, "spot"));

    brain.clearVariable("spot");
    assert.equal(xOf(brain.getVariable("spot")), 0);
    assert.notEqual(brain.getVariable("spot"), firstSeed, "each clear seeds a new cell");
  });

  test("a second runtime over the same program seeds the zero, not the first runtime's write", () => {
    const authoring = newBrain();
    const spot = variable(authoring.brainDef, "spot", kSpotTypeId);
    append(authoring.rule.do(), spot, authoring.spotX, authoring.assign, number(authoring, 5));
    const linked = authoring.environment.linkBrain(authoring.brainDef).program;
    assert.ok(linked, "the brain links");
    const services = authoring.environment.brainServices;
    const hostServices = { runtime: services.runtime, shared: services.shared, app: services.app };

    const first = new BrainRuntime(linked.program, linked.pages, hostServices);
    first.startup();
    first.think(16);
    const second = new BrainRuntime(linked.program, linked.pages, hostServices);

    assert.equal(xOf(first.getVariable("spot")), 5);
    assert.equal(xOf(second.getVariable("spot")), 0);
    assert.notEqual(first.getVariable("spot"), second.getVariable("spot"));
  });

  test("rebuilding a running brain reseeds every slot, the new one included, with a fresh copy", () => {
    const authoring = newBrain();
    const spot = variable(authoring.brainDef, "spot", kSpotTypeId);
    append(authoring.rule.do(), spot, authoring.spotX, authoring.assign, number(authoring, 5));
    const brain = startAndThink(authoring);
    assert.equal(xOf(brain.getVariable("spot")), 5);

    const added = variable(authoring.brainDef, "added", kSpotTypeId);
    const read = authoring.rule.appendNewRule()!;
    append(read.do(), authoring.record, added, authoring.spotX);
    brain.initialize();
    const program = brain.getProgram();
    assert.ok(program, "the rebuilt brain has a linked program");

    assert.equal(xOf(brain.getVariable("spot")), 0, "the rebuild's shutdown cleared the written value");
    assert.equal(xOf(brain.getVariable("added")), 0);
    assert.notEqual(brain.getVariable("added"), brain.getVariable("spot"));
    assert.notEqual(brain.getVariable("added"), pooledZeroOf(program, "added"));
  });
});
