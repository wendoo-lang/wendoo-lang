/**
 * A value placed in an action's anonymous slot gates the call: when the value
 * evaluates to nothing (nil, void, or unknown), the action is not dispatched
 * -- an actuator does not run, and a sensor reads nil, so its rule does not
 * fire. A slot the author left empty gates nothing: it arrives as nil and the
 * action takes its own fallback. These tests run compiled brains on the VM.
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
import { buildDescriptorOutputTiles, setSensorOutput } from "@wendoo/core/app";
import type { IBrainDef, IBrainTileDef } from "@wendoo/core/brain";
import { CoreControlFlowId, mkAccessorTileId, mkControlFlowTileId, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  type AsyncHandle,
  bag,
  CoreHostActions,
  CoreOpId,
  CoreParameterId,
  CoreTypeIds,
  type ErrorValue,
  type HandleId,
  mkCallDef,
  mkClosedStructValue,
  mkNumberValue,
  mkSensorTileId,
  mkTypeId,
  NativeType,
  NIL_VALUE,
  param,
  repeated,
  TARGET_ACTION_ID_BASE,
  TARGET_FUNC_ID_BASE,
  TRUE_VALUE,
  type TypeId,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";

const kPosTypeId = mkTypeId(NativeType.Struct, "PlacedNilPos");
const kAnonPosParamId = "anon.PlacedNilPos";
const kPosX = 0;

/** Every value one dispatch of a recording action received, in slot order. */
type Received = readonly Value[];

/** Tiles and observations the fixture module contributes to a test environment. */
interface Fixture {
  readonly module: WendooModule;
  /** Actuator taking one anonymous number. */
  readonly record: IBrainTileDef;
  /** Actuator taking one anonymous boolean. */
  readonly flag: IBrainTileDef;
  /** Actuator taking one anonymous string. */
  readonly text: IBrainTileDef;
  /** Actuator taking one anonymous `Pos`. */
  readonly mark: IBrainTileDef;
  /** Actuator taking an anonymous `Pos` and an anonymous number. */
  readonly pair: IBrainTileDef;
  /** Actuator gathering any number of anonymous numbers into one list. */
  readonly gather: IBrainTileDef;
  /** Asynchronous actuator taking one anonymous number; settles its handle at once. */
  readonly defer: IBrainTileDef;
  /** Sensor taking one anonymous `Pos`, reading true. */
  readonly probe: IBrainTileDef;
  /** Sensor taking one anonymous number, reading true and writing its run count to its `runs` output. */
  readonly scan: IBrainTileDef;
  /** Output tile reading `scan`'s `runs` output. */
  readonly runs: IBrainTileDef;
  /** Inline sensor reading a fresh `Pos` whose `x` is 3. */
  readonly pos: IBrainTileDef;
  /** Inline sensor declared to read a `Pos` that reads VOID. */
  readonly voidPos: IBrainTileDef;
  /** Inline sensor declared to read a boolean that reads nil. */
  readonly noFlag: IBrainTileDef;
  /** Inline sensor declared to read a string that reads nil. */
  readonly noText: IBrainTileDef;
  /** Inline sensor reading not-a-number. */
  readonly notANumber: IBrainTileDef;
  /** Inline sensor reading 5, counting its dispatches. */
  readonly five: IBrainTileDef;
  /** Received values of every dispatch, keyed by the dispatched action's key, in dispatch order. */
  received(key: string): Received[];
  /** Number of `five` dispatches. */
  fiveCalls(): number;
}

/** Keys of the fixture's recording actions. */
const Keys = {
  record: "placednil.record",
  flag: "placednil.flag",
  text: "placednil.text",
  mark: "placednil.mark",
  pair: "placednil.pair",
  gather: "placednil.gather",
  defer: "placednil.defer",
  probe: "placednil.probe",
  scan: "placednil.scan",
} as const;

