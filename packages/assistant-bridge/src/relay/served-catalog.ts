import { z } from "zod";
import { CatalogScope } from "../catalog/scope.js";
import type { CatalogGroup } from "../tools/read-catalog.js";

/**
 * One tile of a `read_catalog` answer, as it comes off the wire. A field the
 * answer carries that this schema does not name is kept as it arrived.
 */
const servedTileSchema = z.looseObject({
  tileId: z.string(),
  label: z.string(),
  kind: z.string(),
  description: z.string().optional(),
  assistant: z.string().optional(),
  outputType: z.string().optional(),
  args: z.string().optional(),
  placement: z.array(z.string()),
  requires: z.array(z.string()),
  provides: z.array(z.string()),
  outputs: z.array(z.string()),
  consumesWhenResult: z.string().optional(),
  hidden: z.boolean().optional(),
  deprecated: z.boolean().optional(),
});

/** One scope's tiles of a `read_catalog` answer, as they come off the wire. */
const servedGroupSchema = z.object({
  scope: z.enum(CatalogScope),
  tiles: z.array(servedTileSchema),
});

/** A `read_catalog` answer, as much of it as a served catalog is read out of. */
const servedCatalogSchema = z.object({ groups: z.array(servedGroupSchema) });

/**
 * The catalog groups `payload` carries, as a `read_catalog` answer states them;
 * `undefined` when it is not that answer, which includes a group naming a scope
 * this build does not know and a tile missing a field every tile carries. Each
 * tile keeps every field it arrived with, so a catalog read here serializes to
 * the bytes the client that answered serializes the same tiles to.
 */
export function readServedCatalog(payload: unknown): readonly CatalogGroup[] | undefined {
  const parsed = servedCatalogSchema.safeParse(payload);
  return parsed.success ? parsed.data.groups : undefined;
}
