/**
 * A field assignment through a chain of field reads writes every intermediate
 * back into the field of its parent it was read from, innermost first, so a
 * write through a snapshot a field getter hands out reaches the host state
 * behind the snapshot's parent. A falsy link anywhere in the chain skips the
 * store and every write-back while the assigned value still evaluates. A
 * literal may root such a chain only when the assigned field is routed
 * through its type's field setter. These tests compile brains, run them on
 * the VM, and observe host state, recorded values, and the compiled code.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  coreModule,
  createHostActuator,
  createHostSensor,
  createWendooEnvironment,
  List,
  type ReadonlyList,
  type WendooEnvironment,
  type WendooModule,
} from "@wendoo/core";
import type { IBrainDef, IBrainTileDef } from "@wendoo/core/brain";
import { mkAccessorTileId, mkLiteralTileId, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import { ParseDiagCode } from "@wendoo/core/brain/compiler";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  bag,
  CoreOpId,
  CoreParameterId,
  CoreTypeIds,
  type ErrorValue,
  isNumberValue,
  isStructValue,
  mkCallDef,
  mkClosedStructValue,
  mkNativeStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  NIL_VALUE,
  Op,
  param,
  type StructValue,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  type TypeId,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";

const kPosTypeId = mkTypeId(NativeType.Struct, "WriteBackPos");
const kBodyTypeId = mkTypeId(NativeType.Struct, "WriteBackBody");
const kRigTypeId = mkTypeId(NativeType.Struct, "WriteBackRig");
const kNestTypeId = mkTypeId(NativeType.Struct, "WriteBackNest");
const kDialTypeId = mkTypeId(NativeType.Struct, "WriteBackDial");

const kPosX = 0;
const kPosY = 1;
const kBodyPos = 0;
const kBodyWrites = 1;
const kRigBody = 0;
const kRigSpot = 1;
const kNestRig = 0;
const kDialIndex = 0;
const kDialLevel = 1;

/** Key of the `Dial` literal holding index 1. */
const kDialOneKey = "dial one";
/** Key of the `Pos` literal at the origin. */
const kOriginKey = "origin";

/** The host object behind every `Body` value of one fixture. */
interface HostBody {
  x: number;
  y: number;
  /** How many writes the type's field setter accepted. */
  writes: number;
  /** Once true, every `pos` read is absent and every write is rejected. */
  gone: boolean;
}

/** Tiles and host state the fixture module contributes to a test environment. */
interface Fixture {
  readonly module: WendooModule;
  /** Actuator taking one anonymous number, recording each value it receives. */
  readonly recordTile: IBrainTileDef;
  /** Inline writable-result sensor reading the live `Body` over the host body. */
  readonly bodyTile: IBrainTileDef;
  /** Inline sensor reading a fresh `Rig` holding the live `Body` and the spot `{1, 2}`. */
  readonly rigTile: IBrainTileDef;
  /** Inline sensor reading a fresh `Rig` holding no body and no spot. */
  readonly bareRigTile: IBrainTileDef;
  /** Inline sensor reading a fresh `Nest` holding a `Rig` with no body and the spot `{1, 2}`. */
  readonly nestTile: IBrainTileDef;
  /** Inline sensor reading 5, counting its dispatches. */
  readonly fiveTile: IBrainTileDef;
  /** The host body every `Body` value designates. */
  readonly host: HostBody;
  /** The host level of each dial, keyed by its index. */
  readonly dialLevels: Map<number, number>;
  /** Every value `record` received, in dispatch order. */
  readonly recorded: Value[];
  /** Number of `five` dispatches. */
  fiveCalls(): number;
}

function mkPos(x: number, y: number): StructValue {
  return mkClosedStructValue(kPosTypeId, List.from<Value>([mkNumberValue(x), mkNumberValue(y)]));
}

