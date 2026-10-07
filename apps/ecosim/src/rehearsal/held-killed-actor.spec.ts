/**
 * A rehearsal of a creature holding an `ActorRef` to an actor the engine has
 * killed. The engine's kill destroys the rehearsal's sprite stand-in the way
 * Phaser destroys a Matter sprite, so the rehearsal sees death as the browser
 * does, and the creature holding the killed actor acts on nothing: its reads
 * are nil, its conversions fall back, its eat fails, its WHEN gate stays shut,
 * and nothing faults or logs an error.
 */

import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import { createRehearsalEnvironment, createSeededRng } from "@wendoo/assistant-bridge/kit";
import type { IBrainDef, IBrainTileDef } from "@wendoo/core/app";
import { logger, type WendooEnvironment } from "@wendoo/core/app";
import { mkAccessorTileId, mkOperatorTileId } from "@wendoo/core/brain";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  CoreOpId,
  CoreTypeIds,
  type ExecutionContext,
  FALSE_VALUE,
  getClosedStructFieldByName,
  getSlotId,
  mkActuatorTileId,
  mkNumberValue,
  mkParameterTileId,
  NativeType,
  NIL_VALUE,
  type StructTypeDef,
  type StructValue,
  TRUE_VALUE,
  type Value,
} from "@wendoo/core/runtime";
import { EcosimHostActions } from "@/brain/abi-ids";
import eatAction, { execEat } from "@/brain/actions/eat";
import type { Actor } from "@/brain/actor";
import { createEcosimModule } from "@/brain/index";
import { TileIds } from "@/brain/tileids";
import { EcosimTypeIds, mkActorRefDirect } from "@/brain/type-system";
import { sourceRehearsalContent } from "./source-content";
import { createRehearsalWorld } from "./world";

/** The app's own assets, read from the tree these specs run in. */
const CONTENT = sourceRehearsalContent();

/** Seed every run in this file stages its world from. */
const SEED = 20261007;

/**
 * A placeholder ExecutionContext for calling the ActorRef type hooks on a
 * directly held actor; valid only for hooks that do not read the context.
 */
const noContext = undefined as unknown as ExecutionContext;

/**
 * The brain every carnivore runs: each rule reads or acts through the
 * `ActorRef` held in `held`.
 *
 * - `DO [out = held.position.x]` -- the accessor chain.
 * - `DO [id = held]` -- the conversion to a number.
 * - `DO [pos = held]` -- the conversion to a `Vector2`.
 * - `DO [eat held]` -- the named actor parameter.
 * - `WHEN [held] DO [seen = held]` -- the truthiness gate.
 */
function heldBrain(environment: WendooEnvironment): IBrainDef {
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Held Actor Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  const variables = new Map<string, IBrainTileDef>();
  const variable = (name: string, typeId: string): IBrainTileDef => {
    let tile = variables.get(name);
    if (!tile) {
      tile = new BrainTileVariableDef(`variable:heldspec.${name}`, name, typeId, `heldspec.${name}`);
      brainDef.catalog().registerTileDef(tile);
      variables.set(name, tile);
    }
    return tile;
  };
  const assign = tiles.get(mkOperatorTileId(CoreOpId.Assign))!;
  const held = () => variable("held", EcosimTypeIds.ActorRef);
  const rules: { when?: IBrainTileDef[]; do: IBrainTileDef[] }[] = [
    {
      do: [
        variable("out", CoreTypeIds.Number),
        assign,
        held(),
        tiles.get(mkAccessorTileId(EcosimTypeIds.ActorRef, "position"))!,
        tiles.get(mkAccessorTileId(EcosimTypeIds.Vector2, "x"))!,
      ],
    },
    { do: [variable("id", CoreTypeIds.Number), assign, held()] },
    { do: [variable("pos", EcosimTypeIds.Vector2), assign, held()] },
    { do: [tiles.get(mkActuatorTileId(EcosimHostActions.Eat.key))!, held()] },
    { when: [held()], do: [variable("seen", EcosimTypeIds.ActorRef), assign, held()] },
  ];
  rules.forEach((sections, index) => {
    const rule = (index === 0 ? page.children().get(0) : page.appendNewRule()) as BrainRuleDef;
    for (const tile of sections.when ?? []) rule.when().appendTile(tile);
    for (const tile of sections.do) rule.do().appendTile(tile);
  });
  return brainDef;
}

