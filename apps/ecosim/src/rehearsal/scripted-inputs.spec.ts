import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AuthoringWorkspace, ScenarioInput, SimulationRun } from "@wendoo/assistant-bridge";
import { createAuthoringWorkspace, proposeEdit } from "@wendoo/assistant-bridge";
import { createRehearsalEnvironment, createSeededRng } from "@wendoo/assistant-bridge/kit";
import { ruleIdAt } from "@wendoo/assistant-bridge/testing";
import type { Actor, Archetype } from "@/brain/actor";
import { ARCHETYPE_NAMES } from "@/brain/archetypes";
import { createEcosimModule } from "@/brain/index";
import { createTargetAdapter } from "./adapter";
import { sourceRehearsalContent } from "./source-content";
import { createRehearsalWorld, SCENARIO_INPUT_KINDS } from "./world";

/** The app's own assets, read from the tree these specs run in. */
const CONTENT = sourceRehearsalContent();

/** Seed every run here stages its world from. */
const SEED = 20260805;

/** Population role the brain under study drives. */
const SUBJECT = "herbivore";

/** Think a scripted creature is put in the world. */
const PLACED = 60;

/** Think the scripted creature is taken out of it again. */
const CLEARED = 120;

/** Fixed steps each run covers. */
const RUN_THINKS = 180;

/** Thinks the world may take to carry a staged creature through to the sensor. */
const SENSING_LAG = 3;

/** Distance in world pixels a creature is staged at to be seen but not touched. */
const IN_VIEW = 120;

/** Distance in world pixels a creature is staged at to be in contact with the subject. */
const IN_CONTACT = 10;

/** A workspace whose one rule wanders while `sensorTiles` reads true. */
function gatedWorkspace(sensorTiles: string[]): AuthoringWorkspace {
  const workspace = createAuthoringWorkspace(createTargetAdapter(CONTENT), "scripted-input brain");
  const ruleId = ruleIdAt(workspace.brainDef, "0/0");
  const when = proposeEdit(workspace, { op: "placeTiles", ruleId, side: "when", tileIds: sensorTiles });
  assert.equal(when.ok, true, JSON.stringify(when));
  const doSide = proposeEdit(workspace, {
    op: "placeTiles",
    ruleId,
    side: "do",
    tileIds: ["tile.actuator->actuator.move", "tile.modifier->modifier.movement.wander"],
  });
  assert.equal(doSide.ok, true, JSON.stringify(doSide));
  return workspace;
}

/** What a run recorded, which the same seed must reproduce exactly. */
function recorded(run: SimulationRun): Omit<SimulationRun, "runId"> {
  const { runId: _addressedAs, ...rest } = run;
  return rest;
}

/** Rehearse `workspace` over a scenario that stages `kind` at `distance` between the two thinks. */
function rehearse(workspace: AuthoringWorkspace, kind: string, distance: number): Promise<SimulationRun> {
  const inputs: ScenarioInput[] = [
    { kind, at: 0, value: 0 },
    { kind, at: PLACED, value: distance },
    { kind, at: CLEARED, value: 0 },
  ];
  return workspace.adapter.run({
    brainDef: workspace.brainDef,
    scenario: { seed: SEED, subject: SUBJECT, inputs },
    thinks: RUN_THINKS,
  });
}

/** Thinks the brain's gate passed on, in order. */
function firedThinks(run: SimulationRun): number[] {
  const thinks: number[] = [];
  run.observations.forEach((observation, think) => {
    if (observation.gates.some((gate) => gate.fired)) thinks.push(think);
  });
  return thinks;
}

/**
 * Assert `run` lasted past the staged stretch, and that its gate passed over
 * that stretch and nothing outside it, allowing the sensing lag.
 */
function assertFlippedWithTheStaging(run: SimulationRun): void {
  assert.ok(
    run.thinks > CLEARED + SENSING_LAG,
    `the creature under study left the world on think ${run.thinks}, before the staged stretch had played out`
  );
  const fired = firedThinks(run);
  assert.deepEqual(
    fired.filter((think) => think < PLACED),
    [],
    "the gate passed before the creature was in the world"
  );
  assert.deepEqual(
    fired.filter((think) => think > CLEARED + SENSING_LAG),
    [],
    "the gate passed after the creature left the world"
  );
  for (let think = PLACED + SENSING_LAG; think < CLEARED; think++) {
    assert.ok(fired.includes(think), `the gate did not pass on think ${think}, with the creature staged`);
  }
}

