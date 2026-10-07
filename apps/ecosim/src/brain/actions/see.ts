import {
  bag,
  CoreTypeIds,
  type CreateHostSensorOptions,
  choice,
  type ExecutionContext,
  extractNumberValue,
  FALSE_VALUE,
  getSlotId,
  List,
  logger,
  type ModifierTileInput,
  mkCallDef,
  mkListValue,
  mkNumberValue,
  mod,
  optional,
  type ReadonlyList,
  repeated,
  setRuleVariable,
  TRUE_VALUE,
  type Value,
  Vector2,
} from "@wendoo/core/app";
import { EcosimHostActions } from "@/brain/abi-ids";
import { hasArg } from "@/brain/actions/utils";
import type { Archetype } from "@/brain/actor";
import { getSelf } from "@/brain/execution-context-types";
import { ICON_BASE } from "@/brain/icon-base";
import { SeeSensorCapabilityBitSet, TileIds } from "@/brain/tileids";
import { mkVector2Value } from "@/brain/type-system";
import type { SightResult } from "@/brain/vision";

const Carnivore = mod(TileIds.Modifier.ActorKindCarnivore);
const Herbivore = mod(TileIds.Modifier.ActorKindHerbivore);
const Plant = mod(TileIds.Modifier.ActorKindPlant);
const Nearby = mod(TileIds.Modifier.DistanceNearby);
const FarAway = mod(TileIds.Modifier.DistanceFarAway);

const callDef = mkCallDef(
  bag(
    optional(choice(Carnivore, Herbivore, Plant)),
    optional(choice(repeated(Nearby, { max: 3 }), repeated(FarAway, { max: 3 })))
  )
);

const kActorKindCarnivoreSlotId = getSlotId(callDef, Carnivore);
const kActorKindHerbivoreSlotId = getSlotId(callDef, Herbivore);
const kActorKindPlantSlotId = getSlotId(callDef, Plant);
const kDistanceNearbySlotId = getSlotId(callDef, Nearby);
const kDistanceFarAwaySlotId = getSlotId(callDef, FarAway);

const kNearbyDistanceThresholdSq = 100 * 100; // 100 pixels
const kFarAwayDistanceThresholdSq = 300 * 300; // 300 pixels

