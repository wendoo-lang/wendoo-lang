import { z } from "zod";
import type { TargetAdapter, TargetBuildStamp } from "./adapter.js";

/**
 * Version of the declared-surface format {@link declaredSurfaceOf} writes.
 * Increment it when a reader can no longer make sense of a document written by
 * an older writer. Adding a field does not require an increment.
 */
export const DECLARED_SURFACE_FORMAT_VERSION = 1;

/** Facts about a target world, as {@link TargetAdapter.manifest} states them. */
const targetManifestSchema = z.object({
  target: z.string(),
  thing: z.string(),
  provides: z.array(z.string()),
});

/** One named vocabulary entry with the sentence its target explains it by. */
const namedEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
});

/** The language build an adapter artifact bundles, and the moment it was built. */
const buildStampSchema = z.object({
  coreVersion: z.string(),
  coreDistHash: z.string(),
  builtAt: z.string(),
});

/**
 * The baked declarative surface of a target package: everything a consumer
 * needs of the target that is pure data, so it can serve the target without
 * loading its adapter module.
 *
 * Parsing drops fields the schema does not name, so a document written by a
 * later writer reads here as the fields this version knows.
 */
export const declaredSurfaceSchema = z.object({
  /** {@link DECLARED_SURFACE_FORMAT_VERSION} the document was written at. */
  formatVersion: z.number().int().positive(),
  /** Wendoo identity of the target the surface describes, as its `wendoo.json` declares it. */
  targetIdentity: z.string().min(1),
  /** The build stamp the adapter artifact this surface was baked from publishes. */
  buildStamp: buildStampSchema,
  /** Facts about the target world, as the adapter's own `manifest()` states them. */
  manifest: targetManifestSchema,
  /** Population roles a scenario may name as its subject. */
  subjects: z.array(z.string()),
  /** Scenario input kinds the target reads; empty when it scripts no percepts. */
  inputKinds: z.array(namedEntrySchema),
  /** State channels of the subject the target reports per think; empty when it reports none. */
  stateChannels: z.array(namedEntrySchema),
});

/** The baked declarative surface of a target package. */
export type DeclaredSurface = z.infer<typeof declaredSurfaceSchema>;

/**
 * Serialize what `adapter` declares about its target into the data a target
 * package bakes. A state channel bakes as its name and description only.
 *
 * @param adapter The adapter to read the declarations from.
 * @param buildStamp The stamp the artifact publishing `adapter` carries.
 */
export function declaredSurfaceOf(adapter: TargetAdapter, buildStamp: TargetBuildStamp): DeclaredSurface {
  const { target, thing, provides } = adapter.manifest();
  const { coreVersion, coreDistHash, builtAt } = buildStamp;
  return {
    formatVersion: DECLARED_SURFACE_FORMAT_VERSION,
    targetIdentity: adapter.targetIdentity,
    buildStamp: { coreVersion, coreDistHash, builtAt },
    manifest: { target, thing, provides: [...provides] },
    subjects: [...adapter.subjects()],
    inputKinds: adapter.inputKinds().map(({ name, description }) => ({ name, description })),
    stateChannels: adapter.stateChannels().map(({ name, description }) => ({ name, description })),
  };
}
