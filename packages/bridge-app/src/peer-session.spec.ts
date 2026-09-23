import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PeerSessionHelloMessage } from "@wendoo/bridge-protocol";
import { PeerSessionErrorCode } from "@wendoo/bridge-protocol";
import type { PeerSessionKind, PeerSessionPort } from "./peer-session.js";
import { connectPeerSession, PeerSessionError } from "./peer-session.js";

/** A session kind speaking protocol version 1. */
const SAMPLE_KIND: PeerSessionKind<"sample"> = { kind: "sample", protocolVersion: 1 };

/** A payload message of {@link SAMPLE_KIND} carrying opaque text. */
interface SampleDocumentMessage {
  type: "sample:document";
  payload: { content: string };
}

/** Every message {@link SAMPLE_KIND} carries. */
type SampleMessage = PeerSessionHelloMessage<"sample"> | SampleDocumentMessage;

/**
 * A document exercising characters a JSON wire must carry intact: quotes,
 * backslashes, escape sequences written as text, control characters, and
 * non-ASCII code units including a surrogate pair.
 */
const DOCUMENT_TEXT =
  '{"packs":[{"name":"beacon","tiles":[{"name":"say \\"hi\\"","kind":"actuator","docs":"line\\nnext \\u00e9"}]}]}' +
  "\t\r\n\u0001 caf\u00e9 \ud83d\ude00 \\";

/** The document message carrying `content`. */
function documentMessage(content: string): SampleDocumentMessage {
  return { type: "sample:document", payload: { content } };
}

/**
 * Two ports joined by a JSON wire: every message one side posts is
 * serialized, parsed, and delivered to the other side in a later microtask.
 */
function linkedPorts(): [PeerSessionPort<SampleMessage>, PeerSessionPort<SampleMessage>] {
  const listeners: [Set<(message: SampleMessage) => void>, Set<(message: SampleMessage) => void>] = [
    new Set(),
    new Set(),
  ];
  const port = (self: 0 | 1): PeerSessionPort<SampleMessage> => ({
    postMessage(message) {
      const wire = JSON.stringify(message);
      queueMicrotask(() => {
        for (const listener of listeners[1 - self]) {
          listener(JSON.parse(wire) as SampleMessage);
        }
      });
    },
    onMessage(listener) {
      listeners[self].add(listener);
      return () => {
        listeners[self].delete(listener);
      };
    },
  });
  return [port(0), port(1)];
}

/**
 * A scripted peer: answers this side's hello with `replies`, delivered
 * synchronously and in order, and reports how many listeners are attached.
 */
function scriptedPeer(replies: readonly SampleMessage[]): PeerSessionPort<SampleMessage> & {
  listenerCount(): number;
} {
  const listeners = new Set<(message: SampleMessage) => void>();
  return {
    listenerCount: () => listeners.size,
    postMessage(message) {
      if (message.type === "sample:hello") {
        for (const reply of replies) {
          for (const listener of listeners) {
            listener(reply);
          }
        }
      }
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

describe("peer session establishment", () => {
  it("accepts a peer declaring v1 and records its version", async () => {
    const port = scriptedPeer([{ type: "sample:hello", payload: { protocolVersion: 1 } }]);

    const session = await connectPeerSession({ kind: SAMPLE_KIND, port });

    assert.equal(session.peerProtocolVersion, 1);
    session.dispose();
  });

  it("accepts a peer declaring an older version than its own and records it", async () => {
    const port = scriptedPeer([{ type: "sample:hello", payload: { protocolVersion: 1 } }]);

    const session = await connectPeerSession({ kind: { kind: "sample", protocolVersion: 2 }, port });

    assert.equal(session.peerProtocolVersion, 1);
    session.dispose();
  });

  it("establishes between two parties, each recording the version the other declared", async () => {
    const [firstPort, secondPort] = linkedPorts();

    const [first, second] = await Promise.all([
      connectPeerSession({ kind: SAMPLE_KIND, port: firstPort }),
      connectPeerSession({ kind: SAMPLE_KIND, port: secondPort }),
    ]);

    assert.equal(first.peerProtocolVersion, SAMPLE_KIND.protocolVersion);
    assert.equal(second.peerProtocolVersion, SAMPLE_KIND.protocolVersion);
    first.dispose();
    second.dispose();
  });

  it("rejects a peer declaring a newer version with the stable code and detaches", async () => {
    const port = scriptedPeer([{ type: "sample:hello", payload: { protocolVersion: 2 } }]);

    await assert.rejects(connectPeerSession({ kind: SAMPLE_KIND, port }), (error: unknown) => {
      assert.ok(error instanceof PeerSessionError);
      assert.equal(error.code, PeerSessionErrorCode.PROTOCOL_VERSION_NEWER);
      return true;
    });
    assert.equal(port.listenerCount(), 0);
  });
});

describe("peer session messages", () => {
  it("delivers a posted message to the peer byte-verbatim across a JSON wire", async () => {
    const [senderPort, receiverPort] = linkedPorts();
    const [sender, receiver] = await Promise.all([
      connectPeerSession<"sample", SampleDocumentMessage>({ kind: SAMPLE_KIND, port: senderPort }),
      connectPeerSession<"sample", SampleDocumentMessage>({ kind: SAMPLE_KIND, port: receiverPort }),
    ]);
    const received: string[] = [];
    receiver.onMessage((message) => {
      received.push(message.payload.content);
    });

    sender.postMessage(documentMessage(DOCUMENT_TEXT));
    sender.postMessage(documentMessage("{}"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(received, [DOCUMENT_TEXT, "{}"]);
    sender.dispose();
    receiver.dispose();
  });

  it("replays a message that arrives with the peer's hello to the first listener", async () => {
    const port = scriptedPeer([
      { type: "sample:hello", payload: { protocolVersion: 1 } },
      documentMessage(DOCUMENT_TEXT),
    ]);
    const session = await connectPeerSession<"sample", SampleDocumentMessage>({ kind: SAMPLE_KIND, port });

    const received: string[] = [];
    session.onMessage((message) => {
      received.push(message.payload.content);
    });

    assert.deepEqual(received, [DOCUMENT_TEXT]);
    session.dispose();
  });
});