/** A host module carrying the fixture's struct types, literals, and the actions these tests place into rules. */
function createFixture(): Fixture {
  const recorded: Value[] = [];
  const host: HostBody = { x: 10, y: 20, writes: 0, gone: false };
  const dialLevels = new Map<number, number>();
  let fiveCalls = 0;

  const bodyFieldGetter = (_source: StructValue, fieldId: number): Value | undefined => {
    if (fieldId === kBodyWrites) return mkNumberValue(host.writes);
    if (fieldId === kBodyPos && !host.gone) return mkPos(host.x, host.y);
    return undefined;
  };
  const bodyFieldSetter = (_source: StructValue, fieldId: number, value: Value): boolean => {
    if (host.gone || fieldId !== kBodyPos || !isStructValue(value)) return false;
    const x = value.v?.at(kPosX);
    const y = value.v?.at(kPosY);
    if (x === undefined || y === undefined || !isNumberValue(x) || !isNumberValue(y)) return false;
    host.x = x.v;
    host.y = y.v;
    host.writes++;
    return true;
  };
  const dialFieldGetter = (source: StructValue, fieldId: number): Value | undefined => {
    const index = source.v?.at(kDialIndex);
    if (fieldId === kDialIndex) return index;
    if (fieldId === kDialLevel && index !== undefined && isNumberValue(index)) {
      const level = dialLevels.get(index.v);
      return level === undefined ? undefined : mkNumberValue(level);
    }
    return undefined;
  };
  const dialFieldSetter = (source: StructValue, fieldId: number, value: Value): boolean => {
    const index = source.v?.at(kDialIndex);
    if (fieldId !== kDialLevel || index === undefined || !isNumberValue(index) || !isNumberValue(value)) return false;
    dialLevels.set(index.v, value.v);
    return true;
  };

  const record = createHostActuator({
    key: "writeback.record",
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
  const body = createHostSensor({
    key: "writeback.body",
    actionId: TARGET_ACTION_ID_BASE + 1,
    fnId: TARGET_FUNC_ID_BASE + 1,
    callDef: mkCallDef(bag()),
    outputType: kBodyTypeId,
    inline: true,
    writableResult: true,
    fn: { exec: (): Value => mkNativeStructValue(kBodyTypeId, host) },
  });
  const rig = createHostSensor({
    key: "writeback.rig",
    actionId: TARGET_ACTION_ID_BASE + 2,
    fnId: TARGET_FUNC_ID_BASE + 2,
    callDef: mkCallDef(bag()),
    outputType: kRigTypeId,
    inline: true,
    fn: {
      exec: (): Value =>
        mkClosedStructValue(kRigTypeId, List.from<Value>([mkNativeStructValue(kBodyTypeId, host), mkPos(1, 2)])),
    },
  });
  const bareRig = createHostSensor({
    key: "writeback.bare-rig",
    actionId: TARGET_ACTION_ID_BASE + 3,
    fnId: TARGET_FUNC_ID_BASE + 3,
    callDef: mkCallDef(bag()),
    outputType: kRigTypeId,
    inline: true,
    fn: { exec: (): Value => mkClosedStructValue(kRigTypeId, List.from<Value>([NIL_VALUE, NIL_VALUE])) },
  });
  const nest = createHostSensor({
    key: "writeback.nest",
    actionId: TARGET_ACTION_ID_BASE + 4,
    fnId: TARGET_FUNC_ID_BASE + 4,
    callDef: mkCallDef(bag()),
    outputType: kNestTypeId,
    inline: true,
    fn: {
      exec: (): Value =>
        mkClosedStructValue(
          kNestTypeId,
          List.from<Value>([mkClosedStructValue(kRigTypeId, List.from<Value>([NIL_VALUE, mkPos(1, 2)]))])
        ),
    },
  });
  const five = createHostSensor({
    key: "writeback.five",
    actionId: TARGET_ACTION_ID_BASE + 5,
    fnId: TARGET_FUNC_ID_BASE + 5,
    callDef: mkCallDef(bag()),
    outputType: CoreTypeIds.Number,
    inline: true,
    fn: {
      exec: (): Value => {
        fiveCalls++;
        return mkNumberValue(5);
      },
    },
  });

  const module: WendooModule = {
    id: "field-write-back-spec-host",
    install(api): void {
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kPosTypeId,
        name: "WriteBackPos",
        atomId: 1024,
        fields: List.from([
          { name: "x", typeId: CoreTypeIds.Number, fieldIndex: kPosX },
          { name: "y", typeId: CoreTypeIds.Number, fieldIndex: kPosY },
        ]),
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kBodyTypeId,
        name: "WriteBackBody",
        atomId: 1025,
        fields: List.from([
          { name: "pos", typeId: kPosTypeId, fieldIndex: kBodyPos },
          { name: "writes", typeId: CoreTypeIds.Number, readOnly: true, fieldIndex: kBodyWrites },
        ]),
        fieldGetter: bodyFieldGetter,
        fieldSetter: bodyFieldSetter,
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kRigTypeId,
        name: "WriteBackRig",
        atomId: 1026,
        fields: List.from([
          { name: "body", typeId: kBodyTypeId, fieldIndex: kRigBody },
          { name: "spot", typeId: kPosTypeId, fieldIndex: kRigSpot },
        ]),
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kNestTypeId,
        name: "WriteBackNest",
        atomId: 1027,
        fields: List.from([{ name: "rig", typeId: kRigTypeId, fieldIndex: kNestRig }]),
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kDialTypeId,
        name: "WriteBackDial",
        atomId: 1028,
        fields: List.from([
          { name: "index", typeId: CoreTypeIds.Number, readOnly: true, fieldIndex: kDialIndex },
          { name: "level", typeId: CoreTypeIds.Number, fieldIndex: kDialLevel },
        ]),
        fieldGetter: dialFieldGetter,
        fieldSetter: dialFieldSetter,
        accessors: true,
      });
      api.registerTile(
        new BrainTileLiteralDef(
          kDialTypeId,
          mkClosedStructValue(kDialTypeId, List.from<Value>([mkNumberValue(1), NIL_VALUE])),
          { valueLabel: kDialOneKey, persist: false },
          api.brainServices
        )
      );
      api.registerTile(
        new BrainTileLiteralDef(kPosTypeId, mkPos(0, 0), { valueLabel: kOriginKey, persist: false }, api.brainServices)
      );
      api.registerHostActuator(record);
      api.registerHostSensor(body);
      api.registerHostSensor(rig);
      api.registerHostSensor(bareRig);
      api.registerHostSensor(nest);
      api.registerHostSensor(five);
    },
  };

  return {
    module,
    recordTile: record.tile,
    bodyTile: body.tile,
    rigTile: rig.tile,
    bareRigTile: bareRig.tile,
    nestTile: nest.tile,
    fiveTile: five.tile,
    host,
    dialLevels,
    recorded,
    fiveCalls: () => fiveCalls,
  };
}

