import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const indexHtml = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

describe("app document base", () => {
  it("declares a root base, so a nested route resolves the app's relative urls from the site root", () => {
    assert.match(indexHtml, /<base\s+href="\/"\s*\/?>/);
  });

  it("declares the base ahead of every element carrying a url", () => {
    const baseAt = indexHtml.indexOf("<base ");
    const firstUrlElementAt = indexHtml.search(/<(?:link|script|img)\s/);
    assert.notStrictEqual(baseAt, -1);
    assert.notStrictEqual(firstUrlElementAt, -1);
    assert.ok(baseAt < firstUrlElementAt);
  });
});
