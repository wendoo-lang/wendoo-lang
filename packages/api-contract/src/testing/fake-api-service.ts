import type { Sha256 } from "../account-site.js";
import { handoffChallenge } from "../account-site.js";
import type { AccountFetch, AccountRequest, AccountResponse } from "../client/account-client.js";
import { ApiErrorCode, apiErrorSchema } from "../errors.js";
import type { AccountRoute, MeView } from "../routes.js";
import { accountRoutes, meViewSchema } from "../routes.js";
import { urlUnder } from "../url.js";

/** How a {@link FakeApiService} runs. Every field has a default. */
export interface FakeApiServiceOptions {
  /** Absolute URL the fake answers the account routes under. Defaults to `https://api.example.test`. */
  readonly baseUrl?: string;
  /** The fake's clock, in milliseconds since the Unix epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Digest the fake checks handoff verifiers with. Defaults to the global Web Crypto `crypto.subtle`. */
  readonly sha256?: Sha256;
  /** How long redeemed handoff material lasts, in milliseconds. Defaults to fifteen minutes. */
  readonly materialLifetimeMs?: number;
  /**
   * Origins a cookie-authenticated request is accepted from, each as
   * `URL.origin` spells it. Defaults to the origin of {@link baseUrl}.
   */
  readonly registeredOrigins?: readonly string[];
}

/**
 * An in-memory API service answering every account route behind {@link fetch}.
 * It holds one browser's account-session cookie: a request sent with
 * `credentials: "include"` presents it, and the fake honors it only when the
 * request's `origin` is registered or, on a GET, absent.
 * Tickets it mints are arbitrary opaque strings that nothing verifies.
 */
export interface FakeApiService {
  /** The URL the fake answers under, as {@link FakeApiServiceOptions.baseUrl} gave it; configure a client's `baseUrl` with it. */
  readonly baseUrl: string;
  /** Answer one account request as the API service would. Never rejects. */
  readonly fetch: AccountFetch;
  /**
   * Complete a sign-in for `view` on the account site, as if the principal had
   * just signed in there: a fresh account session that the cookie now carries.
   * Throws when `view` fails `meViewSchema`.
   */
  signInPrincipal(view: MeView): void;
  /** End every account session, along with every piece of material and handoff code minted under one. */
  signOutAll(): void;
  /**
   * Mint a handoff code bound to `challenge` under the account session the
   * cookie carries, as the account site's handoff page does. The code is
   * single-use and expires a minute after minting. Throws when no principal is
   * signed in.
   */
  mintHandoffCode(challenge: string): string;
}

/** How long a minted connection ticket lasts, in milliseconds. */
const ticketLifetimeMs = 60_000;

/** How long a minted handoff code lasts, in milliseconds. */
const handoffCodeLifetimeMs = 60_000;

/** Default lifetime of redeemed handoff material, in milliseconds. */
const defaultMaterialLifetimeMs = 15 * 60_000;

/** One live account session. */
interface FakeSession {
  readonly view: MeView;
}

/** Something minted under an account session that expires. */
interface Minted {
  readonly session: FakeSession;
  readonly expiresAt: number;
}

/** SHA-256 through the global Web Crypto implementation. */
const webCryptoSha256: Sha256 = async (data) =>
  new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(data)));

/** A response carrying `body` as it comes back off the wire, or no body for `undefined`. */
function answer(status: number, body?: unknown): AccountResponse {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return {
    status,
    json: async () => {
      if (text === undefined) throw new SyntaxError("the response has no body");
      return JSON.parse(text);
    },
  };
}

/** A refusal carrying `code`, with the status the contract gives it. */
function refusal(code: ApiErrorCode): AccountResponse {
  const status = code === ApiErrorCode.Unauthenticated ? 401 : 400;
  return answer(status, apiErrorSchema.parse({ code }));
}

/** A success `route` answers with `body`, checked against the route's response schema. */
function success(route: AccountRoute, body?: unknown): AccountResponse {
  if (route.response === null) return answer(204);
  return answer(200, route.response.parse(body));
}

/** The value of header `name` in `request`, read without regard to case. */
function header(request: AccountRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) if (key.toLowerCase() === wanted) return value;
  return undefined;
}