/** A host module carrying the `Pos` struct type and the actions these tests place into rules. */
function createFixture(): Fixture {
  const received = new Map<string, Received[]>();
  let fiveCalls = 0;
  let scanRuns = 0;
  let nextId = 0;

  const receive = (key: string, args: ReadonlyList<Value>): void => {
    const list = received.get(key) ?? [];
    list.push(args.toArray());
    received.set(key, list);
  };
  const ids = () => {
    const offset = nextId++;
    return { actionId: TARGET_ACTION_ID_BASE + offset, fnId: TARGET_FUNC_ID_BASE + offset };
  };
  const anonNumber = param(CoreParameterId.AnonymousNumber, { name: "value", anonymous: true });
  const anonPos = param(kAnonPosParamId, { name: "pos", anonymous: true });
  const recorder = (key: string, callDef: ReturnType<typeof mkCallDef>) =>
    createHostActuator({
      key,
      ...ids(),
      callDef,
      fn: {
        exec: (_ctx, args: ReadonlyList<Value>): Value => {
          receive(key, args);
          return VOID_VALUE;
        },
      },
    });
  const reader = (key: string, outputType: TypeId, read: () => Value) =>
    createHostSensor({ key, ...ids(), callDef: mkCallDef(bag()), outputType, inline: true, fn: { exec: read } });

  const record = recorder(Keys.record, mkCallDef(bag(anonNumber)));
  const flag = recorder(
    Keys.flag,
    mkCallDef(bag(param(CoreParameterId.AnonymousBoolean, { name: "value", anonymous: true })))
  );
  const text = recorder(
    Keys.text,
    mkCallDef(bag(param(CoreParameterId.AnonymousString, { name: "value", anonymous: true })))
  );
  const mark = recorder(Keys.mark, mkCallDef(bag(anonPos)));
  const pair = recorder(Keys.pair, mkCallDef(bag(anonPos, anonNumber)));
  const gather = recorder(Keys.gather, mkCallDef(bag(repeated(anonNumber, { min: 0 }))));
  const defer = createHostActuator({
    key: Keys.defer,
    ...ids(),
    callDef: mkCallDef(bag(anonNumber)),
    isAsync: true,
    fn: {
      exec: (_ctx, args: ReadonlyList<Value>, handle: AsyncHandle): void => {
        receive(Keys.defer, args);
        handle.resolve(VOID_VALUE);
      },
    },
  });
  const probe = createHostSensor({
    key: Keys.probe,
    ...ids(),
    callDef: mkCallDef(bag(anonPos)),
    outputType: CoreTypeIds.Boolean,
    fn: {
      exec: (_ctx, args: ReadonlyList<Value>): Value => {
        receive(Keys.probe, args);
        return TRUE_VALUE;
      },
    },
  });
  const scan = createHostSensor({
    key: Keys.scan,
    ...ids(),
    callDef: mkCallDef(bag(anonNumber)),
    outputType: CoreTypeIds.Boolean,
    outputs: [{ name: "runs", type: CoreTypeIds.Number }],
    fn: {
      exec: (ctx, args: ReadonlyList<Value>): Value => {
        receive(Keys.scan, args);
        scanRuns++;
        setSensorOutput(ctx, CoreTypeIds.Number, "runs", mkNumberValue(scanRuns));
        return TRUE_VALUE;
      },
    },
  });
  const [runs] = buildDescriptorOutputTiles(scan.descriptor.outputs!);
  const pos = reader("placednil.pos", kPosTypeId, () =>
    mkClosedStructValue(kPosTypeId, List.from<Value>([mkNumberValue(3), mkNumberValue(4)]))
  );
  const voidPos = reader("placednil.void-pos", kPosTypeId, () => VOID_VALUE);
  const noFlag = reader("placednil.no-flag", CoreTypeIds.Boolean, () => NIL_VALUE);
  const noText = reader("placednil.no-text", CoreTypeIds.String, () => NIL_VALUE);
  const notANumber = reader("placednil.not-a-number", CoreTypeIds.Number, () => mkNumberValue(Number.NaN));
  const five = reader("placednil.five", CoreTypeIds.Number, () => {
    fiveCalls++;
    return mkNumberValue(5);
  });

  const module: WendooModule = {
    id: "placed-nil-gate-spec-host",
    install(api): void {
      api.defineType({
        coreType: NativeType.Struct,
        typeId: kPosTypeId,
        name: "PlacedNilPos",
        atomId: 1024,
        fields: List.from([
          { name: "x", typeId: CoreTypeIds.Number, fieldIndex: kPosX },
          { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
        ]),
        accessors: true,
      });
      api.registerParameters([{ id: kAnonPosParamId, dataType: kPosTypeId, hidden: true }]);
      for (const actuator of [record, flag, text, mark, pair, gather, defer]) {
        api.registerHostActuator(actuator);
      }
      for (const sensor of [probe, scan, pos, voidPos, noFlag, noText, notANumber, five]) {
        api.registerHostSensor(sensor);
      }
      api.registerTile(runs);
    },
  };

  return {
    module,
    record: record.tile,
    flag: flag.tile,
    text: text.tile,
    mark: mark.tile,
    pair: pair.tile,
    gather: gather.tile,
    defer: defer.tile,
    probe: probe.tile,
    scan: scan.tile,
    runs,
    pos: pos.tile,
    voidPos: voidPos.tile,
    noFlag: noFlag.tile,
    noText: noText.tile,
    notANumber: notANumber.tile,
    five: five.tile,
    received: (key) => received.get(key) ?? [],
    fiveCalls: () => fiveCalls,
  };
}

/** What a test authors against: the environment, an empty single-rule brain, and the fixture's tiles. */
interface Authoring {
  readonly environment: WendooEnvironment;
  readonly brainDef: BrainDef;
  readonly page: BrainPageDef;
  readonly rule: BrainRuleDef;
  readonly fixture: Fixture;
  /** Accessor tile on `Pos.x`. */
  readonly posX: IBrainTileDef;
  readonly assign: IBrainTileDef;
  readonly or: IBrainTileDef;
  readonly open: IBrainTileDef;
  readonly close: IBrainTileDef;
}

/** An environment carrying a fresh fixture, and an empty single-rule brain in it. */
function newBrain(): Authoring {
  const fixture = createFixture();
  const environment = createWendooEnvironment({ modules: [coreModule(), fixture.module] });
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Placed Nil Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  return {
    environment,
    brainDef,
    page,
    rule: page.children().get(0) as BrainRuleDef,
    fixture,
    posX: tiles.get(mkAccessorTileId(kPosTypeId, "x"))!,
    assign: tiles.get(mkOperatorTileId(CoreOpId.Assign))!,
    or: tiles.get(mkOperatorTileId(CoreOpId.Or))!,
    open: tiles.get(mkControlFlowTileId(CoreControlFlowId.OpenParen))!,
    close: tiles.get(mkControlFlowTileId(CoreControlFlowId.CloseParen))!,
  };
}

/** A brain-scoped variable tile of `typeId`, registered in `brainDef`'s catalog. */
function variable(brainDef: BrainDef, name: string, typeId: TypeId): IBrainTileDef {
  const tile = new BrainTileVariableDef(`variable:placednil.${name}`, name, typeId, `placednil.${name}`);
  brainDef.catalog().registerTileDef(tile);
  return tile;
}

/** A literal tile carrying `value` of `typeId`, registered in `environment`'s brain's catalog. */
function literal(authoring: Authoring, typeId: TypeId, value: unknown): IBrainTileDef {
  const tile = new BrainTileLiteralDef(typeId, value, {}, authoring.environment.brainServices);
  authoring.brainDef.catalog().registerTileDef(tile);
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
  /** Firing outcomes of the rules that reached their WHEN gate, per think, keyed by rule function id. */
  readonly gates: Map<number, boolean>[];
  /** Handle ids of every asynchronous dispatch, in dispatch order. */
  readonly handles: HandleId[];
  /** The value the brain variable `name` holds after the run, or undefined when it holds none. */
  variable(name: string): Value | undefined;
}

/** Links `def`, then runs `thinks` think steps of it, collecting diagnostics, faults, WHEN gates, and handles. */
function buildAndRun(environment: WendooEnvironment, def: IBrainDef, thinks = 1): RunOutcome {
  const build = environment.linkBrain(def);
  const faults: ErrorValue[] = [];
  const gates: Map<number, boolean>[] = [];
  const handles: HandleId[] = [];
  const brain = environment.createBrain(def, {
    vmEvents: {
      onFiberFault: ({ err }) => {
        faults.push(err);
      },
      onRuleWhenGate: ({ ruleFuncId, fired }) => {
        if (ruleFuncId !== undefined) gates[gates.length - 1].set(ruleFuncId, fired);
      },
      onHostActionDispatch: ({ handleId }) => {
        if (handleId !== undefined) handles.push(handleId);
      },
    },
  });
  brain.startup();
  for (let i = 0; i < thinks; i++) {
    gates.push(new Map());
    brain.think(16 * (i + 1));
  }
  const errors = build.diagnostics
    .toArray()
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
  return { errors, faults, gates, handles, variable: (name) => brain.getVariable(name) };
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

/** Native type tags of each dispatch's received values. */
function tags(dispatches: Received[]): Value["t"][][] {
  return dispatches.map((args) => args.map((v) => v.t));
}

describe("an actuator whose placed anonymous value evaluates to nothing does not run", () => {
  test("a never-assigned struct variable gates the actuator off", () => {
    const { environment, brainDef, rule, fixture } = newBrain();
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.do(), fixture.mark, target);

    const outcome = buildAndRun(environment, brainDef, 2);

    assertRanClean(outcome);
    assert.deepEqual(fixture.received(Keys.mark), []);
  });

  test("the same variable, assigned, runs the actuator with its value", () => {
    const { environment, brainDef, rule, fixture, assign } = newBrain();
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.do(), target, assign, fixture.pos);
    const child = rule.appendNewRule()!;
    append(child.do(), fixture.mark, target);

    const outcome = buildAndRun(environment, brainDef, 2);

    assertRanClean(outcome);
    assert.deepEqual(tags(fixture.received(Keys.mark)), [[NativeType.Struct], [NativeType.Struct]]);
  });

  test("a number read through a nil accessor chain gates the actuator off", () => {
    const { environment, brainDef, rule, fixture, posX } = newBrain();
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.do(), fixture.record, target, posX);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(fixture.received(Keys.record), []);
  });

  test("a void struct, a nil boolean, and a nil string each gate their actuator off", () => {
    const { environment, brainDef, page, rule, fixture } = newBrain();

    append(rule.do(), fixture.mark, fixture.voidPos);
    append(page.appendNewRule()!.do(), fixture.flag, fixture.noFlag);
    append(page.appendNewRule()!.do(), fixture.text, fixture.noText);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(fixture.received(Keys.mark), []);
    assert.deepEqual(fixture.received(Keys.flag), []);
    assert.deepEqual(fixture.received(Keys.text), []);
  });
});

