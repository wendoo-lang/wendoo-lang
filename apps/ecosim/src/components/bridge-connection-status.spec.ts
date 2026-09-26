import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BridgeSessionErrorCode } from "@wendoo/bridge-app";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BridgeConnectionStatus,
  type BridgeConnectionStatusProps,
  bridgeConnectionView,
} from "./BridgeConnectionStatus";

/** Renders the readout for `props` layered over a connected, paired bridge. */
function render(props: Partial<BridgeConnectionStatusProps>): string {
  return renderToStaticMarkup(
    createElement(BridgeConnectionStatus, {
      status: "connected",
      paired: true,
      errorCode: undefined,
      joinCode: undefined,
      onReconnect: () => {},
      ...props,
    })
  );
}

describe("bridgeConnectionView", () => {
  test("reads the bridge's status, pairing, and held failure into one view", () => {
    assert.equal(bridgeConnectionView("disconnected", false, undefined), "off");
    assert.equal(bridgeConnectionView("connecting", false, undefined), "connecting");
    assert.equal(bridgeConnectionView("reconnecting", false, undefined), "connecting");
    assert.equal(bridgeConnectionView("connected", false, undefined), "waiting");
    assert.equal(bridgeConnectionView("connected", true, undefined), "connected");
    assert.equal(bridgeConnectionView("disconnected", false, BridgeSessionErrorCode.SESSION_ENDED), "held");
  });
});

describe("BridgeConnectionStatus", () => {
  test("waits for VS Code with the join code to enter while the session is not connected with it", () => {
    const markup = render({ paired: false, joinCode: "fuzzy-diamond-moor" });

    assert.match(markup, /data-testid="bridge-status" data-state="waiting"/);
    assert.match(markup, /data-testid="bridge-join-code"[^>]*>fuzzy-diamond-moor</);
    assert.doesNotMatch(markup, /data-testid="bridge-hold-notice"/);
  });

  test("shows the session connected with no join code and no notice", () => {
    const markup = render({});

    assert.match(markup, /data-testid="bridge-status" data-state="connected"/);
    assert.doesNotMatch(markup, /data-testid="bridge-join-code"/);
    assert.doesNotMatch(markup, /data-testid="bridge-hold-notice"/);
  });

  for (const code of [
    BridgeSessionErrorCode.SESSION_REPLACED,
    BridgeSessionErrorCode.SESSION_ENDED,
    BridgeSessionErrorCode.OUTBOUND_QUEUE_OVERFLOW,
  ]) {
    test(`holds on ${code} with a reconnect affordance`, () => {
      const markup = render({ status: "disconnected", paired: false, errorCode: code });

      assert.match(markup, /data-testid="bridge-status" data-state="held"/);
      assert.ok(markup.includes(`data-testid="bridge-hold-notice" data-code="${code}"`));
      assert.match(markup, /data-testid="bridge-reconnect"/);
      assert.doesNotMatch(markup, /data-testid="bridge-reload"/);
    });
  }

  test("holds on a version rejection with the reload remedy", () => {
    const code = BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH;
    const markup = render({ status: "disconnected", paired: false, errorCode: code });

    assert.ok(markup.includes(`data-testid="bridge-hold-notice" data-code="${code}"`));
    assert.match(markup, /data-testid="bridge-reload"/);
    assert.doesNotMatch(markup, /data-testid="bridge-reconnect"/);
  });
});
