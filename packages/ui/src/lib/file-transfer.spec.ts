/**
 * Pins the browser file transfer helpers: a download is an anchor carrying the
 * file's name and a URL of its content, clicked while in the document, and a
 * pick resolves the file the chooser's input reports.
 *
 * The document and its elements are stand-ins recording what is done to them.
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { downloadTextFile, pickFile } from "./file-transfer";

/** A stand-in element recording its attributes, listeners and clicks. */
interface StandInElement {
  readonly tagName: string;
  href?: string;
  download?: string;
  type?: string;
  accept?: string;
  files?: File[];
  clicks: number;
  /** Whether the element was in the document body when it was clicked. */
  clickedInBody: boolean;
  readonly listeners: Map<string, () => void>;
  addEventListener(type: string, listener: () => void): void;
  click(): void;
}

/** Elements the stand-in document created, oldest first. */
let created: StandInElement[] = [];

/** What a stand-in element's click does, after recording it. */
let onClick: (element: StandInElement) => void = () => {};

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;

function installDocument(): { body: Set<StandInElement> } {
  const body = new Set<StandInElement>();
  const stand = {
    body: {
      appendChild: (element: StandInElement) => {
        body.add(element);
      },
      removeChild: (element: StandInElement) => {
        body.delete(element);
      },
    },
    createElement: (tagName: string): StandInElement => {
      const element: StandInElement = {
        tagName,
        clicks: 0,
        clickedInBody: false,
        listeners: new Map(),
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        },
        click() {
          this.clicks += 1;
          this.clickedInBody = body.has(this);
          onClick(this);
        },
      };
      created.push(element);
      return element;
    },
  };
  (globalThis as { document?: unknown }).document = stand;
  return { body };
}

afterEach(() => {
  (globalThis as { document?: unknown }).document = undefined;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  created = [];
  onClick = () => {};
});

describe("downloadTextFile", () => {
  test("clicks an anchor in the document carrying the filename and a URL of the content", async () => {
    const { body } = installDocument();
    const blobs = new Map<string, Blob>();
    const revoked: string[] = [];
    URL.createObjectURL = (blob: Blob) => {
      const url = `blob:stand-in/${blobs.size}`;
      blobs.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };

    downloadTextFile('{"name":"rover"}', "rover.brain");

    assert.equal(created.length, 1);
    const [anchor] = created;
    assert.equal(anchor.tagName, "a");
    assert.equal(anchor.download, "rover.brain");
    assert.equal(anchor.clicks, 1);
    assert.equal(anchor.clickedInBody, true);
    assert.equal(body.size, 0);

    const blob = blobs.get(anchor.href ?? "");
    assert.ok(blob);
    assert.equal(blob.type, "application/json");
    assert.equal(await blob.text(), '{"name":"rover"}');
    assert.deepEqual(revoked, [anchor.href]);
  });

  test("saves the content under the media type it is given", () => {
    installDocument();
    const blobs: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return "blob:stand-in/hex";
    };
    URL.revokeObjectURL = () => {};

    downloadTextFile(":00000001FF", "rover.hex", "application/octet-stream");

    assert.equal(blobs.length, 1);
    assert.equal(blobs[0].type, "application/octet-stream");
  });
});

describe("pickFile", () => {
  test("clicks a file input filtered by the accept list and resolves the file it reports", async () => {
    installDocument();
    const file = new File(["{}"], "rover.brain");
    onClick = (input) => {
      input.files = [file];
      input.listeners.get("change")?.();
    };

    const picked = await pickFile(".brain");

    assert.equal(created.length, 1);
    const [input] = created;
    assert.equal(input.tagName, "input");
    assert.equal(input.type, "file");
    assert.equal(input.accept, ".brain");
    assert.equal(input.clicks, 1);
    assert.equal(picked, file);
  });

  test("resolves undefined when the chooser is cancelled", async () => {
    installDocument();
    onClick = (input) => {
      input.listeners.get("cancel")?.();
    };

    assert.equal(await pickFile(".brain"), undefined);
  });

  test("resolves undefined when the input reports no file", async () => {
    installDocument();
    onClick = (input) => {
      input.files = [];
      input.listeners.get("change")?.();
    };

    assert.equal(await pickFile(".brain"), undefined);
  });
});