describe("one placed anonymous value evaluating to nothing gates the whole call", () => {
  test("a nil first argument gates the call and no later argument evaluates", () => {
    const { environment, brainDef, rule, fixture } = newBrain();
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.do(), fixture.pair, target, fixture.five);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(fixture.received(Keys.pair), []);
    assert.equal(fixture.fiveCalls(), 0, "the argument after the nil one never evaluated");
  });

  test("a nil second argument gates the call after the first evaluated", () => {
    const { environment, brainDef, rule, fixture, posX } = newBrain();
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.do(), fixture.pair, fixture.pos, target, posX);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(fixture.received(Keys.pair), []);
  });

  test("every argument present runs the call once with both values", () => {
    const { environment, brainDef, rule, fixture } = newBrain();

    append(rule.do(), fixture.pair, fixture.pos, fixture.five);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(tags(fixture.received(Keys.pair)), [[NativeType.Struct, NativeType.Number]]);
  });

  test("one nil element of a repeated slot gates the call", () => {
    const authoring = newBrain();
    const { environment, brainDef, page, rule, fixture, posX } = authoring;
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.do(), fixture.gather, fixture.five, target, posX, literal(authoring, CoreTypeIds.Number, 2));
    append(page.appendNewRule()!.do(), fixture.gather, fixture.five, literal(authoring, CoreTypeIds.Number, 2));

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    const gathered = fixture.received(Keys.gather);
    assert.equal(gathered.length, 1, "only the call with every element present ran");
    assert.equal(gathered[0][0].t, NativeType.List);
  });
});

