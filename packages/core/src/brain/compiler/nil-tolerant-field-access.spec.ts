/**
 * The tile language's field accessors are nil-tolerant: a field read whose
 * object is not a value (nil, void, or unknown) yields nil, at every link of
 * an accessor chain, and a field assignment through such an object skips the
 * store while its object and value still evaluate. These tests run compiled
 * brains on the VM and pin that no such read or write faults. A read under
 * test is observed by assigning it to a brain variable and inspecting that
 * variable after the run.
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
import { mkAccessorTileId, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  bag,
  CoreOpId,
  CoreParameterId,
  CoreTypeIds,
  type ErrorValue,
  mkCallDef,
  mkClosedStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  NIL_VALUE,
  param,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  type TypeId,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";

const kPosTypeId = mkTypeId(NativeType.Struct, "NilSpecPos");
const kBodyTypeId = mkTypeId(NativeType.Struct, "NilSpecBody");
const kPosX = 0;
const kBodyPos = 0;
const kBodyTag = 1;

/** Tiles and observations the fixture module contributes to a test environment. */
interface Fixture {
  readonly module: WendooModule;
  /** Actuator taking one anonymous number, recording each value it receives. */
  readonly recordTile: IBrainTileDef;
  /** Inline sensor reading a fresh `Body` whose `pos` field is nil and whose `tag` is 7. */
  readonly bodyTile: IBrainTileDef;
  /** Inline sensor declared to read a `Body` that reads VOID at runtime. */
  readonly voidBodyTile: IBrainTileDef;
  /** Inline sensor reading 5, counting its dispatches. */
  readonly fiveTile: IBrainTileDef;
  /** Every value `record` received, in dispatch order. */
  readonly recorded: Value[];
  /** Number of `five` dispatches. */
  fiveCalls(): number;
}

/** A host module carrying the `Pos` and `Body` struct types and the actions these tests place into rules. */
function createFixture(): Fixture {
  const recorded: Value[] = [];
  let fiveCalls = 0;

  const record = createHostActuator({
    key: "nilspec.record",
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
    key: "nilspec.body",
    actionId: TARGET_ACTION_ID_BASE + 1,
    fnId: TARGET_FUNC_ID_BASE + 1,
    callDef: mkCallDef(bag()),
    outputType: kBodyTypeId,
    inline: true,
    fn: { exec: (): Value => mkClosedStructValue(kBodyTypeId, List.from<Value>([NIL_VALUE, mkNumberValue(7)])) },
  });

  const voidBody = createHostSensor({
    key: "nilspec.void-body",
    actionId: TARGET_ACTION_ID_BASE + 2,
    fnId: TARGET_FUNC_ID_BASE + 2,
    callDef: mkCallDef(bag()),
    outputType: kBodyTypeId,
    inline: true,
    fn: { exec: (): Value => VOID_VALUE },
  });

  const five = createHostSensor({
    key: "nilspec.five",
    actionId: TARGET_ACTION_ID_BASE + 3,
    fnId: TARGET_FUNC_ID_BASE + 3,
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
    id: "nil-tolerant-field-access-spec-host",
    install(api): void {
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kPosTypeId,
        name: "NilSpecPos",
        atomId: 1024,
        fields: List.from([
          { name: "x", typeId: CoreTypeIds.Number, fieldIndex: kPosX },
          { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
        ]),
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kBodyTypeId,
        name: "NilSpecBody",
        atomId: 1025,
        fields: List.from([
          { name: "pos", typeId: kPosTypeId, fieldIndex: kBodyPos },
          { name: "tag", typeId: CoreTypeIds.Number, fieldIndex: kBodyTag },
        ]),
        accessors: true,
      });
      api.registerHostActuator(record);
      api.registerHostSensor(body);
      api.registerHostSensor(voidBody);
      api.registerHostSensor(five);
    },
  };

  return {
    module,
    recordTile: record.tile,
    bodyTile: body.tile,
    voidBodyTile: voidBody.tile,
    fiveTile: five.tile,
    recorded,
    fiveCalls: () => fiveCalls,
  };
}

/** The accessor tiles `defineType` registers for the fixture's struct types. */
interface Accessors {
  /** Accessor tile on `Pos.x`. */
  readonly posX: IBrainTileDef;
  /** Accessor tile on `Body.pos`. */
  readonly bodyPos: IBrainTileDef;
  /** Accessor tile on `Body.tag`. */
  readonly bodyTag: IBrainTileDef;
}

/** What a test authors against: the environment, an empty single-rule brain, and the fixture's tiles. */
interface Authoring {
  readonly environment: WendooEnvironment;
  readonly brainDef: BrainDef;
  readonly rule: BrainRuleDef;
  readonly fixture: Fixture;
  readonly accessors: Accessors;
  readonly assign: IBrainTileDef;
}

/** An environment carrying a fresh fixture, and an empty single-rule brain in it. */
function newBrain(): Authoring {
  const fixture = createFixture();
  const environment = createWendooEnvironment({ modules: [coreModule(), fixture.module] });
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Nil Tolerant Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  return {
    environment,
    brainDef,
    rule: page.children().get(0) as BrainRuleDef,
    fixture,
    accessors: {
      posX: tiles.get(mkAccessorTileId(kPosTypeId, "x"))!,
      bodyPos: tiles.get(mkAccessorTileId(kBodyTypeId, "pos"))!,
      bodyTag: tiles.get(mkAccessorTileId(kBodyTypeId, "tag"))!,
    },
    assign: tiles.get(mkOperatorTileId(CoreOpId.Assign))!,
  };
}

