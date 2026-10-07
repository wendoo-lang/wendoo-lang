/**
 * A held `ActorRef` whose actor the engine has killed reads as nothing. The
 * type's existence hook reports a dying actor gone, so a compiled accessor
 * chain through the held value stops before the type's field getter runs, and
 * no read reaches the killed actor's destroyed sprite. These
 * tests run compiled brains on the VM in an environment carrying the ecosim
 * module, with the held value written straight into the brain's variable.
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
  mkNumberValue,
  NativeType,
  type StructTypeDef,
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

/** What one think of `DO [out = held.position.x]` observed, with `held` holding an `ActorRef`. */
interface ChainRead {
  /** Every fault the VM raised. */
  readonly faults: ErrorValue[];
  /** The value `out` holds after the think. */
  readonly out: Value | undefined;
}

/** Builds `DO [out = held.position.x]`, writes an `ActorRef` to `actor` into `held`, and runs one think. */
function readThroughHeld(actor: Actor): ChainRead {
  const environment = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
  const tiles = environment.brainServices.edit.tiles;
  const brainDef = BrainDef.emptyBrainDef(environment.brainServices, "Held Actor Brain");
  const rule = (brainDef.pages().get(0) as BrainPageDef).children().get(0) as BrainRuleDef;
  const variable = (name: string, typeId: string): IBrainTileDef => {
    const tile = new BrainTileVariableDef(`variable:existspec.${name}`, name, typeId, `existspec.${name}`);
    brainDef.catalog().registerTileDef(tile);
    return tile;
  };
  const sequence = [
    variable("out", CoreTypeIds.Number),
    tiles.get(mkOperatorTileId(CoreOpId.Assign))!,
    variable("held", EcosimTypeIds.ActorRef),
    tiles.get(mkAccessorTileId(EcosimTypeIds.ActorRef, "position"))!,
    tiles.get(mkAccessorTileId(EcosimTypeIds.Vector2, "x"))!,
  ];
  for (const tile of sequence) {
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
  brain.startup();
  brain.setVariable("held", mkActorRefDirect(actor));
  brain.think(16);
  return { faults, out: brain.getVariable("out") };
}

describe("a held ActorRef whose actor was killed reads as nothing", () => {
  test("the type's field getter throws over the killed actor's destroyed sprite", () => {
    const environment = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
    const typeDef = environment.brainServices.runtime.types.get(EcosimTypeIds.ActorRef) as StructTypeDef;
    const positionField = typeDef.fieldIndexByName.get("position")!;
    const noContext = undefined as unknown as ExecutionContext;

    assert.throws(() => typeDef.fieldGetter!(mkActorRefDirect(killedActor()), positionField, noContext), TypeError);
  });

  test("an accessor chain through it reads nil without faulting, never reaching that getter", () => {
    const read = readThroughHeld(killedActor());

    assert.deepEqual(
      read.faults.map((f) => f.code),
      [],
      `the chain must not fault: ${read.faults.map((f) => f.message).join(" | ")}`
    );
    assert.equal(read.out?.t, NativeType.Nil);
  });

  test("the same chain through a live actor reads its field", () => {
    const read = readThroughHeld(liveActor());

    assert.deepEqual(read.faults, []);
    assert.deepEqual(read.out, mkNumberValue(12));
  });
});