describe("scripted world causes in an ecosim rehearsal", () => {
  test("reads one percept kind per archetype, and reports them through the adapter", () => {
    assert.deepEqual(createTargetAdapter(CONTENT).inputKinds(), SCENARIO_INPUT_KINDS);
    assert.equal(SCENARIO_INPUT_KINDS.length, ARCHETYPE_NAMES.length);
  });

  test("a creature staged in view turns the sight sensor on, and taking it away turns it off", async () => {
    const run = await rehearse(
      gatedWorkspace(["tile.sensor->sensor.see", "tile.modifier->modifier.actor_kind.carnivore"]),
      "carnivore-ahead",
      IN_VIEW
    );

    assertFlippedWithTheStaging(run);
  });

  test("a creature staged in contact turns the bump sensor on, and taking it away turns it off", async () => {
    const run = await rehearse(
      gatedWorkspace(["tile.sensor->sensor.bump", "tile.modifier->modifier.actor_kind.plant"]),
      "plant-ahead",
      IN_CONTACT
    );

    assertFlippedWithTheStaging(run);
  });

  test("holds the staged kind to one creature from the world's first step", async () => {
    const staged: Archetype = "carnivore";
    let underStudy: Actor | undefined;
    const next = createSeededRng(SEED);
    const world = await createRehearsalWorld({
      environment: createRehearsalEnvironment({ modules: [createEcosimModule()], rng: next }),
      next,
      shippedBrains: CONTENT.shippedBrains,
      observer: {
        onSpawn: (actor: Actor) => {
          if (underStudy === undefined && actor.archetype === SUBJECT) underStudy = actor;
        },
      },
      scripted: { inputs: [{ kind: `${staged}-ahead`, at: 0, value: IN_VIEW }], subject: () => underStudy },
    });

    const counts: number[] = [];
    for (let think = 0; think < RUN_THINKS; think++) {
      world.step();
      counts.push(world.actors().filter((actor) => actor.archetype === staged).length);
    }
    world.shutdown();

    assert.deepEqual(
      [...new Set(counts)],
      [1],
      `the world held ${Math.max(...counts)} creatures of the staged kind at its fullest`
    );
  });

  test("goes on stepping once the creature under study has died", async () => {
    let underStudy: Actor | undefined;
    const next = createSeededRng(SEED);
    const world = await createRehearsalWorld({
      environment: createRehearsalEnvironment({ modules: [createEcosimModule()], rng: next }),
      next,
      shippedBrains: CONTENT.shippedBrains,
      observer: {
        onSpawn: (actor: Actor) => {
          if (underStudy === undefined && actor.archetype === SUBJECT) underStudy = actor;
        },
      },
      scripted: { inputs: [{ kind: "carnivore-ahead", at: 0, value: IN_VIEW }], subject: () => underStudy },
    });
    try {
      world.step();
      assert.ok(underStudy, "the creature under study spawned on the first step");
      underStudy.drainEnergy(underStudy.energy);
      world.step();
      assert.equal(world.actors().includes(underStudy), false, "the engine took the drained creature out of the world");

      assert.doesNotThrow(() => {
        for (let think = 0; think < SENSING_LAG; think++) world.step();
      });
    } finally {
      world.shutdown();
    }
  });

  test("reproduces a scripted run exactly from the same seed", async () => {
    const tiles = ["tile.sensor->sensor.see", "tile.modifier->modifier.actor_kind.carnivore"];

    const workspace = gatedWorkspace(tiles);
    const first = await rehearse(workspace, "carnivore-ahead", IN_VIEW);
    const second = await rehearse(workspace, "carnivore-ahead", IN_VIEW);

    assert.deepEqual(recorded(second), recorded(first));
    assert.notEqual(second.runId, first.runId, "each run is addressable on its own");
  });
});
