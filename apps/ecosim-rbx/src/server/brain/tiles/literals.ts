import { BrainTileLiteralDef, mkNativeStructValue, type WendooModuleApi } from "@wendoo/core/app";
import { getSelf, getTargetActor } from "../execution-context-types";
import { TargetActorCapabilityBitSet } from "../tileids";
import { EcosimTypeIds, mkVector2Origin, VECTOR2_ORIGIN_KEY } from "../type-system";

/**
 * Registers the `[me]` and `[it]` actor-reference literal tiles and the
 * `[origin]` `Vector2` literal tile.
 *
 * @param api - The module registration API.
 */
export function registerLiteralTiles(api: WendooModuleApi) {
  const meVisual = {
    label: "me",
  };
  const itVisual = {
    label: "it",
  };

  api.registerTile(
    new BrainTileLiteralDef(
      EcosimTypeIds.ActorRef,
      mkNativeStructValue(EcosimTypeIds.ActorRef, getSelf),
      {
        metadata: meVisual,
        persist: false,
        valueLabel: "me",
      },
      api.brainServices
    )
  );
  api.registerTile(
    new BrainTileLiteralDef(
      EcosimTypeIds.ActorRef,
      mkNativeStructValue(EcosimTypeIds.ActorRef, getTargetActor),
      {
        metadata: itVisual,
        persist: false,
        valueLabel: "it",
        requirements: TargetActorCapabilityBitSet,
      },
      api.brainServices
    )
  );
  api.registerTile(
    new BrainTileLiteralDef(
      EcosimTypeIds.Vector2,
      mkVector2Origin(),
      {
        metadata: { label: VECTOR2_ORIGIN_KEY },
        persist: false,
        valueLabel: VECTOR2_ORIGIN_KEY,
      },
      api.brainServices
    )
  );
}