describe("a sensor whose placed anonymous value evaluates to nothing reads nil", () => {
  test("a nil filter gates the sensor off and its rule does not fire, without a fault", () => {
    const authoring = newBrain();
    const { environment, brainDef, rule, fixture } = authoring;
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.when(), fixture.probe, target);
    append(rule.do(), fixture.record, literal(authoring, CoreTypeIds.Number, 1));

    const outcome = buildAndRun(environment, brainDef, 2);

    assertRanClean(outcome);
    assert.deepEqual(
      outcome.gates.map((gates) => [...gates.values()]),
      [[false], [false]]
    );
    assert.deepEqual(fixture.received(Keys.probe), [], "the sensor never ran");
    assert.deepEqual(fixture.received(Keys.record), [], "the rule never fired");
  });

  test("an assigned filter runs the sensor and its rule fires", () => {
    const authoring = newBrain();
    const { environment, brainDef, rule, fixture, assign } = authoring;
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.do(), target, assign, fixture.pos);
    const child = rule.appendNewRule()!;
    append(child.when(), fixture.probe, target);
    append(child.do(), fixture.record, literal(authoring, CoreTypeIds.Number, 1));

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.equal(fixture.received(Keys.probe).length, 1);
    assert.equal(fixture.received(Keys.record).length, 1);
  });

  test("a gated sensor writes none of its outputs: they hold the value its last run wrote, or nil before any run", () => {
    const { environment, brainDef, page, rule, fixture, assign, or, open, close, posX } = newBrain();
    const count = variable(brainDef, "count", CoreTypeIds.Number);
    const target = variable(brainDef, "target", kPosTypeId);
    const seen = variable(brainDef, "seen", CoreTypeIds.Number);
    const never = variable(brainDef, "never", CoreTypeIds.Number);

    // Think 1 scans with count 0 and writes runs = 1; the second rule then sets count to nil.
    append(rule.when(), open, fixture.scan, count, close, or, fixture.five);
    append(rule.do(), seen, assign, fixture.runs);
    append(page.appendNewRule()!.do(), count, assign, target, posX);
    // A scan that is gated on every think, read in its own rule.
    const unrun = page.appendNewRule()!;
    append(unrun.when(), open, fixture.scan, target, posX, close, or, fixture.five);
    append(unrun.do(), never, assign, fixture.runs);

    const outcome = buildAndRun(environment, brainDef, 3);

    assertRanClean(outcome);
    assert.deepEqual(tags(fixture.received(Keys.scan)), [[NativeType.Number]], "only think 1's scan ran");
    assert.deepEqual(outcome.variable("seen"), mkNumberValue(1), "think 3 still reads think 1's output");
    assert.equal(outcome.variable("never")?.t, NativeType.Nil, "an output never written reads nil");
  });
});

