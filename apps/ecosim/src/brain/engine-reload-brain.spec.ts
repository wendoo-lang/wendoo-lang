import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BrainDef, coreModule, createWendooEnvironment, type WendooEnvironment } from "@wendoo/core/app";
import type { Playground } from "../game/scenes/Playground";
import type { EcosimEnvironmentStore } from "../services/ecosim-environment-store";
import type { Archetype } from "./actor";
import { Engine } from "./engine";
import { createEcosimModule } from "./index";

function fakeScene(): Playground {
  return {} as unknown as Playground;
}

/**
 * A store stand-in over a mutable per-archetype project brain record and a
 * default brain per archetype. Saved brains land in the record.
 */
function fakeStore(
  env: WendooEnvironment,
  project: Partial<Record<Archetype, BrainDef>>,
  defaults: Record<Archetype, BrainDef>
): EcosimEnvironmentStore {
  return {
    env,
    getDesiredCounts: () => ({ carnivore: 0, herbivore: 0, plant: 0 }),
    loadBrainFromProject: async (archetype: Archetype) => project[archetype],
    getDefaultBrain: (archetype: Archetype) => defaults[archetype],
    saveBrainForArchetype: async (archetype: Archetype, brain: BrainDef) => {
      project[archetype] = brain;
    },
  } as unknown as EcosimEnvironmentStore;
}

function emptyBrains(env: WendooEnvironment): Record<Archetype, BrainDef> {
  return {
    carnivore: BrainDef.emptyBrainDef(env.brainServices, "carnivore"),
    herbivore: BrainDef.emptyBrainDef(env.brainServices, "herbivore"),
    plant: BrainDef.emptyBrainDef(env.brainServices, "plant"),
  };
}

describe("engine reloads one archetype's brain from the project", () => {
  test("a loaded archetype takes the project's current brain", async () => {
    const env = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
    const project: Partial<Record<Archetype, BrainDef>> = emptyBrains(env);
    const engine = new Engine(fakeScene(), [], fakeStore(env, project, emptyBrains(env)));
    await engine.loadBrains();

    const edited = BrainDef.emptyBrainDef(env.brainServices, "edited carnivore");
    project.carnivore = edited;
    await engine.reloadBrain("carnivore");

    assert.strictEqual(engine.getBrainDef("carnivore"), edited);
  });

  test("an archetype the project no longer holds falls back to its default brain, saved to the project", async () => {
    const env = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
    const project: Partial<Record<Archetype, BrainDef>> = emptyBrains(env);
    const defaults = emptyBrains(env);
    const engine = new Engine(fakeScene(), [], fakeStore(env, project, defaults));
    await engine.loadBrains();

    delete project.plant;
    await engine.reloadBrain("plant");

    const reloaded = engine.getBrainDef("plant");
    assert.ok(reloaded, "the archetype still runs a brain");
    assert.notStrictEqual(reloaded, defaults.plant, "the default is cloned, not shared");
    assert.strictEqual(reloaded.name(), defaults.plant.name());
    assert.strictEqual(project.plant, reloaded, "the fallback brain is saved to the project");
  });

  test("an engine still loading its brains is left to the load", async () => {
    const env = createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] });
    const engine = new Engine(fakeScene(), [], fakeStore(env, emptyBrains(env), emptyBrains(env)));

    await engine.reloadBrain("carnivore");

    assert.strictEqual(engine.hasLoadedBrains, false);
  });
});
