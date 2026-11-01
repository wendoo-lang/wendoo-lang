import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import type { Sha256 } from "../account-site.js";
import { AccountSiteParam, AccountSitePath, HANDOFF_MESSAGE_TYPE, handoffChallenge } from "../account-site.js";
import { AccountClientMode } from "../config.js";
import { ApiErrorCode } from "../errors.js";
import type { MeView } from "../routes.js";
import { AccountRole, AccountRoutePath, ticketGrantSchema } from "../routes.js";
import type { FakeApiService } from "../testing/index.js";
import { createFakeApiService } from "../testing/index.js";
import type { AccountClient, AccountFetch, AccountWindowMessage } from "./index.js";
import { createAccountClient } from "./index.js";

/** The global `fetch` is a transport the client takes as it is. */
const globalFetchFits: AccountFetch = fetch;
void globalFetchFits;

const sha256: Sha256 = async (data) => new Uint8Array(createHash("sha256").update(data).digest());

const accountSiteUrl = "https://account.example.test";
const editorUrl = "https://editor.example.test/project/7";
const editorOrigin = new URL(editorUrl).origin;
const materialLifetimeMs = 15 * 60_000;

const robin: MeView = {
  principalId: "principal-1",
  displayName: "Robin",
  account: { id: "account-1", role: AccountRole.Member, tier: "free" },
};

/**
 * What the account site's handoff page does once its popup opens. `self` is
 * the popup's window, which a message the page itself posts carries as its
 * `source`.
 */
type HandoffPage = (url: URL, post: (message: AccountWindowMessage) => void, close: () => void, self: unknown) => void;

/** The account site signing the principal in and posting the code it mints, from its own origin and window. */
const honestSite =
  (fake: FakeApiService): HandoffPage =>
  (url, post, _close, self) => {
    const challenge = url.searchParams.get(AccountSiteParam.Challenge) ?? "";
    fake.signInPrincipal(robin);
    post({
      origin: accountSiteUrl,
      source: self,
      data: { type: HANDOFF_MESSAGE_TYPE, code: fake.mintHandoffCode(challenge) },
    });
  };

/** How a {@link stand} is set up. */
interface StandOptions {
  /** The account site's handoff page; `undefined` from the factory means the browser refuses the popup. */
  readonly page?: (fake: FakeApiService) => HandoffPage | undefined;
  /** Origins the fake accepts the cookie from. Defaults to the editor page's origin. */
  readonly registeredOrigins?: readonly string[];
  /** Base URL of the fake API service. */
  readonly baseUrl?: string;
}

/** One browser running a client against a fake API service, with a clock the test moves. */
interface Stand {
  readonly fake: FakeApiService;
  readonly client: AccountClient;
  /** Every request the client sent, as `METHOD path`. */
  readonly requests: string[];
  /** Every URL the client sent a request to. */
  readonly urls: string[];
  /** Every URL the client navigated its page to. */
  readonly navigations: string[];
  /** Every URL the client opened a popup at. */
  readonly popups: string[];
  /** Move the clock forward by `ms`. */
  advance(ms: number): void;
}

