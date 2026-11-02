import type { z } from "zod";
import type { Sha256 } from "../account-site.js";
import { handoffChallenge, handoffMessageSchema, handoffUrl, signInUrl } from "../account-site.js";
import { base64url } from "../base64url.js";
import type { AccountClientConfig } from "../config.js";
import { AccountClientMode, accountClientConfigSchema } from "../config.js";
import { ApiErrorCode, apiErrorSchema } from "../errors.js";
import type { AccountRoute, AccountRouteMethod, HandoffGrant, MeView, TicketGrant } from "../routes.js";
import { accountRoutes } from "../routes.js";
import { urlUnder } from "../url.js";

/** One HTTP request the account client makes, in the shape `fetch`'s `init` takes. */
export interface AccountRequest {
  readonly method: AccountRouteMethod;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON text of the request body; absent for a route that takes none. */
  readonly body?: string;
  /** `include` sends the account-session cookie; `omit` sends none. */
  readonly credentials: "include" | "omit";
  /**
   * The page's origin, as the browser sends it in `Origin`. A browser sets that
   * header itself and `fetch` ignores this field; a transport that is not a
   * browser presents it in the browser's place.
   */
  readonly origin?: string;
}

/** The part of a `fetch` response the account client reads. */
export interface AccountResponse {
  readonly status: number;
  /** The body parsed as JSON. Rejects when the body is not JSON. */
  json(): Promise<unknown>;
}

/** The HTTP transport of the account client. The global `fetch` is one. */
export type AccountFetch = (url: string, init: AccountRequest) => Promise<AccountResponse>;

/** A popup the account client opened on the account site. */
export interface AccountPopup {
  /**
   * The popup's window, as `window.open` returned it, or any token the deps
   * choose: the messages the popup's page posts carry it as their `source`.
   */
  readonly window: unknown;
  /** Resolves once the popup has closed, whoever closed it. */
  readonly closed: Promise<void>;
  /** Close the popup. Closing one already closed does nothing. */
  close(): void;
}

/** A message posted to the client's window, as a `message` event carries it. */
export interface AccountWindowMessage {
  /** Origin of the window that posted it, as `MessageEvent.origin` reports it. */
  readonly origin: string;
  /**
   * The window that posted it, as `MessageEvent.source` reports it. The client
   * compares it by identity with {@link AccountPopup.window}.
   */
  readonly source: unknown;
  readonly data: unknown;
}

/** The browser capabilities the account client acts through. */
export interface AccountClientDeps {
  readonly fetch: AccountFetch;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly now: () => number;
  /** `length` cryptographically random bytes, as `crypto.getRandomValues` fills them. */
  readonly randomBytes: (length: number) => Uint8Array;
  readonly sha256: Sha256;
  /** Open `url` top-level in a popup; `undefined` when the browser refused to open one. */
  readonly openPopup: (url: string) => AccountPopup | undefined;
  /** Call `listener` with every message posted to the client's window until the returned function is called. */
  readonly subscribeToMessages: (listener: (message: AccountWindowMessage) => void) => () => void;
  /** Navigate the client's page top-level to `url`. */
  readonly navigate: (url: string) => void;
  /** The absolute URL of the client's page. */
  readonly currentUrl: () => string;
}

/**
 * What one account call came to: its value; a refusal carrying the contract's
 * code; `needs-sign-in` when a cross-site client holds no unexpired material
 * to present, or the API service refused the material it held as
 * `unauthenticated`; or `unavailable` when the API service could not be
 * reached or answered outside the contract. A same-site client the API service
 * refuses as `unauthenticated` answers that refusal; a cross-site client never
 * does.
 */
export type AccountOutcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly code: ApiErrorCode; readonly message?: string }
  | { readonly kind: "needs-sign-in" }
  | { readonly kind: "unavailable" };

/** What signing out came to: done, or `unavailable` when the API service could not be told. */
export type SignOutOutcome = { readonly kind: "ok" } | { readonly kind: "unavailable" };

