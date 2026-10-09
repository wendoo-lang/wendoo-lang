/**
 * Starting values of ecosim's variable types: a `Vector2` variable starts at
 * `origin`, holding 0 in both `x` and `y`, each variable its own copy, so a
 * field write lands from the first think with no assignment first; an
 * `ActorRef` variable declares no starting value and holds nothing until a
 * brain stores an actor in it. These tests run compiled brains on the VM in an
 * environment carrying the ecosim module.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { coreModule, createWendooEnvironment } from "@wendoo/core";
import { mkAccessorTileId, mkLiteralTileId, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  CoreOpId,
  CoreTypeIds,
  isNumberValue,
  isStructValue,
  type StructTypeDef,
  type TypeId,
  type Value,
} from "@wendoo/core/runtime";
import { createEcosimModule } from "./index";
import { EcosimTypeIds, VECTOR2_ORIGIN_KEY } from "./type-system";

/** An environment carrying the ecosim module, and an empty single-rule brain in it. */
function newBrain() {
  const environment = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Starting Value Brain");
  const rule = (brainDef.pages().get(0) as BrainPageDef).children().get(0) as BrainRuleDef;
  const tile = (tileId: string) => {
    const found = environment.brainServices.edit.tiles.get(tileId);
    assert.ok(found, `tile ${tileId} is registered`);
    return found;
  };
  const variable = (name: string, typeId: TypeId) => {
    const held = new BrainTileVariableDef(`variable:initial.${name}`, name, typeId, `initial.${name}`);
    brainDef.catalog().registerTileDef(held);
    return held;
  };
  return { environment, brainDef, rule, tile, variable };
}

/** The `x` and `y` fields of `value`, which must be a `Vector2` holding numbers there. */
function pointOf(value: Value | undefined): { x: number; y: number } {
  assert.ok(value !== undefined && isStructValue(value) && value.typeId === EcosimTypeIds.Vector2);
  const x = value.v?.at(0);
  const y = value.v?.at(1);
  assert.ok(x !== undefined && isNumberValue(x) && y !== undefined && isNumberValue(y));
  return { x: x.v, y: y.v };
}

test("the Vector2 type starts its variables at the origin literal's value", () => {
  const { environment, tile } = newBrain();
  const typeDef = environment.brainServices.runtime.types.get(EcosimTypeIds.Vector2) as StructTypeDef;
  const origin = tile(mkLiteralTileId(EcosimTypeIds.Vector2, VECTOR2_ORIGIN_KEY)) as BrainTileLiteralDef;

  assert.deepEqual(pointOf(typeDef.zero), { x: 0, y: 0 });
  assert.deepEqual(pointOf(origin.value as Value), pointOf(typeDef.zero));
});

test("a fresh Vector2 variable's x takes a write with no assignment first, its sibling untouched", () => {
  const { environment, brainDef, rule, tile, variable } = newBrain();
  const spot = variable("spot", EcosimTypeIds.Vector2);
  const other = variable("other", EcosimTypeIds.Vector2);
  const five = new BrainTileLiteralDef(CoreTypeIds.Number, 5, {}, environment.brainServices);
  for (const placed of [
    spot,
    tile(mkAccessorTileId(EcosimTypeIds.Vector2, "x")),
    tile(mkOperatorTileId(CoreOpId.Assign)),
    five,
  ]) {
    __test__appendTile(rule.do(), placed);
  }
  const touch = rule.appendNewRule()!;
  __test__appendTile(touch.when(), other);

  const brain = environment.createBrain(brainDef);
  brain.startup();
  brain.think(16);

  assert.deepEqual(pointOf(brain.getVariable("spot")), { x: 5, y: 0 });
  assert.deepEqual(pointOf(brain.getVariable("other")), { x: 0, y: 0 });
});

test("an ActorRef variable starts holding nothing", () => {
  const { environment, brainDef, rule, variable } = newBrain();
  const held = variable("held", EcosimTypeIds.ActorRef);
  __test__appendTile(rule.when(), held);

  const brain = environment.createBrain(brainDef);
  brain.startup();
  brain.think(16);

  assert.equal(environment.brainServices.runtime.types.get(EcosimTypeIds.ActorRef)?.zero, undefined);
  assert.equal(brain.getVariable("held"), undefined);
});
