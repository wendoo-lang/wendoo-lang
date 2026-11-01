import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import type { Sha256 } from "./account-site.js";
import {
  AccountSiteParam,
  AccountSitePath,
  HANDOFF_MESSAGE_TYPE,
  handoffChallenge,
  handoffMessageSchema,
  handoffUrl,
  signInUrl,
} from "./account-site.js";

const sha256: Sha256 = async (data) => new Uint8Array(createHash("sha256").update(data).digest());

describe("the account site's pages", () => {
  test("open the handoff page for the client, carrying the challenge", () => {
    const url = new URL(handoffUrl("https://account.example.test/", "editor-web", "abc-_123"));

    assert.equal(url.origin, "https://account.example.test");
    assert.equal(url.pathname, AccountSitePath.Handoff);
    assert.equal(url.searchParams.get(AccountSiteParam.Client), "editor-web");
    assert.equal(url.searchParams.get(AccountSiteParam.Challenge), "abc-_123");
  });

  test("open the sign-in page under a site's own path, carrying the return URL intact", () => {
    const returnUrl = "https://editor.example.test/project?id=7&tab=brain#top";
    const url = new URL(signInUrl("https://example.test/account", "editor-web", returnUrl));

    assert.equal(url.pathname, `/account${AccountSitePath.SignIn}`);
    assert.equal(url.searchParams.get(AccountSiteParam.Client), "editor-web");
    assert.equal(url.searchParams.get(AccountSiteParam.ReturnUrl), returnUrl);
  });

  test("open each page directly under the site URL, whatever slash it ends with", () => {
    for (const [site, prefix] of [
      ["https://account.example.test", ""],
      ["https://account.example.test/", ""],
      ["https://example.test/account", "/account"],
      ["https://example.test/account/", "/account"],
    ] as const) {
      const handoff = new URL(handoffUrl(site, "editor-web", "c"));
      const signIn = new URL(signInUrl(site, "editor-web", "https://editor.example.test/"));

      assert.equal(handoff.pathname, `${prefix}${AccountSitePath.Handoff}`, site);
      assert.equal(signIn.pathname, `${prefix}${AccountSitePath.SignIn}`, site);
      assert.equal(handoff.origin, new URL(site).origin, site);
    }
  });

  test("refuse a site URL that is not absolute", () => {
    assert.throws(() => handoffUrl("account.example.test", "editor-web", "c"), TypeError);
  });
});

describe("the handoff challenge", () => {
  test("is the unpadded base64url SHA-256 of the verifier", async () => {
    for (const verifier of ["", "a", "ab", "abc", "verifier-of-forty-three-characters-0123456"]) {
      const expected = createHash("sha256").update(verifier).digest("base64url");

      assert.equal(await handoffChallenge(verifier, sha256), expected, verifier);
    }
  });

  test("encodes every byte value at every trailing-group length", async () => {
    for (let first = 0; first < 256; first += 1) {
      const digest = new Uint8Array([first, 255 - first, first ^ 0x5a]);
      const tail = digest.subarray(0, 1 + (first % 3));

      const challenge = await handoffChallenge("v", async () => tail);

      assert.equal(challenge, Buffer.from(tail).toString("base64url"), String(first));
    }
  });
});

describe("the handoff message", () => {
  test("carries a code across unchanged", () => {
    const message = { type: HANDOFF_MESSAGE_TYPE, code: "code-1" };

    assert.deepEqual(handoffMessageSchema.parse(JSON.parse(JSON.stringify(message))), message);
  });

  test("refuses another type, an empty code, and an extra field", () => {
    for (const message of [
      { type: "wendoo:other", code: "code-1" },
      { type: HANDOFF_MESSAGE_TYPE, code: "" },
      { type: HANDOFF_MESSAGE_TYPE, code: "code-1", material: "m" },
    ]) {
      assert.equal(handoffMessageSchema.safeParse(message).success, false, JSON.stringify(message));
    }
  });
});
