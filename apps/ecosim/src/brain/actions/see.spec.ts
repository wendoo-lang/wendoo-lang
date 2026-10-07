/**
 * What `see` senses from the sight queue an actor carries between vision
 * refreshes. The queue keeps every sighting from the actor's last refresh, so
 * it can hold an actor the engine has killed since; `see` passes over those
 * and senses the nearest living sighting, while a living actor's sighting
 * keeps its recorded distance until the next refresh. These tests run a
 * compiled brain on the VM with a hand-filled sight queue on the thinking
 * actor.
 */

import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { coreModule, createWendooEnvironment } from "@wendoo/core";
import type { IBrainTileDef } from "@wendoo/core/app";
import {
  CoreOpId,
  logger,
  mkLiteralTileId,
  mkModifierTileId,
  mkOperatorTileId,
  mkSensorTileId,
  type StructValue,
} from "@wendoo/core/app";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import type { ErrorValue } from "@wendoo/core/runtime";
import { EcosimHostActions } from "@/brain/abi-ids";
import type { Actor } from "@/brain/actor";
import { createEcosimModule } from "@/brain/index";
import { TileIds } from "@/brain/tileids";
import { EcosimTypeIds } from "@/brain/type-system";
import type { SightResult } from "@/brain/vision";

/** An herbivore the engine has killed: marked dying, its sprite destroyed as Phaser destroys one. */
function killedHerbivore(actorId: number): Actor {
  return {
    actorId,
    archetype: "herbivore",
    isDying: true,
    sprite: {
      body: undefined,
      get x(): never {
        throw new TypeError("the destroyed sprite has no body");
      },
      get y(): never {
        throw new TypeError("the destroyed sprite has no body");
      },
    },
  } as unknown as Actor;
}

/** An herbivore the engine runs, its sprite at (`x`, 0). */
function liveHerbivore(actorId: number, x: number): Actor {
  return {
    actorId,
    archetype: "herbivore",
    isDying: false,
    sprite: { body: {}, x, y: 0, rotation: 0 },
  } as unknown as Actor;
}

/** A sighting of `actor` recorded `distance` pixels from the observer. */
function sighting(actor: Actor, distance: number): SightResult {
  return { actor, distanceSq: distance * distance };
}

/** What one think of {@link thinkSeeing}'s brain observed. */
interface SeeThink {
  /** The actor `WHEN [see] DO [found = it]` sensed, or undefined when its gate stayed shut. */
  readonly found: Actor | undefined;
  /** The actor `WHEN [see herbivore] DO [foundHerbivore = it]` sensed, or undefined when its gate stayed shut. */
  readonly foundHerbivore: Actor | undefined;
  /** Whether each rule's WHEN gate fired, in rule order. */
  readonly gates: readonly boolean[];
  /** Every fault the VM raised. */
  readonly faults: readonly ErrorValue[];
  /** Errors logged during the think. */
  readonly errorsLogged: number;
}

/**
 * Runs one think of a brain holding two rules, `WHEN [see] DO [found = it]`
 * and `WHEN [see herbivore] DO [foundHerbivore = it]`, on an actor whose sight
 * queue holds `queue`. The engine the actor belongs to holds the living actors
 * the queue names.
 */
function thinkSeeing(queue: readonly SightResult[]): SeeThink {
  const environment = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "See Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  const variable = (name: string): IBrainTileDef => {
    const tile = new BrainTileVariableDef(`variable:seespec.${name}`, name, EcosimTypeIds.ActorRef, `seespec.${name}`);
    brainDef.catalog().registerTileDef(tile);
    return tile;
  };
  const see = tiles.get(mkSensorTileId(EcosimHostActions.See.key))!;
  const herbivore = tiles.get(mkModifierTileId(TileIds.Modifier.ActorKindHerbivore))!;
  const assign = tiles.get(mkOperatorTileId(CoreOpId.Assign))!;
  const it = tiles.get(mkLiteralTileId(EcosimTypeIds.ActorRef, "it"))!;
  const rules = [
    { when: [see], do: [variable("found"), assign, it] },
    { when: [see, herbivore], do: [variable("foundHerbivore"), assign, it] },
  ];
  rules.forEach((sections, index) => {
    const rule = (index === 0 ? page.children().get(0) : page.appendNewRule()) as BrainRuleDef;
    for (const tile of sections.when) rule.when().appendTile(tile);
    for (const tile of sections.do) rule.do().appendTile(tile);
  });

  const living = new Map(queue.filter(({ actor }) => !actor.isDying).map(({ actor }) => [actor.actorId, actor]));
  const self = {
    actorId: 1,
    archetype: "carnivore",
    engine: { getActorById: (actorId: number) => living.get(actorId) },
    sightQueue: [...queue],
    debugTargetPositions: new Map(),
  } as unknown as Actor;

  const faults: ErrorValue[] = [];
  const brain = environment.createBrain(brainDef, {
    context: self,
    vmEvents: {
      onFiberFault: ({ err }) => {
        faults.push(err);
      },
    },
  });
  const gates: boolean[] = [];
  brain.events().on("rule_when_evaluated", ({ fired }) => {
    gates.push(fired);
  });
  brain.startup();
  const errors = mock.method(logger, "error", () => {});
  try {
    brain.think(16);
  } finally {
    errors.mock.restore();
  }

  const sensed = (name: string) => (brain.getVariable(name) as StructValue | undefined)?.native as Actor | undefined;
  return {
    found: sensed("found"),
    foundHerbivore: sensed("foundHerbivore"),
    gates,
    faults,
    errorsLogged: errors.mock.callCount(),
  };
}

describe("see senses the nearest living sighting in its sight queue", () => {
  test("a killed actor sighted nearest is passed over for the living one sighted farther", () => {
    const live = liveHerbivore(3, 250);
    const run = thinkSeeing([sighting(live, 250), sighting(killedHerbivore(7), 100)]);

    assert.equal(run.found, live, "the bare see senses the living herbivore");
    assert.equal(run.foundHerbivore, live, "the kind-filtered see senses the living herbivore");
    assert.deepEqual(run.gates, [true, true]);
    assert.deepEqual(run.faults, []);
    assert.equal(run.errorsLogged, 0);
  });

  test("a queue holding only killed actors senses nothing, faulting and logging nothing", () => {
    const run = thinkSeeing([sighting(killedHerbivore(7), 100), sighting(killedHerbivore(8), 250)]);

    assert.equal(run.found, undefined);
    assert.equal(run.foundHerbivore, undefined);
    assert.deepEqual(run.gates, [false, false]);
    assert.deepEqual(run.faults, []);
    assert.equal(run.errorsLogged, 0);
  });

  test("a living actor's sighting keeps its recorded distance though the actor has since moved", () => {
    const movedAway = liveHerbivore(3, 400);
    const run = thinkSeeing([sighting(liveHerbivore(4, 250), 250), sighting(movedAway, 100)]);

    assert.equal(run.found, movedAway, "the bare see senses the living herbivore sighted nearest");
    assert.equal(run.foundHerbivore, movedAway, "the kind-filtered see senses the living herbivore sighted nearest");
    assert.deepEqual(run.gates, [true, true]);
  });
});
