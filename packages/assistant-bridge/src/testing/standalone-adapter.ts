import type { WendooModule } from "@wendoo/core/app";
import type {
  ADAPTER_CONTRACT_VERSION,
  SimulationRun,
  TargetAdapter,
  TargetBuildStamp,
  TargetManifest,
} from "../target/adapter.js";

/** Wendoo identity the standalone adapter reports itself as. */
export const STANDALONE_TARGET_IDENTITY = "example-org/trg-standalone";

/** The one role a standalone rehearsal may put under study. */
export const STANDALONE_SUBJECT = "stand-in";

/** Contract version the standalone adapter reports. */
const contractVersion: typeof ADAPTER_CONTRACT_VERSION = 10;

/** Tile id the standalone adapter ships documentation for. */
const documentedTileId = "tile.standalone";

const manifest: TargetManifest = {
  target: "a world holding one stand-in and nothing else",
  thing: "their stand-in",
  provides: ["A stand-in stands there."],
};

/** The run the standalone adapter answers every request with. */
const emptyRun: SimulationRun = {
  runId: "standalone",
  thinks: 0,
  observations: [],
  world: { initialPopulation: 1, finalPopulation: 1, brainsExecuted: 1 },
};

/**
 * A build stamp for a copy of this module to republish under the `buildStamp`
 * name a loader reads.
 */
export const standaloneBuildStamp: TargetBuildStamp = {
  coreVersion: "0.0.0-standalone",
  coreDistHash: "0".repeat(64),
  builtAt: "2026-01-01T00:00:00.000Z",
};

const adapter: TargetAdapter = {
  contractVersion,
  targetIdentity: STANDALONE_TARGET_IDENTITY,
  manifest: () => manifest,
  modules: (): readonly WendooModule[] => [],
  tileDocs: () => new Map([[documentedTileId, "The stand-in tile, documented by the artifact that carries it."]]),
  subjects: () => [STANDALONE_SUBJECT],
  inputKinds: () => [],
  stateChannels: () => [],
  run: () => Promise.resolve(emptyRun),
};

/**
 * The standalone target adapter: a conforming adapter whose built module
 * imports nothing and loads wherever that module is copied to.
 */
export function createTargetAdapter(): TargetAdapter {
  return adapter;
}
