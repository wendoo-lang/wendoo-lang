import type { IncomingMessage } from "node:http";
import type { Context } from "hono";

/**
 * The address of the client that made the request `c`: the first address in
 * its `x-forwarded-for` header, else its `x-real-ip` header, else the remote
 * address of its socket, else `"unknown"`.
 */
export function getClientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp;
  const incoming = (c.env as Record<string, unknown>).incoming as IncomingMessage | undefined;
  return incoming?.socket?.remoteAddress ?? "unknown";
}
