/**
 * A native-backed struct type may declare an existence hook. A value of such a
 * type whose backing the hook reports gone is falsy, so every truthiness test a
 * compiled brain makes reads it as nothing: a WHEN holding it does not fire, an
 * accessor chain through it reads nil before any field hook runs, and an action
 * it is placed in is not dispatched. A type declaring no hook keeps every value
 * truthy. These tests run compiled brains on the VM against a fixture whose
 * field hooks read and write the backing whether or not it still exists, so a
 * nil read or a skipped write can only come from the existence hook.
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
  type WendooBrain,
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
  isNumberValue,
  mkCallDef,
  mkNativeStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  param,
  type StructValue,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  type TypeId,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";

const kMortalTypeId = mkTypeId(NativeType.Struct, "ExistSpecMortal");
const kHooklessTypeId = mkTypeId(NativeType.Struct, "ExistSpecHookless");
const kAnonMortalParamId = "anon.ExistSpecMortal";
const kTagField = 0;

/** The host object behind every value of one fixture type. */
interface Backing {
  /** Whether the object still exists; the test flips it between thinks. */
  alive: boolean;
  /** The object's `tag` field, readable and writable whether or not the object exists. */
  tag: number;
}

/** Calls the fixture's hooks received. */
interface HookCalls {
  getter: number;
  setter: number;
  exists: number;
}

/** Tiles, backings, and observations the fixture module contributes to a test environment. */
interface Fixture {
  readonly module: WendooModule;
  /** The object behind every `Mortal` value; its type declares the existence hook. */
  readonly mortal: Backing;
  /** The object behind every `Hookless` value; its type declares no existence hook. */
  readonly hookless: Backing;
  /** Calls the `Mortal` type's hooks received. */
  readonly calls: HookCalls;
  /** Inline sensor reading a fresh `Mortal` value over {@link Fixture.mortal}. */
  readonly mortalTile: IBrainTileDef;
  /** Inline sensor reading a fresh `Hookless` value over {@link Fixture.hookless}. */
  readonly hooklessTile: IBrainTileDef;
  /** Actuator taking one anonymous number, recording each value it receives. */
  readonly recordTile: IBrainTileDef;
  /** Actuator taking one anonymous `Mortal`, counting its dispatches. */
  readonly markTile: IBrainTileDef;
  /** Inline sensor reading 5. */
  readonly fiveTile: IBrainTileDef;
  /** Every value `record` received, in dispatch order. */
  readonly recorded: Value[];
  /** Number of `mark` dispatches. */
  markCalls(): number;
}

/** A host module carrying the `Mortal` and `Hookless` native struct types and the actions these tests place into rules. */
function createFixture(): Fixture {
  const mortal: Backing = { alive: true, tag: 7 };
  const hookless: Backing = { alive: true, tag: 7 };
  const calls: HookCalls = { getter: 0, setter: 0, exists: 0 };
  const recorded: Value[] = [];
  let markCalls = 0;
  let nextId = 0;
  const ids = () => {
    const offset = nextId++;
    return { actionId: TARGET_ACTION_ID_BASE + offset, fnId: TARGET_FUNC_ID_BASE + offset };
  };

  const backingOf = (source: StructValue): Backing => source.native as Backing;
  const fieldGetter = (count: boolean) => (source: StructValue, fieldId: number) => {
    if (count) calls.getter++;
    return fieldId === kTagField ? mkNumberValue(backingOf(source).tag) : undefined;
  };
  const fieldSetter = (count: boolean) => (source: StructValue, fieldId: number, value: Value) => {
    if (count) calls.setter++;
    if (fieldId !== kTagField || !isNumberValue(value)) return false;
    backingOf(source).tag = value.v;
    return true;
  };

  const reader = (key: string, outputType: TypeId, read: () => Value) =>
    createHostSensor({ key, ...ids(), callDef: mkCallDef(bag()), outputType, inline: true, fn: { exec: read } });
  const mortalSensor = reader("existspec.mortal", kMortalTypeId, () => mkNativeStructValue(kMortalTypeId, mortal));
  const hooklessSensor = reader("existspec.hookless", kHooklessTypeId, () =>
    mkNativeStructValue(kHooklessTypeId, hookless)
  );
  const five = reader("existspec.five", CoreTypeIds.Number, () => mkNumberValue(5));
  const record = createHostActuator({
    key: "existspec.record",
    ...ids(),
    callDef: mkCallDef(bag(param(CoreParameterId.AnonymousNumber, { name: "value", anonymous: true }))),
    fn: {
      exec: (_ctx, args: ReadonlyList<Value>): Value => {
        recorded.push(args.get(0));
        return VOID_VALUE;
      },
    },
  });
  const mark = createHostActuator({
    key: "existspec.mark",
    ...ids(),
    callDef: mkCallDef(bag(param(kAnonMortalParamId, { name: "target", anonymous: true }))),
    fn: {
      exec: (): Value => {
        markCalls++;
        return VOID_VALUE;
      },
    },
  });

  const tagField = List.from([{ name: "tag", typeId: CoreTypeIds.Number, fieldIndex: kTagField }]);
  const module: WendooModule = {
    id: "struct-existence-hook-spec-host",
    install(api): void {
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kMortalTypeId,
        name: "ExistSpecMortal",
        atomId: 1024,
        fields: tagField,
        fieldGetter: fieldGetter(true),
        fieldSetter: fieldSetter(true),
        exists: (source: StructValue) => {
          calls.exists++;
          return backingOf(source).alive;
        },
        accessors: true,
      });
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kHooklessTypeId,
        name: "ExistSpecHookless",
        atomId: 1025,
        fields: tagField,
        fieldGetter: fieldGetter(false),
        fieldSetter: fieldSetter(false),
        accessors: true,
      });
      api.registerParameters([{ id: kAnonMortalParamId, dataType: kMortalTypeId, hidden: true }]);
      api.registerHostActuator(record);
      api.registerHostActuator(mark);
      api.registerHostSensor(mortalSensor);
      api.registerHostSensor(hooklessSensor);
      api.registerHostSensor(five);
    },
  };

  return {
    module,
    mortal,
    hookless,
    calls,
    mortalTile: mortalSensor.tile,
    hooklessTile: hooklessSensor.tile,
    recordTile: record.tile,
    markTile: mark.tile,
    fiveTile: five.tile,
    recorded,
    markCalls: () => markCalls,
  };
}

