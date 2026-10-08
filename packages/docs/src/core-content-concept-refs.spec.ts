/**
 * Pins that every concept reference in the core docs markdown, read from
 * core's source tree, names a concept page the core manifest registers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { coreConceptDocs } from "@wendoo/core/docs";

/** Root of the core docs markdown, relative to this module. */
const CORE_CONTENT_DIR = fileURLToPath(new URL("../../core/src/docs/content", import.meta.url));

/** An inline `concept:<id>` code span, capturing the id. */
const CONCEPT_REF_RE = /`concept:([^`]*)`/g;

/** One concept reference found in the content tree. */
interface ContentConceptRef {
  /** Path of the markdown file, relative to the content root. */
  file: string;
  /** The concept id the reference names. */
  conceptId: string;
}

/** Every `.md` file under `dir` and its subdirectories, as paths relative to `dir`. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      found.push(...markdownFiles(path.join(dir, entry.name)).map((child) => path.join(entry.name, child)));
    } else if (entry.name.endsWith(".md")) {
      found.push(entry.name);
    }
  }
  return found;
}

/** Every concept reference in the core content tree, in file then document order. */
function coreContentConceptRefs(): ContentConceptRef[] {
  const refs: ContentConceptRef[] = [];
  for (const file of markdownFiles(CORE_CONTENT_DIR)) {
    const markdown = fs.readFileSync(path.join(CORE_CONTENT_DIR, file), "utf-8");
    for (const match of markdown.matchAll(CONCEPT_REF_RE)) {
      refs.push({ file, conceptId: match[1] });
    }
  }
  return refs;
}

describe("the concept references in the core docs content", () => {
  test("are found at all, so an empty sweep cannot pass as a clean one", () => {
    assert.ok(coreContentConceptRefs().length > 0, `no concept references found under ${CORE_CONTENT_DIR}`);
  });

  test("name only concept ids the core manifest registers", () => {
    const registered = new Set(coreConceptDocs.map((meta) => meta.id));
    const unresolved = coreContentConceptRefs()
      .filter((ref) => !registered.has(ref.conceptId))
      .map((ref) => `${ref.file}: ${ref.conceptId}`);
    assert.deepEqual(unresolved, []);
  });
});
