import { z } from "zod";

/**
 * Envelope every bridge WebSocket message conforms to before its `type`-specific
 * payload is validated against a narrower schema.
 */
export const wsMessageSchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  payload: z.unknown().optional(),
  seq: z.number().optional(),
});

/** Generic envelope for any bridge WebSocket message. */
export type WsMessage = z.infer<typeof wsMessageSchema>;

/**
 * Namespaces of the message types the bridge protocol defines. A message
 * type's namespace is the text before its first `:`, or the whole type when it
 * has no `:`. A message whose namespace is not listed is a payload message:
 * the protocol carries it between the session's endpoints without
 * interpreting it.
 */
export const BRIDGE_PROTOCOL_NAMESPACES: readonly string[] = ["session", "control", "filesystem", "compile", "error"];
