import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { FileContent } from "@wendoo/app-host";
import type { DiagnosticEntry, PeerSessionHelloMessage, PeerSessionKind, PeerSessionPort } from "@wendoo/bridge-app";
import {
  type AppBridgeFeature,
  type AppBridgeSnapshot,
  BridgeSessionErrorCode,
  connectPeerSession,
  createAppBridge,
  type ProjectFileChange,
  type ProjectFileSnapshot,
  type ProjectFileSystem,
} from "@wendoo/bridge-app";
import { FileSystem, type FileSystemNotification, type FileSystemSnapshot } from "@wendoo/bridge-client";
import type { WsMessage } from "@wendoo/bridge-protocol";

type WsCallback = ((...args: unknown[]) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: WsCallback = null;
  onclose: WsCallback = null;
  onmessage: WsCallback = null;
  onerror: WsCallback = null;

  readonly url: string;
  readonly sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  simulateOpen(): void {
    this.onopen?.({});
  }

  simulateMessage(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.onclose?.({});
  }
}

class MemoryProjectFileSystem implements ProjectFileSystem {
  private readonly _fs = new FileSystem();
  private readonly _listeners = new Set<(change: ProjectFileChange) => void>();
  private readonly _anyChangeListeners = new Set<() => void>();

  constructor(entries: FileSystemSnapshot = new Map()) {
    this._fs.import(entries);
  }

  exportSnapshot(): ProjectFileSnapshot {
    return new Map(this._fs.export());
  }

  applyRemoteChange(change: ProjectFileChange): void {
    applyChange(this._fs, change);
    for (const listener of this._anyChangeListeners) {
      listener();
    }
  }

  onLocalChange(listener: (change: ProjectFileChange) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  onAnyChange(listener: () => void): () => void {
    this._anyChangeListeners.add(listener);
    return () => {
      this._anyChangeListeners.delete(listener);
    };
  }

  flush(): void {}

  applyLocalChange(change: ProjectFileChange): void {
    applyChange(this._fs, change);
    for (const listener of this._listeners) {
      listener(change);
    }
    for (const listener of this._anyChangeListeners) {
      listener();
    }
  }

  read(path: string): FileContent {
    return this._fs.read(path);
  }

  has(path: string): boolean {
    try {
      this._fs.stat(path);
      return true;
    } catch {
      return false;
    }
  }
}

function applyChange(fs: FileSystem, change: ProjectFileChange): void {
  switch (change.action) {
    case "write":
      fs.writeRestore(change.path, change.content, change.isReadonly ?? false, change.newEtag);
      break;
    case "delete":
      fs.delete(change.path);
      break;
    case "rename":
      fs.rename(change.oldPath, change.newPath);
      break;
    case "mkdir":
      fs.mkdir(change.path);
      break;
    case "rmdir":
      fs.rmdir(change.path);
      break;
    case "import":
      fs.import(new Map(change.entries));
      break;
  }
}

function lastSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1);
  assert.ok(socket, "expected a MockWebSocket instance");
  return socket;
}

function parseSent(socket: MockWebSocket): WsMessage[] {
  return socket.sent.map((raw) => JSON.parse(raw) as WsMessage);
}

function createBridge(filesystem: MemoryProjectFileSystem, features: readonly AppBridgeFeature[] = []) {
  return createAppBridge({
    bridgeUrl: "http://localhost:3000",
    filesystem,
    features,
  });
}

/** A welcome from the bridge declaring `protocolVersion`. */
function welcome(protocolVersion: number): WsMessage {
  return { type: "session:welcome", payload: { protocolVersion, sessionId: "session-1", joinCode: "JOIN-1" } };
}

/** A session kind speaking protocol version 1. */
const SAMPLE_KIND: PeerSessionKind<"sample"> = { kind: "sample", protocolVersion: 1 };

/** A payload message of {@link SAMPLE_KIND} carrying opaque text. */
interface SampleDocumentMessage {
  type: "sample:document";
  payload: { content: string };
}

/** Every message {@link SAMPLE_KIND} carries. */
type SampleMessage = PeerSessionHelloMessage<"sample"> | SampleDocumentMessage;

function createDiagnostic(message: string): DiagnosticEntry {
  return {
    severity: "error",
    message,
    code: "MC001",
    range: {
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 5,
    },
  };
}

