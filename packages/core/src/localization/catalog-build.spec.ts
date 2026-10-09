/**
 * Pins the catalog pipeline end to end: catalog JSON compiles to a generated
 * TypeScript module, the module loads and drives a Localizer, and a malformed
 * translation template is reported with its stable code.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { CatalogEntryInput, LocaleCatalog, PluralRuleSpec } from "@wendoo/core/localization";
import {
  buildLocaleCatalogModule,
  createLocalizer,
  defaultPluralRule,
  TemplateDiagCode,
} from "@wendoo/core/localization";

type CatalogJson = {
  entries?: Record<string, string>;
  contexts?: Record<string, Record<string, string>>;
};

const kPluralSource = "{count, plural, one {# item} other {# items}}";

/** Flatten catalog JSON the way the generator script does. */
function toEntries(json: CatalogJson): CatalogEntryInput[] {
  const entries: CatalogEntryInput[] = [];
  for (const [source, translation] of Object.entries(json.entries ?? {})) {
    entries.push({ source, translation });
  }
  for (const [context, sources] of Object.entries(json.contexts ?? {})) {
    for (const [source, translation] of Object.entries(sources)) {
      entries.push({ context, source, translation });
    }
  }
  return entries;
}

/** Write a generated module to a temp dir, load it back as a {@link LocaleCatalog}, and delete the dir. */
async function loadGeneratedModule(locale: string, source: string): Promise<LocaleCatalog> {
  const dir = mkdtempSync(join(tmpdir(), "wendoo-localization-"));
  try {
    const file = join(dir, `${locale}.ts`);
    writeFileSync(file, source, "utf-8");
    try {
      const loaded = (await import(pathToFileURL(file).href)) as {
        locale: string;
        pluralRule: PluralRuleSpec;
        entries: Record<string, string>;
        contexts: Record<string, Record<string, string>>;
      };
      return loaded;
    } finally {
      unlinkSync(file);
    }
  } finally {
    rmdirSync(dir);
  }
}

describe("catalog round trip", () => {
  test("catalog JSON compiles to a module a localizer resolves through", async () => {
    const json: CatalogJson = {
      entries: {
        "Translated {value}": "XX-{value}",
        [kPluralSource]: "{count, plural, one {XX-ONE-#} other {XX-OTHER-#}}",
      },
      contexts: {
        "tile-label": { Stop: "XX-STOP" },
        "a-context-invented-by-a-future-consumer": { Anything: "XX-ANYTHING" },
      },
    };

    const built = buildLocaleCatalogModule({ locale: "xx", pluralRule: defaultPluralRule, entries: toEntries(json) });
    assert.deepEqual(built.issues, []);

    const catalog = await loadGeneratedModule("xx", built.source);
    const localizer = createLocalizer(catalog);

    assert.equal(localizer.locale(), "xx");
    assert.equal(localizer.tr("Translated {value}", { value: 7 }), "XX-7");
    assert.equal(localizer.tr(kPluralSource, { count: 1 }), "XX-ONE-1");
    assert.equal(localizer.tr(kPluralSource, { count: 3 }), "XX-OTHER-3");
    assert.equal(localizer.tr("Stop", undefined, "tile-label"), "XX-STOP");
    assert.equal(localizer.tr("Anything", undefined, "a-context-invented-by-a-future-consumer"), "XX-ANYTHING");
    assert.equal(localizer.tr("Never translated", undefined), "Never translated");
  });

  test("quotes, backslashes, and newlines survive generation", async () => {
    const entries: CatalogEntryInput[] = [{ source: "raw", translation: 'a "quoted" \\ path\nsecond line' }];
    const built = buildLocaleCatalogModule({ locale: "xx", pluralRule: defaultPluralRule, entries });
    const localizer = createLocalizer(await loadGeneratedModule("xx", built.source));
    assert.equal(localizer.tr("raw"), 'a "quoted" \\ path\nsecond line');
  });

  test("a locale's plural rule ships in its generated module", async () => {
    const rule: PluralRuleSpec = [
      {
        category: "many",
        any: [[{ operand: "i", mod: 10, not: true, ranges: [{ lo: 1, hi: 1 }] }]],
      },
    ];
    const source = "{n, plural, many {M#} other {O#}}";
    const built = buildLocaleCatalogModule({
      locale: "xx",
      pluralRule: rule,
      entries: [{ source, translation: source }],
    });
    const localizer = createLocalizer(await loadGeneratedModule("xx", built.source));
    assert.equal(localizer.tr(source, { n: 1 }), "O1");
    assert.equal(localizer.tr(source, { n: 2 }), "M2");
  });

  test("an empty catalog generates a module that falls back to every source", async () => {
    const built = buildLocaleCatalogModule({ locale: "xx", pluralRule: defaultPluralRule, entries: [] });
    const localizer = createLocalizer(await loadGeneratedModule("xx", built.source));
    assert.equal(localizer.tr("Anything at all"), "Anything at all");
  });
});

describe("catalog validation", () => {
  test("a malformed translation is reported with its code and its entry", () => {
    const entries: CatalogEntryInput[] = [
      { source: "ok {a}", translation: "fine {a}" },
      { context: "tile-label", source: "Stop", translation: "{n, date, short}" },
    ];
    const built = buildLocaleCatalogModule({ locale: "xx", pluralRule: defaultPluralRule, entries });
    assert.equal(built.issues.length, 1);
    assert.equal(built.issues[0].code, TemplateDiagCode.UnknownFormat);
    assert.equal(built.issues[0].context, "tile-label");
    assert.equal(built.issues[0].source, "Stop");
  });

  test("a plural translation missing its other branch is reported", () => {
    const entries: CatalogEntryInput[] = [{ source: "x", translation: "{n, plural, one {#}}" }];
    const built = buildLocaleCatalogModule({ locale: "xx", pluralRule: defaultPluralRule, entries });
    assert.deepEqual(
      built.issues.map((issue) => issue.code),
      [TemplateDiagCode.MissingOtherBranch]
    );
  });
});
