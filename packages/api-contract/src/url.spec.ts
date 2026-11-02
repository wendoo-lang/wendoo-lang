import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { urlUnder } from "./url.js";

describe("a path under a base URL", () => {
  for (const [base, expected] of [
    ["https://example.test", "https://example.test/account"],
    ["https://example.test/", "https://example.test/account"],
    ["https://example.test/site", "https://example.test/site/account"],
    ["https://example.test/site//", "https://example.test/site/account"],
    ["http://localhost:8788", "http://localhost:8788/account"],
  ] as const) {
    test(`is appended to the pathname of ${base}`, () => {
      assert.equal(urlUnder(base, "/account").toString(), expected);
    });
  }

  test("carries nothing of the base's query or fragment", () => {
    const url = urlUnder("https://example.test/site?tenant=a#top", "/account");

    assert.equal(url.toString(), "https://example.test/site/account");
  });

  test("throws a TypeError for a base that is not an absolute URL", () => {
    assert.throws(() => urlUnder("/site", "/account"), TypeError);
  });
});