/**
 * What a sign-in came to. A same-site client is `navigating`: its page is
 * leaving for the account site and returns signed in. A cross-site client is
 * `signed-in` holding fresh material, `cancelled` when the popup was refused or
 * closed before the account site posted a code, refused with the contract's
 * code, or `unavailable`.
 */
export type SignInOutcome =
  | { readonly kind: "navigating" }
  | { readonly kind: "signed-in" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "error"; readonly code: ApiErrorCode; readonly message?: string }
  | { readonly kind: "unavailable" };

/** A client of the account routes. No method throws; each answers an outcome. */
export interface AccountClient {
  /**
   * The signed-in principal and its account. A view carrying a link on any
   * origin but the configured account site's is answered `unavailable`.
   */
  me(): Promise<AccountOutcome<MeView>>;
  /** A fresh connection ticket for one harness connection. */
  getTicket(): Promise<AccountOutcome<TicketGrant>>;
  /** End the account session. A cross-site client also drops the material it holds, whatever the answer. */
  signOut(): Promise<SignOutOutcome>;
  /**
   * Sign in on the account site: top-level navigation for a same-site client,
   * the handoff popup for a cross-site one. Call it from a user gesture, since
   * a browser refuses a popup opened without one.
   */
  signIn(): Promise<SignInOutcome>;
}

/** Number of random bytes a handoff verifier is drawn from. */
const verifierBytes = 32;

/** How a request authenticates: the cookie, bearer material, or nothing. */
type Credential = { readonly kind: "cookie" } | { readonly kind: "bearer"; readonly material: string } | undefined;

/** The success body `R` answers. */
type RouteBody<R extends AccountRoute> = R["response"] extends z.ZodType<infer T> ? T : undefined;

/** What one route answered, read against the route table. */
type RouteAnswer<R extends AccountRoute> =
  | { readonly kind: "ok"; readonly body: RouteBody<R> }
  | { readonly kind: "error"; readonly code: ApiErrorCode; readonly message?: string }
  | { readonly kind: "unavailable" };

const unavailable = { kind: "unavailable" } as const;