function execSee(ctx: ExecutionContext, args: ReadonlyList<Value>): Value {
  try {
    // Get the Actor from the execution context (optional - sensor can work without it)
    const self = getSelf(ctx);

    if (!self) {
      console.warn("See sensor invoked without an actor in context");
      return FALSE_VALUE;
    }

    // Check if there are any bumps in the actor's bump queue
    const hasSeen = self.sightQueue.length > 0;

    if (!hasSeen) {
      return FALSE_VALUE;
    }

    const bHasCarnivoreFilter = hasArg(args, kActorKindCarnivoreSlotId);
    const bHasHerbivoreFilter = hasArg(args, kActorKindHerbivoreSlotId);
    const bHasPlantFilter = hasArg(args, kActorKindPlantSlotId);
    let nearbyThresholdSq = kNearbyDistanceThresholdSq;
    let farAwayThresholdSq = kFarAwayDistanceThresholdSq;
    const nearbyCount = extractNumberValue(args.at(kDistanceNearbySlotId)) ?? 0;
    const farAwayCount = extractNumberValue(args.at(kDistanceFarAwaySlotId)) ?? 0;
    if (nearbyCount > 0) {
      // decrease nearby threshold for each additional nearby modifier (e.g., "see herbivore nearby nearby" is more restrictive than "see herbivore nearby")
      nearbyThresholdSq = kNearbyDistanceThresholdSq / nearbyCount;
    }
    if (farAwayCount > 0) {
      // increase far away threshold for each additional far away modifier (e.g., "see herbivore far away far away" is more restrictive than "see herbivore far away")
      farAwayThresholdSq = kFarAwayDistanceThresholdSq * farAwayCount;
    }

    let sightResult: SightResult | undefined;
    let archetype: Archetype | undefined;

    if (bHasCarnivoreFilter) {
      archetype = "carnivore";
    } else if (bHasHerbivoreFilter) {
      archetype = "herbivore";
    } else if (bHasPlantFilter) {
      archetype = "plant";
    }

    // Build the filtered list in a single pass, avoiding redundant getActorById
    // lookups and distance recomputations.  Uses distanceSq already present on
    // each SightResult (populated by queryVisibleActors).  The sight queue
    // persists between vision refreshes, so it can hold actors the engine has
    // killed since; those are skipped.
    const filteredSightQueue: SightResult[] = [];

    const needsArchetypeFilter = archetype !== undefined;
    const needsNearby = nearbyCount > 0;
    const needsFarAway = !needsNearby && farAwayCount > 0;

    for (let i = 0; i < self.sightQueue.length; i++) {
      const sr = self.sightQueue[i];
      if (sr.actor.isDying) continue;
      if (needsArchetypeFilter && sr.actor.archetype !== archetype) continue;
      if (needsNearby && sr.distanceSq > nearbyThresholdSq) continue;
      if (needsFarAway && sr.distanceSq < farAwayThresholdSq) continue;
      filteredSightQueue.push(sr);
    }

    if (filteredSightQueue.length > 0) {
      // Find the nearest actor in the (unsorted) filtered list -- O(n) scan
      let nearestIdx = 0;
      let nearestDistSq = filteredSightQueue[0].distanceSq;
      for (let i = 1; i < filteredSightQueue.length; i++) {
        if (filteredSightQueue[i].distanceSq < nearestDistSq) {
          nearestDistSq = filteredSightQueue[i].distanceSq;
          nearestIdx = i;
        }
      }
      sightResult = filteredSightQueue[nearestIdx];
    }

    if (!sightResult) {
      return FALSE_VALUE; // No seen actor passed the filters (if any)
    }

    const seenActor = sightResult.actor;
    let targetPos: Vector2;
    try {
      targetPos = new Vector2(seenActor.sprite.x, seenActor.sprite.y);
    } catch (error) {
      return FALSE_VALUE;
    }

    // Store targets for the DO side to access
    const seenActors = filteredSightQueue.filter((sr) => !!sr.actor.sprite.body).map((sr) => sr.actor);
    setRuleVariable(
      ctx,
      "targetActors",
      mkListValue("", List.from(seenActors.map((actor) => mkNumberValue(actor.actorId))))
    );
    setRuleVariable(
      ctx,
      "targetPositions",
      mkListValue(
        "",
        List.from(seenActors.map((actor) => mkVector2Value(ctx, new Vector2(actor.sprite.x, actor.sprite.y))))
      )
    );
    setRuleVariable(ctx, "targetActor", mkNumberValue(seenActor.actorId));
    setRuleVariable(ctx, "targetPos", mkVector2Value(ctx, targetPos));
    self.debugTargetPositions.set(seenActor.actorId, targetPos);
    return TRUE_VALUE;
  } catch (error) {
    logger.error("Error executing see sensor:", error);
    return FALSE_VALUE;
  }
}

export default {
  ...EcosimHostActions.See,
  callDef,
  fn: {
    exec: execSee,
  },
  isAsync: false,
  outputType: CoreTypeIds.Boolean,
  metadata: { label: "see", iconUrl: `${ICON_BASE}/see.svg` },
  capabilities: SeeSensorCapabilityBitSet,
} satisfies CreateHostSensorOptions;

export const modifiers: ModifierTileInput[] = [
  {
    id: TileIds.Modifier.ActorKindCarnivore,
    label: "carnivore",
    iconUrl: `${ICON_BASE}/carnivore.svg`,
    language: { form: "a carnivore" },
  },
  {
    id: TileIds.Modifier.ActorKindHerbivore,
    label: "herbivore",
    iconUrl: `${ICON_BASE}/herbivore.svg`,
    language: { form: "a herbivore" },
  },
  {
    id: TileIds.Modifier.ActorKindPlant,
    label: "plant",
    iconUrl: `${ICON_BASE}/plant.svg`,
    language: { form: "a plant" },
  },
  { id: TileIds.Modifier.DistanceNearby, label: "nearby", iconUrl: `${ICON_BASE}/nearby.svg` },
  { id: TileIds.Modifier.DistanceFarAway, label: "far away", iconUrl: `${ICON_BASE}/faraway.svg` },
];
