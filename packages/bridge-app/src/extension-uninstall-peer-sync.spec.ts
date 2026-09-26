import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createInMemoryProjectFileSystem } from "@wendoo/app-host";
import type { FileSystemSnapshotEntry } from "@wendoo/bridge-client";
import type { WsMessage } from "@wendoo/bridge-protocol";
import { coreModule, createWendooEnvironment } from "@wendoo/core";
import {
  buildAmbientDeclarations,
  createWorkspaceCompiler,
  type DependencyMount,
  declarationMount,
  isCompilerControlledPath,
  type Mount,
} from "@wendoo/ts-compiler";
import { createAppBridge } from "./app-bridge.js";
import { augmentProjectFileSystem } from "./compilation.js";

type WsCallback = ((...args: unknown[]) => void) | null;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  onopen: WsCallback = null;
  onclose: WsCallback = null;
  onmessage: WsCallback = null;
  onerror: WsCallback = null;

  readonly sent: string[] = [];

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  simulateOpen(): void {
    this.onopen?.({});
  }

  simulateMessage(data: WsMessage): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const TELEPORT_COORDINATE = "wendoo-lang/lib-ecosim-teleport";
const TELEPORT_INDEX_PATH = `.libraries/${TELEPORT_COORDINATE}/index.ts`;

const TELEPORT_MOUNT: DependencyMount = {
  namespace: TELEPORT_COORDINATE,
  files: new Map([["/index.ts", "export const teleport = 1;"]]),
  dependencies: [],
};

/**
 * Drive a peer `filesystem:sync` request against the app socket and return the
 * paths the app answered with, mirroring what the vscode peer imports on a
 * refresh.
 */
function peerSyncPaths(socket: MockWebSocket, syncId: string): string[] {
  const before = socket.sent.length;
  socket.simulateMessage({ type: "filesystem:sync", id: syncId, seq: 1 } as WsMessage);
  for (let i = before; i < socket.sent.length; i++) {
    const msg = JSON.parse(socket.sent[i]) as WsMessage;
    if (msg.type === "filesystem:sync" && msg.id === syncId && msg.payload) {
      const entries = (msg.payload as { entries: [string, FileSystemSnapshotEntry][] }).entries;
      return entries.map(([path]) => path);
    }
  }
  throw new Error("no sync response captured");
}

describe("extension uninstall peer sync", () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    MockWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
  });

  it("prunes the uninstalled extension's .libraries tree from the peer sync view", () => {
    const environment = createWendooEnvironment({ modules: [coreModule()] });
    const ambient = buildAmbientDeclarations(environment.brainServices.runtime.types);
    const mounts: Mount[] = [declarationMount([{ path: "wendoo.core.d.ts", content: ambient }])];
    const compiler = createWorkspaceCompiler({
      projectNamespace: "teleport-project",
      mounts,
      environment,
      dependencies: [{ coordinate: TELEPORT_COORDINATE }],
      dependencyMounts: [TELEPORT_MOUNT],
    });
    const filesystem = createInMemoryProjectFileSystem({
      shouldExclude: (path) => isCompilerControlledPath(path, mounts),
    });
    filesystem.applyLocalChange({ action: "write", path: "wendoo.json", content: "{}", newEtag: "e0" });
    filesystem.applyLocalChange({ action: "write", path: "src/main.ts", content: "export {};", newEtag: "e1" });
    compiler.replaceWorkspace(
      new Map([["src/main.ts", { kind: "file", content: "export {};", etag: "e1", isReadonly: false }]])
    );
    compiler.compile();

    const served = augmentProjectFileSystem(filesystem, compiler);
    const bridge = createAppBridge({ bridgeUrl: "http://localhost:3000", filesystem: served });

    bridge.start();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.simulateOpen();
    socket.simulateMessage({
      type: "session:welcome",
      payload: { protocolVersion: 1, sessionId: "s" },
    } as WsMessage);

    // While installed, the peer's sync view carries the extension tree.
    assert.ok(
      peerSyncPaths(socket, "sync-installed").includes(TELEPORT_INDEX_PATH),
      "installed extension is present in the peer sync view"
    );

    // Uninstall: drop the dependency and recompile, exactly as
    // updateProjectExtensions does.
    compiler.setDependencies([], []);
    compiler.compile();

    // After uninstall + a peer refresh, the extension tree must be gone.
    assert.ok(
      !peerSyncPaths(socket, "sync-uninstalled").includes(TELEPORT_INDEX_PATH),
      `uninstalled extension ${TELEPORT_INDEX_PATH} must no longer appear in the peer sync view`
    );

    // Reinstalling re-adds the tree: the propagation is symmetric.
    compiler.setDependencies([{ coordinate: TELEPORT_COORDINATE }], [TELEPORT_MOUNT]);
    compiler.compile();
    assert.ok(
      peerSyncPaths(socket, "sync-reinstalled").includes(TELEPORT_INDEX_PATH),
      "reinstalled extension reappears in the peer sync view"
    );

    // A genuine user-file edit still syncs normally.
    filesystem.applyLocalChange({
      action: "write",
      path: "src/main.ts",
      content: "export const v = 2;",
      newEtag: "e2",
    });
    const afterEdit = peerSyncPaths(socket, "sync-edit");
    assert.ok(afterEdit.includes("src/main.ts"), "user file remains in the peer sync view after an edit");
    assert.ok(afterEdit.includes(TELEPORT_INDEX_PATH), "the reinstalled extension survives an unrelated user edit");

    bridge.stop();
  });
});