/** What one rehearsal of a carnivore holding an herbivore observed. */
interface HeldRun {
  /** The carnivore holding the herbivore. */
  readonly holder: Actor;
  /** The herbivore the carnivore holds. */
  readonly target: Actor;
  /** Whether the target was in the world when the carnivore's observed think ran. */
  readonly targetPresent: boolean;
  /** The value `out` holds after the observed think. */
  readonly out: Value | undefined;
  /** The value `id` holds after the observed think. */
  readonly id: Value | undefined;
  /** The (x, y) fields of the value `pos` holds after the observed think. */
  readonly pos: readonly [Value | undefined, Value | undefined];
  /** What each `eat` call the observed think dispatched returned. */
  readonly eats: readonly (Value | undefined)[];
  /** Whether the WHEN gate fired, for each time the observed think reached it. */
  readonly gates: readonly boolean[];
  /** Errors logged anywhere in the world from the target's death through the observed think. */
  readonly errorsLogged: number;
}

/**
 * Stage the shipped world with every carnivore running {@link heldBrain}, hand
 * the first carnivore an `ActorRef` to the first herbivore -- killed by the
 * engine first when `kill` is set -- and run one more step.
 */
async function rehearseHolding(kill: boolean): Promise<HeldRun> {
  const next = createSeededRng(SEED);
  const environment = createRehearsalEnvironment({ modules: [createEcosimModule()], rng: next });
  const spawned: Actor[] = [];
  const world = await createRehearsalWorld({
    environment,
    next,
    observer: { onSpawn: (actor) => spawned.push(actor) },
    shippedBrains: CONTENT.shippedBrains,
    brains: { carnivore: heldBrain(environment) },
  });
  const errors = mock.method(logger, "error", () => {});
  try {
    world.step();
    const holder = spawned.find((actor) => actor.archetype === "carnivore");
    const target = spawned.find((actor) => actor.archetype === "herbivore");
    assert.ok(holder && target, "the world spawned a carnivore and an herbivore");
    errors.mock.resetCalls();

    if (kill) {
      target.drainEnergy(target.energy);
      world.step();
    }
    holder.brain.setVariable("held", mkActorRefDirect(target));
    const eats: (Value | undefined)[] = [];
    const gates: boolean[] = [];
    holder.brain.events().on("host_action_returned", ({ actionId, result }) => {
      if (actionId === EcosimHostActions.Eat.actionId) eats.push(result);
    });
    holder.brain.events().on("rule_when_evaluated", ({ fired }) => {
      gates.push(fired);
    });
    const targetPresent = world.actors().includes(target);
    world.step();

    const vector2 = environment.brainServices.runtime.types.get(EcosimTypeIds.Vector2) as StructTypeDef;
    const pos = holder.brain.getVariable("pos") as StructValue | undefined;
    return {
      holder,
      target,
      targetPresent,
      out: holder.brain.getVariable("out"),
      id: holder.brain.getVariable("id"),
      pos: pos
        ? [getClosedStructFieldByName(vector2, pos, "x"), getClosedStructFieldByName(vector2, pos, "y")]
        : [undefined, undefined],
      eats,
      gates,
      errorsLogged: errors.mock.callCount(),
    };
  } finally {
    errors.mock.restore();
    world.shutdown();
  }
}

/** What one host call of eat, made with no cooldown running, did. */
interface EatCall {
  /** The value eat returned. */
  readonly result: Value;
  /** The sim time the call left the call site's cooldown running until; 0 when it spent none. */
  readonly cooldownUntil: number;
}

