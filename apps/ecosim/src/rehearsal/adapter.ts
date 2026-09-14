import type { TargetAdapter, TargetManifest } from "@wendoo/assistant-bridge";
import type { RehearsalWorld, WorldDriver, WorldStaging } from "@wendoo/assistant-bridge/kit";
import { createRehearsalAdapter, pairTileDocs } from "@wendoo/assistant-bridge/kit";
import type { CoreBuild } from "@wendoo/core";
import type { IBrainDef } from "@wendoo/core/app";
import type { Actor, Archetype } from "@/brain/actor";
import { ARCHETYPE_NAMES } from "@/brain/archetypes";
import { getSelf } from "@/brain/execution-context-types";
import { createEcosimModule } from "@/brain/index";
import { appTileDocs } from "@/docs/manifest";
import type { RehearsalContent, ShippedBrainDefs } from "./content";
import { injectedContent } from "./content";
import { createRehearsalWorld, SCENARIO_INPUT_KINDS } from "./world";

/**
 * The language build this module graph bundles. Absent in a source run and in
 * every build that injects no language build, which states no vintage at all.
 */
export const buildStamp: CoreBuild | undefined = typeof BUILD_STAMP === "object" ? BUILD_STAMP : undefined;

const MANIFEST: TargetManifest = {
  target: "ecosim, a top-down world of creatures",
  thing: "their creature",
  provides: [
    "A creature can see other creatures in front of it and can feel a bump when one touches it.",
    "A creature can move, turn, eat, shoot, and say something out loud.",
    "Creatures come in three kinds: carnivores, herbivores, and plants.",
  ],
};

/** Stage one ecosim world with the brain under study driving the subject archetype. */
async function stage(shippedBrains: ShippedBrainDefs, staging: WorldStaging): Promise<RehearsalWorld> {
  const role = staging.subject as Archetype;
  /** The creature under study; unset until its first spawn. */
  let underStudy: Actor | undefined;
  /** Every brain document that has driven a creature through a step of this world. */
  const executed = new Set<IBrainDef>();

  const world = await createRehearsalWorld({
    environment: staging.environment,
    next: staging.next,
    shippedBrains,
    brains: { [role]: staging.subjectBrain },
    scripted: { inputs: staging.inputs, subject: () => underStudy },
    observer: {
      // The first actor spawned in the subject role is the creature under
      // study; later ones run their brains unobserved.
      onSpawn: (actor: Actor) => {
        if (actor.archetype !== role || underStudy !== undefined) return;
        underStudy = actor;
        staging.observeSubject({
          brain: actor.brain,
          runs: (ctx) => getSelf(ctx) === underStudy,
        });
      },
    },
  });

  return {
    // A step runs the creatures standing when it opens.
    step: () => {
      for (const actor of world.actors()) executed.add(actor.brainDef);
      world.step();
    },
    subjectPresent: () => world.actors().some((actor) => actor === underStudy),
    participants: () => world.actors().length,
    brainsExecuted: () => executed.size,
    shutdown: () => world.shutdown(),
  };
}

/**
 * The ecosim world driver: a whole seeded world of creatures, stepped at a
 * fixed timestep, populated by the brains `shippedBrains` carries.
 */
function createDriver(shippedBrains: ShippedBrainDefs): WorldDriver {
  return {
    modules: () => [createEcosimModule()],
    subjects: () => [...ARCHETYPE_NAMES],
    inputKinds: () => SCENARIO_INPUT_KINDS,
    stage: (staging) => stage(shippedBrains, staging),
  };
}

/**
 * The ecosim target adapter: installs the ecosim module for authoring, and
 * rehearses a brain by running a whole ecosim world headlessly with the brain
 * under study driving one archetype's population.
 *
 * @param content The app assets the adapter rehearses over; defaults to the
 * content this module graph was built with.
 */
export function createTargetAdapter(content: RehearsalContent = injectedContent()): TargetAdapter {
  return createRehearsalAdapter({
    targetIdentity: content.targetIdentity,
    manifest: MANIFEST,
    tileDocs: () => pairTileDocs(content.tileDocs, appTileDocs),
    driver: createDriver(content.shippedBrains),
  });
}
