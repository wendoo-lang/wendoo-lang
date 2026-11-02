import { z } from "zod";
import { ApiErrorCode } from "./errors.js";

/**
 * Version of the account routes this package defines. Every route path carries
 * it as its `/account/v<version>/` prefix, so a service answering another
 * version answers none of these paths.
 */
export const API_CONTRACT_VERSION = 1;

/**
 * Path of each account route, relative to the API service base URL the client
 * is configured with: appended to the base URL's origin and pathname, whatever
 * slash that pathname ends with.
 *
 * Every route authenticates its request by EITHER the account-session cookie
 * (a client on the API service's own site) OR an `Authorization: Bearer
 * <material>` header carrying handoff material (a client on another site). The
 * routes answer the same way whichever one the request carries.
 *
 * A request authenticated by the account-session cookie is accepted only when
 * its `Origin` header names an origin the API service has registered for the
 * client -- the same registration the redirect allowlist and the handoff's
 * `targetOrigin` use. A cookie-authenticated request from any other origin, or
 * a POST with no `Origin` header, is treated as carrying no account session:
 * refused `unauthenticated` by the routes that refuse, and ending nothing at
 * sign-out. A bearer-authenticated request is not subject to the check.
 */
export const AccountRoutePath = {
  Me: "/account/v1/me",
  Tickets: "/account/v1/tickets",
  SignOut: "/account/v1/sign-out",
  HandoffRedeem: "/account/v1/handoff/redeem",
} as const;

/** Path of an account route, relative to the API service base URL. */
export type AccountRoutePath = (typeof AccountRoutePath)[keyof typeof AccountRoutePath];

/** A principal's role in the account it belongs to. */
export const AccountRole = {
  /** Purchases, invites, removes, transfers ownership, and deletes the account. */
  Owner: "owner",
  /** Signs in for themselves and spends from the account's wallet. */
  Member: "member",
} as const;

/** A principal's role in the account it belongs to. */
export type AccountRole = (typeof AccountRole)[keyof typeof AccountRole];

/** The account's wallet, as a principal sees it. */
export interface MeWallet {
  /**
   * Credits available for new model requests: a whole number, never negative.
   * Zero is an ordinary value; it refuses only model requests.
   */
  readonly availableCredits: number;
}

/** Schema of {@link MeWallet}. Refuses a figure that is negative or not whole, and any field it does not name. */
export const meWalletSchema = z.strictObject({
  availableCredits: z.number().int().nonnegative(),
}) satisfies z.ZodType<MeWallet>;

/**
 * The account site's pages for the account, as absolute `http` or `https` URLs
 * the API service supplies. A client opens a link as it is and never builds
 * one.
 *
 * Every link lies on the origin of the account site URL the client is
 * configured with; a view carrying a link on any other origin is malformed.
 */
export interface MeLinks {
  /** The page where the principal manages their account. */
  readonly manage: string;
  /** The page where the principal adds credits to the account's wallet. */
  readonly refill: string;
}

/** Schema of {@link MeLinks}. Refuses a link that is not an absolute `http` or `https` URL, and any field it does not name. */
export const meLinksSchema = z.strictObject({
  manage: z.url({ protocol: /^https?$/ }),
  refill: z.url({ protocol: /^https?$/ }),
}) satisfies z.ZodType<MeLinks>;

/** The account a signed-in principal belongs to, as the principal sees it. */
export interface MeAccount {
  /** Opaque identifier of the account. */
  readonly id: string;
  readonly role: AccountRole;
  readonly wallet: MeWallet;
  readonly links: MeLinks;
}

/** The signed-in principal, as `GET` {@link AccountRoutePath.Me} answers it. */
export interface MeView {
  /** The principal's stable opaque subject identifier. */
  readonly principalId: string;
  /**
   * The principal's display name. The API service always supplies one: the
   * name the principal chose, or a fallback where they chose none.
   */
  readonly displayName: string;
  readonly account: MeAccount;
}

/** Schema of {@link MeView}. Refuses any field it does not name. */
export const meViewSchema = z.strictObject({
  principalId: z.string().min(1),
  displayName: z.string().min(1),
  account: z.strictObject({
    id: z.string().min(1),
    role: z.enum(AccountRole),
    wallet: meWalletSchema,
    links: meLinksSchema,
  }),
}) satisfies z.ZodType<MeView>;

