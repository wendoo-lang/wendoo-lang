import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AccountClientMode, accountClientConfigSchema } from "./config.js";
import { ApiErrorCode, apiErrorSchema } from "./errors.js";
import {
  AccountRole,
  AccountRoutePath,
  API_CONTRACT_VERSION,
  accountRoutes,
  handoffGrantSchema,
  handoffRedeemRequestSchema,
  meViewSchema,
  ticketGrantSchema,
} from "./routes.js";

const me = {
  principalId: "principal-1",
  displayName: "Robin",
  account: { id: "account-1", role: AccountRole.Owner, tier: "free" },
};

/** `value` as it comes back off the wire. */
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("the account routes", () => {
  test("carry the contract version in every path", () => {
    for (const path of Object.values(AccountRoutePath)) {
      assert.ok(path.startsWith(`/account/v${API_CONTRACT_VERSION}/`), path);
    }
  });

  test("give every route a distinct method and path", () => {
    const keys = Object.values(accountRoutes).map((route) => `${route.method} ${route.path}`);

    assert.equal(new Set(keys).size, keys.length);
  });

  test("answer each route with the codes the contract assigns it", () => {
    assert.deepEqual(accountRoutes.me.errors, [ApiErrorCode.Unauthenticated]);
    assert.deepEqual(accountRoutes.tickets.errors, [ApiErrorCode.Unauthenticated]);
    assert.deepEqual(accountRoutes.signOut.errors, []);
    assert.deepEqual(accountRoutes.handoffRedeem.errors, [ApiErrorCode.HandoffInvalid, ApiErrorCode.Unauthenticated]);
  });

  test("take a body only for the handoff redeem, and answer none only for sign-out", () => {
    assert.equal(accountRoutes.me.request, null);
    assert.equal(accountRoutes.tickets.request, null);
    assert.equal(accountRoutes.signOut.request, null);
    assert.equal(accountRoutes.handoffRedeem.request, handoffRedeemRequestSchema);
    assert.equal(accountRoutes.signOut.response, null);
  });

  test("carry every example payload across unchanged", () => {
    const examples: readonly [{ parse(value: unknown): unknown }, unknown][] = [
      [meViewSchema, me],
      [meViewSchema, { ...me, account: { ...me.account, role: AccountRole.Member } }],
      [ticketGrantSchema, { ticket: "opaque.ticket.value", expiresAt: "2026-10-31T12:00:00.000Z" }],
      [handoffRedeemRequestSchema, { code: "code-1", verifier: "verifier-1" }],
      [handoffGrantSchema, { material: "opaque-material", expiresAt: "2026-10-31T12:15:00Z" }],
    ];

    for (const [schema, example] of examples) assert.deepEqual(schema.parse(overTheWire(example)), example);
  });

  test("refuse a payload carrying a field the contract does not define", () => {
    const forged: readonly [{ safeParse(value: unknown): { success: boolean } }, unknown][] = [
      [meViewSchema, { ...me, wallet: 100 }],
      [meViewSchema, { ...me, account: { ...me.account, balance: 100 } }],
      [ticketGrantSchema, { ticket: "t", expiresAt: "2026-10-31T12:00:00Z", lease: 500 }],
      [handoffRedeemRequestSchema, { code: "c", verifier: "v", challenge: "x" }],
      [handoffGrantSchema, { material: "m", expiresAt: "2026-10-31T12:00:00Z", refresh: "r" }],
    ];

    for (const [schema, payload] of forged)
      assert.equal(schema.safeParse(payload).success, false, JSON.stringify(payload));
  });

  test("refuse a principal with an empty display name", () => {
    assert.equal(meViewSchema.safeParse({ ...me, displayName: "" }).success, false);
  });

  test("refuse a role the contract does not define and an expiry that is not an instant", () => {
    assert.equal(meViewSchema.safeParse({ ...me, account: { ...me.account, role: "admin" } }).success, false);
    assert.equal(ticketGrantSchema.safeParse({ ticket: "t", expiresAt: "tomorrow" }).success, false);
    assert.equal(handoffGrantSchema.safeParse({ material: "m", expiresAt: 1798718400000 }).success, false);
  });
});

describe("the error body", () => {
  test("names every code as the wire spells it", () => {
    assert.deepEqual(ApiErrorCode, { Unauthenticated: "unauthenticated", HandoffInvalid: "handoff_invalid" });
  });

  test("carries a code with or without context", () => {
    for (const body of [{ code: ApiErrorCode.Unauthenticated }, { code: ApiErrorCode.HandoffInvalid, message: "x" }]) {
      assert.deepEqual(apiErrorSchema.parse(overTheWire(body)), body);
    }
  });

  test("refuses an unknown code, a missing code, and an extra field", () => {
    for (const body of [{ code: "forbidden" }, { message: "x" }, { code: ApiErrorCode.Unauthenticated, retry: true }]) {
      assert.equal(apiErrorSchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });
});

describe("the client configuration", () => {
  const config = {
    baseUrl: "https://api.example.test",
    accountSiteUrl: "https://account.example.test",
    clientId: "editor-web",
    mode: AccountClientMode.CrossSite,
  };

  test("carries a configuration across unchanged", () => {
    assert.deepEqual(accountClientConfigSchema.parse(overTheWire(config)), config);
  });

  test("refuses a relative, non-web, queried, or fragmented URL, an empty client, an unknown mode, and an extra field", () => {
    for (const forged of [
      { ...config, baseUrl: "/api" },
      { ...config, accountSiteUrl: "javascript:alert(1)" },
      { ...config, clientId: "" },
      { ...config, mode: "embedded" },
      { ...config, secret: "s" },
      { ...config, baseUrl: "https://api.example.test/?tenant=a" },
      { ...config, baseUrl: "https://api.example.test/#top" },
      { ...config, accountSiteUrl: "https://account.example.test/?next=x" },
      { ...config, accountSiteUrl: "https://account.example.test/#x" },
    ]) {
      assert.equal(accountClientConfigSchema.safeParse(forged).success, false, JSON.stringify(forged));
    }
  });
});