/** A brain-scoped variable tile of `typeId`, registered in `brainDef`'s catalog. */
function variable(brainDef: BrainDef, name: string, typeId: TypeId): IBrainTileDef {
  const tile = new BrainTileVariableDef(`variable:nilspec.${name}`, name, typeId, `nilspec.${name}`);
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
  /** Every fault the VM raised while the brain ran. */
  readonly faults: ErrorValue[];
  /** Firing outcome of each rule that reached its WHEN gate, keyed by rule function id. */
  readonly gates: Map<number, boolean>;
  /** The value the brain variable `name` holds after the run, or undefined when it holds none. */
  variable(name: string): Value | undefined;
}

/** Links `def`, then runs `thinks` think steps of it, collecting error diagnostics, faults, and WHEN gates. */
function buildAndRun(environment: WendooEnvironment, def: IBrainDef, thinks = 1): RunOutcome {
  const build = environment.linkBrain(def);
  const faults: ErrorValue[] = [];
  const gates = new Map<number, boolean>();
  const brain = environment.createBrain(def, {
    vmEvents: {
      onFiberFault: ({ err }) => {
        faults.push(err);
      },
      onRuleWhenGate: ({ ruleFuncId, fired }) => {
        if (ruleFuncId !== undefined) gates.set(ruleFuncId, fired);
      },
    },
  });
  brain.startup();
  for (let i = 0; i < thinks; i++) {
    brain.think(16 * (i + 1));
  }
  const errors = build.diagnostics
    .toArray()
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
  return { errors, faults, gates, variable: (name) => brain.getVariable(name) };
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

describe("a field read through an object that is not a value yields nil", () => {
  test("a never-assigned struct variable's field reads nil", () => {
    const { environment, brainDef, rule, accessors, assign } = newBrain();
    const pos = variable(brainDef, "pos", kPosTypeId);
    const out = variable(brainDef, "out", CoreTypeIds.Number);

    append(rule.do(), out, assign, pos, accessors.posX);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(outcome.variable("out")?.t, NativeType.Nil);
  });

  test("a held struct whose field reads nil chains to nil at depth 2", () => {
    const { environment, brainDef, rule, fixture, accessors, assign } = newBrain();
    const held = variable(brainDef, "held", kBodyTypeId);
    const out = variable(brainDef, "out", CoreTypeIds.Number);

    append(rule.do(), held, assign, fixture.bodyTile);
    const child = rule.appendNewRule()!;
    append(child.do(), out, assign, held, accessors.bodyPos, accessors.posX);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(outcome.variable("out")?.t, NativeType.Nil);
  });

  test("a live chain still reads its field", () => {
    const { environment, brainDef, rule, fixture, accessors } = newBrain();

    append(rule.do(), fixture.recordTile, fixture.bodyTile, accessors.bodyTag);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(fixture.recorded.length, 1);
    assert.deepEqual(fixture.recorded[0], mkNumberValue(7));
  });

  test("a WHEN-side chain through nil gates its rule off instead of faulting", () => {
    const { environment, brainDef, rule, fixture, accessors } = newBrain();
    const pos = variable(brainDef, "pos", kPosTypeId);

    append(rule.when(), pos, accessors.posX);
    append(rule.do(), fixture.recordTile, fixture.fiveTile);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual([...outcome.gates.values()], [false], "the rule reached its gate and did not fire");
    assert.deepEqual(fixture.recorded, []);
  });

  test("a void object reads nil, not void", () => {
    const { environment, brainDef, rule, fixture, accessors, assign } = newBrain();
    const out = variable(brainDef, "out", CoreTypeIds.Number);

    append(rule.do(), out, assign, fixture.voidBodyTile, accessors.bodyTag);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(outcome.variable("out")?.t, NativeType.Nil);
  });
});

describe("a field assignment through an object that is not a value skips the store", () => {
  test("the value still evaluates, nothing faults, and the object stays nil", () => {
    const { environment, brainDef, rule, fixture, accessors, assign } = newBrain();
    const pos = variable(brainDef, "pos", kPosTypeId);

    const out = variable(brainDef, "out", CoreTypeIds.Number);

    append(rule.do(), pos, accessors.posX, assign, fixture.fiveTile);
    const child = rule.appendNewRule()!;
    append(child.do(), out, assign, pos, accessors.posX);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(fixture.fiveCalls(), 1, "the assigned value evaluated");
    assert.equal(outcome.variable("out")?.t, NativeType.Nil, "no store reached the object");
  });

  test("a void object held in a variable skips the store", () => {
    const { environment, brainDef, rule, fixture, accessors, assign } = newBrain();
    const held = variable(brainDef, "held", kBodyTypeId);
    const out = variable(brainDef, "out", CoreTypeIds.Number);

    append(rule.do(), held, assign, fixture.voidBodyTile);
    const write = rule.appendNewRule()!;
    append(write.do(), held, accessors.bodyTag, assign, fixture.fiveTile);
    const read = write.appendNewRule()!;
    append(read.do(), out, assign, held, accessors.bodyTag);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(fixture.fiveCalls(), 1, "the assigned value evaluated");
    assert.equal(outcome.variable("out")?.t, NativeType.Nil);
  });

  test("a struct object still takes the store", () => {
    const { environment, brainDef, rule, fixture, accessors, assign } = newBrain();
    const held = variable(brainDef, "held", kBodyTypeId);

    append(rule.do(), held, assign, fixture.bodyTile);
    const write = rule.appendNewRule()!;
    append(write.do(), held, accessors.bodyTag, assign, fixture.fiveTile);
    const read = write.appendNewRule()!;
    append(read.do(), fixture.recordTile, held, accessors.bodyTag);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(fixture.recorded, [mkNumberValue(5)]);
  });
});
