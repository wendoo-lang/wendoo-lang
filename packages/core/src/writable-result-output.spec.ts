import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { coreModule, createHostSensor, createWendooEnvironment, List, type WendooModule } from "@wendoo/core";
import { buildDescriptorOutputTiles, setSensorOutput } from "@wendoo/core/app";
import { type BrainServices, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import { BrainDef } from "@wendoo/core/brain/model";
import {
  BrainTileAccessorDef,
  BrainTileLiteralDef,
  BrainTileOutputDef,
  type BrainTileSensorDef,
} from "@wendoo/core/brain/tiles";
import {
  CoreOpId,
  CoreTypeIds,
  mkCallDef,
  mkNativeStructValue,
  mkNumberValue,
  mkTypeId,
  NativeType,
  type NumberValue,
  TRUE_VALUE,
} from "@wendoo/core/runtime";

/** Host-owned state a native "actor" struct reads from and writes to by reference. */
interface ActorState {
  health: number;
}

/** The tiles a rule reaches the located actor through. */
interface LocatorTiles {
  locateTile?: BrainTileSensorDef;
  foundTile?: BrainTileOutputDef;
  seenTile?: BrainTileOutputDef;
  healthAccessor?: BrainTileAccessorDef;
}

/**
 * Register a native reference "Actor" struct (a `fieldSetter`-backed live
 * reference) and a `locate` sensor that writes the same live actor to two
 * outputs on every run: `found`, declared `writableResult`, and `seen`, not.
 */
function createLocatorModule(host: ActorState): { module: WendooModule; captured: LocatorTiles } {
  const captured: LocatorTiles = {};

  const module: WendooModule = {
    id: "locator-module",
    install(api): void {
      const numTypeId = mkTypeId(NativeType.Number, "number");
      const actorTypeId = api.brainServices.runtime.types.addStructType("LocatedActor", {
        atomId: 40110,
        fields: List.from([{ name: "health", typeId: numTypeId, fieldIndex: 0 }]),
        fieldGetter: (source, fieldId) =>
          fieldId === 0 ? mkNumberValue((source.native as ActorState).health) : undefined,
        fieldSetter: (source, fieldId, val) => {
          if (fieldId === 0) {
            (source.native as ActorState).health = (val as NumberValue).v;
            return true;
          }
          return false;
        },
      });

      const healthAccessor = new BrainTileAccessorDef(actorTypeId, "health", CoreTypeIds.Number, {
        metadata: { label: "health" },
      });
      api.registerTile(healthAccessor);
      captured.healthAccessor = healthAccessor;

      const locate = createHostSensor({
        key: "locator.locate",
        actionId: 40311,
        fnId: 40211,
        isAsync: false,
        callDef: mkCallDef({ type: "bag", items: [] }),
        outputType: CoreTypeIds.Boolean,
        outputs: [
          { name: "found", type: actorTypeId, writableResult: true },
          { name: "seen", type: actorTypeId },
        ],
        fn: {
          exec: (ctx) => {
            setSensorOutput(ctx, actorTypeId, "found", mkNativeStructValue(actorTypeId, host));
            setSensorOutput(ctx, actorTypeId, "seen", mkNativeStructValue(actorTypeId, host));
            return TRUE_VALUE;
          },
        },
      });
      api.registerHostSensor(locate);
      captured.locateTile = locate.tile as BrainTileSensorDef;

      const [foundTile, seenTile] = buildDescriptorOutputTiles(locate.descriptor.outputs!);
      api.registerTile(foundTile);
      api.registerTile(seenTile);
      captured.foundTile = foundTile;
      captured.seenTile = seenTile;
    },
  };

  return { module, captured };
}

function getEnvironmentServices(environment: { brainServices?: BrainServices }): BrainServices {
  return (environment as unknown as { brainServices: BrainServices }).brainServices;
}

describe("output tile `writableResult` forwarding", () => {
  test("an output tile defaults to a read-only value", () => {
    assert.equal(new BrainTileOutputDef(CoreTypeIds.Number, "reading").writableResult, false);
  });

  test("buildDescriptorOutputTiles forwards each output's writableResult to its tile", () => {
    const [flagged, unflagged] = buildDescriptorOutputTiles([
      { name: "flagged", type: CoreTypeIds.Number, writableResult: true },
      { name: "unflagged", type: CoreTypeIds.Number },
    ]);
    assert.equal(flagged.writableResult, true);
    assert.equal(unflagged.writableResult, false);
  });
});

describe("writableResult output field write (headless, native reference struct)", () => {
  function setup(host: ActorState) {
    const { module, captured } = createLocatorModule(host);
    const environment = createWendooEnvironment({ modules: [coreModule(), module] });
    const services = getEnvironmentServices(environment);
    return { environment, services, captured };
  }

  // WHEN: [locate]  DO: [output] [health] [=] [42]
  function appendOutputAssignRule(
    brainDef: BrainDef,
    services: BrainServices,
    captured: LocatorTiles,
    outputTile: BrainTileOutputDef
  ): void {
    const rule = brainDef.pages().get(0)!.children().get(0)!;
    __test__appendTile(rule.when(), captured.locateTile!);
    __test__appendTile(rule.do(), outputTile);
    __test__appendTile(rule.do(), captured.healthAccessor!);
    __test__appendTile(rule.do(), services.edit.tiles.get(mkOperatorTileId(CoreOpId.Assign))!);
    __test__appendTile(rule.do(), new BrainTileLiteralDef(CoreTypeIds.Number, 42, {}, services));
  }

  test("green: a field write through a writableResult output mutates the live value end to end", () => {
    const host: ActorState = { health: 100 };
    const { environment, services, captured } = setup(host);
    const brainDef = BrainDef.emptyBrainDef(services, "Found Actor Brain");
    appendOutputAssignRule(brainDef, services, captured, captured.foundTile!);

    const brain = environment.createBrain(brainDef);
    assert.equal(brain.status, "active", "the brain must build");
    brain.startup();
    brain.think(1);

    assert.equal(host.health, 42, "the field write must mutate the live actor state");
  });

  test("red: the same field write through a read-only output is rejected and mutates nothing", () => {
    const host: ActorState = { health: 100 };
    const { environment, services, captured } = setup(host);
    const brainDef = BrainDef.emptyBrainDef(services, "Seen Actor Brain");
    appendOutputAssignRule(brainDef, services, captured, captured.seenTile!);

    // The assignment is rejected during rule compilation (an ErrorExpr), so the
    // brain drops that action and the live actor state is never written.
    const brain = environment.createBrain(brainDef);
    brain.startup();
    brain.think(1);

    assert.equal(host.health, 100, "a read-only output must not be mutated by the rejected field write");
  });
});
