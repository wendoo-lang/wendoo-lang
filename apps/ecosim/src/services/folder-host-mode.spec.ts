import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FolderAppMessage, FolderHostMessage, FolderHostPort } from "@wendoo/bridge-app";
import {
  FOLDER_HOST_MODE_FOLDER,
  FOLDER_HOST_MODE_GLOBAL,
  FolderSessionError,
  FolderSessionErrorCode,
  WORKSPACE_FOLDER_PROJECT_COLLECTION_ID,
} from "@wendoo/bridge-app";
import { name as simName } from "../../package.json";
import {
  appChromeForMode,
  connectEcosimFolderSession,
  ecosimFolderAppDataCodec,
  isFolderHostMode,
} from "./folder-host-mode";
import { DESIRED_COUNTS_KEY, type EcosimAppChunk, OBSTACLES_KEY } from "./project-io";

describe("isFolderHostMode", () => {
  it("is true only for the folder host-mode bootstrap flag", () => {
    assert.strictEqual(isFolderHostMode("?wendooHostMode=folder", {}), true);
    assert.strictEqual(isFolderHostMode("", {}), false);
    assert.strictEqual(isFolderHostMode("?wendooHostMode=other", {}), false);
    assert.strictEqual(isFolderHostMode("?other=folder", {}), false);
  });

  it("accepts the host-defined global as a second carrier of the same flag", () => {
    assert.strictEqual(isFolderHostMode("", { [FOLDER_HOST_MODE_GLOBAL]: FOLDER_HOST_MODE_FOLDER }), true);
    assert.strictEqual(isFolderHostMode("", { [FOLDER_HOST_MODE_GLOBAL]: "other" }), false);
  });
});

describe("appChromeForMode", () => {
  it("keeps the full default-mode chrome", () => {
    assert.deepStrictEqual(appChromeForMode(false), {
      showProjectMenu: true,
      showBridgePanel: true,
      showSettings: true,
      showDocsPageLinks: true,
    });
  });

  it("hides project-management, bridge, and settings chrome in folder host mode", () => {
    assert.deepStrictEqual(appChromeForMode(true), {
      showProjectMenu: false,
      showBridgePanel: false,
      showSettings: false,
      showDocsPageLinks: false,
    });
  });
});

const COUNTS = { carnivore: 3, herbivore: 12, plant: 40 };
const OBSTACLES = [{ x: 10, y: 20, width: 30, height: 40, rotation: 0.5 }];

describe("ecosimFolderAppDataCodec", () => {
  it("round-trips desired counts and obstacles through the app chunk", () => {
    const appData = new Map<string, string>([
      [DESIRED_COUNTS_KEY, JSON.stringify(COUNTS)],
      [OBSTACLES_KEY, JSON.stringify(OBSTACLES)],
    ]);

    const chunk = ecosimFolderAppDataCodec.chunkFromAppData(appData);
    const restored = ecosimFolderAppDataCodec.appDataFromChunk(chunk);

    assert.deepStrictEqual(JSON.parse(restored[DESIRED_COUNTS_KEY] ?? "null"), COUNTS);
    assert.deepStrictEqual(JSON.parse(restored[OBSTACLES_KEY] ?? "null"), OBSTACLES);
  });

  it("writes the export chunk shape, naming the archetypes whose brain the project stores", () => {
    const appData = new Map<string, string>([
      ["brains", JSON.stringify({ carnivore: { pages: [] } })],
      [DESIRED_COUNTS_KEY, JSON.stringify(COUNTS)],
    ]);

    const chunk = ecosimFolderAppDataCodec.chunkFromAppData(appData) as EcosimAppChunk;

    assert.deepStrictEqual(chunk.actors, [
      { archetype: "carnivore", brain: "carnivore", desiredCount: 3 },
      { archetype: "herbivore", brain: null, desiredCount: 12 },
      { archetype: "plant", brain: null, desiredCount: 40 },
    ]);
    assert.strictEqual(chunk.obstacles, undefined);
  });

  it("produces no chunk when the app data carries no session state", () => {
    assert.strictEqual(ecosimFolderAppDataCodec.chunkFromAppData(new Map()), undefined);
  });
});

/** A host port that welcomes the hello with `manifestContent` and acknowledges every write. */
function fakeHostPort(manifestContent: string): FolderHostPort {
  let listener: ((message: FolderHostMessage) => void) | undefined;
  return {
    postMessage(message: FolderAppMessage): void {
      queueMicrotask(() => {
        if (message.type === "folder:hello") {
          listener?.({
            type: "folder:welcome",
            id: message.id,
            payload: {
              protocolVersion: message.payload.protocolVersion,
              projectId: "the-folder-project",
              manifest: { content: manifestContent, etag: "disk-1" },
            },
          });
        } else if (message.type === "folder:loadFiles") {
          listener?.({ type: "folder:files", id: message.id, payload: { entries: [] } });
        } else if (message.type === "folder:change" || message.type === "folder:manifestWrite") {
          listener?.({ type: "folder:ack", id: message.id });
        }
      });
    },
    onMessage(next: (message: FolderHostMessage) => void): () => void {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
}

/** A host port that refuses the hello with `code`. */
function refusingHostPort(code: FolderSessionErrorCode): FolderHostPort {
  let listener: ((message: FolderHostMessage) => void) | undefined;
  return {
    postMessage(message: FolderAppMessage): void {
      queueMicrotask(() => {
        listener?.({ type: "folder:error", id: message.id, payload: { code, message: "refused" } });
      });
    },
    onMessage(next: (message: FolderHostMessage) => void): () => void {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
}

describe("connectEcosimFolderSession", () => {
  it("selects a workspace-folder store hosting the handshake project", async () => {
    const session = await connectEcosimFolderSession(
      fakeHostPort(JSON.stringify({ name: "Hosted Project", version: "0.1.0" }))
    );

    const tabSession = session.store.getProjectSession();
    assert.strictEqual(tabSession?.projectCollectionId, WORKSPACE_FOLDER_PROJECT_COLLECTION_ID);
    assert.strictEqual(tabSession.activeProjectId, "the-folder-project");
    const project = await session.store.getProject("the-folder-project");
    assert.strictEqual(project?.name, "Hosted Project");
    session.dispose();
  });

  it("seeds the store's app data from the sim's chunk in the folder's wendoo.json", async () => {
    const chunk: EcosimAppChunk = {
      actors: [
        { archetype: "carnivore", brain: null, desiredCount: 3 },
        { archetype: "herbivore", brain: null, desiredCount: 12 },
        { archetype: "plant", brain: null, desiredCount: 40 },
      ],
      obstacles: OBSTACLES,
    };
    const session = await connectEcosimFolderSession(
      fakeHostPort(JSON.stringify({ name: "Hosted Project", version: "0.1.0", app: { [simName]: chunk } }))
    );

    const counts = await session.store.loadAppData("the-folder-project", DESIRED_COUNTS_KEY);
    const obstacles = await session.store.loadAppData("the-folder-project", OBSTACLES_KEY);
    assert.deepStrictEqual(JSON.parse(counts ?? "null"), COUNTS);
    assert.deepStrictEqual(JSON.parse(obstacles ?? "null"), OBSTACLES);
    session.dispose();
  });

  it("rejects with the host's coded error when the host refuses this build's newer protocol version", async () => {
    await assert.rejects(
      connectEcosimFolderSession(refusingHostPort(FolderSessionErrorCode.PROTOCOL_VERSION_NEWER)),
      (error: unknown) =>
        error instanceof FolderSessionError && error.code === FolderSessionErrorCode.PROTOCOL_VERSION_NEWER
    );
  });
});