function stand(mode: AccountClientMode, options: StandOptions = {}): Stand {
  let clock = Date.parse("2026-10-31T12:00:00Z");
  const now = () => clock;
  const fake = createFakeApiService({
    now,
    sha256,
    materialLifetimeMs,
    registeredOrigins: options.registeredOrigins ?? [editorOrigin],
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  const page = options.page;
  const listeners = new Set<(message: AccountWindowMessage) => void>();
  const requests: string[] = [];
  const urls: string[] = [];
  const navigations: string[] = [];
  const popups: string[] = [];
  const handoffPage = page === undefined ? honestSite(fake) : page(fake);

  const client = createAccountClient(
    { baseUrl: fake.baseUrl, accountSiteUrl, clientId: "editor-web", mode },
    {
      fetch: async (url, init) => {
        requests.push(`${init.method} ${new URL(url).pathname}`);
        urls.push(url);
        return fake.fetch(url, init);
      },
      now,
      randomBytes: (length) => new Uint8Array(randomBytes(length)),
      sha256,
      openPopup: (url) => {
        popups.push(url);
        if (handoffPage === undefined) return undefined;
        let settleClosed: () => void = () => {};
        const closed = new Promise<void>((resolve) => {
          settleClosed = resolve;
        });
        const self = {};
        const post = (message: AccountWindowMessage) =>
          queueMicrotask(() => {
            for (const listener of listeners) listener(message);
          });
        queueMicrotask(() => handoffPage(new URL(url), post, () => queueMicrotask(settleClosed), self));
        return { window: self, closed, close: settleClosed };
      },
      subscribeToMessages: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      navigate: (url) => navigations.push(url),
      currentUrl: () => editorUrl,
    }
  );

  return {
    fake,
    client,
    requests,
    urls,
    navigations,
    popups,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe("a same-site client", () => {
  test("reads the signed-in principal through the account-session cookie", async () => {
    const { fake, client } = stand(AccountClientMode.SameSite);
    fake.signInPrincipal(robin);

    assert.deepEqual(await client.me(), { kind: "ok", value: robin });
  });

  test("is refused as unauthenticated before anyone signs in", async () => {
    const { client } = stand(AccountClientMode.SameSite);

    assert.deepEqual(await client.me(), { kind: "error", code: ApiErrorCode.Unauthenticated });
    assert.deepEqual(await client.getTicket(), { kind: "error", code: ApiErrorCode.Unauthenticated });
  });

  test("gets a fresh ticket for every connection", async () => {
    const { fake, client } = stand(AccountClientMode.SameSite);
    fake.signInPrincipal(robin);

    const first = await client.getTicket();
    const second = await client.getTicket();

    assert.equal(first.kind, "ok");
    assert.equal(second.kind, "ok");
    if (first.kind !== "ok" || second.kind !== "ok") return;
    assert.equal(ticketGrantSchema.safeParse(first.value).success, true);
    assert.notEqual(first.value.ticket, second.value.ticket);
  });

  test("signs out, after which the cookie authenticates nothing", async () => {
    const { fake, client } = stand(AccountClientMode.SameSite);
    fake.signInPrincipal(robin);

    assert.deepEqual(await client.signOut(), { kind: "ok" });
    assert.deepEqual(await client.me(), { kind: "error", code: ApiErrorCode.Unauthenticated });
    assert.deepEqual(await client.signOut(), { kind: "ok" });
  });

  test("is refused as unauthenticated when its page's origin is not registered", async () => {
    const { fake, client } = stand(AccountClientMode.SameSite, { registeredOrigins: ["https://other.example.test"] });
    fake.signInPrincipal(robin);

    assert.deepEqual(await client.me(), { kind: "error", code: ApiErrorCode.Unauthenticated });
    assert.deepEqual(await client.getTicket(), { kind: "error", code: ApiErrorCode.Unauthenticated });
    assert.deepEqual(await client.signOut(), { kind: "ok" });
  });

  test("signs in by navigating top-level to the account site with its client and return URL", async () => {
    const { client, navigations, popups } = stand(AccountClientMode.SameSite);

    assert.deepEqual(await client.signIn(), { kind: "navigating" });
    assert.equal(navigations.length, 1);
    assert.equal(popups.length, 0);
    const url = new URL(navigations[0] as string);
    assert.equal(url.origin, accountSiteUrl);
    assert.equal(url.pathname, AccountSitePath.SignIn);
    assert.equal(url.searchParams.get(AccountSiteParam.Client), "editor-web");
    assert.equal(url.searchParams.get(AccountSiteParam.ReturnUrl), editorUrl);
  });

  test("is unavailable when the API service cannot be reached", async () => {
    const client = createAccountClient(
      { baseUrl: "https://api.example.test", accountSiteUrl, clientId: "editor-web", mode: AccountClientMode.SameSite },
      {
        fetch: async () => {
          throw new TypeError("network down");
        },
        now: Date.now,
        randomBytes: (length) => new Uint8Array(length),
        sha256,
        openPopup: () => undefined,
        subscribeToMessages: () => () => {},
        navigate: () => {},
        currentUrl: () => editorUrl,
      }
    );

    assert.deepEqual(await client.me(), { kind: "unavailable" });
    assert.deepEqual(await client.signOut(), { kind: "unavailable" });
  });
});

describe("a cross-site client", () => {
  test("needs sign-in before it holds material, without opening anything on its own", async () => {
    const { fake, client, requests, popups } = stand(AccountClientMode.CrossSite);
    fake.signInPrincipal(robin);

    assert.deepEqual(await client.me(), { kind: "needs-sign-in" });
    assert.deepEqual(await client.getTicket(), { kind: "needs-sign-in" });
    assert.deepEqual(requests, []);
    assert.deepEqual(popups, []);
  });

  test("signs in through the handoff and then reads the principal and gets tickets", async () => {
    const { client, requests, popups } = stand(AccountClientMode.CrossSite);

    assert.deepEqual(await client.signIn(), { kind: "signed-in" });
    assert.deepEqual(await client.me(), { kind: "ok", value: robin });
    assert.equal((await client.getTicket()).kind, "ok");

    assert.equal(popups.length, 1);
    const url = new URL(popups[0] as string);
    assert.equal(url.pathname, AccountSitePath.Handoff);
    assert.equal(url.searchParams.get(AccountSiteParam.Client), "editor-web");
    assert.deepEqual(requests, [
      `POST ${AccountRoutePath.HandoffRedeem}`,
      `GET ${AccountRoutePath.Me}`,
      `POST ${AccountRoutePath.Tickets}`,
    ]);
  });

  test("needs sign-in again once its material has expired", async () => {
    const { client, requests, advance } = stand(AccountClientMode.CrossSite);
    await client.signIn();

    advance(materialLifetimeMs);

    assert.deepEqual(await client.me(), { kind: "needs-sign-in" });
    assert.deepEqual(await client.getTicket(), { kind: "needs-sign-in" });
    assert.deepEqual(requests, [`POST ${AccountRoutePath.HandoffRedeem}`]);
  });

  test("is refused as handoff-invalid when its verifier does not hash to the code's challenge", async () => {
    const { client } = stand(AccountClientMode.CrossSite, {
      page: (fake) => async (_url, post, _close, self) => {
        fake.signInPrincipal(robin);
        const challenge = await handoffChallenge("another client's verifier", sha256);
        post({
          origin: accountSiteUrl,
          source: self,
          data: { type: HANDOFF_MESSAGE_TYPE, code: fake.mintHandoffCode(challenge) },
        });
      },
    });

    assert.deepEqual(await client.signIn(), { kind: "error", code: ApiErrorCode.HandoffInvalid });
    assert.deepEqual(await client.me(), { kind: "needs-sign-in" });
  });

  test("ignores a handoff message from any origin but the account site's", async () => {
    const { client, requests } = stand(AccountClientMode.CrossSite, {
      page: (fake) => (url, post, close, self) => {
        fake.signInPrincipal(robin);
        const code = fake.mintHandoffCode(url.searchParams.get(AccountSiteParam.Challenge) ?? "");
        post({ origin: "https://clone.example.test", source: self, data: { type: HANDOFF_MESSAGE_TYPE, code } });
        post({ origin: accountSiteUrl, source: self, data: { type: "wendoo:other", code } });
        close();
      },
    });

    assert.deepEqual(await client.signIn(), { kind: "cancelled" });
    assert.deepEqual(requests, []);
  });

  test("ignores a handoff message from another window on the account site, and waits for its popup's own", async () => {
    const { client, requests } = stand(AccountClientMode.CrossSite, {
      page: (fake) => (url, post, _close, self) => {
        fake.signInPrincipal(robin);
        const stray = fake.mintHandoffCode("a challenge some other tab opened with");
        const own = fake.mintHandoffCode(url.searchParams.get(AccountSiteParam.Challenge) ?? "");
        post({ origin: accountSiteUrl, source: {}, data: { type: HANDOFF_MESSAGE_TYPE, code: stray } });
        post({ origin: accountSiteUrl, source: self, data: { type: HANDOFF_MESSAGE_TYPE, code: own } });
      },
    });

    assert.deepEqual(await client.signIn(), { kind: "signed-in" });
    assert.deepEqual(requests, [`POST ${AccountRoutePath.HandoffRedeem}`]);
  });

  test("is cancelled when the browser refuses the popup", async () => {
    const { client, requests } = stand(AccountClientMode.CrossSite, { page: () => undefined });

    assert.deepEqual(await client.signIn(), { kind: "cancelled" });
    assert.deepEqual(requests, []);
  });

  test("needs sign-in, dropping its material, when the API service answers unauthenticated", async () => {
    const { fake, client, requests } = stand(AccountClientMode.CrossSite);
    await client.signIn();

    fake.signOutAll();

    assert.deepEqual(await client.me(), { kind: "needs-sign-in" });
    assert.deepEqual(await client.getTicket(), { kind: "needs-sign-in" });
    assert.deepEqual(requests, [`POST ${AccountRoutePath.HandoffRedeem}`, `GET ${AccountRoutePath.Me}`]);
  });

  test("presents its material from any origin, registered or not", async () => {
    const { client } = stand(AccountClientMode.CrossSite, { registeredOrigins: [] });
    await client.signIn();

    assert.deepEqual(await client.me(), { kind: "ok", value: robin });
    assert.equal((await client.getTicket()).kind, "ok");
  });

  test("signs out with its material, ending the account session it belonged to", async () => {
    const { fake, client } = stand(AccountClientMode.CrossSite);
    await client.signIn();

    assert.deepEqual(await client.signOut(), { kind: "ok" });
    assert.deepEqual(await client.me(), { kind: "needs-sign-in" });
    assert.throws(() => fake.mintHandoffCode("challenge"));
  });
});

describe("the URLs a client builds", () => {
  for (const [baseUrl, routeUrl] of [
    ["https://api.example.test", "https://api.example.test/account/v1/me"],
    ["https://api.example.test/", "https://api.example.test/account/v1/me"],
    ["https://example.test/api", "https://example.test/api/account/v1/me"],
    ["https://example.test/api/", "https://example.test/api/account/v1/me"],
  ] as const) {
    test(`reach the route under ${baseUrl}`, async () => {
      const { fake, client, urls } = stand(AccountClientMode.SameSite, { baseUrl });
      fake.signInPrincipal(robin);

      assert.deepEqual(await client.me(), { kind: "ok", value: robin });
      assert.deepEqual(urls, [routeUrl]);
    });
  }
});

describe("the fake API service's origin check", () => {
  const fake = createFakeApiService({ registeredOrigins: [editorOrigin] });
  fake.signInPrincipal(robin);
  const at = (path: string) => `${fake.baseUrl}${path}`;

  test("takes the cookie on a POST from a registered origin", async () => {
    const answer = await fake.fetch(at(AccountRoutePath.Tickets), {
      method: "POST",
      headers: {},
      credentials: "include",
      origin: editorOrigin,
    });

    assert.equal(answer.status, 200);
  });

  test("refuses the cookie on a POST from an unregistered origin or from no origin", async () => {
    for (const origin of ["https://clone.example.test", undefined]) {
      const answer = await fake.fetch(at(AccountRoutePath.Tickets), {
        method: "POST",
        headers: {},
        credentials: "include",
        ...(origin === undefined ? {} : { origin }),
      });

      assert.equal(answer.status, 401, String(origin));
      assert.deepEqual(await answer.json(), { code: ApiErrorCode.Unauthenticated }, String(origin));
    }
  });

  test("ends nothing on a sign-out from an unregistered origin", async () => {
    const forged = await fake.fetch(at(AccountRoutePath.SignOut), {
      method: "POST",
      headers: {},
      credentials: "include",
      origin: "https://clone.example.test",
    });
    const after = await fake.fetch(at(AccountRoutePath.Me), { method: "GET", headers: {}, credentials: "include" });

    assert.equal(forged.status, 204);
    assert.equal(after.status, 200);
  });

  test("takes the cookie on a GET that names no origin", async () => {
    const answer = await fake.fetch(at(AccountRoutePath.Me), { method: "GET", headers: {}, credentials: "include" });

    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), robin);
  });
});