describe("createAppBridge", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  });

  afterEach(() => {
    mock.timers.reset();
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  it("tracks connection state and join code through snapshot updates", () => {
    const filesystem = new MemoryProjectFileSystem();
    const bridge = createBridge(filesystem);
    const snapshots: AppBridgeSnapshot[] = [];

    bridge.onStateChange(() => {
      snapshots.push(bridge.snapshot());
    });

    bridge.start();
    const socket = lastSocket();

    assert.deepEqual(snapshots[0], { status: "connecting", joinCode: undefined, errorCode: undefined });

    socket.simulateOpen();
    socket.simulateMessage({
      type: "session:welcome",
      payload: { protocolVersion: 1, sessionId: "session-1", joinCode: "JOIN-1" },
    });
    socket.simulateMessage({
      type: "session:joinCode",
      payload: { joinCode: "JOIN-2" },
    });
    socket.simulateClose();

    assert.equal(bridge.snapshot().status, "reconnecting");
    assert.equal(bridge.snapshot().joinCode, "JOIN-2");
    assert.ok(snapshots.some((snapshot) => snapshot.status === "connected"));
    assert.ok(snapshots.some((snapshot) => snapshot.joinCode === "JOIN-1"));
    assert.ok(snapshots.some((snapshot) => snapshot.joinCode === "JOIN-2"));

    bridge.stop();

    assert.deepEqual(bridge.snapshot(), { status: "disconnected", joinCode: undefined, errorCode: undefined });
  });

  it("forwards local changes and applies remote changes through the project file system", () => {
    const filesystem = new MemoryProjectFileSystem(
      new Map([["src/main.ts", { kind: "file", content: "const value = 1;", etag: "etag-1", isReadonly: false }]])
    );
    const bridge = createBridge(filesystem);
    const remoteChanges: ProjectFileChange[] = [];

    bridge.onRemoteChange((change) => {
      remoteChanges.push(change);
    });

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();

    const localChange: ProjectFileChange = {
      action: "write",
      path: "src/main.ts",
      content: "const value = 2;",
      isReadonly: false,
      newEtag: "etag-2",
      expectedEtag: "etag-1",
    };

    filesystem.applyLocalChange(localChange);

    const localMessage = parseSent(socket).find((message) => {
      return (
        message.type === "filesystem:change" &&
        typeof message.payload === "object" &&
        message.payload !== null &&
        "path" in message.payload
      );
    });

    assert.deepEqual(localMessage?.payload, localChange);

    const remoteChange: FileSystemNotification = {
      action: "write",
      path: "src/remote.ts",
      content: "export const remote = true;",
      isReadonly: false,
      newEtag: "etag-remote",
    };

    socket.simulateMessage({
      type: "filesystem:change",
      seq: 1,
      payload: remoteChange,
    });

    assert.equal(filesystem.read("src/remote.ts"), "export const remote = true;");
    assert.deepEqual(remoteChanges, [remoteChange]);
  });

  it("applies sync responses as one import change and updates the project file snapshot", async () => {
    const filesystem = new MemoryProjectFileSystem(
      new Map([["src/stale.ts", { kind: "file", content: "stale", etag: "etag-stale", isReadonly: false }]])
    );
    const bridge = createBridge(filesystem);
    const remoteChanges: ProjectFileChange[] = [];
    let syncCount = 0;

    bridge.onRemoteChange((change) => {
      remoteChanges.push(change);
    });
    bridge.onStateChange(() => {});

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();

    const syncPromise = bridge.requestSync();
    const syncRequest = parseSent(socket).find((message) => message.type === "filesystem:sync" && message.id);

    assert.ok(syncRequest?.id);

    const feature: AppBridgeFeature = {
      attach(context) {
        return context.onDidSync(() => {
          syncCount++;
        });
      },
    };

    const syncBridge = createBridge(filesystem, [feature]);
    syncBridge.start();
    const syncSocket = lastSocket();
    syncSocket.simulateOpen();

    const secondSync = syncBridge.requestSync();
    const secondRequest = parseSent(syncSocket).find((message) => message.type === "filesystem:sync" && message.id);

    assert.ok(secondRequest?.id);

    const entries: FileSystemSnapshot = new Map([
      ["src/fresh.ts", { kind: "file", content: "fresh", etag: "etag-fresh", isReadonly: false }],
    ]);

    socket.simulateMessage({
      type: "filesystem:sync",
      id: syncRequest.id,
      seq: 4,
      payload: { entries: [...entries] },
    });
    syncSocket.simulateMessage({
      type: "filesystem:sync",
      id: secondRequest.id,
      seq: 4,
      payload: { entries: [...entries] },
    });

    await syncPromise;
    await secondSync;

    assert.equal(remoteChanges.length, 1);
    assert.deepEqual(remoteChanges[0], { action: "import", entries: [...entries] });
    assert.throws(() => filesystem.read("src/stale.ts"));
    assert.equal(filesystem.read("src/fresh.ts"), "fresh");
    assert.equal(syncCount, 1);
  });

  it("attaches features and replays through the sync hook with publish helpers", () => {
    const filesystem = new MemoryProjectFileSystem(
      new Map([["src/main.ts", { kind: "file", content: "const value = 1;", etag: "etag-1", isReadonly: false }]])
    );
    const seenSnapshots: AppBridgeSnapshot[] = [];
    let attachedWorkspaceSize = 0;

    const feature: AppBridgeFeature = {
      attach(context) {
        seenSnapshots.push(context.snapshot());
        attachedWorkspaceSize = context.projectFileSnapshot().size;

        return context.onDidSync(() => {
          context.publishDiagnostics("src/main.ts", [createDiagnostic("unexpected token")]);
          context.publishStatus({
            file: "src/main.ts",
            success: false,
            diagnosticCount: { error: 1, warning: 0 },
          });
        });
      },
    };

    const bridge = createBridge(filesystem, [feature]);
    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();

    socket.simulateMessage({
      type: "filesystem:sync",
      id: "sync-1",
      seq: 1,
    });

    const messages = parseSent(socket);
    const diagnosticsMessage = messages.find((message) => message.type === "compile:diagnostics");
    const statusMessage = messages.find((message) => message.type === "compile:status");
    const syncResponse = messages.find((message) => message.type === "filesystem:sync" && message.id === "sync-1");

    assert.equal(attachedWorkspaceSize, 1);
    assert.deepEqual(seenSnapshots[0], { status: "disconnected", joinCode: undefined, errorCode: undefined });
    assert.ok(syncResponse?.payload);
    assert.deepEqual(diagnosticsMessage?.payload, {
      file: "src/main.ts",
      version: 1,
      diagnostics: [createDiagnostic("unexpected token")],
    });
    assert.deepEqual(statusMessage?.payload, {
      file: "src/main.ts",
      success: false,
      diagnosticCount: { error: 1, warning: 0 },
    });
  });

  it("carries payload messages to and from the peer verbatim", () => {
    const bridge = createBridge(new MemoryProjectFileSystem());
    const received: WsMessage[] = [];
    bridge.onPayload((message) => {
      received.push(message);
    });

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage(welcome(1));

    const inbound = { type: "sample:document", payload: { content: "line\nnext \u00e9" }, extra: [1, 2] };
    socket.simulateMessage({ type: "session:joinCode", payload: { joinCode: "JOIN-2" } });
    socket.simulateMessage({ type: "control:pong" });
    socket.simulateMessage({ type: "filesystem:change", seq: 1, payload: { action: "mkdir", path: "src" } });
    socket.simulateMessage(inbound);

    const outbound = { type: "sample:document", payload: { content: "reply" }, extra: { kept: true } };
    const before = socket.sent.length;
    bridge.sendPayload(outbound);

    assert.deepEqual(received, [inbound]);
    assert.deepEqual(
      socket.sent.slice(before).map((raw) => JSON.parse(raw) as unknown),
      [outbound]
    );
  });

  it("throws when a payload is sent before start", () => {
    const bridge = createBridge(new MemoryProjectFileSystem());

    assert.throws(() => bridge.sendPayload({ type: "sample:document" }));
  });

  it("reports a protocol version mismatch in the snapshot and clears it on the next start", () => {
    const bridge = createBridge(new MemoryProjectFileSystem());
    const snapshots: AppBridgeSnapshot[] = [];
    bridge.onStateChange(() => {
      snapshots.push(bridge.snapshot());
    });

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage(welcome(2));

    const reported = snapshots.filter((snapshot) => snapshot.errorCode !== undefined);
    assert.deepEqual(
      reported.map((snapshot) => [snapshot.status, snapshot.errorCode]),
      [["disconnected", BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH]]
    );
    assert.equal(bridge.snapshot().errorCode, BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH);

    bridge.stop();
    bridge.start();
    lastSocket().simulateOpen();

    assert.equal(bridge.snapshot().errorCode, undefined);
    assert.equal(bridge.snapshot().status, "connected");
  });

  it("opens a new session when started again after a version rejection", () => {
    const bridge = createBridge(new MemoryProjectFileSystem());
    const received: WsMessage[] = [];
    bridge.onPayload((message) => {
      received.push(message);
    });

    bridge.start();
    const rejectedSocket = lastSocket();
    rejectedSocket.simulateOpen();
    rejectedSocket.simulateMessage(welcome(2));

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage(welcome(1));
    const inbound = { type: "sample:document", payload: { content: "after restart" } };
    socket.simulateMessage(inbound);

    assert.notEqual(socket, rejectedSocket);
    assert.deepEqual(bridge.snapshot(), { status: "connected", joinCode: "JOIN-1", errorCode: undefined });
    assert.deepEqual(received, [inbound]);
  });

  it("adopts nothing from a rejected welcome", () => {
    const tokens: string[] = [];
    const bridge = createAppBridge({
      bridgeUrl: "http://localhost:3000",
      filesystem: new MemoryProjectFileSystem(),
      onBindingTokenChange: (token) => {
        tokens.push(token);
      },
    });
    const snapshots: AppBridgeSnapshot[] = [];
    bridge.onStateChange(() => {
      snapshots.push(bridge.snapshot());
    });

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage({
      type: "session:welcome",
      payload: { protocolVersion: 2, sessionId: "session-1", joinCode: "JOIN-1", bindingToken: "token-1" },
    });

    assert.deepEqual(
      snapshots.filter((snapshot) => snapshot.joinCode !== undefined),
      []
    );
    assert.deepEqual(tokens, []);
    assert.equal(bridge.snapshot().errorCode, BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH);

    bridge.start();
    lastSocket().simulateOpen();
    lastSocket().simulateMessage({
      type: "session:welcome",
      payload: { protocolVersion: 1, sessionId: "session-2", joinCode: "JOIN-2", bindingToken: "token-2" },
    });

    assert.equal(bridge.snapshot().joinCode, "JOIN-2");
    assert.deepEqual(tokens, ["token-2"]);
    assert.deepEqual(parseSent(lastSocket())[0], { type: "session:hello", payload: { protocolVersion: 1 } });
  });

  it("reports a code the bridge sends in a session error and opens a new session on the next start", () => {
    const bridge = createBridge(new MemoryProjectFileSystem());
    const snapshots: AppBridgeSnapshot[] = [];
    bridge.onStateChange(() => {
      snapshots.push(bridge.snapshot());
    });

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage({
      type: "session:error",
      payload: { message: "unsupported protocol version", code: BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH },
    });

    assert.deepEqual(snapshots.at(-1), {
      status: "disconnected",
      joinCode: undefined,
      errorCode: BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH,
    });
    assert.equal(socket.closed, true);

    bridge.start();
    lastSocket().simulateOpen();
    lastSocket().simulateMessage(welcome(1));

    assert.deepEqual(bridge.snapshot(), { status: "connected", joinCode: "JOIN-1", errorCode: undefined });
  });

  it("connects to the app endpoint unless a wsPath is given", () => {
    createBridge(new MemoryProjectFileSystem()).start();
    const defaultUrl = lastSocket().url;

    createAppBridge({
      bridgeUrl: "localhost:3000",
      wsPath: "sample/editor",
      filesystem: new MemoryProjectFileSystem(),
    }).start();

    assert.equal(defaultUrl, "ws://localhost:3000/app");
    assert.equal(lastSocket().url, "ws://localhost:3000/sample/editor");
  });

  it("presents the join code and binding token it is given in its first hello", () => {
    createAppBridge({
      bridgeUrl: "localhost:3000",
      filesystem: new MemoryProjectFileSystem(),
      joinCode: "JOIN-9",
      bindingToken: "token-9",
    }).start();
    const socket = lastSocket();
    socket.simulateOpen();

    assert.deepEqual(parseSent(socket)[0], {
      type: "session:hello",
      payload: { protocolVersion: 1, bindingToken: "token-9", joinCode: "JOIN-9" },
    });
  });

  it("presents the join code it is given until a welcome is accepted, then its binding token alone", () => {
    const bridge = createAppBridge({
      bridgeUrl: "localhost:3000",
      filesystem: new MemoryProjectFileSystem(),
      joinCode: "JOIN-9",
    });
    const replaced = {
      type: "session:error",
      payload: { message: "replaced", code: BridgeSessionErrorCode.SESSION_REPLACED },
    };
    bridge.start();
    lastSocket().simulateOpen();
    lastSocket().simulateMessage(replaced);
    bridge.start();
    const unwelcomed = lastSocket();
    unwelcomed.simulateOpen();
    unwelcomed.simulateMessage({
      type: "session:welcome",
      payload: { protocolVersion: 1, sessionId: "session-1", joinCode: "JOIN-9", bindingToken: "token-1" },
    });
    unwelcomed.simulateMessage({ type: "session:joinCode", payload: { joinCode: "JOIN-10" } });
    unwelcomed.simulateMessage(replaced);

    bridge.start();
    const welcomed = lastSocket();
    welcomed.simulateOpen();

    assert.deepEqual(parseSent(unwelcomed)[0], {
      type: "session:hello",
      payload: { protocolVersion: 1, joinCode: "JOIN-9" },
    });
    assert.deepEqual(parseSent(welcomed)[0], {
      type: "session:hello",
      payload: { protocolVersion: 1, bindingToken: "token-1" },
    });
  });

  it("reports a counterpart away until the next welcome, keeping the connection, join code, and token", () => {
    const tokens: string[] = [];
    const bridge = createAppBridge({
      bridgeUrl: "localhost:3000",
      filesystem: new MemoryProjectFileSystem(),
      onBindingTokenChange: (token) => {
        tokens.push(token);
      },
    });
    const snapshots: AppBridgeSnapshot[] = [];
    bridge.onStateChange(() => {
      snapshots.push(bridge.snapshot());
    });
    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage({
      type: "session:welcome",
      payload: { protocolVersion: 1, sessionId: "session-1", joinCode: "JOIN-1", bindingToken: "token-1" },
    });
    const before = snapshots.length;

    socket.simulateMessage({ type: "session:counterpartAway" });

    assert.deepEqual(snapshots.slice(before), [
      { status: "connected", joinCode: "JOIN-1", errorCode: undefined, counterpartAway: true },
    ]);
    assert.equal(socket.closed, false);
    assert.deepEqual(tokens, ["token-1"]);

    socket.simulateMessage({
      type: "session:welcome",
      payload: { protocolVersion: 1, sessionId: "session-1", joinCode: "JOIN-1", bindingToken: "token-1" },
    });

    assert.deepEqual(bridge.snapshot(), { status: "connected", joinCode: "JOIN-1", errorCode: undefined });

    socket.simulateMessage({ type: "session:counterpartAway" });
    bridge.stop();

    assert.deepEqual(bridge.snapshot(), { status: "disconnected", joinCode: undefined, errorCode: undefined });
  });

  it("carries a peer session bound over its payload messages", async () => {
    const bridge = createBridge(new MemoryProjectFileSystem());
    const port: PeerSessionPort<SampleMessage> = {
      postMessage(message) {
        bridge.sendPayload(message);
      },
      onMessage(listener) {
        return bridge.onPayload((message) => {
          listener(message as SampleMessage);
        });
      },
    };

    bridge.start();
    const socket = lastSocket();
    socket.simulateOpen();
    socket.simulateMessage(welcome(1));

    const connecting = connectPeerSession<"sample", SampleDocumentMessage>({ kind: SAMPLE_KIND, port });
    assert.deepEqual(parseSent(socket).at(-1), { type: "sample:hello", payload: { protocolVersion: 1 } });

    socket.simulateMessage({ type: "sample:hello", payload: { protocolVersion: 1 } });
    socket.simulateMessage({ type: "sample:document", payload: { content: "from peer" } });
    const session = await connecting;
    const documents: string[] = [];
    session.onMessage((message) => {
      documents.push(message.payload.content);
    });
    session.postMessage({ type: "sample:document", payload: { content: "from here" } });

    assert.equal(session.peerProtocolVersion, 1);
    assert.deepEqual(documents, ["from peer"]);
    assert.deepEqual(parseSent(socket).at(-1), { type: "sample:document", payload: { content: "from here" } });
  });
});
