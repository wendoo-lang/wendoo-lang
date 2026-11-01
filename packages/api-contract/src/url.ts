/**
 * `path` appended to the origin and pathname of `base`, whatever slash `base`
 * ends with; the query and fragment of `base` are not carried. Throws a
 * `TypeError` when `base` is not an absolute URL.
 */
export function urlUnder(base: string, path: string): URL {
  const parsed = new URL(base);
  const url = new URL(parsed.origin);
  url.pathname = `${parsed.pathname.replace(/\/+$/, "")}${path}`;
  return url;
}
