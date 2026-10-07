/**
 * A rehearsal of a carnivore whose nearest sighted herbivore the engine kills
 * between two of the carnivore's vision refreshes, while a living herbivore
 * stands farther ahead. The carnivore's sight queue still holds the killed
 * herbivore on the think after the kill, and its `see herbivore` rule fires on
 * the living one.
 */

import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { createRehearsalEnvironment, createSeededRng } from "@wendoo/assistant-bridge/kit";
import type { IBrainDef, IBrainTileDef } from "@wendoo/core/app";
import {
  CoreOpId,
  logger,
  mkLiteralTileId,
  mkModifierTileId,
  mkOperatorTileId,
  mkSensorTileId,
  NIL_VALUE,
  type StructValue,
  type WendooEnvironment,
} from "@wendoo/core/app";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import { EcosimHostActions } from "@/brain/abi-ids";
import type { Actor } from "@/brain/actor";
import { Engine } from "@/brain/engine";
import { createEcosimModule } from "@/brain/index";
import { TileIds } from "@/brain/tileids";
import { EcosimTypeIds } from "@/brain/type-system";
import { sourceRehearsalContent } from "./source-content";
import { createRehearsalWorld } from "./world";

/** The app's own assets, read from the tree these specs run in. */
const CONTENT = sourceRehearsalContent();

/** Seed every run in this file stages its world from. */
const SEED = 20261007;

/** Distance in world pixels the nearer herbivore stands directly ahead of the carnivore. */
const NEAR = 100;

/** Distance in world pixels the farther herbivore stands directly ahead of the carnivore. */
const FAR = 250;

/** The brain every carnivore runs: `WHEN [see herbivore] DO [found = it]`. */
function seeingBrain(environment: WendooEnvironment): IBrainDef {
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Seeing Brain");
  const found = new BrainTileVariableDef(
    "variable:sightspec.found",
    "found",
    EcosimTypeIds.ActorRef,
    "sightspec.found"
  );
  brainDef.catalog().registerTileDef(found);
  const rule = (brainDef.pages().get(0) as BrainPageDef).children().get(0) as BrainRuleDef;
  const when: IBrainTileDef[] = [
    tiles.get(mkSensorTileId(EcosimHostActions.See.key))!,
    tiles.get(mkModifierTileId(TileIds.Modifier.ActorKindHerbivore))!,
  ];
  const act: IBrainTileDef[] = [
    found,
    tiles.get(mkOperatorTileId(CoreOpId.Assign))!,
    tiles.get(mkLiteralTileId(EcosimTypeIds.ActorRef, "it"))!,
  ];
  for (const tile of when) rule.when().appendTile(tile);
  for (const tile of act) rule.do().appendTile(tile);
  return brainDef;
}

/** What the carnivore's observed think saw. */
interface SightRun {
  /** The herbivore standing nearer. */
  readonly near: Actor;
  /** The herbivore standing farther. */
  readonly far: Actor;
  /** Whether the near herbivore was in the world when the observed think ran. */
  readonly nearPresent: boolean;
  /** Whether the carnivore's sight queue held the near herbivore when the observed think ran. */
  readonly nearSighted: boolean;
  /** Whether the `see herbivore` gate fired, for each time the observed think reached it. */
  readonly gates: readonly boolean[];
  /** The actor `found` holds after the observed think, or undefined when it holds none. */
  readonly found: Actor | undefined;
  /** Errors logged anywhere in the world from the kill through the observed think. */
  readonly errorsLogged: number;
}

/**
 * Stage the shipped world with every carnivore running {@link seeingBrain},
 * hold two herbivores directly ahead of the first carnivore -- {@link NEAR}
 * and {@link FAR} pixels away -- with every other herbivore killed, and
 * observe the carnivore's think on the step after one of its vision refreshes.
 * When `killNear` is set, the near herbivore is drained before that refresh,
 * so the refresh still sights it and the engine kills it at the end of the
 * same step.
 */
async function rehearseSighting(killNear: boolean): Promise<SightRun> {
  const next = createSeededRng(SEED);
  const environment = createRehearsalEnvironment({ modules: [createEcosimModule()], rng: next });
  const spawned: Actor[] = [];
  const world = await createRehearsalWorld({
    environment,
    next,
    observer: { onSpawn: (actor) => spawned.push(actor) },
    shippedBrains: CONTENT.shippedBrains,
    brains: { carnivore: seeingBrain(environment) },
  });
  const errors = mock.method(logger, "error", () => {});
  try {
    world.step();
    const watcher = spawned.find((actor) => actor.archetype === "carnivore");
    const [near, far, ...others] = spawned.filter((actor) => actor.archetype === "herbivore");
    assert.ok(watcher && near && far, "the world spawned a carnivore and two herbivores");
    const engine = watcher.engine;
    engine.setDesiredCount("herbivore", 2);
    for (const other of others) other.drainEnergy(other.energy);

    const hold = () => {
      const facing = watcher.sprite.rotation;
      for (const [herbivore, distance] of [
        [near, NEAR],
        [far, FAR],
      ] as const) {
        if (engine.getActorById(herbivore.actorId) !== herbivore) continue;
        herbivore.sprite.setPosition(
          watcher.sprite.x + Math.cos(facing) * distance,
          watcher.sprite.y + Math.sin(facing) * distance
        );
        herbivore.sprite.setVelocity(0, 0);
      }
    };
    const step = () => {
      hold();
      world.step();
    };
    const refreshesNext = () =>
      (engine.tickCount + 1) % Engine.VISION_PHASES === watcher.actorId % Engine.VISION_PHASES;

    for (let i = 0; i < Engine.VISION_PHASES || !refreshesNext(); i++) step();
    errors.mock.resetCalls();
    if (killNear) near.drainEnergy(near.energy);
    step();

    watcher.brain.setVariable("found", NIL_VALUE);
    const gates: boolean[] = [];
    watcher.brain.events().on("rule_when_evaluated", ({ fired }) => {
      gates.push(fired);
    });
    const nearPresent = engine.getActorById(near.actorId) === near;
    const nearSighted = watcher.sightQueue.some((sight) => sight.actor === near);
    step();

    return {
      near,
      far,
      nearPresent,
      nearSighted,
      gates,
      found: (watcher.brain.getVariable("found") as StructValue | undefined)?.native as Actor | undefined,
      errorsLogged: errors.mock.callCount(),
    };
  } finally {
    errors.mock.restore();
    world.shutdown();
  }
}

describe("a rehearsal of a carnivore whose nearest sighted herbivore was killed", () => {
  test("its see rule fires on the living herbivore standing farther", async () => {
    const run = await rehearseSighting(true);

    assert.equal(run.nearPresent, false, "the engine took the killed herbivore out of the world");
    assert.equal(run.nearSighted, true, "the carnivore's sight queue still held the killed herbivore");
    assert.deepEqual(run.gates, [true], "the see rule fires");
    assert.equal(run.found, run.far, "the see rule sensed the living herbivore");
    assert.equal(run.errorsLogged, 0, "nothing faulted or logged an error");
  });

  test("with both herbivores living, its see rule fires on the nearer", async () => {
    const run = await rehearseSighting(false);

    assert.equal(run.nearPresent, true);
    assert.equal(run.nearSighted, true);
    assert.deepEqual(run.gates, [true], "the see rule fires");
    assert.equal(run.found, run.near, "the see rule sensed the nearer herbivore");
    assert.equal(run.errorsLogged, 0, "nothing faulted or logged an error");
  });
});