/** Create an in-memory API service. */
export function createFakeApiService(options: FakeApiServiceOptions = {}): FakeApiService {
  const baseUrl = options.baseUrl ?? "https://api.example.test";
  const registeredOrigins = new Set(options.registeredOrigins ?? [new URL(baseUrl).origin]);
  const now = options.now ?? Date.now;
  const sha256 = options.sha256 ?? webCryptoSha256;
  const materialLifetimeMs = options.materialLifetimeMs ?? defaultMaterialLifetimeMs;

  const sessions = new Set<FakeSession>();
  const materials = new Map<string, Minted>();
  const codes = new Map<string, Minted & { readonly challenge: string }>();
  let cookie: FakeSession | undefined;
  let minted = 0;

  const mint = (kind: string): string => `${kind}-${++minted}`;
  const instant = (at: number): string => new Date(at).toISOString();

  /** The live account session `request` authenticates as, if any. */
  const sessionOf = (request: AccountRequest): FakeSession | undefined => {
    const authorization = header(request, "Authorization");
    if (authorization !== undefined) {
      const held = materials.get(authorization.replace(/^Bearer /, ""));
      if (held === undefined || now() >= held.expiresAt || !sessions.has(held.session)) return undefined;
      return held.session;
    }
    if (request.credentials !== "include" || cookie === undefined || !sessions.has(cookie)) return undefined;
    if (request.origin === undefined) return request.method === "GET" ? cookie : undefined;
    return registeredOrigins.has(request.origin) ? cookie : undefined;
  };

  const endSession = (session: FakeSession): void => {
    sessions.delete(session);
    if (cookie === session) cookie = undefined;
    for (const [material, held] of materials) if (held.session === session) materials.delete(material);
    for (const [code, held] of codes) if (held.session === session) codes.delete(code);
  };

  const redeem = async (request: AccountRequest): Promise<AccountResponse> => {
    const route = accountRoutes.handoffRedeem;
    let body: unknown;
    try {
      body = request.body === undefined ? undefined : JSON.parse(request.body);
    } catch {
      return refusal(ApiErrorCode.HandoffInvalid);
    }
    const parsed = route.request.safeParse(body);
    if (!parsed.success) return refusal(ApiErrorCode.HandoffInvalid);
    const held = codes.get(parsed.data.code);
    codes.delete(parsed.data.code);
    if (held === undefined || now() >= held.expiresAt) return refusal(ApiErrorCode.HandoffInvalid);
    if ((await handoffChallenge(parsed.data.verifier, sha256)) !== held.challenge) {
      return refusal(ApiErrorCode.HandoffInvalid);
    }
    if (!sessions.has(held.session)) return refusal(ApiErrorCode.Unauthenticated);
    const material = mint("material");
    const expiresAt = now() + materialLifetimeMs;
    materials.set(material, { session: held.session, expiresAt });
    return success(route, { material, expiresAt: instant(expiresAt) });
  };

  const fetch: AccountFetch = async (url, request) => {
    const route = Object.values(accountRoutes).find(
      (candidate) => urlUnder(baseUrl, candidate.path).toString() === url && candidate.method === request.method
    );
    if (route === undefined) return answer(404);
    if (route === accountRoutes.handoffRedeem) return redeem(request);
    const session = sessionOf(request);
    if (route === accountRoutes.signOut) {
      if (session !== undefined) endSession(session);
      return success(route);
    }
    if (session === undefined) return refusal(ApiErrorCode.Unauthenticated);
    if (route === accountRoutes.me) return success(route, session.view);
    return success(route, { ticket: mint("ticket"), expiresAt: instant(now() + ticketLifetimeMs) });
  };

  return {
    baseUrl,
    fetch,
    signInPrincipal: (view) => {
      const session: FakeSession = { view: meViewSchema.parse(view) };
      sessions.add(session);
      cookie = session;
    },
    signOutAll: () => {
      for (const session of [...sessions]) endSession(session);
    },
    mintHandoffCode: (challenge) => {
      if (cookie === undefined || !sessions.has(cookie)) throw new Error("no principal is signed in");
      const code = mint("code");
      codes.set(code, { session: cookie, challenge, expiresAt: now() + handoffCodeLifetimeMs });
      return code;
    },
  };
}
