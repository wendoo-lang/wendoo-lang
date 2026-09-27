import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FOLDER_SESSION_PROTOCOL_VERSION, FolderSessionErrorCode } from "@wendoo/bridge-protocol";
import { judgeFolderHello } from "./folder-hello";

describe("judgeFolderHello", () => {
  it("accepts the host's own version as the session's version", () => {
    assert.deepEqual(judgeFolderHello(FOLDER_SESSION_PROTOCOL_VERSION), {
      accepted: true,
      protocolVersion: FOLDER_SESSION_PROTOCOL_VERSION,
    });
  });

  it("accepts every older version as the session's version, so the welcome returns the app's own", () => {
    for (let declared = 1; declared < FOLDER_SESSION_PROTOCOL_VERSION; declared++) {
      assert.deepEqual(judgeFolderHello(declared), { accepted: true, protocolVersion: declared });
    }
  });

  it("refuses a newer version with PROTOCOL_VERSION_NEWER and a notice to update the extension", () => {
    const verdict = judgeFolderHello(FOLDER_SESSION_PROTOCOL_VERSION + 1);

    assert.equal(verdict.accepted, false);
    assert.ok(!verdict.accepted);
    assert.equal(verdict.error.code, FolderSessionErrorCode.PROTOCOL_VERSION_NEWER);
    assert.equal(typeof verdict.extensionUpdateNotice, "string");
  });

  for (const [label, declared] of [
    ["a missing version", undefined],
    ["a non-numeric version", "3"],
    ["a fractional version", 2.5],
    ["version zero", 0],
  ] as const) {
    it(`refuses ${label} with INVALID_PAYLOAD and no notice`, () => {
      const verdict = judgeFolderHello(declared);

      assert.ok(!verdict.accepted);
      assert.equal(verdict.error.code, FolderSessionErrorCode.INVALID_PAYLOAD);
      assert.equal(verdict.extensionUpdateNotice, undefined);
    });
  }
});