/** The accessor and literal tiles `defineType` and the fixture register. */
interface Tiles {
  readonly posX: IBrainTileDef;
  readonly posY: IBrainTileDef;
  readonly bodyPos: IBrainTileDef;
  readonly bodyWrites: IBrainTileDef;
  readonly rigBody: IBrainTileDef;
  readonly rigSpot: IBrainTileDef;
  readonly nestRig: IBrainTileDef;
  readonly dialLevel: IBrainTileDef;
  readonly dialOne: IBrainTileDef;
  readonly origin: IBrainTileDef;
  readonly assign: IBrainTileDef;
}

/** What a test authors against: the environment, an empty single-rule brain, and the fixture's tiles. */
interface Authoring {
  readonly environment: WendooEnvironment;
  readonly brainDef: BrainDef;
  readonly rule: BrainRuleDef;
  readonly fixture: Fixture;
  readonly tiles: Tiles;
}

/** An environment carrying a fresh fixture, and an empty single-rule brain in it. */
function newBrain(): Authoring {
  const fixture = createFixture();
  const environment = createWendooEnvironment({ modules: [coreModule(), fixture.module] });
  const catalog = environment.brainServices.edit.tiles;
  const tile = (tileId: string): IBrainTileDef => {
    const found = catalog.get(tileId);
    assert.ok(found, `fixture tile ${tileId} is registered`);
    return found;
  };
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Write Back Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  return {
    environment,
    brainDef,
    rule: page.children().get(0) as BrainRuleDef,
    fixture,
    tiles: {
      posX: tile(mkAccessorTileId(kPosTypeId, "x")),
      posY: tile(mkAccessorTileId(kPosTypeId, "y")),
      bodyPos: tile(mkAccessorTileId(kBodyTypeId, "pos")),
      bodyWrites: tile(mkAccessorTileId(kBodyTypeId, "writes")),
      rigBody: tile(mkAccessorTileId(kRigTypeId, "body")),
      rigSpot: tile(mkAccessorTileId(kRigTypeId, "spot")),
      nestRig: tile(mkAccessorTileId(kNestTypeId, "rig")),
      dialLevel: tile(mkAccessorTileId(kDialTypeId, "level")),
      dialOne: tile(mkLiteralTileId(kDialTypeId, kDialOneKey)),
      origin: tile(mkLiteralTileId(kPosTypeId, kOriginKey)),
      assign: tile(mkOperatorTileId(CoreOpId.Assign)),
    },
  };
}

