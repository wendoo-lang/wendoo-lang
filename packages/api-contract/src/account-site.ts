import { z } from "zod";
import { base64url } from "./base64url.js";
import { urlUnder } from "./url.js";

/**
 * Path of each page of the account site a client opens, relative to the
 * account site URL the client is configured with.
 */
export const AccountSitePath = {
  /**
   * Sign-in for a client on the API service's own site, navigated to top-level.
   * Takes {@link AccountSiteParam.Client} and {@link AccountSiteParam.ReturnUrl};
   * once the principal is signed in, the account site navigates back to the
   * return URL only when it lies on an origin registered for that client.
   */
  SignIn: "/sign-in",
  /**
   * Sign-in for a client on another site, opened top-level in a popup. Takes
   * {@link AccountSiteParam.Client} and {@link AccountSiteParam.Challenge}; once
   * the principal is signed in, the account site mints a handoff code bound to
   * the challenge and posts it as a {@link HandoffMessage} to `window.opener`,
   * with `targetOrigin` set to the origin registered for that client -- never
   * an origin read from the query string, and leaves the popup open for the
   * client to close. The code is single-use and expires within about a minute.
   */
  Handoff: "/handoff",
} as const;

/** Path of a page of the account site, relative to the account site URL. */
export type AccountSitePath = (typeof AccountSitePath)[keyof typeof AccountSitePath];

/** Query parameters of the account site's pages. */
export const AccountSiteParam = {
  /** The registered client identifier of the editor opening the page. */
  Client: "client",
  /** Absolute URL the sign-in page navigates back to once the principal is signed in. */
  ReturnUrl: "return",
  /** The handoff challenge: {@link handoffChallenge} of the client's verifier. */
  Challenge: "challenge",
} as const;

/** Query parameter of an account site page. */
export type AccountSiteParam = (typeof AccountSiteParam)[keyof typeof AccountSiteParam];

/** `path` on the account site at `accountSiteUrl`, carrying `params` and nothing of the site URL's own query. */
function accountSitePage(accountSiteUrl: string, path: AccountSitePath, params: Record<string, string>): string {
  const url = urlUnder(accountSiteUrl, path);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

/**
 * The URL of the account site's sign-in page for `clientId`, returning to
 * `returnUrl`. Throws a `TypeError` when `accountSiteUrl` is not an absolute
 * URL.
 */
export function signInUrl(accountSiteUrl: string, clientId: string, returnUrl: string): string {
  return accountSitePage(accountSiteUrl, AccountSitePath.SignIn, {
    [AccountSiteParam.Client]: clientId,
    [AccountSiteParam.ReturnUrl]: returnUrl,
  });
}

/**
 * The URL of the account site's handoff page for `clientId`, carrying
 * `challenge`. Throws a `TypeError` when `accountSiteUrl` is not an absolute
 * URL.
 */
export function handoffUrl(accountSiteUrl: string, clientId: string, challenge: string): string {
  return accountSitePage(accountSiteUrl, AccountSitePath.Handoff, {
    [AccountSiteParam.Client]: clientId,
    [AccountSiteParam.Challenge]: challenge,
  });
}

/** SHA-256 digest of `data`, as Web Crypto's `crypto.subtle.digest("SHA-256", data)` computes it. */
export type Sha256 = (data: Uint8Array) => Promise<Uint8Array>;

/**
 * The handoff challenge for `verifier`: the unpadded base64url of the SHA-256
 * digest of the verifier's UTF-8 bytes. The client opens the handoff page with
 * it, and the API service refuses a redeem whose verifier does not derive the
 * code's challenge with `handoff_invalid`.
 */
export async function handoffChallenge(verifier: string, sha256: Sha256): Promise<string> {
  return base64url(await sha256(new TextEncoder().encode(verifier)));
}

/** The `type` of a {@link HandoffMessage}. */
export const HANDOFF_MESSAGE_TYPE = "wendoo:handoff";

/**
 * What the account site's handoff page posts to `window.opener` once the
 * principal is signed in. The client acts only on one whose `event.origin` is
 * its configured account site's origin, and redeems the code with its verifier.
 */
export interface HandoffMessage {
  readonly type: typeof HANDOFF_MESSAGE_TYPE;
  /** The single-use handoff code, bound to the challenge the page was opened with. */
  readonly code: string;
}

/** Schema of {@link HandoffMessage}. Refuses any field it does not name. */
export const handoffMessageSchema = z.strictObject({
  type: z.literal(HANDOFF_MESSAGE_TYPE),
  code: z.string().min(1),
}) satisfies z.ZodType<HandoffMessage>;
