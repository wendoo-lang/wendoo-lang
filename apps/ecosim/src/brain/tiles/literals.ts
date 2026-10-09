import { BrainTileLiteralDef, mkNativeStructValue, type WendooModuleApi } from "@wendoo/core/app";
import { getSelf, getTargetActor } from "../execution-context-types";
import { ICON_BASE } from "../icon-base";
import { TargetActorCapabilityBitSet } from "../tileids";
import { EcosimTypeIds, mkVector2Origin, VECTOR2_ORIGIN_KEY } from "../type-system";

export function registerLiteralTiles(api: WendooModuleApi) {
  const meVisual = {
    label: "me",
    iconUrl: `${ICON_BASE}/actor-mask.svg`,
  };
  const itVisual = {
    label: "it",
    iconUrl: `${ICON_BASE}/actor-mask.svg`,
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
        metadata: { label: VECTOR2_ORIGIN_KEY, iconUrl: `${ICON_BASE}/vector2.svg` },
        persist: false,
        valueLabel: VECTOR2_ORIGIN_KEY,
      },
      api.brainServices
    )
  );
}
