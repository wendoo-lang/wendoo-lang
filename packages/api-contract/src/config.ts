import { z } from "zod";

/** How a client reaches the account session. */
export const AccountClientMode = {
  /** The client is on the API service's own site and presents the account-session cookie. */
  SameSite: "same-site",
  /**
   * The client is on another site, where the browser withholds the cookie. It
   * signs in through the handoff and presents the bearer material it redeemed.
   */
  CrossSite: "cross-site",
} as const;

/** How a client reaches the account session. */
export type AccountClientMode = (typeof AccountClientMode)[keyof typeof AccountClientMode];

/** Where a client finds the API service and its account site, and how it reaches them. */
export interface AccountClientConfig {
  /** Absolute URL the account route paths are appended to, with no query string or fragment. */
  readonly baseUrl: string;
  /**
   * Absolute URL of the account site, with no query string or fragment; its
   * origin is the only one a handoff message is accepted from.
   */
  readonly accountSiteUrl: string;
  /** The client identifier the account site has registered for this editor. */
  readonly clientId: string;
  readonly mode: AccountClientMode;
}

/** An absolute `http` or `https` URL carrying no query string and no fragment. */
const baseUrlSchema = z.url({ protocol: /^https?$/ }).refine(
  (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // A URL that does not parse is refused by the URL check alone.
      return true;
    }
    return parsed.search === "" && parsed.hash === "";
  },
  { message: "the URL carries a query string or fragment" }
);

/**
 * Schema of {@link AccountClientConfig}. Refuses a URL that is not absolute
 * `http` or `https` or that carries a query string or fragment, an empty
 * client identifier, and any field it does not name.
 */
export const accountClientConfigSchema = z.strictObject({
  baseUrl: baseUrlSchema,
  accountSiteUrl: baseUrlSchema,
  clientId: z.string().min(1),
  mode: z.enum(AccountClientMode),
}) satisfies z.ZodType<AccountClientConfig>;