/** What a test authors against: the environment, an empty single-rule brain, and the fixture's tiles. */
interface Authoring {
  readonly environment: WendooEnvironment;
  readonly brainDef: BrainDef;
  readonly page: BrainPageDef;
  readonly rule: BrainRuleDef;
  readonly fixture: Fixture;
  /** Accessor tile on `Mortal.tag`. */
  readonly mortalTag: IBrainTileDef;
  readonly assign: IBrainTileDef;
}

/** An environment carrying a fresh fixture, and an empty single-rule brain in it. */
function newBrain(): Authoring {
  const fixture = createFixture();
  const environment = createWendooEnvironment({ modules: [coreModule(), fixture.module] });
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Existence Hook Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  return {
    environment,
    brainDef,
    page,
    rule: page.children().get(0) as BrainRuleDef,
    fixture,
    mortalTag: tiles.get(mkAccessorTileId(kMortalTypeId, "tag"))!,
    assign: tiles.get(mkOperatorTileId(CoreOpId.Assign))!,
  };
}

/** A brain-scoped variable tile of `typeId`, registered in `brainDef`'s catalog. */
function variable(brainDef: BrainDef, name: string, typeId: TypeId): IBrainTileDef {
  const tile = new BrainTileVariableDef(`variable:existspec.${name}`, name, typeId, `existspec.${name}`);
  brainDef.catalog().registerTileDef(tile);
  return tile;
}

/** Appends `tiles` to a rule side, in order. */
function append(side: ReturnType<BrainRuleDef["do"]>, ...tiles: IBrainTileDef[]): void {
  for (const tile of tiles) {
    __test__appendTile(side, tile);
  }
}

/** A started brain under test, stepped one think at a time. */
interface Run {
  readonly brain: WendooBrain;
  /** Every fault the VM raised so far. */
  readonly faults: ErrorValue[];
  /** Firing outcomes of the rules that reached their WHEN gate on the latest think, keyed by rule function id. */
  readonly gates: Map<number, boolean>;
  /** Runs one think, clearing the gates the previous think recorded. */
  think(): void;
}

/** Links and starts `def`, asserting it builds with no error diagnostics. */
function start(environment: WendooEnvironment, def: IBrainDef): Run {
  const build = environment.linkBrain(def);
  const errors = build.diagnostics
    .toArray()
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
  assert.deepEqual(errors, [], "the brain must build");
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
  let thinks = 0;
  return {
    brain,
    faults,
    gates,
    think: () => {
      gates.clear();
      thinks++;
      brain.think(16 * thinks);
    },
  };
}

