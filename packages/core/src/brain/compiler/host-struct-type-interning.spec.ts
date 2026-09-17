/**
 * Compiler interning of struct types that host actions produce at runtime.
 *
 * A host action with a struct-typed output constructs struct values the
 * program's bytecode never names: no instruction operand references the type,
 * so without interning the program would ship an empty type table and a VM
 * that resolves struct types through the table could not handle the value.
 * The compiler interns such a type through two channels -- the
 * action-dispatch site (the action's declared `outputType` and each declared
 * output's type, read or not) and the output value-tile site (the output's
 * declared type) -- and pins the interned index as an explicit tree-shaker
 * root so the entry survives the dead-code sweep.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import {
  createHostActuator,
  createHostSensor,
  type HostActuatorDefinition,
  type HostSensorDefinition,
  List,
  type ReadonlyList,
} from "@wendoo/core";
import type { BrainServices } from "@wendoo/core/brain";
import { type ITileCatalog, TilePlacement } from "@wendoo/core/brain";
import { __test__appendTile, __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { runBrainLinkPipeline } from "@wendoo/core/brain/compiler";
import { BrainDef, type BrainPageDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainTileActuatorDef, BrainTileOutputDef, BrainTileSensorDef } from "@wendoo/core/brain/tiles";
import {
  type ActionDescriptor,
  BYTECODE_VERSION,
  CoreTypeIds,
  type ExecutionContext,
  type HostActionBinding,
  mkCallDef,
  NIL_VALUE,
  Op,
  type ProgramArtifact,
  type ProgramTypeEntry,
  type TypeId,
  type Value,
  VOID_VALUE,
} from "@wendoo/core/runtime";

let services: BrainServices;
let poseTypeId: TypeId;
let nullablePoseTypeId: TypeId;

/** Type-atom id of the test struct type; target-owned, so at or above 1024. */
const POSE_ATOM_ID = 2101;

/** Distinguishes the host ids each test registers; ids must be unique per registry. */
let hostIdCounter = 0;

