/**
 * A field write through a held `ActorRef`'s `position` reaches the actor: the
 * type's field getter hands out a fresh `Vector2` snapshot, the write lands in
 * that snapshot, and the compiled assignment writes the snapshot back through
 * the type's field setter, which moves the actor's sprite. These tests run a
 * compiled brain on the VM in an environment carrying the ecosim module, with
 * the held value written straight into the brain's variable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { coreModule, createWendooEnvironment } from "@wendoo/core";
import { mkAccessorTileId, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileLiteralDef, BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import { CoreOpId, CoreTypeIds, type ErrorValue } from "@wendoo/core/runtime";
import type { Actor } from "./actor";
import { createEcosimModule } from "./index";
import { EcosimTypeIds, mkActorRefDirect } from "./type-system";

/** A live actor whose sprite sits at (12, 34) and records every position it is set to. */
function movableActor(): { actor: Actor; sprite: { x: number; y: number; moves: number } } {
  const sprite = {
    x: 12,
    y: 34,
    rotation: 0,
    moves: 0,
    setPosition(x: number, y: number): void {
      sprite.x = x;
      sprite.y = y;
      sprite.moves++;
    },
  };
  return { actor: { actorId: 3, isDying: false, sprite } as unknown as Actor, sprite };
}

test("a write to a held actor's position x moves the actor and keeps its y", () => {
  const environment = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Write Back Brain");
  const rule = (brainDef.pages().get(0) as BrainPageDef).children().get(0) as BrainRuleDef;
  const held = new BrainTileVariableDef("variable:writeback.held", "held", EcosimTypeIds.ActorRef, "writeback.held");
  brainDef.catalog().registerTileDef(held);
  const five = new BrainTileLiteralDef(CoreTypeIds.Number, 5, {}, environment.brainServices);
  brainDef.catalog().registerTileDef(five);
  for (const tile of [
    held,
    tiles.get(mkAccessorTileId(EcosimTypeIds.ActorRef, "position"))!,
    tiles.get(mkAccessorTileId(EcosimTypeIds.Vector2, "x"))!,
    tiles.get(mkOperatorTileId(CoreOpId.Assign))!,
    five,
  ]) {
    __test__appendTile(rule.do(), tile);
  }

  const faults: ErrorValue[] = [];
  const brain = environment.createBrain(brainDef, {
    vmEvents: {
      onFiberFault: ({ err }) => {
        faults.push(err);
      },
    },
  });
  const { actor, sprite } = movableActor();
  brain.startup();
  brain.setVariable("held", mkActorRefDirect(actor));
  brain.think(16);

  assert.deepEqual(faults, []);
  assert.deepEqual({ x: sprite.x, y: sprite.y, moves: sprite.moves }, { x: 5, y: 34, moves: 1 });
});