/**
 * Calls eat as the host does, for `holder` with `target` in its actor slot, at
 * a call site whose cooldown has never run.
 */
function eatTarget(holder: Actor, target: Value): EatCall {
  const state = { nextEatTime: 0 };
  const ctx = {
    data: holder,
    currentCallSiteId: 0,
    services: { brain: { callsite: { getHostState: () => state } } },
  } as unknown as ExecutionContext;
  const slot = getSlotId(eatAction.callDef, mkParameterTileId(TileIds.Parameter.AnonymousActorRef));
  const args = eatAction.callDef.argSlots.map((_, index): Value => (index === slot ? target : NIL_VALUE));
  return { result: execEat(ctx, args), cooldownUntil: state.nextEatTime };
}

describe("a rehearsal of a creature holding a killed actor", () => {
  test("the engine's kill destroys the sprite stand-in as Phaser destroys a Matter sprite", async () => {
    const { target, targetPresent } = await rehearseHolding(true);

    assert.equal(targetPresent, false, "the engine took the killed actor out of the world");
    assert.equal(target.isDying, true);
    assert.ok(target.sprite.body === undefined, "the destroyed sprite has no body");
    assert.throws(() => target.sprite.x, TypeError, "a transform read on the destroyed sprite throws");
  });

  test("the holder reads nil, converts to the fallbacks, skips its eat, gates its rule shut, and logs no error", async () => {
    const run = await rehearseHolding(true);

    assert.equal(run.out?.t, NativeType.Nil, "the accessor chain reads nil");
    assert.deepEqual(run.id, mkNumberValue(0), "the number conversion falls back to 0");
    assert.deepEqual(run.pos, [mkNumberValue(0), mkNumberValue(0)], "the Vector2 conversion falls back to the origin");
    assert.deepEqual(run.eats, [], "the placed actor gate skips the eat call");
    assert.deepEqual(run.gates, [false], "the WHEN gate stays shut");
    assert.equal(run.errorsLogged, 0, "nothing faulted or logged an error");
  });

  test("host calls given the killed actor: the getter answers absent, the setter rejects, eat fails", async () => {
    const { holder, target } = await rehearseHolding(true);
    const environment = createRehearsalEnvironment({ modules: [createEcosimModule()], rng: createSeededRng(SEED) });
    const typeDef = environment.brainServices.runtime.types.get(EcosimTypeIds.ActorRef) as StructTypeDef;
    const rotation = typeDef.fieldIndexByName.get("rotation")!;
    const ref = mkActorRefDirect(target);
    const eat = eatTarget(holder, ref);

    assert.equal(typeDef.fieldGetter!(ref, rotation, noContext), undefined);
    assert.equal(typeDef.fieldSetter!(ref, rotation, mkNumberValue(1), noContext), false);
    assert.deepEqual(eat.result, FALSE_VALUE, "eat fails as it does with no target");
    assert.equal(eat.cooldownUntil, 0, "the failed eat leaves the cooldown unspent");
  });

  test("the same holder of a live actor reads it, converts it, eats it, and fires its rule", async () => {
    const run = await rehearseHolding(false);

    assert.equal(run.targetPresent, true);
    assert.equal(run.out?.t, NativeType.Number, "the accessor chain reads the target's x");
    assert.deepEqual(run.id, mkNumberValue(run.target.actorId), "the number conversion is the target's id");
    assert.deepEqual(
      run.pos.map((field) => field?.t),
      [NativeType.Number, NativeType.Number],
      "the Vector2 conversion is the target's position"
    );
    assert.deepEqual(run.eats, [TRUE_VALUE], "eat bites the target");
    assert.deepEqual(eatTarget(run.holder, mkActorRefDirect(run.target)).result, TRUE_VALUE, "a host eat bites it");
    assert.deepEqual(run.gates, [true], "the WHEN gate fires");
    assert.equal(run.errorsLogged, 0, "nothing faulted or logged an error");
  });
});
