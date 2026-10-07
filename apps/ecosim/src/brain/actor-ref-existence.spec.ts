/**
 * A held `ActorRef` whose actor the engine has killed reads as nothing. The
 * type resolves a dying actor to no actor, so its existence hook reports the
 * value gone, its field getter answers absent, its field setter rejects, and
 * its conversions produce their no-actor fallbacks -- none of them reaching
 * the killed actor's destroyed sprite. These tests run compiled brains on the
 * VM in an environment carrying the ecosim module, with the held value written
 * straight into the brain's variable, and call the type's hooks directly.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { coreModule, createWendooEnvironment } from "@wendoo/core";
import type { IBrainTileDef } from "@wendoo/core/brain";
import { mkAccessorTileId, mkOperatorTileId } from "@wendoo/core/brain";
import { __test__appendTile } from "@wendoo/core/brain/__test__";
import type { BrainPageDef, BrainRuleDef } from "@wendoo/core/brain/model";
import { BrainDef } from "@wendoo/core/brain/model";
import { BrainTileVariableDef } from "@wendoo/core/brain/tiles";
import {
  CoreOpId,
  CoreTypeIds,
  type ErrorValue,
  type ExecutionContext,
  getClosedStructFieldByName,
  mkNumberValue,
  NativeType,
  type StructTypeDef,
  type StructValue,
  type Value,
} from "@wendoo/core/runtime";
import type { Actor } from "./actor";
import { createEcosimModule } from "./index";
import { EcosimTypeIds, mkActorRefDirect } from "./type-system";

/** An actor the engine has killed: marked dying, with a destroyed sprite whose every read throws. */
function killedActor(): Actor {
  return {
    actorId: 7,
    isDying: true,
    get sprite(): never {
      throw new TypeError("the destroyed sprite has no body");
    },
  } as unknown as Actor;
}

/** An actor the engine runs, its sprite at (12, 34). */
function liveActor(): Actor {
  return { actorId: 3, isDying: false, sprite: { x: 12, y: 34, rotation: 0 } } as unknown as Actor;
}

/**
 * A read a brain makes through the `ActorRef` it holds in `held`, each its own
 * rule: `out` is `DO [out = held.position.x]`, the accessor chain; `id` is
 * `DO [id = held]`, the conversion to a number; `pos` is `DO [pos = held]`, the
 * conversion to a `Vector2`.
 */
type HeldRead = "out" | "id" | "pos";

/** What one think of a brain holding an `ActorRef` in `held` observed. */
interface HeldThink {
  /** Every fault the VM raised. */
  readonly faults: ErrorValue[];
  /** The value `out` holds after the think. */
  readonly out: Value | undefined;
  /** The value `id` holds after the think. */
  readonly id: Value | undefined;
  /** The (x, y) fields of the value `pos` holds after the think. */
  readonly pos: readonly [Value | undefined, Value | undefined];
}