/** `response`'s body as JSON, or `undefined` when it is not JSON. */
async function bodyOf(response: AccountResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * A client of the account routes at `config`, acting through `deps`. Throws
 * when `config` fails `accountClientConfigSchema`.
 */
export function createAccountClient(config: AccountClientConfig, deps: AccountClientDeps): AccountClient {
  const settled = accountClientConfigSchema.parse(config);
  const accountSiteOrigin = new URL(settled.accountSiteUrl).origin;
  let held: HandoffGrant | undefined;

  /** The material a cross-site client holds, dropping it once expired. */
  const heldMaterial = (): string | undefined => {
    if (held !== undefined && deps.now() >= Date.parse(held.expiresAt)) held = undefined;
    return held?.material;
  };

  /**
   * Send `route` its request presenting `credential`, and read the answer
   * against the route table: a status or body outside the contract, or a
   * refusal code the route does not list, is `unavailable`.
   */
  const call = async <R extends AccountRoute>(
    route: R,
    credential: Credential,
    body?: unknown
  ): Promise<RouteAnswer<R>> => {
    const headers: Record<string, string> = {};
    if (credential?.kind === "bearer") headers.Authorization = `Bearer ${credential.material}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: AccountResponse;
    try {
      response = await deps.fetch(urlUnder(settled.baseUrl, route.path).toString(), {
        method: route.method,
        headers,
        credentials: credential?.kind === "cookie" ? "include" : "omit",
        origin: new URL(deps.currentUrl()).origin,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return unavailable;
    }
    if (route.response === null) {
      return response.status === 204 ? { kind: "ok", body: undefined as RouteBody<R> } : unavailable;
    }
    if (response.status === 200) {
      const parsed = route.response.safeParse(await bodyOf(response));
      return parsed.success ? { kind: "ok", body: parsed.data as RouteBody<R> } : unavailable;
    }
    const refusal = apiErrorSchema.safeParse(await bodyOf(response));
    if (!refusal.success || !route.errors.includes(refusal.data.code)) return unavailable;
    return {
      kind: "error",
      code: refusal.data.code,
      ...(refusal.data.message === undefined ? {} : { message: refusal.data.message }),
    };
  };

  /** Call an authenticated route with the credential this client presents. */
  const authenticated = async <R extends AccountRoute>(route: R): Promise<AccountOutcome<RouteBody<R>>> => {
    if (settled.mode === AccountClientMode.SameSite) {
      const answer = await call(route, { kind: "cookie" });
      return answer.kind === "ok" ? { kind: "ok", value: answer.body } : answer;
    }
    const material = heldMaterial();
    if (material === undefined) return { kind: "needs-sign-in" };
    const answer = await call(route, { kind: "bearer", material });
    if (answer.kind === "error" && answer.code === ApiErrorCode.Unauthenticated) {
      held = undefined;
      return { kind: "needs-sign-in" };
    }
    return answer.kind === "ok" ? { kind: "ok", value: answer.body } : answer;
  };

  /**
   * Wait for the popup's own page, on the account site's origin, to post a
   * handoff code, or for the popup to close first.
   */
  const awaitHandoffCode = async (challenge: string): Promise<string | undefined> => {
    const popup = deps.openPopup(handoffUrl(settled.accountSiteUrl, settled.clientId, challenge));
    if (popup === undefined) return undefined;
    let deliver: (code: string) => void = () => {};
    const delivered = new Promise<string>((resolve) => {
      deliver = resolve;
    });
    const unsubscribe = deps.subscribeToMessages((message) => {
      if (message.origin !== accountSiteOrigin || message.source !== popup.window) return;
      const parsed = handoffMessageSchema.safeParse(message.data);
      if (parsed.success) deliver(parsed.data.code);
    });
    try {
      return await Promise.race([delivered, popup.closed.then(() => undefined)]);
    } finally {
      unsubscribe();
      popup.close();
    }
  };

  /** Read the view, answering `unavailable` for one with a link off the account site's origin. */
  const me = async (): Promise<AccountOutcome<MeView>> => {
    const outcome = await authenticated(accountRoutes.me);
    if (outcome.kind !== "ok") return outcome;
    const links = Object.values(outcome.value.account.links);
    return links.every((link) => new URL(link).origin === accountSiteOrigin) ? outcome : unavailable;
  };

  /** Run the cross-site handoff and hold the material it redeems. */
  const handoff = async (): Promise<SignInOutcome> => {
    const verifier = base64url(deps.randomBytes(verifierBytes));
    const code = await awaitHandoffCode(await handoffChallenge(verifier, deps.sha256));
    if (code === undefined) return { kind: "cancelled" };
    const answer = await call(accountRoutes.handoffRedeem, undefined, { code, verifier });
    if (answer.kind !== "ok") return answer;
    held = answer.body;
    return { kind: "signed-in" };
  };

  return {
    me,
    getTicket: () => authenticated(accountRoutes.tickets),
    signOut: async () => {
      let credential: Credential = { kind: "cookie" };
      if (settled.mode === AccountClientMode.CrossSite) {
        const material = heldMaterial();
        held = undefined;
        if (material === undefined) return { kind: "ok" };
        credential = { kind: "bearer", material };
      }
      const answer = await call(accountRoutes.signOut, credential);
      return answer.kind === "ok" ? { kind: "ok" } : unavailable;
    },
    signIn: async () => {
      if (settled.mode === AccountClientMode.CrossSite) return handoff();
      deps.navigate(signInUrl(settled.accountSiteUrl, settled.clientId, deps.currentUrl()));
      return { kind: "navigating" };
    },
  };
}
