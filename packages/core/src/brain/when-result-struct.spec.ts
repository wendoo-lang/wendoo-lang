/**
 * Behavioral test for a struct-valued WHEN result. A rule whose WHEN section
 * evaluates to a struct captures that container into the reserved
 * `__whenResult` rule variable at `WHEN_END`, and a `HOST_CALL` to
 * `Context.getWhenResult` (`CoreFuncId.ContextGetWhenResult`) inside the
 * rule's DO reads the same container back.
 *
 * The test builds a real BrainDef through the tile API, links it, and runs it
 * on a `BrainRuntime`. The reader is a bytecode-backed actuator whose body is
 * the `HOST_CALL` itself, so the read goes through the VM's host-call
 * dispatch of function id 101, not through a host-side service call.
 */

import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { createHostSensor, Dict, type HostSensorDefinition, List, type ReadonlyList } from "@wendoo/core";
import type { BrainServices } from "@wendoo/core/brain";
import { type ITileCatalog, TilePlacement } from "@wendoo/core/brain";
import { __test__appendTile, __test__createBrainServices } from "@wendoo/core/brain/__test__";
import { runBrainLinkPipeline } from "@wendoo/core/brain/compiler";
import { BrainDef, type BrainPageDef, type BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainTileActuatorDef, BrainTileSensorDef } from "@wendoo/core/brain/tiles";
import {
  type ActionDescriptor,
  BrainRuntime,
  BYTECODE_VERSION,
  CoreFuncId,
  CoreTypeIds,
  type ExecutionContext,
  type HostActionBinding,
  type HostActionReturnEvent,
  mkCallDef,
  mkClosedStructValueByName,
  mkNumberValue,
  NIL_VALUE,
  Op,
  type ProgramArtifact,
  type StructTypeDef,
  type TypeId,
  type Value,
  type VmEvents,
} from "@wendoo/core/runtime";

let services: BrainServices;
let pointTypeId: TypeId;

/** Type-atom id of the test struct type; target-owned, so at or above 1024. */
const POINT_ATOM_ID = 2201;

/** Field values the sensor's struct reading carries. */
const READING = { x: 1.5, y: 2.25 } as const;

before(() => {
  services = __test__createBrainServices();
  pointTypeId = services.runtime.types.addStructType("ProbeWhenPoint", {
    atomId: POINT_ATOM_ID,
    fields: List.from([
      { name: "x", typeId: CoreTypeIds.Number, fieldIndex: 0 },
      { name: "y", typeId: CoreTypeIds.Number, fieldIndex: 1 },
    ]),
  });
});

/** The struct reading the sensor returns, freshly built. */
function mkReading(): Value {
  const typeDef = services.runtime.types.get(pointTypeId) as StructTypeDef;
  return mkClosedStructValueByName(
    typeDef,
    new Dict<string, Value>([
      ["x", mkNumberValue(READING.x)],
      ["y", mkNumberValue(READING.y)],
    ])
  );
}

/** Synchronous action body shape, for narrowing a definition's untyped `actionFn`. */
type SyncActionFn = { exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => Value };

/** Registers a WHEN-side sensor whose reading is the struct value. */
function makeStructSensor(): BrainTileSensorDef {
  const def: HostSensorDefinition = createHostSensor({
    key: "when-result-struct-sensor",
    actionId: 7900,
    fnId: 8900,
    callDef: mkCallDef({ type: "bag", items: [] }),
    outputType: pointTypeId,
    fn: { exec: () => mkReading() },
  });
  const fn = def.function;
  services.runtime.functions.register(fn.id, fn.name, fn.isAsync, fn.fn, fn.callDef);
  const binding: HostActionBinding = { binding: "host", descriptor: def.descriptor, id: def.actionId };
  binding.execSync = (def.actionFn as SyncActionFn).exec;
  services.runtime.actions.register(binding);
  const tile = new BrainTileSensorDef(def.descriptor.key, def.descriptor, {
    placement: TilePlacement.WhenSide | TilePlacement.Inline,
  });
  services.edit.tiles.registerTileDef(tile);
  return tile;
}

/**
 * Registers a bytecode-backed actuator whose body is one `HOST_CALL` to
 * `Context.getWhenResult` followed by `RET`, so the action's returned value is
 * whatever function id 101 reads.
 */
function makeWhenResultReader(): BrainTileActuatorDef {
  const key = "when-result-struct-reader";
  const callDef = mkCallDef({ type: "bag", items: [] });
  const descriptor: ActionDescriptor = { key, kind: "actuator", callDef, isAsync: false };
  const artifact: ProgramArtifact = {
    version: BYTECODE_VERSION,
    functions: List.from([
      {
        code: List.from([{ op: Op.HOST_CALL, a: CoreFuncId.ContextGetWhenResult, b: 0, c: 0 }, { op: Op.RET }]),
        numParams: 0,
        name: "when-result-reader",
      },
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

describe("a struct-valued WHEN result read back through Context.getWhenResult", () => {
  test("the captured __whenResult carries the container and fn 101 returns it", () => {
    const brainDef = BrainDef.emptyBrainDef(services);
    const page = brainDef.pages().get(0)! as BrainPageDef;
    const rule = page.children().get(0)! as BrainRuleDef;
    __test__appendTile(rule.when(), makeStructSensor());
    __test__appendTile(rule.do(), makeWhenResultReader());

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

    const readerReturns: Value[] = [];
    const events: VmEvents = {
      onHostActionReturn: (payload: HostActionReturnEvent) => {
        if (payload.binding === "bytecode" && payload.result !== undefined) {
          readerReturns.push(payload.result);
        }
      },
    };
    const runtime = new BrainRuntime(
      result.program.program,
      result.program.pages,
      { runtime: services.runtime, shared: services.shared, app: services.app },
      undefined,
      undefined,
      events
    );
    runtime.startup();
    runtime.think(16);

    assert.deepEqual(readerReturns, [mkReading()], "fn 101 returns the struct container the WHEN captured");
  });
});