/** Asserts the run raised no VM fault. */
function assertNoFaults(run: Run): void {
  assert.deepEqual(
    run.faults.map((f) => f.code),
    [],
    `the brain must run without faulting: ${run.faults.map((f) => f.message).join(" | ")}`
  );
}

describe("a value whose backing the existence hook reports gone is falsy", () => {
  test("a WHEN holding the value fires while its backing exists, and not once it is gone, consulted afresh each time", () => {
    const { environment, brainDef, rule, fixture, assign } = newBrain();
    const held = variable(brainDef, "held", kMortalTypeId);
    append(rule.do(), held, assign, fixture.mortalTile);
    const gated = rule.appendNewRule()!;
    append(gated.when(), held);
    append(gated.do(), fixture.recordTile, fixture.fiveTile);

    const run = start(environment, brainDef);
    run.think();
    assert.deepEqual([...run.gates.values()], [true], "a live backing fires the WHEN");

    fixture.mortal.alive = false;
    run.think();
    assert.deepEqual([...run.gates.values()], [false], "a gone backing gates the WHEN off");

    fixture.mortal.alive = true;
    run.think();
    assert.deepEqual([...run.gates.values()], [true], "the hook is consulted again, not cached");

    assertNoFaults(run);
    assert.deepEqual(fixture.recorded, [mkNumberValue(5), mkNumberValue(5)]);
    assert.ok(fixture.calls.exists >= 3, "every truthiness test of the value consults the hook");
  });

  test("an accessor chain through the value reads nil without running the field getter", () => {
    const { environment, brainDef, rule, fixture, assign, mortalTag } = newBrain();
    const held = variable(brainDef, "held", kMortalTypeId);
    const out = variable(brainDef, "out", CoreTypeIds.Number);
    append(rule.do(), held, assign, fixture.mortalTile);
    const read = rule.appendNewRule()!;
    append(read.do(), out, assign, held, mortalTag);

    const run = start(environment, brainDef);
    run.think();
    assert.deepEqual(run.brain.getVariable("out"), mkNumberValue(7), "a live backing reads its field");
    const gettersWhileLive = fixture.calls.getter;

    fixture.mortal.alive = false;
    run.think();
    assertNoFaults(run);
    assert.equal(run.brain.getVariable("out")?.t, NativeType.Nil, "a gone backing reads nil");
    assert.equal(fixture.calls.getter, gettersWhileLive, "the chain stops before the field getter");
  });

  test("a field write through the value skips the store without running the field setter", () => {
    const { environment, brainDef, rule, fixture, assign, mortalTag } = newBrain();
    const held = variable(brainDef, "held", kMortalTypeId);
    append(rule.do(), held, assign, fixture.mortalTile);
    const write = rule.appendNewRule()!;
    append(write.do(), held, mortalTag, assign, fixture.fiveTile);

    fixture.mortal.alive = false;
    const run = start(environment, brainDef);
    run.think();

    assertNoFaults(run);
    assert.equal(fixture.calls.setter, 0, "the store is skipped before the field setter");
    assert.equal(fixture.mortal.tag, 7, "the backing keeps its field");
  });

  test("an action the value is placed in is not dispatched", () => {
    const { environment, brainDef, rule, fixture, assign } = newBrain();
    const held = variable(brainDef, "held", kMortalTypeId);
    append(rule.do(), held, assign, fixture.mortalTile);
    const act = rule.appendNewRule()!;
    append(act.do(), fixture.markTile, held);

    const run = start(environment, brainDef);
    run.think();
    assert.equal(fixture.markCalls(), 1, "a live backing dispatches the action");

    fixture.mortal.alive = false;
    run.think();
    assertNoFaults(run);
    assert.equal(fixture.markCalls(), 1, "a gone backing gates the action off");
  });
});

describe("a type declaring no existence hook keeps every value truthy", () => {
  test("a WHEN holding a value of a hookless type fires after its backing is gone", () => {
    const { environment, brainDef, rule, fixture, assign } = newBrain();
    const held = variable(brainDef, "held", kHooklessTypeId);
    append(rule.do(), held, assign, fixture.hooklessTile);
    const gated = rule.appendNewRule()!;
    append(gated.when(), held);
    append(gated.do(), fixture.recordTile, fixture.fiveTile);

    const run = start(environment, brainDef);
    fixture.hookless.alive = false;
    run.think();

    assertNoFaults(run);
    assert.deepEqual([...run.gates.values()], [true]);
    assert.deepEqual(fixture.recorded, [mkNumberValue(5)]);
  });
});
