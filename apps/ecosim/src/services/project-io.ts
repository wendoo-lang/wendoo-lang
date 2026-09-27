import { buildActiveProjectExportDocument, type ImportAppChunkResult, type ProjectManager } from "@wendoo/app-host";
import type { Archetype } from "@/brain/actor";
import { ARCHETYPES } from "@/brain/archetypes";
import type { Obstacle } from "@/brain/vision";
import { defaultDesiredCounts } from "@/brain/world-definition";
import { name as simName } from "../../package.json";

/** Project app-data key holding the desired population per archetype, as a JSON record. */
export const DESIRED_COUNTS_KEY = "actors";

/** Project app-data key holding the scene's obstacles, as a JSON array. */
export const OBSTACLES_KEY = "obstacles";

/** Project app-data key holding the stored brains, keyed by archetype. */
const BRAINS_KEY = "brains";

/** One actor roster entry of the sim's session chunk in a shared `.wendoo` document. */
export interface EcosimAppChunkActor {
  /** Archetype name of the roster entry. */
  archetype: string;
  /** Brain key flashed onto the archetype, or `null` when it has no brain. */
  brain: string | null;
  /** Number of live instances the scene keeps for the archetype. */
  desiredCount: number;
}

/** The sim's session chunk inside a document manifest's `app` map: actor roster and obstacles. */
export interface EcosimAppChunk {
  actors: EcosimAppChunkActor[];
  obstacles?: Obstacle[];
}

/**
 * Reads obstacles from untrusted JSON: keeps each entry with finite numeric
 * geometry and a positive size, and drops the rest. Returns `undefined` when
 * `value` is not an array.
 */
export function parseObstacles(value: unknown): Obstacle[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Obstacle[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const o = entry as Partial<Obstacle>;
    if (
      typeof o.x === "number" &&
      typeof o.y === "number" &&
      typeof o.width === "number" &&
      typeof o.height === "number" &&
      Number.isFinite(o.x) &&
      Number.isFinite(o.y) &&
      Number.isFinite(o.width) &&
      Number.isFinite(o.height) &&
      o.width > 0 &&
      o.height > 0
    ) {
      const rotation = typeof o.rotation === "number" && Number.isFinite(o.rotation) ? o.rotation : undefined;
      result.push({ x: o.x, y: o.y, width: o.width, height: o.height, rotation });
    }
  }
  return result;
}

/**
 * Reads the stored desired-counts record: each archetype takes its stored
 * count rounded and clamped to 0-100, or its default when the record lacks a
 * finite number for it. Absent or unparseable text yields the defaults.
 *
 * @param raw - The {@link DESIRED_COUNTS_KEY} app-data text, if any.
 */
export function parseDesiredCounts(raw: string | undefined): Record<Archetype, number> {
  const counts = defaultDesiredCounts();
  if (!raw) return counts;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<Archetype, number>>;
    for (const key of Object.keys(counts) as Archetype[]) {
      const value = parsed[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        counts[key] = Math.max(0, Math.min(100, Math.round(value)));
      }
    }
  } catch {
    // corrupted data -- fall back to defaults
  }
  return counts;
}

/**
 * Reads the stored brain record as an object keyed by brain key. Absent,
 * unparseable, or non-object text yields an empty record.
 *
 * @param raw - The stored brains app-data text, if any.
 */
function parseBrainRecord(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // corrupted brain data -- yields an empty record
  }
  return {};
}

/**
 * Builds the sim's session chunk: one roster entry per archetype, naming the
 * archetype as its brain when `brains` holds one, plus the obstacles when
 * there are any.
 *
 * @param brains - Stored brains keyed by archetype.
 * @param desiredCounts - Live instance count per archetype; a missing archetype counts 0.
 * @param obstacles - Scene obstacles; omitted from the chunk when empty.
 */
export function buildEcosimAppChunk(
  brains: Readonly<Record<string, unknown>>,
  desiredCounts: Partial<Record<Archetype, number>>,
  obstacles: readonly Obstacle[] | undefined
): EcosimAppChunk {
  const actors: EcosimAppChunkActor[] = [];
  for (const archetype of Object.keys(ARCHETYPES)) {
    actors.push({
      archetype,
      brain: archetype in brains ? archetype : null,
      desiredCount: desiredCounts[archetype as Archetype] ?? 0,
    });
  }

  const chunk: EcosimAppChunk = { actors };
  if (obstacles && obstacles.length > 0) {
    chunk.obstacles = obstacles.map((obstacle) => ({
      x: obstacle.x,
      y: obstacle.y,
      width: obstacle.width,
      height: obstacle.height,
      ...(obstacle.rotation !== undefined ? { rotation: obstacle.rotation } : {}),
    }));
  }
  return chunk;
}