/** A brain-scoped variable tile of `typeId`, registered in `brainDef`'s catalog. */
function variable(brainDef: BrainDef, name: string, typeId: TypeId): IBrainTileDef {
  const tile = new BrainTileVariableDef(`variable:writeback.${name}`, name, typeId, `writeback.${name}`);
  brainDef.catalog().registerTileDef(tile);
  return tile;
}

/** Appends `tiles` to a rule side, in order. */
function append(side: ReturnType<BrainRuleDef["do"]>, ...tiles: IBrainTileDef[]): void {
  for (const tile of tiles) {
    __test__appendTile(side, tile);
  }
}

/** What a build-and-run of one brain observed. */
interface RunOutcome {
  /** Error-severity build diagnostic codes. */
  readonly errors: number[];
  /** Every build diagnostic code, whatever its severity. */
  readonly codes: number[];
  /** Every fault the VM raised while the brain ran. */
  readonly faults: ErrorValue[];
}

/** Links `def`, then runs one think step of it, collecting error diagnostics and faults. */
function buildAndRun(environment: WendooEnvironment, def: IBrainDef): RunOutcome {
  const build = environment.linkBrain(def);
  const faults: ErrorValue[] = [];
  const brain = environment.createBrain(def, {
    vmEvents: {
      onFiberFault: ({ err }) => {
        faults.push(err);
      },
    },
  });
  brain.startup();
  brain.think(16);
  const errors = build.diagnostics
    .toArray()
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
  const codes = build.diagnostics.toArray().map((d) => d.code);
  return { errors, codes, faults };
}

/** Asserts `outcome` built cleanly and ran without a VM fault. */
function assertRanClean(outcome: RunOutcome): void {
  assert.deepEqual(outcome.errors, [], "the brain must build");
  assert.deepEqual(
    outcome.faults.map((f) => f.code),
    [],
    `the brain must run without faulting: ${outcome.faults.map((f) => f.message).join(" | ")}`
  );
}

/** The ops of `def`'s compiled code that read, write, or copy a struct, with their field operand, in program order. */
function structOps(environment: WendooEnvironment, def: IBrainDef): string[] {
  const program = environment.linkBrain(def).program;
  assert.ok(program, "the brain must link");
  const ops: string[] = [];
  const functions = program.program.functions;
  for (let i = 0; i < functions.size(); i++) {
    const code = functions.get(i)!.code;
    for (let j = 0; j < code.size(); j++) {
      const ins = code.get(j)!;
      if (ins.op === Op.STRUCT_GET_FIELD) ops.push(`get ${ins.a}`);
      if (ins.op === Op.STRUCT_SET_FIELD) ops.push(`set ${ins.a}`);
      if (ins.op === Op.STRUCT_DEEP_COPY) ops.push("copy");
    }
  }
  return ops;
}

