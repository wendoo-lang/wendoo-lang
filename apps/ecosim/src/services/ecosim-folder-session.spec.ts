/**
 * The sim store running on a folder session: the workspace folder backs the
 * project, and edits made to the folder outside the app reach the running app.
 * Each case drives the real store over a real host whose project manager holds
 * the folder session's store, against a fake folder host.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { ProjectManager } from "@wendoo/app-host";
import type { FolderAppMessage, FolderHostMessage, FolderHostPort, FolderHostSession } from "@wendoo/bridge-app";
import { AppEnvironmentHost } from "@wendoo/bridge-app";
import { BrainDef, coreModule } from "@wendoo/core/app";
import { isCompilerControlledPath } from "@wendoo/ts-compiler";
import { name as simName } from "../../package.json";
import { createEcosimModule } from "../brain";
import type { EcosimEnvironmentStore, ExternalProjectDataChange } from "./ecosim-environment-store";
import { connectEcosimFolderSession } from "./folder-host-mode";
import type { EcosimAppChunk } from "./project-io";

// Resolves `virtual:wendoo-embedded-extensions` to the empty stub bundle. The
// store module must be imported only after this hook is registered.
const VIRTUAL_EMBEDDED_EXTENSIONS = "virtual:wendoo-embedded-extensions";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === VIRTUAL_EMBEDDED_EXTENSIONS) {
      return { url: new URL("./embedded-extensions-stub.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { EcosimEnvironmentStore: StoreClass } = await import("./ecosim-environment-store");

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, String(value));
    },
  } as Storage;
}
const globalShim = globalThis as unknown as { localStorage?: Storage; sessionStorage?: Storage };
globalShim.localStorage ??= memoryStorage();
globalShim.sessionStorage ??= memoryStorage();

const PROJECT_ID = "file:///work/folder-project";

/** A folder host double: answers the app's requests and records what the app sent. */
interface FakeFolderHost {
  readonly port: FolderHostPort;
  /** Every message the app posted, in order. */
  readonly posted: FolderAppMessage[];
  /** Deliver an unsolicited host message to the app. */
  send(message: FolderHostMessage): void;
}