describe("the core timer's delay slot", () => {
  /** Runs a brain whose one rule is `WHEN [timeout] <delay> DO [record 1]` for 80 thinks 16 ms apart. */
  function runTimer(placeDelay: boolean): { outcome: RunOutcome; fixture: Fixture } {
    const authoring = newBrain();
    const { environment, brainDef, rule, fixture, posX } = authoring;
    const timer = environment.brainServices.edit.tiles.get(mkSensorTileId(CoreHostActions.Timeout.key))!;
    const target = variable(brainDef, "target", kPosTypeId);

    append(rule.when(), timer);
    if (placeDelay) {
      append(rule.when(), target, posX);
    }
    append(rule.do(), fixture.record, literal(authoring, CoreTypeIds.Number, 1));
    return { outcome: buildAndRun(environment, brainDef, 80), fixture };
  }

  test("a placed delay evaluating to nothing keeps its rule from ever firing", () => {
    const { outcome, fixture } = runTimer(true);

    assertRanClean(outcome);
    assert.ok(
      outcome.gates.every((gates) => [...gates.values()].every((fired) => !fired)),
      "the rule never fired"
    );
    assert.deepEqual(fixture.received(Keys.record), []);
  });

  test("an empty delay slot runs the default one-second delay", () => {
    const { outcome, fixture } = runTimer(false);

    assertRanClean(outcome);
    assert.equal(fixture.received(Keys.record).length, 1, "the rule fired once in 1.28 seconds");
  });
});

