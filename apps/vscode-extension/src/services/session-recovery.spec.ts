import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BridgeSessionErrorCode } from "@wendoo/bridge-protocol";
import { SessionRecoveryAction, sessionRecoveryOffer } from "./session-recovery";

/** The actions the offer for `code` presents, in order. */
function actionsFor(code: BridgeSessionErrorCode): string[] {
  return sessionRecoveryOffer(code).choices.map((choice) => choice.action);
}

describe("sessionRecoveryOffer", () => {
  it("offers a way back for every code that ends a session's connection", () => {
    for (const code of Object.values(BridgeSessionErrorCode)) {
      assert.ok(actionsFor(code).length > 0, `expected a recovery action for ${code}`);
    }
  });

  it("offers reconnecting by token, and never code entry, after another window supersedes this one", () => {
    assert.deepEqual(actionsFor(BridgeSessionErrorCode.SESSION_REPLACED), [SessionRecoveryAction.RECONNECT]);
  });

  it("offers entering a current code after a refused one", () => {
    assert.deepEqual(actionsFor(BridgeSessionErrorCode.JOIN_CODE_UNKNOWN), [SessionRecoveryAction.ENTER_JOIN_CODE]);
  });

  it("offers a code or a deliberate re-form by token after the session ended", () => {
    assert.deepEqual(actionsFor(BridgeSessionErrorCode.SESSION_ENDED), [
      SessionRecoveryAction.ENTER_JOIN_CODE,
      SessionRecoveryAction.RECONNECT,
    ]);
  });

  it("offers reconnecting after an outbound backlog overflowed", () => {
    assert.deepEqual(actionsFor(BridgeSessionErrorCode.OUTBOUND_QUEUE_OVERFLOW), [SessionRecoveryAction.RECONNECT]);
  });

  it("offers updating, then reconnecting, after a version rejection", () => {
    assert.deepEqual(actionsFor(BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH), [
      SessionRecoveryAction.CHECK_FOR_UPDATES,
      SessionRecoveryAction.RECONNECT,
    ]);
  });
});