/**
 * Builds the sim's session chunk from the project's app-data entries: the
 * stored brains, desired counts, and obstacles. Returns `undefined` when the
 * entries hold neither desired counts nor obstacles.
 *
 * @param appData - The project's app-data entries, keyed by app-data key.
 */
export function ecosimAppChunkFromAppData(appData: ReadonlyMap<string, string>): EcosimAppChunk | undefined {
  const countsRaw = appData.get(DESIRED_COUNTS_KEY);
  const obstaclesRaw = appData.get(OBSTACLES_KEY);
  if (countsRaw === undefined && obstaclesRaw === undefined) {
    return undefined;
  }
  let obstacles: Obstacle[] | undefined;
  try {
    obstacles = obstaclesRaw ? parseObstacles(JSON.parse(obstaclesRaw) as unknown) : undefined;
  } catch {
    // corrupted obstacle data -- the chunk carries none
  }
  return buildEcosimAppChunk(parseBrainRecord(appData.get(BRAINS_KEY)), parseDesiredCounts(countsRaw), obstacles);
}

/**
 * Translates the sim's session chunk from a shared document or a project
 * manifest into app-data entries: the roster's desired counts (rounded and
 * clamped to 0-100) and the obstacles. A chunk with no actor roster yields an
 * error diagnostic and no app data; unknown archetypes and malformed obstacle
 * data yield warnings.
 */
export function translateEcosimAppChunk(app: unknown): ImportAppChunkResult {
  const diagnostics: { severity: "error" | "warning"; message: string }[] = [];
  const appData = app as { actors?: unknown[]; obstacles?: unknown } | null;
  if (!appData?.actors || !Array.isArray(appData.actors) || appData.actors.length === 0) {
    return {
      diagnostics: [{ severity: "error", message: "No actor data found in the sim's app chunk." }],
    };
  }

  const counts: Record<string, number> = {};
  for (const entry of appData.actors) {
    const actorEntry = entry as { archetype?: string; desiredCount?: number } | null;
    if (!actorEntry?.archetype || !(actorEntry.archetype in ARCHETYPES)) {
      diagnostics.push({
        severity: "warning",
        message: `Skipped unknown archetype: "${actorEntry?.archetype ?? "(none)"}".`,
      });
      continue;
    }
    if (typeof actorEntry.desiredCount === "number") {
      counts[actorEntry.archetype] = Math.max(0, Math.min(100, Math.round(actorEntry.desiredCount)));
    }
  }

  const importedAppData: Record<string, string> = { [DESIRED_COUNTS_KEY]: JSON.stringify(counts) };
  if (appData.obstacles !== undefined) {
    const obstacles = parseObstacles(appData.obstacles);
    if (obstacles) {
      importedAppData[OBSTACLES_KEY] = JSON.stringify(obstacles);
    } else {
      diagnostics.push({
        severity: "warning",
        message: "Ignored malformed obstacle data in the sim's app chunk.",
      });
    }
  }

  return {
    diagnostics,
    appData: importedAppData,
  };
}

/**
 * Builds a shared `.wendoo` document string for the active project: the
 * common export document with the sim's session chunk embedded in the
 * manifest's `app` map under the sim's own key. Chunks stored for other apps
 * are preserved.
 *
 * @param projectManager - Manager holding the active project to export.
 * @param desiredCounts - Live instance count per archetype for the roster.
 * @param obstacles - Scene obstacles; omitted from the chunk when empty.
 */
export async function buildEcosimExportDocument(
  projectManager: ProjectManager,
  desiredCounts: Partial<Record<Archetype, number>>,
  obstacles: readonly Obstacle[] | undefined
): Promise<string> {
  let brains: Record<string, unknown> = {};
  try {
    brains = parseBrainRecord(await projectManager.loadAppData(BRAINS_KEY));
  } catch {
    // unreadable brain data -- export an empty roster mapping
  }

  const doc = await buildActiveProjectExportDocument(projectManager, {
    appChunk: { name: simName, chunk: buildEcosimAppChunk(brains, desiredCounts, obstacles) },
  });
  return JSON.stringify(doc, null, 2);
}