function fakeFolderHost(manifest: Record<string, unknown>): FakeFolderHost {
  let listener: ((message: FolderHostMessage) => void) | undefined;
  const posted: FolderAppMessage[] = [];
  const reply = (message: FolderHostMessage): void => {
    queueMicrotask(() => {
      listener?.(message);
    });
  };
  return {
    posted,
    send: reply,
    port: {
      postMessage(message: FolderAppMessage): void {
        posted.push(message);
        if (message.type === "folder:hello") {
          reply({
            type: "folder:welcome",
            id: message.id,
            payload: {
              protocolVersion: message.payload.protocolVersion,
              projectId: PROJECT_ID,
              manifest: { content: JSON.stringify(manifest), etag: "disk-1" },
            },
          });
        } else if (message.type === "folder:loadFiles") {
          reply({ type: "folder:files", id: message.id, payload: { entries: [] } });
        } else if (message.type === "folder:change" || message.type === "folder:manifestWrite") {
          reply({ type: "folder:ack", id: message.id });
        }
      },
      onMessage(next: (message: FolderHostMessage) => void): () => void {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
  };
}

type StoreCtor = new (host: AppEnvironmentHost, folderSession: FolderHostSession) => EcosimEnvironmentStore;

/**
 * The store as `EcosimEnvironmentStore.create()` composes it in folder host
 * mode, over `folderHost` in place of the webview port.
 */
async function folderBackedStore(folderHost: FakeFolderHost): Promise<EcosimEnvironmentStore> {
  const session = await connectEcosimFolderSession(folderHost.port);
  const host = new AppEnvironmentHost({
    projectManager: new ProjectManager(session.store, {
      filesystemOptions: { shouldExclude: (path) => isCompilerControlledPath(path, []) },
    }),
    modules: [coreModule(), createEcosimModule()],
    mounts: [],
  });
  return new (StoreClass as unknown as StoreCtor)(host, session);
}

/** Resolves once every queued microtask and the next macrotask turn have run. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function lastManifestWrite(folderHost: FakeFolderHost): Record<string, unknown> {
  const writes = folderHost.posted.filter((message) => message.type === "folder:manifestWrite");
  const last = writes[writes.length - 1];
  assert.ok(last && last.type === "folder:manifestWrite", "the app wrote wendoo.json");
  return JSON.parse(last.payload.content) as Record<string, unknown>;
}

describe("sim store in folder host mode", () => {
  it("opens the folder's project and persists app data to the folder's wendoo.json", async () => {
    const folderHost = fakeFolderHost({ name: "Folder Project", version: "0.1.0" });
    const store = await folderBackedStore(folderHost);
    try {
      await store.initialize();

      assert.strictEqual(store.projectManager.activeProject?.manifest.id, PROJECT_ID);
      assert.strictEqual(store.activeProjectManifest?.name, "Folder Project");
      assert.ok(
        folderHost.posted.some((message) => message.type === "folder:compilerFiles"),
        "the generated project files are published to the host"
      );

      const obstacles = [{ x: 10, y: 20, width: 30, height: 40, rotation: 0.5 }];
      store.setObstacles(obstacles);
      await settle();

      const written = lastManifestWrite(folderHost);
      const chunk = (written.app as Record<string, EcosimAppChunk>)[simName];
      assert.deepStrictEqual(chunk?.obstacles, obstacles);
    } finally {
      store.dispose();
    }
  });

  it("applies an external wendoo.json edit to the running app", async () => {
    const folderHost = fakeFolderHost({ name: "Folder Project", version: "0.1.0" });
    const store = await folderBackedStore(folderHost);
    try {
      await store.initialize();
      let countsReloaded = 0;
      store.onDesiredCountsReloaded(() => {
        countsReloaded++;
      });
      const applied = new Promise<ExternalProjectDataChange>((resolve) => {
        store.onExternalProjectDataChange(resolve);
      });

      const plantBrain = BrainDef.emptyBrainDef(store.env.brainServices, "plant");
      const obstacles = [{ x: 50, y: 60, width: 70, height: 80, rotation: 0.25 }];
      const edited = {
        name: "Folder Project",
        version: "0.1.0",
        brains: { plant: store.host.serializeBrainForStorage(plantBrain) },
        app: {
          [simName]: {
            actors: [
              { archetype: "carnivore", brain: null, desiredCount: 7 },
              { archetype: "herbivore", brain: null, desiredCount: 8 },
              { archetype: "plant", brain: "plant", desiredCount: 9 },
            ],
            obstacles,
          } satisfies EcosimAppChunk,
        },
      };
      folderHost.send({
        type: "folder:externalChange",
        payload: { action: "write", path: "wendoo.json", content: JSON.stringify(edited), newEtag: "disk-2" },
      });

      const change = await applied;
      assert.deepStrictEqual(change.brains, ["plant"]);
      assert.strictEqual(change.obstaclesChanged, true);
      assert.deepStrictEqual(store.getDesiredCounts(), { carnivore: 7, herbivore: 8, plant: 9 });
      assert.ok(countsReloaded > 0, "desired-count listeners hear the reload");
      assert.deepStrictEqual(store.getObstacles(), obstacles);
      assert.strictEqual(store.host.getCachedBrain("plant")?.name(), plantBrain.name());
    } finally {
      store.dispose();
    }
  });

  it("applies an external project file edit to the live project file system", async () => {
    const folderHost = fakeFolderHost({ name: "Folder Project", version: "0.1.0" });
    const store = await folderBackedStore(folderHost);
    try {
      await store.initialize();

      folderHost.send({
        type: "folder:externalChange",
        payload: { action: "write", path: "notes.txt", content: "hello\n", newEtag: "disk-3" },
      });
      await settle();

      const snapshot = store.projectFileSystem.exportSnapshot();
      assert.ok(snapshot.has("notes.txt"), "the externally written file is in the live project");
    } finally {
      store.dispose();
    }
  });
});
