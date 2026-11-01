import { z } from "zod";

/** Why the API service refused a request. */
export const ApiErrorCode = {
  /**
   * The request carries no account session, or one that has ended or expired:
   * no session cookie, or bearer material the service does not hold. Answered
   * with status 401. The client shows the signed-out state.
   */
  Unauthenticated: "unauthenticated",
  /**
   * The handoff code cannot be redeemed: unknown, already redeemed, expired, or
   * presented with a verifier that does not hash to the challenge it was minted
   * for. Answered with status 400. The client runs the handoff again from the
   * start.
   */
  HandoffInvalid: "handoff_invalid",
} as const;

/** Why the API service refused a request. */
export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** The body of every refusal the API service answers with. */
export interface ApiError {
  readonly code: ApiErrorCode;
  /** Human-readable context; the code is the contract. */
  readonly message?: string;
}

/**
 * Schema of {@link ApiError}. Refuses a code the contract does not define and
 * any field it does not name.
 */
export const apiErrorSchema = z.strictObject({
  code: z.enum(ApiErrorCode),
  message: z.string().optional(),
});