describe("a field assignment through a getter's snapshot writes it back", () => {
  test("a variable root's hooked middle link routes the updated snapshot through the setter", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();
    const held = variable(brainDef, "held", kBodyTypeId);

    append(rule.do(), held, tiles.assign, fixture.bodyTile);
    const write = rule.appendNewRule()!;
    append(write.do(), held, tiles.bodyPos, tiles.posX, tiles.assign, fixture.fiveTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(
      { x: fixture.host.x, y: fixture.host.y, writes: fixture.host.writes },
      { x: 5, y: 20, writes: 1 },
      "the host takes the new x, keeps its y, and sees one write"
    );
  });

  test("a writable-result sensor root routes the same way", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();

    append(rule.do(), fixture.bodyTile, tiles.bodyPos, tiles.posX, tiles.assign, fixture.fiveTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual({ x: fixture.host.x, y: fixture.host.y }, { x: 5, y: 20 });
  });

  test("a depth-three chain with a hooked middle link reaches the host", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();
    const held = variable(brainDef, "held", kRigTypeId);

    append(rule.do(), held, tiles.assign, fixture.rigTile);
    const write = rule.appendNewRule()!;
    append(write.do(), held, tiles.rigBody, tiles.bodyPos, tiles.posY, tiles.assign, fixture.fiveTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual({ x: fixture.host.x, y: fixture.host.y, writes: fixture.host.writes }, { x: 10, y: 5, writes: 1 });
  });

  test("a depth-three chain of plain links stores in place and reads back", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();
    const held = variable(brainDef, "held", kNestTypeId);

    append(rule.do(), held, tiles.assign, fixture.nestTile);
    const write = rule.appendNewRule()!;
    append(write.do(), held, tiles.nestRig, tiles.rigSpot, tiles.posX, tiles.assign, fixture.fiveTile);
    const readX = write.appendNewRule()!;
    append(readX.do(), fixture.recordTile, held, tiles.nestRig, tiles.rigSpot, tiles.posX);
    const readY = write.appendNewRule()!;
    append(readY.do(), fixture.recordTile, held, tiles.nestRig, tiles.rigSpot, tiles.posY);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(fixture.recorded, [mkNumberValue(5), mkNumberValue(2)]);
  });

  test("the chain reads down outermost first, stores, then writes back innermost first", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();
    const held = variable(brainDef, "held", kNestTypeId);

    append(rule.do(), held, tiles.nestRig, tiles.rigSpot, tiles.posX, tiles.assign, fixture.fiveTile);

    assert.deepEqual(structOps(environment, brainDef), [
      `get ${kNestRig}`,
      `get ${kRigSpot}`,
      "copy",
      `set ${kPosX}`,
      `set ${kRigSpot}`,
      `set ${kNestRig}`,
    ]);
  });
});

describe("a falsy link skips the store and every write-back", () => {
  test("a nil root, a nil middle link, and a nil snapshot each skip the whole tail", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();
    const unset = variable(brainDef, "unset", kRigTypeId);
    const bare = variable(brainDef, "bare", kRigTypeId);
    const lost = variable(brainDef, "lost", kRigTypeId);
    fixture.host.gone = true;

    append(rule.do(), bare, tiles.assign, fixture.bareRigTile);
    const assignLost = rule.appendNewRule()!;
    append(assignLost.do(), lost, tiles.assign, fixture.rigTile);
    for (const root of [unset, bare, lost]) {
      const write = assignLost.appendNewRule()!;
      append(write.do(), root, tiles.rigBody, tiles.bodyPos, tiles.posX, tiles.assign, fixture.fiveTile);
    }

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(fixture.fiveCalls(), 3, "every assigned value evaluated");
    assert.equal(fixture.host.writes, 0, "no write-back reached the setter");
    assert.deepEqual({ x: fixture.host.x, y: fixture.host.y }, { x: 10, y: 20 });
  });
});

describe("a literal roots an assignment only through a routed terminal field", () => {
  test("a routed field of a literal stores through the setter and leaves the constant alone", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();

    append(rule.do(), tiles.dialOne, tiles.dialLevel, tiles.assign, fixture.fiveTile);
    const read = rule.appendNewRule()!;
    append(read.do(), fixture.recordTile, tiles.dialOne, tiles.dialLevel);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(fixture.dialLevels.get(1), 5);
    assert.deepEqual(fixture.recorded, [mkNumberValue(5)]);
    const constant = (tiles.dialOne as BrainTileLiteralDef).value as StructValue;
    assert.deepEqual(constant.v?.at(kDialLevel), NIL_VALUE, "the literal's own storage is untouched");
  });

  test("a plain field of a literal is refused at compile time", () => {
    const { environment, brainDef, rule, fixture, tiles } = newBrain();

    append(rule.do(), tiles.origin, tiles.posX, tiles.assign, fixture.fiveTile);

    const outcome = buildAndRun(environment, brainDef);

    assert.ok(
      outcome.codes.includes(ParseDiagCode.ReadOnlyResultFieldAssignment),
      `diagnostics: ${outcome.codes.join(", ")}`
    );
    assert.equal(fixture.fiveCalls(), 0, "the refused assignment compiles to nothing");
  });
});