/**
 * A connection ticket, as `POST` {@link AccountRoutePath.Tickets} answers it.
 * Single-use: a harness connection spends it in its connect message, and every
 * new connection asks for a fresh one.
 */
export interface TicketGrant {
  /**
   * The ticket, opaque to the client. It carries the principal and the
   * account for the harness service; the client never parses it and presents
   * it only as the connect message's `ticket`.
   */
  readonly ticket: string;
  /** ISO-8601 instant after which the harness service refuses the ticket. */
  readonly expiresAt: string;
}

/** Schema of {@link TicketGrant}. Refuses any field it does not name. */
export const ticketGrantSchema = z.strictObject({
  ticket: z.string().min(1),
  expiresAt: z.iso.datetime(),
}) satisfies z.ZodType<TicketGrant>;

/** The body of `POST` {@link AccountRoutePath.HandoffRedeem}. */
export interface HandoffRedeemRequest {
  /** The handoff code the account site posted to the client. */
  readonly code: string;
  /** The verifier whose challenge the client opened the account site with. */
  readonly verifier: string;
}

/** Schema of {@link HandoffRedeemRequest}. Refuses any field it does not name. */
export const handoffRedeemRequestSchema = z.strictObject({
  code: z.string().min(1),
  verifier: z.string().min(1),
}) satisfies z.ZodType<HandoffRedeemRequest>;

/** What redeeming a handoff code grants a client on another site. */
export interface HandoffGrant {
  /**
   * Bearer material for the account session the handoff completed. Opaque to
   * the client, held only in memory, and presented as `Authorization: Bearer
   * <material>` until {@link expiresAt}.
   */
  readonly material: string;
  /** ISO-8601 instant after which the API service refuses the material. */
  readonly expiresAt: string;
}

/** Schema of {@link HandoffGrant}. Refuses any field it does not name. */
export const handoffGrantSchema = z.strictObject({
  material: z.string().min(1),
  expiresAt: z.iso.datetime(),
}) satisfies z.ZodType<HandoffGrant>;

/** HTTP method an account route answers. */
export type AccountRouteMethod = "GET" | "POST";

/**
 * One HTTP route of the account contract. A success answers status 200 with a
 * body {@link response} parses, or status 204 with no body when
 * {@link response} is `null`. A refusal answers a non-2xx status with a body
 * `apiErrorSchema` parses, carrying one of {@link errors}.
 */
export interface AccountRoute {
  readonly method: AccountRouteMethod;
  readonly path: AccountRoutePath;
  /** Schema of the JSON request body, or `null` for a request that sends none. */
  readonly request: z.ZodType | null;
  /** Schema of the JSON success body, or `null` for a 204 that sends none. */
  readonly response: z.ZodType | null;
  /** Every code the route may refuse with; empty for a route that never refuses. */
  readonly errors: readonly ApiErrorCode[];
}

/** Every route of the account contract, by name. */
export const accountRoutes = {
  /** The signed-in principal and its account. */
  me: {
    method: "GET",
    path: AccountRoutePath.Me,
    request: null,
    response: meViewSchema,
    errors: [ApiErrorCode.Unauthenticated],
  },
  /** Mint a connection ticket for the signed-in principal. */
  tickets: {
    method: "POST",
    path: AccountRoutePath.Tickets,
    request: null,
    response: ticketGrantSchema,
    errors: [ApiErrorCode.Unauthenticated],
  },
  /**
   * End the account session the request carries, and every harness connection
   * bound to its principal. Idempotent: a request carrying no live session
   * answers 204 as well.
   */
  signOut: {
    method: "POST",
    path: AccountRoutePath.SignOut,
    request: null,
    response: null,
    errors: [],
  },
  /**
   * Redeem a handoff code for bearer material. Refuses `handoff_invalid` for a
   * code it cannot redeem, and `unauthenticated` when the account session the
   * code was minted under has ended since.
   */
  handoffRedeem: {
    method: "POST",
    path: AccountRoutePath.HandoffRedeem,
    request: handoffRedeemRequestSchema,
    response: handoffGrantSchema,
    errors: [ApiErrorCode.HandoffInvalid, ApiErrorCode.Unauthenticated],
  },
} as const satisfies Readonly<Record<string, AccountRoute>>;