/** Builds a brain making each read in `reads`, writes an `ActorRef` to `actor` into `held`, and runs one think. */
function thinkHolding(actor: Actor, reads: readonly HeldRead[]): HeldThink {
  const environment = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Held Actor Brain");
  const page = brainDef.pages().get(0) as BrainPageDef;
  const variables = new Map<string, IBrainTileDef>();
  const variable = (name: string, typeId: string): IBrainTileDef => {
    let tile = variables.get(name);
    if (!tile) {
      tile = new BrainTileVariableDef(`variable:existspec.${name}`, name, typeId, `existspec.${name}`);
      brainDef.catalog().registerTileDef(tile);
      variables.set(name, tile);
    }
    return tile;
  };
  const assign = tiles.get(mkOperatorTileId(CoreOpId.Assign))!;
  const held = () => variable("held", EcosimTypeIds.ActorRef);
  const sequences: Record<HeldRead, () => IBrainTileDef[]> = {
    out: () => [
      variable("out", CoreTypeIds.Number),
      assign,
      held(),
      tiles.get(mkAccessorTileId(EcosimTypeIds.ActorRef, "position"))!,
      tiles.get(mkAccessorTileId(EcosimTypeIds.Vector2, "x"))!,
    ],
    id: () => [variable("id", CoreTypeIds.Number), assign, held()],
    pos: () => [variable("pos", EcosimTypeIds.Vector2), assign, held()],
  };
  reads.forEach((read, index) => {
    const sequence = sequences[read]();
    const rule = (index === 0 ? page.children().get(0) : page.appendNewRule()) as BrainRuleDef;
    for (const tile of sequence) {
      __test__appendTile(rule.do(), tile);
    }
  });

  const faults: ErrorValue[] = [];
  const brain = environment.createBrain(brainDef, {
    vmEvents: {
      onFiberFault: ({ err }) => {
        faults.push(err);
      },
    },
  });
  brain.startup();
  brain.setVariable("held", mkActorRefDirect(actor));
  brain.think(16);

  const vector2 = environment.brainServices.runtime.types.get(EcosimTypeIds.Vector2) as StructTypeDef;
  const pos = brain.getVariable("pos") as StructValue | undefined;
  return {
    faults,
    out: brain.getVariable("out"),
    id: brain.getVariable("id"),
    pos: pos
      ? [getClosedStructFieldByName(vector2, pos, "x"), getClosedStructFieldByName(vector2, pos, "y")]
      : [undefined, undefined],
  };
}

/** The registered `ActorRef` struct definition and the field ids of `position` and `rotation`. */
function actorRefType(): { typeDef: StructTypeDef; position: number; rotation: number } {
  const environment = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
  const typeDef = environment.brainServices.runtime.types.get(EcosimTypeIds.ActorRef) as StructTypeDef;
  return {
    typeDef,
    position: typeDef.fieldIndexByName.get("position")!,
    rotation: typeDef.fieldIndexByName.get("rotation")!,
  };
}

/**
 * A placeholder ExecutionContext for calling the ActorRef type hooks on a
 * directly held actor; valid only for hooks that do not read the context.
 */
const noContext = undefined as unknown as ExecutionContext;

describe("a held ActorRef whose actor was killed reads as nothing", () => {
  test("the type's existence hook reports it gone, and reports a live actor present", () => {
    const { typeDef } = actorRefType();

    assert.equal(typeDef.exists!(mkActorRefDirect(killedActor()), noContext), false);
    assert.equal(typeDef.exists!(mkActorRefDirect(liveActor()), noContext), true);
  });

  test("the type's field getter answers absent, never touching the destroyed sprite", () => {
    const { typeDef, position } = actorRefType();

    assert.equal(typeDef.fieldGetter!(mkActorRefDirect(killedActor()), position, noContext), undefined);
  });

  test("the type's field setter rejects the write, never touching the destroyed sprite", () => {
    const { typeDef, rotation } = actorRefType();

    assert.equal(typeDef.fieldSetter!(mkActorRefDirect(killedActor()), rotation, mkNumberValue(1), noContext), false);
  });

  test("an accessor chain through it reads nil without faulting", () => {
    const read = thinkHolding(killedActor(), ["out"]);

    assert.deepEqual(
      read.faults.map((f) => f.code),
      [],
      `the brain must not fault: ${read.faults.map((f) => f.message).join(" | ")}`
    );
    assert.equal(read.out?.t, NativeType.Nil);
  });

  test("its conversions produce the no-actor fallbacks: number 0 and the origin", () => {
    const read = thinkHolding(killedActor(), ["id", "pos"]);

    assert.deepEqual(read.faults, []);
    assert.deepEqual(read.id, mkNumberValue(0));
    assert.deepEqual(read.pos, [mkNumberValue(0), mkNumberValue(0)]);
  });

  test("the same reads through a live actor see its fields", () => {
    const read = thinkHolding(liveActor(), ["out", "id", "pos"]);

    assert.deepEqual(read.faults, []);
    assert.deepEqual(read.out, mkNumberValue(12));
    assert.deepEqual(read.id, mkNumberValue(3));
    assert.deepEqual(read.pos, [mkNumberValue(12), mkNumberValue(34)]);
  });
});
