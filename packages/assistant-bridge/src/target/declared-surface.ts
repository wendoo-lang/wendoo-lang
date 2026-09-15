import type { CoreBuild } from "@wendoo/core";
import { z } from "zod";
import type { ScenarioInputKind, SubjectStateChannel, TargetAdapter, TargetManifest } from "./adapter.js";

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
}) satisfies z.ZodType<TargetManifest>;

/** One scenario input kind, as {@link TargetAdapter.inputKinds} states it. */
const scenarioInputKindSchema = z.object({
  name: z.string(),
  description: z.string(),
}) satisfies z.ZodType<ScenarioInputKind>;

/**
 * One subject state channel, as {@link TargetAdapter.stateChannels} states it,
 * carrying the parts of it that are data.
 */
const subjectStateChannelSchema = z.object({
  name: z.string(),
  description: z.string(),
}) satisfies z.ZodType<SubjectStateChannel>;

/** The language build an adapter artifact bundles. */
const buildStampSchema = z.object({
  coreVersion: z.string(),
  coreDistHash: z.string(),
}) satisfies z.ZodType<CoreBuild>;

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
  inputKinds: z.array(scenarioInputKindSchema),
  /** State channels of the subject the target reports per think; empty when it reports none. */
  stateChannels: z.array(subjectStateChannelSchema),
});

/** The baked declarative surface of a target package. */
export type DeclaredSurface = z.infer<typeof declaredSurfaceSchema>;

/** Why a baked declared-surface document could not be read. */
export const DeclaredSurfaceReadCode = {
  /** The document states a format version other than {@link DECLARED_SURFACE_FORMAT_VERSION}. */
  UnsupportedFormatVersion: "declared_surface_unsupported_format_version",
  /** The document states no readable format version, or does not match the format. */
  Malformed: "declared_surface_malformed",
} as const;

/** Why a baked declared-surface document could not be read. */
export type DeclaredSurfaceReadCode = (typeof DeclaredSurfaceReadCode)[keyof typeof DeclaredSurfaceReadCode];

/** One reason a document is not a readable declared surface, machine-readable first. */
export interface DeclaredSurfaceRejection {
  readonly code: DeclaredSurfaceReadCode;
  /** Human-readable context; the code is the contract. */
  readonly detail: string;
}

/** The declared surface a document carries, or why it carries none this reader can use. */
export type DeclaredSurfaceReadResult =
  | { readonly ok: true; readonly surface: DeclaredSurface }
  | { readonly ok: false; readonly rejection: DeclaredSurfaceRejection };

/** The one field read off a document before the format it is written in is known. */
const formatVersionEnvelopeSchema = z.object({ formatVersion: z.number().int().positive() });

/**
 * Read `document` as a baked declared surface. The format version is read off
 * the document first and must equal {@link DECLARED_SURFACE_FORMAT_VERSION};
 * both an older and a newer document are refused with
 * {@link DeclaredSurfaceReadCode.UnsupportedFormatVersion}. A document at this
 * version is then read against the format, and one that does not match it is
 * refused with {@link DeclaredSurfaceReadCode.Malformed}. Fields this version
 * does not name are accepted and left out of the surface.
 *
 * @param document The parsed JSON of a package's baked declared-surface file.
 */
export function readDeclaredSurface(document: unknown): DeclaredSurfaceReadResult {
  const envelope = formatVersionEnvelopeSchema.safeParse(document);
  if (!envelope.success) {
    return {
      ok: false,
      rejection: { code: DeclaredSurfaceReadCode.Malformed, detail: "the document states no format version" },
    };
  }
  const { formatVersion } = envelope.data;
  if (formatVersion !== DECLARED_SURFACE_FORMAT_VERSION) {
    return {
      ok: false,
      rejection: {
        code: DeclaredSurfaceReadCode.UnsupportedFormatVersion,
        detail: `the document is written at format ${formatVersion}; this reader reads ${DECLARED_SURFACE_FORMAT_VERSION}`,
      },
    };
  }
  const parsed = declaredSurfaceSchema.safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return { ok: false, rejection: { code: DeclaredSurfaceReadCode.Malformed, detail: issues } };
  }
  return { ok: true, surface: parsed.data };
}

/**
 * Serialize what `adapter` declares about its target into the data a target
 * package bakes. A state channel bakes as its name and description only.
 *
 * @param adapter The adapter to read the declarations from.
 * @param buildStamp The language build the artifact publishing `adapter` carries.
 */
export function declaredSurfaceOf(adapter: TargetAdapter, buildStamp: CoreBuild): DeclaredSurface {
  const { target, thing, provides } = adapter.manifest();
  const { coreVersion, coreDistHash } = buildStamp;
  return {
    formatVersion: DECLARED_SURFACE_FORMAT_VERSION,
    targetIdentity: adapter.targetIdentity,
    buildStamp: { coreVersion, coreDistHash },
    manifest: { target, thing, provides: [...provides] },
    subjects: [...adapter.subjects()],
    inputKinds: adapter.inputKinds().map(({ name, description }) => ({ name, description })),
    stateChannels: adapter.stateChannels().map(({ name, description }) => ({ name, description })),
  };
}