before(() => {
  services = __test__createBrainServices();
  poseTypeId = services.runtime.types.addStructType("ProbePose", {
    atomId: POSE_ATOM_ID,
    fields: List.from([
      { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 },
      { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
    ]),
  });
  nullablePoseTypeId = services.runtime.types.addNullableType(poseTypeId);
});

/** Synchronous action body shape, for narrowing a definition's untyped `actionFn`. */
type SyncActionFn = { exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => Value };

/** Registers one host definition's function and action on the test services. */
function registerHost(def: HostSensorDefinition | HostActuatorDefinition): void {
  const fn = def.function;
  services.runtime.functions.register(fn.id, fn.name, fn.isAsync, fn.fn, fn.callDef);
  const binding: HostActionBinding = { binding: "host", descriptor: def.descriptor, id: def.actionId };
  binding.execSync = (def.actionFn as SyncActionFn).exec;
  services.runtime.actions.register(binding);
}

/** Registers a WHEN-side sensor returning `outputType`; no declared named outputs. */
function makeSensor(outputType: TypeId): BrainTileSensorDef {
  hostIdCounter += 1;
  const def = createHostSensor({
    key: `struct-intern-sensor-${hostIdCounter}`,
    actionId: 7700 + hostIdCounter,
    fnId: 8700 + hostIdCounter,
    callDef: mkCallDef({ type: "bag", items: [] }),
    outputType,
    fn: { exec: () => NIL_VALUE },
  });
  registerHost(def);
  const tile = new BrainTileSensorDef(def.descriptor.key, def.descriptor, {
    placement: TilePlacement.WhenSide | TilePlacement.Inline,
  });
  services.edit.tiles.registerTileDef(tile);
  return tile;
}

/** Registers a boolean WHEN-side sensor declaring one named output of `outputType`, and that output's value-tile. */
function makeOutputProvider(outputType: TypeId): { sensor: BrainTileSensorDef; output: BrainTileOutputDef } {
  hostIdCounter += 1;
  const output = new BrainTileOutputDef(outputType, `pose-${hostIdCounter}`);
  const def = createHostSensor({
    key: `struct-intern-provider-${hostIdCounter}`,
    actionId: 7700 + hostIdCounter,
    fnId: 8700 + hostIdCounter,
    callDef: mkCallDef({ type: "bag", items: [] }),
    outputType: CoreTypeIds.Boolean,
    outputs: [{ name: `pose-${hostIdCounter}`, type: outputType }],
    fn: { exec: () => NIL_VALUE },
  });
  registerHost(def);
  const sensor = new BrainTileSensorDef(def.descriptor.key, def.descriptor, {
    placement: TilePlacement.WhenSide | TilePlacement.Inline,
  });
  services.edit.tiles.registerTileDef(sensor);
  return { sensor, output };
}

/** Registers a no-op DO-side actuator with no declared output type. */
function makeActuator(): BrainTileActuatorDef {
  hostIdCounter += 1;
  const def = createHostActuator({
    key: `struct-intern-actuator-${hostIdCounter}`,
    actionId: 7700 + hostIdCounter,
    fnId: 8700 + hostIdCounter,
    callDef: mkCallDef({ type: "bag", items: [] }),
    fn: { exec: () => VOID_VALUE },
  });
  registerHost(def);
  return def.tile as BrainTileActuatorDef;
}

/**
 * Registers a bytecode-backed actuator whose artifact carries one function no
 * code reaches, so the linked program has dead code and the tree-shaker sweep
 * runs.
 */
function makeDeadCodeActuator(): BrainTileActuatorDef {
  hostIdCounter += 1;
  const key = `struct-intern-bytecode-actuator-${hostIdCounter}`;
  const callDef = mkCallDef({ type: "bag", items: [] });
  const descriptor: ActionDescriptor = { key, kind: "actuator", callDef, isAsync: false };
  const returnNil = () => List.from([{ op: Op.PUSH_CONST_VAL, a: 0 }, { op: Op.RET }]);
  const artifact: ProgramArtifact = {
    version: BYTECODE_VERSION,
    functions: List.from([
      { code: returnNil(), numParams: 0, name: "artifact-entry" },
      { code: returnNil(), numParams: 0, name: "artifact-dead-helper" },
    ]),
    constantPools: {
      numbers: List.empty<number>(),
      strings: List.empty<string>(),
      values: List.from<Value>([NIL_VALUE]),
    },
    variableNames: List.empty<string>(),
    entryFuncId: 0,
    numStateSlots: 0,
    isAsync: false,
    revisionId: "test",
  };
  services.runtime.actions.register({
    binding: "bytecode",
    descriptor,
    artifact,
    metadata: { key, kind: "actuator", callDef },
  });
  return new BrainTileActuatorDef(key, descriptor);
}

/** A one-page brain, its page, and the page's default rule. */
function newBrain(): { brainDef: BrainDef; page: BrainPageDef; rule: BrainRuleDef } {
  const brainDef = BrainDef.emptyBrainDef(services);
  const page = brainDef.pages().get(0)! as BrainPageDef;
  return { brainDef, page, rule: page.children().get(0)! as BrainRuleDef };
}

/** Compiles, links, and treeshakes `brainDef`, returning the final type table and function names. */
function linkBrain(brainDef: BrainDef): { types: List<ProgramTypeEntry>; functionNames: string[] } {
  const result = runBrainLinkPipeline(
    brainDef,
    {
      catalogs: List.from<ITileCatalog>([services.edit.tiles, brainDef.catalog()]),
      actionResolver: services.runtime.actions,
      typeRegistry: services.runtime.types,
    },
    services.shared.conversions
  );
  assert.ok(result.program, "the brain must compile and link");
  const program = result.program.program;
  const functionNames: string[] = [];
  for (let i = 0; i < program.functions.size(); i++) {
    functionNames.push(program.functions.get(i)!.name ?? `<func#${i}>`);
  }
  return { types: program.types ?? List.empty<ProgramTypeEntry>(), functionNames };
}

/** Asserts `types` is exactly the one atom entry for the test struct type. */
function assertPoseAtomTable(types: List<ProgramTypeEntry>): void {
  assert.equal(types.size(), 1, "the type table carries exactly the struct entry");
  const entry = types.get(0)!;
  assert.equal(entry.tag, "atom");
  assert.equal(entry.typeId, poseTypeId);
  assert.equal((entry as { atomId: number }).atomId, POSE_ATOM_ID);
}

describe("host struct output types intern into the program type table", () => {
  test("a struct-returning sensor's dispatch interns exactly the one atom entry", () => {
    const { brainDef, rule } = newBrain();
    __test__appendTile(rule.when(), makeSensor(poseTypeId));
    __test__appendTile(rule.do(), makeActuator());

    assertPoseAtomTable(linkBrain(brainDef).types);
  });

  test("a nullable struct output interns its base struct entry", () => {
    const { brainDef, rule } = newBrain();
    __test__appendTile(rule.when(), makeSensor(nullablePoseTypeId));
    __test__appendTile(rule.do(), makeActuator());

    assertPoseAtomTable(linkBrain(brainDef).types);
  });

  test("a struct-typed output value-tile read interns exactly the one atom entry", () => {
    const { brainDef, rule } = newBrain();
    const provider = makeOutputProvider(poseTypeId);
    __test__appendTile(rule.when(), provider.sensor);
    __test__appendTile(rule.do(), provider.output);

    assertPoseAtomTable(linkBrain(brainDef).types);
  });

  test("dispatch and output reads of the same struct type share one entry", () => {
    const { brainDef, page, rule } = newBrain();
    __test__appendTile(rule.when(), makeSensor(poseTypeId));
    __test__appendTile(rule.do(), makeActuator());
    const provider = makeOutputProvider(poseTypeId);
    const outputRule = page.appendNewRule() as BrainRuleDef;
    __test__appendTile(outputRule.when(), provider.sensor);
    __test__appendTile(outputRule.do(), provider.output);

    assertPoseAtomTable(linkBrain(brainDef).types);
  });

  test("a declared struct output no tile reads interns exactly the one atom entry", () => {
    const { brainDef, rule } = newBrain();
    const provider = makeOutputProvider(poseTypeId);
    __test__appendTile(rule.when(), provider.sensor);
    __test__appendTile(rule.do(), makeActuator());

    assertPoseAtomTable(linkBrain(brainDef).types);
  });

  test("the unread-output entry survives the dead-code sweep", () => {
    const { brainDef, page, rule } = newBrain();
    const provider = makeOutputProvider(poseTypeId);
    __test__appendTile(rule.when(), provider.sensor);
    __test__appendTile(rule.do(), makeActuator());
    const sweepRule = page.appendNewRule() as BrainRuleDef;
    __test__appendTile(sweepRule.do(), makeDeadCodeActuator());

    const { types, functionNames } = linkBrain(brainDef);
    assert.ok(functionNames.indexOf("artifact-dead-helper") === -1, "the sweep removed the artifact's dead function");
    assertPoseAtomTable(types);
  });

  test("the dispatch-channel entry survives the dead-code sweep", () => {
    const { brainDef, rule } = newBrain();
    __test__appendTile(rule.when(), makeSensor(poseTypeId));
    __test__appendTile(rule.do(), makeDeadCodeActuator());

    const { types, functionNames } = linkBrain(brainDef);
    assert.ok(functionNames.indexOf("artifact-entry") !== -1, "the artifact entry function is linked in");
    assert.ok(functionNames.indexOf("artifact-dead-helper") === -1, "the sweep removed the artifact's dead function");
    assertPoseAtomTable(types);
  });

  test("the output-channel entry survives the dead-code sweep", () => {
    const { brainDef, page, rule } = newBrain();
    const provider = makeOutputProvider(poseTypeId);
    __test__appendTile(rule.when(), provider.sensor);
    __test__appendTile(rule.do(), provider.output);
    const sweepRule = page.appendNewRule() as BrainRuleDef;
    __test__appendTile(sweepRule.do(), makeDeadCodeActuator());

    const { types, functionNames } = linkBrain(brainDef);
    assert.ok(functionNames.indexOf("artifact-dead-helper") === -1, "the sweep removed the artifact's dead function");
    assertPoseAtomTable(types);
  });

  test("a brain with no struct-typed host output compiles to an empty type table", () => {
    const { brainDef, rule } = newBrain();
    __test__appendTile(rule.when(), makeSensor(CoreTypeIds.Boolean));
    __test__appendTile(rule.do(), makeActuator());

    assert.equal(linkBrain(brainDef).types.size(), 0);
  });
});