describe("a present falsy value is a value and does not gate", () => {
  test("0, false, the empty string, and not-a-number each run their actuator", () => {
    const { environment, brainDef, page, rule, fixture } = newBrain();
    const zero = variable(brainDef, "zero", CoreTypeIds.Number);
    const off = variable(brainDef, "off", CoreTypeIds.Boolean);
    const empty = variable(brainDef, "empty", CoreTypeIds.String);

    append(rule.do(), fixture.record, zero);
    append(page.appendNewRule()!.do(), fixture.flag, off);
    append(page.appendNewRule()!.do(), fixture.text, empty);
    append(page.appendNewRule()!.do(), fixture.record, fixture.notANumber);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    const recorded = fixture.received(Keys.record);
    assert.equal(recorded.length, 2);
    assert.deepEqual(recorded[0], [mkNumberValue(0)]);
    assert.ok(recorded[1][0].t === NativeType.Number && Number.isNaN(recorded[1][0].v), "not-a-number arrives");
    assert.deepEqual(fixture.received(Keys.flag).length, 1);
    assert.equal(fixture.received(Keys.flag)[0][0].t, NativeType.Boolean);
    assert.deepEqual(fixture.received(Keys.text).length, 1);
    assert.equal(fixture.received(Keys.text)[0][0].t, NativeType.String);
  });
});

describe("an empty anonymous slot gates nothing", () => {
  test("a bare actuator runs, its empty slot arriving as nil", () => {
    const { environment, brainDef, rule, fixture } = newBrain();

    append(rule.do(), fixture.mark);

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(tags(fixture.received(Keys.mark)), [[NativeType.Nil]]);
  });

  test("a placed literal is never tested: the nil literal arrives as nil, as an empty slot does", () => {
    const authoring = newBrain();
    const { environment, brainDef, rule, fixture } = authoring;

    append(rule.do(), fixture.mark, literal(authoring, CoreTypeIds.Nil, undefined));

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(tags(fixture.received(Keys.mark)), [[NativeType.Nil]]);
  });

  test("a bare sensor runs and its rule fires", () => {
    const authoring = newBrain();
    const { environment, brainDef, rule, fixture } = authoring;

    append(rule.when(), fixture.probe);
    append(rule.do(), fixture.record, literal(authoring, CoreTypeIds.Number, 1));

    const outcome = buildAndRun(environment, brainDef);

    assertRanClean(outcome);
    assert.deepEqual(tags(fixture.received(Keys.probe)), [[NativeType.Nil]]);
    assert.equal(fixture.received(Keys.record).length, 1);
  });
});

describe("a gated asynchronous call allocates no handle", () => {
  test("gated thinks dispatch nothing, and the first present call takes the handle an ungated run takes first", () => {
    const authoring = newBrain();
    const { environment, brainDef, page, rule, fixture, assign, posX } = authoring;
    const tiles = environment.brainServices.edit.tiles;
    const target = variable(brainDef, "target", kPosTypeId);
    const tick = variable(brainDef, "tick", CoreTypeIds.Number);

    // Thinks 1..6 defer a nil number: the counter assigns the target on think 6, after the defer.
    append(rule.do(), fixture.defer, target, posX);
    append(
      page.appendNewRule()!.do(),
      tick,
      assign,
      tick,
      tiles.get(mkOperatorTileId(CoreOpId.Add))!,
      literal(authoring, CoreTypeIds.Number, 1)
    );
    const arm = page.appendNewRule()!;
    append(
      arm.when(),
      tick,
      tiles.get(mkOperatorTileId(CoreOpId.GreaterThanOrEqualTo))!,
      literal(authoring, CoreTypeIds.Number, 6)
    );
    append(arm.do(), target, assign, fixture.pos);
    const gated = buildAndRun(environment, brainDef, 8);

    const control = newBrain();
    append(control.rule.do(), control.fixture.defer, control.fixture.five);
    const ungated = buildAndRun(control.environment, control.brainDef, 1);

    assertRanClean(gated);
    assertRanClean(ungated);
    assert.equal(fixture.received(Keys.defer).length, 2, "only the two thinks after the assignment dispatched");
    assert.equal(gated.handles.length, 2);
    assert.equal(gated.handles[0], ungated.handles[0], "no gated think allocated a handle");
  });
});
