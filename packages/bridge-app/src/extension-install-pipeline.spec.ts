import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  ActiveProject,
  ApprovedCatalogEntryLookup,
  ExtensionCatalogMoves,
  ExtensionFetchTransport,
  ProjectCollection,
  ProjectFileSystem,
  ProjectManager,
} from "@wendoo/app-host";
import {
  AppHostErrorCode,
  createInMemoryProjectFileSystem,
  createJsDelivrExtensionTransport,
  ExtensionAddInputErrorCode,
  ExtensionFetchErrorCode,
} from "@wendoo/app-host";
import type { PersistedBrainJson } from "@wendoo/core/app";
import { BrainDef, coreModule } from "@wendoo/core/app";
import { declarationMount } from "@wendoo/ts-compiler";
import { AppEnvironmentHost } from "./app-environment-host.js";
import type { EmbeddedExtension } from "./embedded-extensions.js";
import { CatalogMoveWarningCode } from "./embedded-extensions.js";
import { buildExtensionCatalog } from "./extension-catalog.js";
import { parseExtensionInstallLog } from "./extension-install-log.js";
import {
  parseInstalledExtensionSnapshots,
  reconstructInstalledSnapshotsFromTree,
  serializeInstalledExtensionSnapshots,
} from "./fetched-extension-snapshots.js";

const CORE_AMBIENT = readFileSync(fileURLToPath(new URL("../../core/lib/wendoo.core.d.ts", import.meta.url)), "utf8");

const PROJECT_ID = "install-pipeline-project";

const encoder = new TextEncoder();

/**
 * In-memory transport over text content keyed by `<owner>/<repo>@<pin>`, with
 * branch heads keyed by `<owner>/<repo>#<branch>` and published version lists
 * keyed by `<owner>/<repo>`. Branch heads and version lists are mutable so a
 * test can move the source between installs.
 */
function createTestTransport(options: {
  content: Record<string, Record<string, string>>;
  branches?: Record<string, string>;
  versions?: Record<string, readonly string[]>;
}): ExtensionFetchTransport & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async fetchFile(owner, repo, pin, path) {
      requests.push(`file ${owner}/${repo}@${pin} ${path}`);
      const content = options.content[`${owner}/${repo}@${pin}`]?.[path];
      if (content === undefined) {
        return { ok: false, kind: "not-found" };
      }
      return { ok: true, content: encoder.encode(content) };
    },
    async resolveBranch(owner, repo, branch) {
      requests.push(`branch ${owner}/${repo}#${branch}`);
      const sha = options.branches?.[`${owner}/${repo}#${branch}`];
      if (sha === undefined) {
        return { ok: false, kind: "not-found" };
      }
      return { ok: true, sha };
    },
    async listVersionTags(owner, repo) {
      requests.push(`versions ${owner}/${repo}`);
      const versions = options.versions?.[`${owner}/${repo}`];
      if (versions === undefined) {
        return { ok: false, kind: "not-found" };
      }
      return { ok: true, versions };
    },
  };
}

function manifestText(name: string, extensions?: Record<string, string>): string {
  return JSON.stringify({ name, version: "0.1.0", files: ["index.ts"], ...(extensions ? { extensions } : {}) });
}

const POSITION_COORDINATE = "example-org/position-ext";
const POSITION_REFERENCE = `gh:${POSITION_COORDINATE}@v0.1.0`;
const POSITION_CONTENT: Record<string, string> = {
  "wendoo.json": manifestText("Position"),
  "index.ts": "export const position = 42;\n",
};

const BROKEN_COORDINATE = "example-org/broken-ext";
const BROKEN_REFERENCE = `gh:${BROKEN_COORDINATE}@v0.1.0`;
const BROKEN_CONTENT: Record<string, string> = {
  "wendoo.json": manifestText("Broken"),
  "index.ts": 'export const broken: number = "not a number";\n',
};

const HOST_IMPORTS_POSITION = `import { position } from "@lib/${POSITION_COORDINATE}";

export const doubled = position * 2;
`;

/** A shared mutable project world: one manifest and one app-data record, reusable across host instances. */
interface ProjectWorld {
  readonly appData: Map<string, string>;
  extensions: Record<string, string>;
  /** App-data keys whose reads reject, standing in for a store that cannot serve those records. */
  unreadableKeys?: Set<string>;
}

function createProjectCollectionFixture(): ProjectCollection {
  return { projectCollectionId: "collection-1", name: "Collection", createdAt: 1, updatedAt: 1 };
}

function createManager(world: ProjectWorld, filesystem: ProjectFileSystem): ProjectManager {
  let activeProject: ActiveProject = {
    manifest: {
      id: PROJECT_ID,
      projectCollectionId: "collection-1",
      name: PROJECT_ID,
      version: "0.1.0",
      description: "",
      createdAt: 1,
      updatedAt: 1,
      extensions: world.extensions,
    },
    filesystem,
  } as ActiveProject;
  return {
    get activeProject(): ActiveProject {
      return activeProject;
    },
    activeProjectCollection: createProjectCollectionFixture(),
    async init(): Promise<void> {},
    async getProjectCollectionState(): Promise<{ access: "ready" }> {
      return { access: "ready" };
    },
    async ensureDefaultProject(): Promise<void> {},
    async updateActive(updates: { extensions?: Record<string, string> }): Promise<void> {
      if (updates.extensions !== undefined) {
        world.extensions = updates.extensions;
      }
      activeProject = {
        manifest: { ...activeProject.manifest, ...updates },
        filesystem: activeProject.filesystem,
      } as ActiveProject;
    },
    async saveAppData(key: string, data: string): Promise<void> {
      world.appData.set(key, data);
    },
    async loadAppData(key: string): Promise<string | undefined> {
      if (world.unreadableKeys?.has(key)) {
        throw new Error(`app data "${key}" is unreadable`);
      }
      return world.appData.get(key);
    },
    async deleteAppData(key: string): Promise<void> {
      world.appData.delete(key);
    },
    dispose(): void {},
  } as unknown as ProjectManager;
}

function installEmptyLocalStorage(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = {
    length: 0,
    clear(): void {},
    getItem(): string | null {
      return null;
    },
    key(): string | null {
      return null;
    },
    removeItem(): void {},
    setItem(): void {},
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  return () => {
    if (original) {
      Object.defineProperty(globalThis, "localStorage", original);
      return;
    }
    Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function createHost(
  world: ProjectWorld,
  options?: {
    transport?: ExtensionFetchTransport;
    hostFiles?: Record<string, string>;
    embeddedExtensions?: readonly EmbeddedExtension[];
    catalogMoves?: ExtensionCatalogMoves;
    approvedCatalogEntry?: ApprovedCatalogEntryLookup;
  }
): AppEnvironmentHost {
  const filesystem = createInMemoryProjectFileSystem();
  for (const [path, content] of Object.entries(options?.hostFiles ?? {})) {
    filesystem.applyLocalChange({ action: "write", path, content, newEtag: `seed-${path}` });
  }
  return new AppEnvironmentHost({
    projectManager: createManager(world, filesystem),
    modules: [coreModule()],
    mounts: [declarationMount([{ path: "wendoo.core.d.ts", content: CORE_AMBIENT }])],
    extensionFetchTransport: options?.transport,
    ...(options?.embeddedExtensions ? { embeddedExtensions: options.embeddedExtensions } : {}),
    ...(options?.catalogMoves ? { catalogMoves: options.catalogMoves } : {}),
    ...(options?.approvedCatalogEntry ? { approvedCatalogEntry: options.approvedCatalogEntry } : {}),
  });
}

/** The workspace paths of the host's served snapshot (project files plus compiler-controlled files). */
function servedPaths(host: AppEnvironmentHost): string[] {
  return [...host.servedProjectFileSystem.exportSnapshot().keys()];
}

describe("extension install pipeline", () => {
  it("installs a remote extension as one transaction: fetch, snapshot persistence, materialization, improved outcome, install log", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const transport = createTestTransport({ content: { [`${POSITION_COORDINATE}@v0.1.0`]: POSITION_CONTENT } });
    const host = createHost(world, { transport, hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });

    try {
      await host.initialize(PROJECT_ID);
      // A brain in the project participates in the outcome diff without
      // flagging a spurious change.
      await host.saveBrainForKey("b1", BrainDef.emptyBrainDef(host.env.brainServices, "b1"));

      const report = await host.updateProjectExtensions({ [POSITION_COORDINATE]: POSITION_REFERENCE });

      assert.ok(report.committed);
      assert.equal(report.outcome.kind, "improved");
      assert.ok(report.outcome.resolvedProblems.some((problem) => problem.location === "main.ts"));

      // The fetched snapshot persists in the project store: reference,
      // resolved specifier, and content.
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      const record = stored[POSITION_COORDINATE];
      assert.ok(record);
      assert.equal(record.reference, POSITION_REFERENCE);
      assert.equal(record.specifier, "v0.1.0");
      assert.deepStrictEqual(Object.keys(record.files).sort(), ["index.ts", "wendoo.json"]);

      // The installed tree materializes exactly like an embedded install.
      assert.ok(servedPaths(host).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));

      const log = parseExtensionInstallLog(world.appData.get("extension-install-log"));
      assert.deepStrictEqual(
        log.map((event) => event.kind),
        ["install"]
      );
      assert.ok(log[0].kind === "install" && log[0].specifier === "v0.1.0");
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("regenerates .libraries from the stored snapshot on load, never from the network", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const transport = createTestTransport({ content: { [`${POSITION_COORDINATE}@v0.1.0`]: POSITION_CONTENT } });
    const first = createHost(world, { transport, hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });
    try {
      await first.initialize(PROJECT_ID);
      const report = await first.updateProjectExtensions({ [POSITION_COORDINATE]: POSITION_REFERENCE });
      assert.ok(report.committed);
    } finally {
      first.dispose();
    }

    // A fresh host over the same store, with no transport at all: the tree
    // regenerates from the stored snapshot and the import resolves.
    const reloaded = createHost(world, { hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });
    try {
      await reloaded.initialize(PROJECT_ID);
      assert.ok(servedPaths(reloaded).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));
      // The import compiles cleanly offline: an install never depends on its
      // sources being reachable after installation. A re-resolve of the same
      // map reuses the stored snapshot without a transport.
      const followup = await reloaded.updateProjectExtensions(world.extensions);
      assert.ok(followup.committed);
      assert.equal(followup.outcome.kind, "unchanged");
    } finally {
      reloaded.dispose();
      restoreLocalStorage();
    }
  });

  it("loads snapshot records rebuilt from a materialized tree and resolves without a transport", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    // The world a folder host seeds: the manifest names the dependency, and
    // the store's snapshot records were rebuilt from the on-disk tree plus
    // its provenance record.
    const seeded = reconstructInstalledSnapshotsFromTree(
      { [POSITION_COORDINATE]: { reference: POSITION_REFERENCE, specifier: "v0.1.0" } },
      Object.entries(POSITION_CONTENT).map(
        ([path, content]) => [`.libraries/${POSITION_COORDINATE}/${path}`, content] as [string, string]
      )
    );
    const world: ProjectWorld = {
      appData: new Map([["installed-extensions", serializeInstalledExtensionSnapshots(seeded)]]),
      extensions: { [POSITION_COORDINATE]: POSITION_REFERENCE },
    };
    const transport = createTestTransport({ content: {} });
    const host = createHost(world, { transport, hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });

    try {
      await host.initialize(PROJECT_ID);
      assert.ok(servedPaths(host).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));
      assert.deepStrictEqual(host.getInstalledExtensionMetadata(), {
        [POSITION_COORDINATE]: { reference: POSITION_REFERENCE, specifier: "v0.1.0" },
      });

      // A re-resolve of the unchanged map reuses the rebuilt record: the
      // transport sees no request.
      const report = await host.updateProjectExtensions(world.extensions);
      assert.ok(report.committed);
      assert.deepStrictEqual(transport.requests, []);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("refetches a dependency whose manifest reference no longer matches the rebuilt record", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const seeded = reconstructInstalledSnapshotsFromTree(
      { [POSITION_COORDINATE]: { reference: POSITION_REFERENCE, specifier: "v0.1.0" } },
      Object.entries(POSITION_CONTENT).map(
        ([path, content]) => [`.libraries/${POSITION_COORDINATE}/${path}`, content] as [string, string]
      )
    );
    const updatedReference = `gh:${POSITION_COORDINATE}@v0.2.0`;
    const world: ProjectWorld = {
      appData: new Map([["installed-extensions", serializeInstalledExtensionSnapshots(seeded)]]),
      extensions: { [POSITION_COORDINATE]: updatedReference },
    };
    const transport = createTestTransport({
      content: { [`${POSITION_COORDINATE}@v0.2.0`]: POSITION_CONTENT },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });

    try {
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions(world.extensions);
      assert.ok(report.committed);
      assert.ok(
        transport.requests.some((request) => request.includes(`${POSITION_COORDINATE}@v0.2.0`)),
        "the changed pin is fetched fresh instead of served from the rebuilt record"
      );
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("commits a worsened install with a report naming the new problems", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const transport = createTestTransport({ content: { [`${BROKEN_COORDINATE}@v0.1.0`]: BROKEN_CONTENT } });
    const host = createHost(world, { transport, hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions({ [BROKEN_COORDINATE]: BROKEN_REFERENCE });

      // Worsened still commits.
      assert.ok(report.committed);
      assert.equal(report.outcome.kind, "worsened");
      assert.ok(
        report.outcome.newProblems.some((problem) => problem.location === `.libraries/${BROKEN_COORDINATE}/index.ts`)
      );
      assert.equal(world.extensions[BROKEN_COORDINATE], BROKEN_REFERENCE);
      assert.ok(servedPaths(host).includes(`.libraries/${BROKEN_COORDINATE}/index.ts`));
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("refuses outright when the source is unreachable, leaving the project unchanged", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const host = createHost(world, { hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions({ [POSITION_COORDINATE]: POSITION_REFERENCE });

      assert.ok(!report.committed);
      assert.equal(report.refusal.kind, "fetch");
      assert.ok(report.refusal.kind === "fetch" && report.refusal.error.code === ExtensionFetchErrorCode.UNREACHABLE);
      assert.deepStrictEqual(world.extensions, {});
      assert.equal(world.appData.get("installed-extensions"), undefined);
      assert.ok(!servedPaths(host).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("refuses outright on a dependency cycle, surfacing the cycle origins", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const aReference = "gh:example-org/a-ext@v1";
    const bReference = "gh:example-org/b-ext@v1";
    const transport = createTestTransport({
      content: {
        "example-org/a-ext@v1": {
          "wendoo.json": manifestText("A", { "example-org/b-ext": bReference }),
          "index.ts": "export {};\n",
        },
        "example-org/b-ext@v1": {
          "wendoo.json": manifestText("B", { "example-org/a-ext": aReference }),
          "index.ts": "export {};\n",
        },
      },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions({ "example-org/a-ext": aReference });

      assert.ok(!report.committed);
      assert.equal(report.refusal.kind, "cycle");
      assert.ok(
        report.refusal.kind === "cycle" &&
          report.refusal.cycle.join(" -> ") === "example-org/a-ext -> example-org/b-ext -> example-org/a-ext"
      );
      assert.deepStrictEqual(world.extensions, {});
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("installs a dependency set as one transaction with one outcome, and removes it symmetrically", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const motorReference = "gh:example-org/motor-ext@v1";
    const robotReference = "gh:example-org/robot-ext@v1";
    const transport = createTestTransport({
      content: {
        "example-org/robot-ext@v1": {
          "wendoo.json": manifestText("Robot", { "example-org/motor-ext": motorReference }),
          "index.ts": `export { motor } from "@lib/example-org/motor-ext";\n`,
        },
        "example-org/motor-ext@v1": {
          "wendoo.json": manifestText("Motor"),
          "index.ts": "export const motor = 1;\n",
        },
      },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions({ "example-org/robot-ext": robotReference });

      assert.ok(report.committed);
      assert.equal(report.outcome.kind, "unchanged");
      assert.ok(servedPaths(host).includes(".libraries/example-org/robot-ext/index.ts"));
      assert.ok(servedPaths(host).includes(".libraries/example-org/motor-ext/index.ts"));
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.deepStrictEqual(Object.keys(stored).sort(), ["example-org/motor-ext", "example-org/robot-ext"]);

      const removal = await host.updateProjectExtensions({});
      assert.ok(removal.committed);
      assert.ok(!servedPaths(host).includes(".libraries/example-org/robot-ext/index.ts"));
      assert.ok(!servedPaths(host).includes(".libraries/example-org/motor-ext/index.ts"));
      assert.deepStrictEqual(parseInstalledExtensionSnapshots(world.appData.get("installed-extensions")), {});

      const log = parseExtensionInstallLog(world.appData.get("extension-install-log"));
      assert.deepStrictEqual(log.map((event) => event.kind).sort(), ["install", "install", "remove", "remove"]);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("resolves a #branch reference to a commit SHA and records the SHA with the installed content", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const transport = createTestTransport({
      content: { [`${POSITION_COORDINATE}@${sha}`]: POSITION_CONTENT },
      branches: { [`${POSITION_COORDINATE}#main`]: sha },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      const branchReference = `gh:${POSITION_COORDINATE}#main`;
      const report = await host.updateProjectExtensions({ [POSITION_COORDINATE]: branchReference });

      assert.ok(report.committed);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.reference, branchReference);
      assert.equal(stored[POSITION_COORDINATE]?.specifier, sha);
      // The branch itself is never fetched as content: every file request
      // names the resolved commit.
      assert.ok(transport.requests.every((request) => !request.startsWith(`file ${POSITION_COORDINATE}@main`)));
      const log = parseExtensionInstallLog(world.appData.get("extension-install-log"));
      assert.ok(log[0].kind === "install" && log[0].specifier === sha);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("installs through the real jsDelivr transport against a local server with the jsDelivr layout", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const served: Record<string, string> = {
      [`/gh/${POSITION_COORDINATE}@v0.1.0/wendoo.json`]: POSITION_CONTENT["wendoo.json"],
      [`/gh/${POSITION_COORDINATE}@v0.1.0/index.ts`]: POSITION_CONTENT["index.ts"],
    };
    const server: Server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const content = served[path];
      if (content === undefined) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.end(content);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const host = createHost(world, {
      transport: createJsDelivrExtensionTransport({ cdnBaseUrl: baseUrl }),
      hostFiles: { "main.ts": HOST_IMPORTS_POSITION },
    });

    try {
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions({ [POSITION_COORDINATE]: POSITION_REFERENCE });
      assert.ok(report.committed);
      assert.equal(report.outcome.kind, "improved");
      assert.ok(servedPaths(host).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));
    } finally {
      host.dispose();
      restoreLocalStorage();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

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

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe("extension install pipeline -- hand-edited wendoo.json", () => {
  it("routes a peer's extensions edit through the install transaction", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const originalWebSocket = globalThis.WebSocket;
    MockWebSocket.instances = [];
    (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;

    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const transport = createTestTransport({ content: { [`${POSITION_COORDINATE}@v0.1.0`]: POSITION_CONTENT } });
    const filesystem = createInMemoryProjectFileSystem();
    filesystem.applyLocalChange({ action: "write", path: "main.ts", content: "export const ok = 1;\n", newEtag: "e1" });
    const host = new AppEnvironmentHost({
      projectManager: createManager(world, filesystem),
      modules: [coreModule()],
      mounts: [declarationMount([{ path: "wendoo.core.d.ts", content: CORE_AMBIENT }])],
      extensionFetchTransport: transport,
      bridgeUrl: "http://localhost:3000",
    });

    try {
      await host.initialize(PROJECT_ID);
      host.connectBridge();
      const socket = MockWebSocket.instances.at(-1)!;
      socket.simulateOpen();
      socket.simulateMessage({
        type: "session:welcome",
        payload: { protocolVersion: 1, sessionId: "s" },
      });

      // The peer edits wendoo.json by hand, adding a gh reference.
      socket.simulateMessage({
        type: "filesystem:change",
        payload: {
          action: "write",
          path: "wendoo.json",
          content: JSON.stringify({
            name: PROJECT_ID,
            version: "0.1.0",
            description: "",
            extensions: { [POSITION_COORDINATE]: POSITION_REFERENCE },
          }),
          newEtag: "peer-1",
        },
        seq: 1,
      });

      // The edit flows through the same transactional pipeline: fetched,
      // snapshotted, and materialized.
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && world.appData.get("installed-extensions") === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.reference, POSITION_REFERENCE);
      assert.equal(world.extensions[POSITION_COORDINATE], POSITION_REFERENCE);
      assert.ok(servedPaths(host).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));
    } finally {
      host.dispose();
      (globalThis as Record<string, unknown>).WebSocket = originalWebSocket;
      restoreLocalStorage();
    }
  });
});

describe("extension update flows", () => {
  const SHA_A = "0123456789abcdef0123456789abcdef01234567";
  const SHA_B = "89abcdef0123456789abcdef0123456789abcdef";

  it("checks and applies a pin update: the manifest reference is rewritten and the content refetched", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const transport = createTestTransport({
      content: {
        [`${POSITION_COORDINATE}@v0.1.0`]: POSITION_CONTENT,
        [`${POSITION_COORDINATE}@0.2.0`]: {
          "wendoo.json": JSON.stringify({ name: "Position", version: "0.2.0", files: ["index.ts"] }),
          "index.ts": "export const position = 43;\n",
        },
      },
      versions: { [POSITION_COORDINATE]: ["0.1.0", "0.2.0"] },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });

    try {
      await host.initialize(PROJECT_ID);
      const install = await host.updateProjectExtensions({ [POSITION_COORDINATE]: POSITION_REFERENCE });
      assert.ok(install.committed);

      const check = await host.checkExtensionUpdate(POSITION_COORDINATE);
      assert.ok(check.ok && check.updateAvailable);
      assert.deepStrictEqual(check.update, {
        coordinate: POSITION_COORDINATE,
        reference: `gh:${POSITION_COORDINATE}@0.2.0`,
        latestVersion: "0.2.0",
      });

      const report = await host.applyExtensionUpdates([check.update]);
      assert.ok(report.committed);
      assert.equal(world.extensions[POSITION_COORDINATE], `gh:${POSITION_COORDINATE}@0.2.0`);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.specifier, "0.2.0");

      // The update records an install event carrying the new specifier.
      const log = parseExtensionInstallLog(world.appData.get("extension-install-log"));
      const last = log.at(-1);
      assert.ok(last?.kind === "install" && last.specifier === "0.2.0");

      // An immediate re-check reports the project current.
      const recheck = await host.checkExtensionUpdate(POSITION_COORDINATE);
      assert.deepStrictEqual(recheck, { ok: true, updateAvailable: false });
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("offers the catalog's approved pin to a project installed at an earlier approved SHA pin, and applies it", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    // An earlier approved SHA pin of the coordinate, distinct from any version tag.
    const priorPinReference = `gh:${POSITION_COORDINATE}@${SHA_A}`;
    const approvedReference = `gh:${POSITION_COORDINATE}@${SHA_B}`;
    const transport = createTestTransport({
      content: {
        [`${POSITION_COORDINATE}@${SHA_A}`]: POSITION_CONTENT,
        [`${POSITION_COORDINATE}@${SHA_B}`]: {
          "wendoo.json": JSON.stringify({ name: "Position", version: "0.2.0", files: ["index.ts"] }),
          "index.ts": "export const position = 43;\n",
        },
        [`${POSITION_COORDINATE}@0.3.0`]: {
          "wendoo.json": JSON.stringify({ name: "Position", version: "0.3.0", files: ["index.ts"] }),
          "index.ts": "export const position = 44;\n",
        },
      },
      // A newer unapproved tag stands at the source; the catalog outranks it.
      versions: { [POSITION_COORDINATE]: ["0.1.0", "0.3.0"] },
    });
    const host = createHost(world, {
      transport,
      hostFiles: { "main.ts": HOST_IMPORTS_POSITION },
      approvedCatalogEntry: (coordinate) =>
        coordinate === POSITION_COORDINATE ? { ref: approvedReference, version: "0.2.0" } : undefined,
    });

    try {
      await host.initialize(PROJECT_ID);
      const install = await host.updateProjectExtensions({ [POSITION_COORDINATE]: priorPinReference });
      assert.ok(install.committed);

      const check = await host.checkExtensionUpdate(POSITION_COORDINATE);
      assert.ok(check.ok && check.updateAvailable);
      assert.deepStrictEqual(check.update, {
        coordinate: POSITION_COORDINATE,
        reference: approvedReference,
        latestVersion: "0.2.0",
      });

      const report = await host.applyExtensionUpdates([check.update]);
      assert.ok(report.committed);
      assert.equal(world.extensions[POSITION_COORDINATE], approvedReference);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.specifier, SHA_B);

      const recheck = await host.checkExtensionUpdate(POSITION_COORDINATE);
      assert.deepStrictEqual(recheck, { ok: true, updateAvailable: false });
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("checks and applies a branch update: the reference text is unchanged and the content refetched at the new head", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const branchReference = `gh:${POSITION_COORDINATE}#main`;
    const branches: Record<string, string> = { [`${POSITION_COORDINATE}#main`]: SHA_A };
    const transport = createTestTransport({
      content: {
        [`${POSITION_COORDINATE}@${SHA_A}`]: POSITION_CONTENT,
        [`${POSITION_COORDINATE}@${SHA_B}`]: {
          "wendoo.json": JSON.stringify({ name: "Position", version: "0.1.1", files: ["index.ts"] }),
          "index.ts": "export const position = 44;\n",
        },
      },
      branches,
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });

    try {
      await host.initialize(PROJECT_ID);
      const install = await host.updateProjectExtensions({ [POSITION_COORDINATE]: branchReference });
      assert.ok(install.committed);

      // The branch has not moved: no update.
      const current = await host.checkExtensionUpdate(POSITION_COORDINATE);
      assert.deepStrictEqual(current, { ok: true, updateAvailable: false });

      // The branch head moves upstream.
      branches[`${POSITION_COORDINATE}#main`] = SHA_B;
      const check = await host.checkExtensionUpdate(POSITION_COORDINATE);
      assert.ok(check.ok && check.updateAvailable);
      assert.deepStrictEqual(check.update, {
        coordinate: POSITION_COORDINATE,
        reference: branchReference,
        resolvedSha: SHA_B,
      });

      const report = await host.applyExtensionUpdates([check.update]);
      assert.ok(report.committed);
      assert.equal(world.extensions[POSITION_COORDINATE], branchReference);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.specifier, SHA_B);
      // The apply fetched the new commit; it did not reuse the stored snapshot.
      assert.ok(transport.requests.includes(`file ${POSITION_COORDINATE}@${SHA_B} wendoo.json`));
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("updates several dependencies as one transaction with one outcome", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const motorCoordinate = "example-org/motor-ext";
    const transport = createTestTransport({
      content: {
        [`${POSITION_COORDINATE}@v0.1.0`]: POSITION_CONTENT,
        [`${POSITION_COORDINATE}@0.2.0`]: {
          "wendoo.json": JSON.stringify({ name: "Position", version: "0.2.0", files: ["index.ts"] }),
          "index.ts": "export const position = 43;\n",
        },
        [`${motorCoordinate}@v1.0.0`]: {
          "wendoo.json": JSON.stringify({ name: "Motor", version: "1.0.0", files: ["index.ts"] }),
          "index.ts": "export const motor = 1;\n",
        },
        [`${motorCoordinate}@1.1.0`]: {
          "wendoo.json": JSON.stringify({ name: "Motor", version: "1.1.0", files: ["index.ts"] }),
          "index.ts": "export const motor = 2;\n",
        },
      },
      versions: {
        [POSITION_COORDINATE]: ["0.1.0", "0.2.0"],
        [motorCoordinate]: ["1.0.0", "1.1.0"],
      },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      const install = await host.updateProjectExtensions({
        [POSITION_COORDINATE]: POSITION_REFERENCE,
        [motorCoordinate]: `gh:${motorCoordinate}@v1.0.0`,
      });
      assert.ok(install.committed);
      const logBefore = parseExtensionInstallLog(world.appData.get("extension-install-log")).length;

      const positionCheck = await host.checkExtensionUpdate(POSITION_COORDINATE);
      const motorCheck = await host.checkExtensionUpdate(motorCoordinate);
      assert.ok(positionCheck.ok && positionCheck.updateAvailable);
      assert.ok(motorCheck.ok && motorCheck.updateAvailable);

      const report = await host.applyExtensionUpdates([positionCheck.update, motorCheck.update]);
      assert.ok(report.committed);
      assert.equal(report.outcome.kind, "unchanged");

      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.specifier, "0.2.0");
      assert.equal(stored[motorCoordinate]?.specifier, "1.1.0");
      // One transaction: both updates land as install events appended together.
      const appended = parseExtensionInstallLog(world.appData.get("extension-install-log")).slice(logBefore);
      assert.deepStrictEqual(appended.map((event) => event.kind).sort(), ["install", "install"]);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("answers INVALID_REFERENCE for a coordinate that is not an installed fetched dependency", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const host = createHost(world, { hostFiles: { "main.ts": "export const ok = 1;\n" } });
    try {
      await host.initialize(PROJECT_ID);
      const check = await host.checkExtensionUpdate("example-org/not-installed");
      assert.ok(!check.ok);
      assert.equal(check.error.code, ExtensionFetchErrorCode.INVALID_REFERENCE);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("broken fetched dependencies", () => {
  it("records a fetch refusal in the install log, surfaces it on the catalog entry, and a retry re-runs the transaction", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    // The project's manifest already declares the dependency (as after an
    // import), but no snapshot content was ever installed.
    const world: ProjectWorld = {
      appData: new Map(),
      extensions: { [POSITION_COORDINATE]: POSITION_REFERENCE },
    };
    const content: Record<string, Record<string, string>> = {};
    const transport = createTestTransport({ content });
    const host = createHost(world, { transport, hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      // Never fetched: the catalog entry is broken with a generic reason.
      const beforeRetry = buildExtensionCatalog(
        world.extensions,
        [],
        new Set(),
        host.installedExtensionContent,
        host.extensionFetchFailures
      );
      assert.deepStrictEqual(beforeRetry[0].broken, {
        message: `No content is installed for "${POSITION_REFERENCE}".`,
      });

      // Retry against a source that has nothing: the refusal's stable code is
      // recorded and surfaces as the entry's reason.
      const refused = await host.updateProjectExtensions(world.extensions);
      assert.ok(!refused.committed);
      const failed = buildExtensionCatalog(
        world.extensions,
        [],
        new Set(),
        host.installedExtensionContent,
        host.extensionFetchFailures
      );
      assert.equal(failed[0].broken?.code, ExtensionFetchErrorCode.MANIFEST_MISSING);
      const log = parseExtensionInstallLog(world.appData.get("extension-install-log"));
      assert.ok(
        log.some((event) => event.kind === "fetch-refusal" && event.code === ExtensionFetchErrorCode.MANIFEST_MISSING)
      );

      // The source starts serving the content: the same retry transaction
      // succeeds and the failure clears.
      content[`${POSITION_COORDINATE}@v0.1.0`] = POSITION_CONTENT;
      const retried = await host.updateProjectExtensions(world.extensions);
      assert.ok(retried.committed);
      const healthy = buildExtensionCatalog(
        world.extensions,
        [],
        new Set(),
        host.installedExtensionContent,
        host.extensionFetchFailures
      );
      assert.equal(healthy[0].broken, undefined);
      assert.equal(healthy[0].updatable, true);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("seeds the last recorded failure from the install log on project load", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = {
      appData: new Map(),
      extensions: { [POSITION_COORDINATE]: POSITION_REFERENCE },
    };
    const failing = createHost(world, {
      transport: createTestTransport({ content: {} }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
    });
    try {
      await failing.initialize(PROJECT_ID);
      const refused = await failing.updateProjectExtensions(world.extensions);
      assert.ok(!refused.committed);
    } finally {
      failing.dispose();
    }

    const reloaded = createHost(world, { hostFiles: { "main.ts": "export const ok = 1;\n" } });
    try {
      await reloaded.initialize(PROJECT_ID);
      assert.equal(
        reloaded.extensionFetchFailures.get(POSITION_REFERENCE)?.code,
        ExtensionFetchErrorCode.MANIFEST_MISSING
      );
    } finally {
      reloaded.dispose();
      restoreLocalStorage();
    }
  });
});

describe("add-by-reference input normalization through the host", () => {
  it("resolves a pasted repository URL to the latest published version and installs it through the one transaction", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const transport = createTestTransport({
      content: { [`${POSITION_COORDINATE}@0.1.0`]: POSITION_CONTENT },
      versions: { [POSITION_COORDINATE]: ["0.1.0"] },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": HOST_IMPORTS_POSITION } });
    try {
      await host.initialize(PROJECT_ID);
      const resolved = await host.resolveExtensionInstallInput(`https://github.com/${POSITION_COORDINATE}`);
      assert.deepStrictEqual(resolved, { ok: true, reference: `gh:${POSITION_COORDINATE}@0.1.0` });

      const report = await host.updateProjectExtensions({
        [POSITION_COORDINATE]: resolved.ok ? resolved.reference : "",
      });
      assert.ok(report.committed);
      assert.equal(world.extensions[POSITION_COORDINATE], `gh:${POSITION_COORDINATE}@0.1.0`);
      assert.ok(servedPaths(host).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("without a transport, a complete reference still normalizes and a coordinate fails as unreachable", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const host = createHost(world, { hostFiles: { "main.ts": "export const ok = 1;\n" } });
    try {
      await host.initialize(PROJECT_ID);
      assert.deepStrictEqual(await host.resolveExtensionInstallInput(POSITION_REFERENCE), {
        ok: true,
        reference: POSITION_REFERENCE,
      });
      const coordinate = await host.resolveExtensionInstallInput(POSITION_COORDINATE);
      assert.ok(!coordinate.ok);
      assert.equal(coordinate.code, ExtensionFetchErrorCode.UNREACHABLE);
      const invalid = await host.resolveExtensionInstallInput("ffff:x");
      assert.ok(!invalid.ok);
      assert.equal(invalid.code, ExtensionAddInputErrorCode.UNRECOGNIZED);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("unstable project dependencies", () => {
  it("flags branch references and pins without installed content; installed pins pass", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const branchReference = "gh:example-org/steering-ext#main";
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const transport = createTestTransport({
      content: {
        [`${POSITION_COORDINATE}@v0.1.0`]: POSITION_CONTENT,
        "example-org/steering-ext@0123456789abcdef0123456789abcdef01234567": {
          "wendoo.json": JSON.stringify({ name: "Steering", version: "0.1.0", files: ["index.ts"] }),
          "index.ts": "export const steering = 1;\n",
        },
      },
      branches: { "example-org/steering-ext#main": sha },
    });
    const host = createHost(world, { transport, hostFiles: { "main.ts": "export const ok = 1;\n" } });

    try {
      await host.initialize(PROJECT_ID);
      const install = await host.updateProjectExtensions({
        [POSITION_COORDINATE]: POSITION_REFERENCE,
        "example-org/steering-ext": branchReference,
      });
      assert.ok(install.committed);
      // A declared pin with no installed snapshot: the bootstrap phase.
      await host.projectManager.updateActive({
        extensions: { ...world.extensions, "example-org/unpublished-ext": "gh:example-org/unpublished-ext@v0.5.0" },
      });

      const unstable = await host.collectUnstableProjectDependencies();
      assert.deepStrictEqual(unstable.map((dependency) => [dependency.coordinate, dependency.code]).sort(), [
        ["example-org/steering-ext", "DEPENDENCY_BRANCH_REFERENCE"],
        ["example-org/unpublished-ext", "DEPENDENCY_VERSION_UNPUBLISHED"],
      ]);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- top-level transport flip", () => {
  const MOVE_SHA = "1111111111111111111111111111111111111111";
  const MOVE_REF = `gh:${POSITION_COORDINATE}@${MOVE_SHA}`;
  const EMBEDDED_REF = `embedded:${POSITION_COORDINATE}`;
  const POSITION_EMBEDDED: EmbeddedExtension = {
    canonicalOrigin: POSITION_COORDINATE,
    files: [
      { path: "wendoo.json", content: manifestText("Position") },
      { path: "index.ts", content: "export const position = 42;\n" },
    ],
  };

  it("leaves the top-level entry untouched when no catalog move targets its coordinate", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: { [POSITION_COORDINATE]: EMBEDDED_REF } };
    const host = createHost(world, {
      transport: createTestTransport({ content: { [`${POSITION_COORDINATE}@${MOVE_SHA}`]: POSITION_CONTENT } }),
      hostFiles: { "main.ts": HOST_IMPORTS_POSITION },
      embeddedExtensions: [POSITION_EMBEDDED],
    });
    try {
      // RED baseline: absent a move for the coordinate, project load rewrites nothing.
      await host.initialize(PROJECT_ID);
      assert.equal(world.extensions[POSITION_COORDINATE], EMBEDDED_REF);
      assert.equal(await host.applyCatalogMoves(), undefined);
      assert.equal(world.extensions[POSITION_COORDINATE], EMBEDDED_REF);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("rewrites a moved top-level entry to the target on load, persists it, and is idempotent", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: { [POSITION_COORDINATE]: EMBEDDED_REF } };
    const host = createHost(world, {
      transport: createTestTransport({ content: { [`${POSITION_COORDINATE}@${MOVE_SHA}`]: POSITION_CONTENT } }),
      hostFiles: { "main.ts": HOST_IMPORTS_POSITION },
      embeddedExtensions: [POSITION_EMBEDDED],
      catalogMoves: { [POSITION_COORDINATE]: [{ ref: MOVE_REF }] },
    });
    try {
      // GREEN: load auto-applies the move; the persisted manifest ref flips to
      // the gh target, the target content is fetched and materialized, and the
      // install-log signal records the change.
      await host.initialize(PROJECT_ID);
      assert.equal(world.extensions[POSITION_COORDINATE], MOVE_REF);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.reference, MOVE_REF);
      assert.equal(stored[POSITION_COORDINATE]?.specifier, MOVE_SHA);
      assert.ok(servedPaths(host).includes(`.libraries/${POSITION_COORDINATE}/index.ts`));
      assert.ok(
        parseExtensionInstallLog(world.appData.get("extension-install-log")).some((event) => event.kind === "install")
      );

      // A re-encountered un-migrated map migrates on an explicit call, and the
      // returned outcome's transaction commits.
      await host.projectManager.updateActive({ extensions: { [POSITION_COORDINATE]: EMBEDDED_REF } });
      const outcome = await host.applyCatalogMoves();
      assert.ok(outcome);
      assert.equal(outcome.warnings.length, 0);
      assert.ok(outcome.reports.some((report) => report.committed));
      assert.equal(world.extensions[POSITION_COORDINATE], MOVE_REF);

      // Idempotent: a project already at its move target is a no-op.
      assert.equal(await host.applyCatalogMoves(), undefined);
      assert.equal(world.extensions[POSITION_COORDINATE], MOVE_REF);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("does not drag a newer gh pin of the flipped coordinate back to the move pin", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const NEWER_SHA = "9999999999999999999999999999999999999999";
    const newerReference = `gh:${POSITION_COORDINATE}@${NEWER_SHA}`;
    const world: ProjectWorld = { appData: new Map(), extensions: { [POSITION_COORDINATE]: newerReference } };
    const transport = createTestTransport({
      content: {
        [`${POSITION_COORDINATE}@${MOVE_SHA}`]: POSITION_CONTENT,
        [`${POSITION_COORDINATE}@${NEWER_SHA}`]: POSITION_CONTENT,
      },
    });
    const host = createHost(world, {
      transport,
      hostFiles: { "main.ts": HOST_IMPORTS_POSITION },
      catalogMoves: { [POSITION_COORDINATE]: [{ ref: MOVE_REF }] },
    });
    try {
      await host.initialize(PROJECT_ID);
      // The default selector captures only references not already on the
      // destination's (coordinate, transport) pair: the newer pin survives.
      assert.equal(world.extensions[POSITION_COORDINATE], newerReference);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.reference, newerReference);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- load warnings surface", () => {
  const MOVE_SHA = "1111111111111111111111111111111111111111";
  const MOVE_REF = `gh:${POSITION_COORDINATE}@${MOVE_SHA}`;
  const DEPENDENT_COORDINATE = "example-org/dependent-ext";
  const DEPENDENT_EMBEDDED: EmbeddedExtension = {
    canonicalOrigin: DEPENDENT_COORDINATE,
    files: [
      {
        path: "wendoo.json",
        content: manifestText("Dependent", { [POSITION_COORDINATE]: `embedded:${POSITION_COORDINATE}` }),
      },
      { path: "index.ts", content: "export const dependent = 1;\n" },
    ],
  };

  it("a load whose moved transitive dependency cannot be resolved surfaces the stable-coded warning", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = {
      appData: new Map(),
      extensions: { [DEPENDENT_COORDINATE]: `embedded:${DEPENDENT_COORDINATE}` },
    };
    // The transport serves nothing: the moved Position content cannot be fetched.
    const host = createHost(world, {
      transport: createTestTransport({ content: {} }),
      embeddedExtensions: [DEPENDENT_EMBEDDED],
      catalogMoves: { [POSITION_COORDINATE]: [{ ref: MOVE_REF }] },
    });
    try {
      await host.initialize(PROJECT_ID);
      const failed = host.resolutionWarnings.filter((warning) => warning.kind === "catalog-move-failed");
      assert.equal(failed.length, 1, "the skipped move is surfaced exactly once");
      assert.ok(failed[0].kind === "catalog-move-failed");
      assert.equal(failed[0].code, CatalogMoveWarningCode.FETCH_FAILED);
      assert.equal(failed[0].origin, POSITION_COORDINATE);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("a load that heals its moved transitive dependency surfaces no warnings", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = {
      appData: new Map(),
      extensions: { [DEPENDENT_COORDINATE]: `embedded:${DEPENDENT_COORDINATE}` },
    };
    const host = createHost(world, {
      transport: createTestTransport({ content: { [`${POSITION_COORDINATE}@${MOVE_SHA}`]: POSITION_CONTENT } }),
      embeddedExtensions: [DEPENDENT_EMBEDDED],
      catalogMoves: { [POSITION_COORDINATE]: [{ ref: MOVE_REF }] },
    });
    try {
      await host.initialize(PROJECT_ID);
      assert.deepStrictEqual(host.resolutionWarnings, [], "a healed load carries no move warnings");
      // The heal persists the fetched snapshot; the manifest map itself gains
      // no entry for the transitive dependency.
      assert.deepStrictEqual(Object.keys(world.extensions), [DEPENDENT_COORDINATE]);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[POSITION_COORDINATE]?.reference, MOVE_REF);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- per-move transaction independence", () => {
  const HEALTHY_COORDINATE = "example-org/healthy-ext";
  const FAILING_COORDINATE = "example-org/failing-ext";
  const HEALTHY_SHA = "5555555555555555555555555555555555555555";
  const FAILING_SHA = "6666666666666666666666666666666666666666";
  const HEALTHY_REF = `gh:${HEALTHY_COORDINATE}@${HEALTHY_SHA}`;
  const FAILING_RENAMED_COORDINATE = "example-org/failing-ext-2";
  const FAILING_RENAME_REF = `gh:${FAILING_RENAMED_COORDINATE}@${FAILING_SHA}`;

  function embeddedFixture(coordinate: string): EmbeddedExtension {
    return {
      canonicalOrigin: coordinate,
      files: [
        { path: "wendoo.json", content: manifestText(coordinate) },
        { path: "index.ts", content: "export const x = 1;\n" },
      ],
    };
  }

  const catalogMoves = {
    [HEALTHY_COORDINATE]: [{ ref: HEALTHY_REF }],
    [FAILING_COORDINATE]: [{ ref: FAILING_RENAME_REF }],
  };

  it("commits the healthy move while the failing rename writes nothing, warns, and succeeds once served", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const brains = JSON.stringify({
      b1: {
        version: 1,
        id: "b1",
        name: "B",
        catalog: [],
        pages: [
          {
            version: 2,
            pageId: "p1",
            name: "Page 1",
            rules: [
              {
                version: 1,
                when: [{ k: "action", area: "sensor", id: "aaa111", ns: FAILING_COORDINATE }],
                do: [],
                children: [],
              },
            ],
          },
        ],
      },
    });
    const world: ProjectWorld = {
      appData: new Map([["brains", brains]]),
      extensions: {
        [HEALTHY_COORDINATE]: `embedded:${HEALTHY_COORDINATE}`,
        [FAILING_COORDINATE]: `embedded:${FAILING_COORDINATE}`,
      },
    };
    const content: Record<string, Record<string, string>> = {
      [`${HEALTHY_COORDINATE}@${HEALTHY_SHA}`]: {
        "wendoo.json": manifestText("Healthy"),
        "index.ts": "export const x = 1;\n",
      },
    };
    const embedded = [embeddedFixture(HEALTHY_COORDINATE), embeddedFixture(FAILING_COORDINATE)];
    const first = createHost(world, {
      transport: createTestTransport({ content }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: embedded,
      catalogMoves,
    });
    try {
      await first.initialize(PROJECT_ID);
      // The healthy move persisted...
      assert.equal(world.extensions[HEALTHY_COORDINATE], HEALTHY_REF);
      // ...while the failing rename wrote nothing: the manifest keeps the
      // source coordinate at its source reference...
      assert.equal(world.extensions[FAILING_COORDINATE], `embedded:${FAILING_COORDINATE}`);
      assert.equal(FAILING_RENAMED_COORDINATE in world.extensions, false);
      // ...and the saved brain's namespaces were restored with the manifest.
      const storedBrains = world.appData.get("brains");
      assert.ok(storedBrains?.includes(`"ns":"${FAILING_COORDINATE}"`));
      assert.ok(!storedBrains?.includes(FAILING_RENAMED_COORDINATE));
    } finally {
      first.dispose();
    }

    // A later load with the destination served applies the failed move.
    content[`${FAILING_RENAMED_COORDINATE}@${FAILING_SHA}`] = {
      "wendoo.json": manifestText("Failing Renamed"),
      "index.ts": "export const x = 2;\n",
    };
    const second = createHost(world, {
      transport: createTestTransport({ content }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: embedded,
      catalogMoves,
    });
    try {
      await second.initialize(PROJECT_ID);
      assert.equal(world.extensions[FAILING_RENAMED_COORDINATE], FAILING_RENAME_REF);
      assert.equal(FAILING_COORDINATE in world.extensions, false);
      assert.ok(world.appData.get("brains")?.includes(`"ns":"${FAILING_RENAMED_COORDINATE}"`));
    } finally {
      second.dispose();
      restoreLocalStorage();
    }
  });

  it("surfaces the failing move as a stable-coded warning on the outcome", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = {
      appData: new Map(),
      extensions: { [FAILING_COORDINATE]: `embedded:${FAILING_COORDINATE}` },
    };
    const host = createHost(world, {
      transport: createTestTransport({ content: {} }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: [embeddedFixture(FAILING_COORDINATE)],
      catalogMoves: { [FAILING_COORDINATE]: [{ ref: FAILING_RENAME_REF }] },
    });
    try {
      await host.initialize(PROJECT_ID);
      const outcome = await host.applyCatalogMoves();
      assert.ok(outcome);
      assert.ok(
        outcome.warnings.some(
          (warning) => warning.kind === "catalog-move-failed" && warning.code === CatalogMoveWarningCode.FETCH_FAILED
        )
      );
      assert.equal(world.extensions[FAILING_COORDINATE], `embedded:${FAILING_COORDINATE}`);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- version-scoped capture learned within one load", () => {
  const COORDINATE = "example-org/versioned-ext";
  const OLD_SHA = "7777777777777777777777777777777777777777";
  const NEW_SHA = "8888888888888888888888888888888888888888";
  const oldReference = `gh:${COORDINATE}@${OLD_SHA}`;
  const newReference = `gh:${COORDINATE}@${NEW_SHA}`;

  it("applies a range-scoped move to a pin whose version is only learned by fetching it", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    // The manifest pins a sha whose version is unknown until its content is
    // fetched; the version proves in-range and the move applies in the SAME
    // load: apply -> fetch -> re-apply.
    const world: ProjectWorld = { appData: new Map(), extensions: { [COORDINATE]: oldReference } };
    const transport = createTestTransport({
      content: {
        [`${COORDINATE}@${OLD_SHA}`]: {
          "wendoo.json": JSON.stringify({ name: "Versioned", version: "0.1.2", files: ["index.ts"] }),
          "index.ts": "export const v = 1;\n",
        },
        [`${COORDINATE}@${NEW_SHA}`]: {
          "wendoo.json": JSON.stringify({ name: "Versioned", version: "0.2.0", files: ["index.ts"] }),
          "index.ts": "export const v = 2;\n",
        },
      },
    });
    const host = createHost(world, {
      transport,
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      catalogMoves: { [COORDINATE]: [{ from: { packageVersion: "^0.1.0" }, ref: newReference }] },
    });
    try {
      await host.initialize(PROJECT_ID);
      assert.equal(world.extensions[COORDINATE], newReference);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[COORDINATE]?.reference, newReference);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("surfaces a stable-coded warning when the version stays undeterminable, and leaves the entry unmoved", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    // The pin's content is unavailable, so its version can never be learned
    // this load: the entry stays as written and the load reports the skip.
    const world: ProjectWorld = { appData: new Map(), extensions: { [COORDINATE]: oldReference } };
    const host = createHost(world, {
      transport: createTestTransport({ content: {} }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      catalogMoves: { [COORDINATE]: [{ from: { packageVersion: "^0.1.0" }, ref: newReference }] },
    });
    try {
      await host.initialize(PROJECT_ID);
      const outcome = await host.applyCatalogMoves();
      assert.ok(outcome);
      assert.ok(
        outcome.warnings.some(
          (warning) => warning.kind === "catalog-move-failed" && warning.code === CatalogMoveWarningCode.VERSION_UNKNOWN
        )
      );
      assert.equal(world.extensions[COORDINATE], oldReference);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- floating destinations", () => {
  const COORDINATE = "example-org/floating-ext";
  const EMBEDDED_REF = `embedded:${COORDINATE}`;
  const embedded: EmbeddedExtension = {
    canonicalOrigin: COORDINATE,
    files: [
      { path: "wendoo.json", content: manifestText("Floating") },
      { path: "index.ts", content: "export const f = 1;\n" },
    ],
  };
  const catalogMoves = { [COORDINATE]: [{ from: { transport: "embedded" as const }, ref: `gh:${COORDINATE}` }] };

  it("pins the highest stable published version, excluding prereleases, and persists the pin", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: { [COORDINATE]: EMBEDDED_REF } };
    const transport = createTestTransport({
      content: {
        [`${COORDINATE}@0.2.0`]: {
          "wendoo.json": JSON.stringify({ name: "Floating", version: "0.2.0", files: ["index.ts"] }),
          "index.ts": "export const f = 2;\n",
        },
      },
      versions: { [COORDINATE]: ["0.1.0", "0.2.0", "1.0.0-rc.1"] },
    });
    const host = createHost(world, {
      transport,
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: [embedded],
      catalogMoves,
    });
    try {
      await host.initialize(PROJECT_ID);
      // The stored manifest holds the PIN, never the floating form, and the
      // prerelease above the chosen version was not selected.
      assert.equal(world.extensions[COORDINATE], `gh:${COORDINATE}@0.2.0`);
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[COORDINATE]?.reference, `gh:${COORDINATE}@0.2.0`);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("reloading an already-migrated project performs no version listing and no fetch", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: { [COORDINATE]: EMBEDDED_REF } };
    const content = {
      [`${COORDINATE}@0.2.0`]: {
        "wendoo.json": JSON.stringify({ name: "Floating", version: "0.2.0", files: ["index.ts"] }),
        "index.ts": "export const f = 2;\n",
      },
    };
    const first = createHost(world, {
      transport: createTestTransport({ content, versions: { [COORDINATE]: ["0.2.0"] } }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: [embedded],
      catalogMoves,
    });
    try {
      await first.initialize(PROJECT_ID);
      assert.equal(world.extensions[COORDINATE], `gh:${COORDINATE}@0.2.0`);
    } finally {
      first.dispose();
    }

    const secondTransport = createTestTransport({ content, versions: { [COORDINATE]: ["0.2.0"] } });
    const second = createHost(world, {
      transport: secondTransport,
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: [embedded],
      catalogMoves,
    });
    try {
      await second.initialize(PROJECT_ID);
      assert.deepStrictEqual(secondTransport.requests, []);
      assert.equal(world.extensions[COORDINATE], `gh:${COORDINATE}@0.2.0`);
    } finally {
      second.dispose();
      restoreLocalStorage();
    }
  });

  it("warns with a stable code when no stable version exists, writes nothing, and succeeds on a later load", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: { [COORDINATE]: EMBEDDED_REF } };
    const versions: Record<string, readonly string[]> = { [COORDINATE]: ["1.0.0-rc.1"] };
    const content: Record<string, Record<string, string>> = {};
    const first = createHost(world, {
      transport: createTestTransport({ content, versions }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: [embedded],
      catalogMoves,
    });
    try {
      await first.initialize(PROJECT_ID);
      assert.equal(world.extensions[COORDINATE], EMBEDDED_REF);
      const outcome = await first.applyCatalogMoves();
      assert.ok(outcome);
      assert.ok(
        outcome.warnings.some(
          (warning) =>
            warning.kind === "catalog-move-failed" && warning.code === CatalogMoveWarningCode.FLOATING_UNRESOLVED
        )
      );
      assert.equal(world.appData.get("installed-extensions"), undefined);
    } finally {
      first.dispose();
    }

    // The next load finds a stable version and migrates.
    versions[COORDINATE] = ["1.0.0-rc.1", "0.3.0"];
    content[`${COORDINATE}@0.3.0`] = {
      "wendoo.json": JSON.stringify({ name: "Floating", version: "0.3.0", files: ["index.ts"] }),
      "index.ts": "export const f = 3;\n",
    };
    const second = createHost(world, {
      transport: createTestTransport({ content, versions }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: [embedded],
      catalogMoves,
    });
    try {
      await second.initialize(PROJECT_ID);
      assert.equal(world.extensions[COORDINATE], `gh:${COORDINATE}@0.3.0`);
    } finally {
      second.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- rename chains", () => {
  const X = "example-org/chain-x";
  const Y = "example-org/chain-y";
  const Z = "example-org/chain-z";
  const SHA_Y = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SHA_Z = "cccccccccccccccccccccccccccccccccccccccc";
  const catalogMoves = {
    [X]: [{ ref: `gh:${Y}@${SHA_Y}` }],
    [Y]: [{ ref: `gh:${Z}@${SHA_Z}` }],
  };

  function chainBrains(): Map<string, string> {
    const brain = (ns: string) => ({
      version: 1,
      id: ns,
      name: ns,
      catalog: [],
      pages: [
        {
          version: 2,
          pageId: "p1",
          name: "Page 1",
          rules: [{ version: 1, when: [{ k: "action", area: "sensor", id: "aaa111", ns }], do: [], children: [] }],
        },
      ],
    });
    return new Map([["brains", JSON.stringify({ bx: brain(X), by: brain(Y) })]]);
  }

  it("rewrites a source AND an intermediate coordinate's manifest entries and brain namespaces to the final coordinate", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const embedded = (coordinate: string): EmbeddedExtension => ({
      canonicalOrigin: coordinate,
      files: [
        { path: "wendoo.json", content: manifestText(coordinate) },
        { path: "index.ts", content: "export const c = 1;\n" },
      ],
    });
    const world: ProjectWorld = {
      appData: chainBrains(),
      extensions: { [X]: `embedded:${X}`, [Y]: `embedded:${Y}` },
    };
    const host = createHost(world, {
      transport: createTestTransport({
        content: {
          [`${Z}@${SHA_Z}`]: {
            "wendoo.json": manifestText("Chain Z"),
            "index.ts": "export const c = 3;\n",
          },
        },
      }),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      embeddedExtensions: [embedded(X), embedded(Y)],
      catalogMoves,
    });
    try {
      await host.initialize(PROJECT_ID);
      // Both entries fixpoint to Z in one load: X -> Y -> Z, Y -> Z.
      assert.deepStrictEqual(Object.keys(world.extensions), [Z]);
      assert.equal(world.extensions[Z], `gh:${Z}@${SHA_Z}`);
      // Both brains' namespaces rewrote to the FINAL coordinate.
      const brains = JSON.parse(world.appData.get("brains") ?? "{}") as Record<
        string,
        { pages: { rules: { when: { ns: string }[] }[] }[] }
      >;
      assert.equal(brains.bx.pages[0].rules[0].when[0].ns, Z);
      assert.equal(brains.by.pages[0].rules[0].when[0].ns, Z);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- ambiguous capture", () => {
  const COORDINATE = "example-org/ambiguous-ext";
  const SHA = "4444444444444444444444444444444444444444";

  it("fails the move with a stable code and leaves the entry unmoved", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: { [COORDINATE]: `gh:${COORDINATE}@${SHA}` } };
    // An exact selector inside another entry's transport scope: structurally
    // clean at parse, ambiguous only when a matching reference is applied.
    const host = createHost(world, {
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      catalogMoves: {
        [COORDINATE]: [
          { from: { transport: "gh" as const }, ref: `embedded:${COORDINATE}` },
          { from: `gh:${COORDINATE}@${SHA}`, ref: `embedded:${COORDINATE}` },
        ],
      },
    });
    try {
      await host.initialize(PROJECT_ID);
      const outcome = await host.applyCatalogMoves();
      assert.ok(outcome);
      assert.ok(
        outcome.warnings.some(
          (warning) =>
            warning.kind === "catalog-move-failed" &&
            warning.code === CatalogMoveWarningCode.AMBIGUOUS_CAPTURE &&
            warning.reference === `gh:${COORDINATE}@${SHA}`
        )
      );
      assert.equal(world.extensions[COORDINATE], `gh:${COORDINATE}@${SHA}`);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- transitive dependency redirect", () => {
  const MOTOR_COORDINATE = "example-org/motor-ext";
  const MOTOR_SHA = "2222222222222222222222222222222222222222";
  const MOTOR_MOVE_REF = `gh:${MOTOR_COORDINATE}@${MOTOR_SHA}`;
  const ROBOT_COORDINATE = "example-org/robot-ext";
  const ROBOT_REFERENCE = `gh:${ROBOT_COORDINATE}@v1`;

  /** A transport serving robot-ext (declaring an embedded motor dependency) and the moved motor content. */
  function createMoveTransport(): ExtensionFetchTransport & { requests: string[] } {
    return createTestTransport({
      content: {
        [`${ROBOT_COORDINATE}@v1`]: {
          "wendoo.json": manifestText("Robot", { [MOTOR_COORDINATE]: `embedded:${MOTOR_COORDINATE}` }),
          "index.ts": `export { motor } from "@lib/${MOTOR_COORDINATE}";\n`,
        },
        [`${MOTOR_COORDINATE}@${MOTOR_SHA}`]: {
          "wendoo.json": manifestText("Motor"),
          "index.ts": "export const motor = 1;\n",
        },
      },
    });
  }

  it("does not resolve a transitive embedded dependency when the embedded copy is absent and no move applies", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const host = createHost(world, {
      transport: createMoveTransport(),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
    });
    try {
      // RED: robot-ext declares `embedded:motor-ext`, motor-ext is not bundled,
      // and no move applies -- motor-ext never resolves.
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions({ [ROBOT_COORDINATE]: ROBOT_REFERENCE });
      assert.ok(report.committed);
      assert.ok(!servedPaths(host).includes(`.libraries/${MOTOR_COORDINATE}/index.ts`));
      assert.deepStrictEqual(host.installedLibraries.map((library) => library.coordinate).sort(), [ROBOT_COORDINATE]);
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("redirects the transitive dependency through the move target: fetched, resolved, not added to the manifest map, dependent content unchanged", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const host = createHost(world, {
      transport: createMoveTransport(),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      catalogMoves: { [MOTOR_COORDINATE]: [{ ref: MOTOR_MOVE_REF }] },
    });
    try {
      // GREEN: the move redirects `embedded:motor-ext` to the gh target during
      // resolution; motor-ext is fetched and materialized.
      await host.initialize(PROJECT_ID);
      const report = await host.updateProjectExtensions({ [ROBOT_COORDINATE]: ROBOT_REFERENCE });
      assert.ok(report.committed);
      assert.ok(servedPaths(host).includes(`.libraries/${MOTOR_COORDINATE}/index.ts`));

      // The transitive coordinate is not written into the project's manifest map.
      assert.deepStrictEqual(Object.keys(world.extensions), [ROBOT_COORDINATE]);

      // A snapshot for the redirected transitive dependency persists at the move target.
      const stored = parseInstalledExtensionSnapshots(world.appData.get("installed-extensions"));
      assert.equal(stored[MOTOR_COORDINATE]?.reference, MOTOR_MOVE_REF);

      // The dependent's content is data, not rewritten: robot-ext's manifest
      // still declares the embedded reference it shipped with.
      const robotManifest = host.servedProjectFileSystem
        .exportSnapshot()
        .get(`.libraries/${ROBOT_COORDINATE}/wendoo.json`);
      assert.ok(
        robotManifest?.kind === "file" &&
          typeof robotManifest.content === "string" &&
          robotManifest.content.includes(`embedded:${MOTOR_COORDINATE}`)
      );
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("resolves the redirected transitive dependency from stored snapshots on reload without a transport", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = { appData: new Map(), extensions: {} };
    const first = createHost(world, {
      transport: createMoveTransport(),
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      catalogMoves: { [MOTOR_COORDINATE]: [{ ref: MOTOR_MOVE_REF }] },
    });
    try {
      await first.initialize(PROJECT_ID);
      const report = await first.updateProjectExtensions({ [ROBOT_COORDINATE]: ROBOT_REFERENCE });
      assert.ok(report.committed);
    } finally {
      first.dispose();
    }

    // A fresh host over the same store, with no transport: the load-path
    // transitive redirect resolves motor-ext from the stored snapshot.
    const reloaded = createHost(world, {
      hostFiles: { "main.ts": "export const ok = 1;\n" },
      catalogMoves: { [MOTOR_COORDINATE]: [{ ref: MOTOR_MOVE_REF }] },
    });
    try {
      await reloaded.initialize(PROJECT_ID);
      assert.ok(servedPaths(reloaded).includes(`.libraries/${MOTOR_COORDINATE}/index.ts`));
      assert.deepStrictEqual(Object.keys(world.extensions), [ROBOT_COORDINATE]);
    } finally {
      reloaded.dispose();
      restoreLocalStorage();
    }
  });
});

describe("catalog moves -- coordinate rename", () => {
  const SOURCE_COORDINATE = "example-org/cutebot";
  const TARGET_COORDINATE = "example-org/cutebot-chassis";
  const RENAME_SHA = "3333333333333333333333333333333333333333";
  const RENAME_REF = `gh:${TARGET_COORDINATE}@${RENAME_SHA}`;
  const FLIP_SHA = "4444444444444444444444444444444444444444";
  const FLIP_REF = `gh:${SOURCE_COORDINATE}@${FLIP_SHA}`;
  const SOURCE_EMBEDDED_REF = `embedded:${SOURCE_COORDINATE}`;

  const SOURCE_EMBEDDED: EmbeddedExtension = {
    canonicalOrigin: SOURCE_COORDINATE,
    files: [
      { path: "wendoo.json", content: manifestText("Cutebot") },
      { path: "index.ts", content: "export const cutebot = 1;\n" },
    ],
  };

  /**
   * A saved brain referencing a library tile and a library type from the source
   * coordinate: an action tile keyed `<SOURCE_COORDINATE>:user.sensor.aaa111`
   * and an accessor over a named type in the same namespace. Both carry the
   * source coordinate as the `ns` field of their structured references.
   */
  function brainWithSourceRefs(): PersistedBrainJson {
    return {
      version: 1,
      id: "b1",
      name: "Robot",
      catalog: [],
      pages: [
        {
          version: 2,
          pageId: "p1",
          name: "Page 1",
          rules: [
            {
              version: 1,
              when: [{ k: "action", area: "sensor", id: "aaa111", ns: SOURCE_COORDINATE }],
              do: [
                {
                  k: "accessor",
                  type: { k: "named", t: "struct", name: "/index.ts::Speed", ns: SOURCE_COORDINATE },
                  field: "value",
                },
              ],
              children: [],
            },
          ],
        },
      ],
    };
  }

  function storedBrains(brain: PersistedBrainJson): Map<string, string> {
    return new Map([["brains", JSON.stringify({ b1: brain })]]);
  }

  it("renames the manifest coordinate and rewrites saved-brain namespaces to the new coordinate", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = {
      appData: storedBrains(brainWithSourceRefs()),
      extensions: { [SOURCE_COORDINATE]: SOURCE_EMBEDDED_REF },
    };
    const host = createHost(world, {
      transport: createTestTransport({
        content: {
          [`${TARGET_COORDINATE}@${RENAME_SHA}`]: {
            "wendoo.json": manifestText("Cutebot Chassis"),
            "index.ts": "export const cutebot = 1;\n",
          },
        },
      }),
      embeddedExtensions: [SOURCE_EMBEDDED],
      catalogMoves: { [SOURCE_COORDINATE]: [{ ref: RENAME_REF }] },
    });
    try {
      // GREEN: load auto-applies the rename. The manifest key moves from the
      // source coordinate to the new coordinate at the move ref...
      await host.initialize(PROJECT_ID);
      assert.deepStrictEqual(Object.keys(world.extensions), [TARGET_COORDINATE]);
      assert.equal(world.extensions[TARGET_COORDINATE], RENAME_REF);

      // ...and, in the same moment, the saved brain's source-coordinate
      // references are rewritten to the new coordinate, stable ids intact.
      const storedBrain = (JSON.parse(world.appData.get("brains") ?? "{}") as Record<string, PersistedBrainJson>).b1;
      const rule = storedBrain.pages[0].rules[0];
      assert.deepStrictEqual(rule.when[0], { k: "action", area: "sensor", id: "aaa111", ns: TARGET_COORDINATE });
      assert.deepStrictEqual(rule.do[0], {
        k: "accessor",
        type: { k: "named", t: "struct", name: "/index.ts::Speed", ns: TARGET_COORDINATE },
        field: "value",
      });

      // The in-memory brain cache is healed too: re-serializing it yields the
      // new-coordinate namespace, so a later save cannot regress the store.
      const cached = host.getCachedBrain("b1");
      assert.ok(cached);
      const reserialized = host.serializeBrainForStorage(cached);
      assert.deepStrictEqual(reserialized.pages[0].rules[0].when[0], {
        k: "action",
        area: "sensor",
        id: "aaa111",
        ns: TARGET_COORDINATE,
      });

      // Idempotent: a project already at the new coordinate is a no-op, and the
      // brain is not rewritten again.
      assert.equal(await host.applyCatalogMoves(), undefined);
      assert.deepStrictEqual(Object.keys(world.extensions), [TARGET_COORDINATE]);
      const afterIdempotent = (JSON.parse(world.appData.get("brains") ?? "{}") as Record<string, PersistedBrainJson>)
        .b1;
      assert.deepStrictEqual(afterIdempotent.pages[0].rules[0].when[0], {
        k: "action",
        area: "sensor",
        id: "aaa111",
        ns: TARGET_COORDINATE,
      });
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });

  it("a rename whose brain record cannot be read writes nothing, warns, and applies on a later load", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const authored = JSON.stringify({ b1: brainWithSourceRefs() });
    const world: ProjectWorld = {
      appData: new Map([["brains", authored]]),
      extensions: { [SOURCE_COORDINATE]: SOURCE_EMBEDDED_REF },
      unreadableKeys: new Set(["brains"]),
    };
    const transport = createTestTransport({
      content: {
        [`${TARGET_COORDINATE}@${RENAME_SHA}`]: {
          "wendoo.json": manifestText("Cutebot Chassis"),
          "index.ts": "export const cutebot = 1;\n",
        },
      },
    });
    const catalogMoves = { [SOURCE_COORDINATE]: [{ ref: RENAME_REF }] };
    const failing = createHost(world, { transport, embeddedExtensions: [SOURCE_EMBEDDED], catalogMoves });
    try {
      // The load completes, and the unreadable record is reported on the
      // host's stored-record failure channel.
      await failing.initialize(PROJECT_ID);
      assert.equal(failing.projectRecordFailure?.code, AppHostErrorCode.BRAIN_RECORD_UNREADABLE);

      // The rename unit failed closed: neither the manifest entry nor the
      // stored brains moved, so nothing partial was written.
      assert.deepStrictEqual(Object.keys(world.extensions), [SOURCE_COORDINATE]);
      assert.equal(world.extensions[SOURCE_COORDINATE], SOURCE_EMBEDDED_REF);
      assert.equal(world.appData.get("brains"), authored);

      // The skipped unit surfaces as a stable-coded move warning.
      assert.ok(
        failing.resolutionWarnings.some(
          (warning) =>
            warning.kind === "catalog-move-failed" && warning.code === CatalogMoveWarningCode.BRAINS_UNREADABLE
        ),
        "the skipped rename is reported with its stable code"
      );
    } finally {
      failing.dispose();
    }

    // The next load of the same project, with the record readable again,
    // applies the rename in full.
    world.unreadableKeys = new Set();
    const served = createHost(world, { transport, embeddedExtensions: [SOURCE_EMBEDDED], catalogMoves });
    try {
      await served.initialize(PROJECT_ID);
      assert.equal(served.projectRecordFailure, undefined);
      assert.deepStrictEqual(Object.keys(world.extensions), [TARGET_COORDINATE]);
      assert.equal(world.extensions[TARGET_COORDINATE], RENAME_REF);
      const storedBrain = (JSON.parse(world.appData.get("brains") ?? "{}") as Record<string, PersistedBrainJson>).b1;
      assert.deepStrictEqual(storedBrain.pages[0].rules[0].when[0], {
        k: "action",
        area: "sensor",
        id: "aaa111",
        ns: TARGET_COORDINATE,
      });
    } finally {
      served.dispose();
      restoreLocalStorage();
    }
  });

  it("a store that serves no record at all loads, skips the move, writes nothing, and applies on a later load", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const authoredBrains = JSON.stringify({ b1: brainWithSourceRefs() });
    const authoredLog = JSON.stringify([{ kind: "install", at: 1, origin: SOURCE_COORDINATE, reference: "embedded" }]);
    const world: ProjectWorld = {
      appData: new Map([
        ["brains", authoredBrains],
        ["extension-install-log", authoredLog],
      ]),
      extensions: { [SOURCE_COORDINATE]: SOURCE_EMBEDDED_REF },
      unreadableKeys: new Set(["brains", "installed-extensions", "extension-install-log"]),
    };
    const transport = createTestTransport({
      content: {
        [`${TARGET_COORDINATE}@${RENAME_SHA}`]: {
          "wendoo.json": manifestText("Cutebot Chassis"),
          "index.ts": "export const cutebot = 1;\n",
        },
      },
    });
    const catalogMoves = { [SOURCE_COORDINATE]: [{ ref: RENAME_REF }] };
    const failing = createHost(world, { transport, embeddedExtensions: [SOURCE_EMBEDDED], catalogMoves });
    try {
      // The load completes, and the first record the store could not serve is
      // reported on the host's stored-record failure channel.
      await failing.initialize(PROJECT_ID);
      assert.equal(failing.projectRecordFailure?.code, AppHostErrorCode.EXTENSION_RECORD_UNREADABLE);

      // The brains are withheld whole: with the installed-library closure
      // unknown, no saved tile reference resolves.
      assert.deepStrictEqual([...failing.getCachedBrainKeys()], []);

      // Nothing was written: the manifest entry, the stored brains, and the
      // install log are byte-identical, and no snapshot record was minted.
      assert.deepStrictEqual(Object.keys(world.extensions), [SOURCE_COORDINATE]);
      assert.equal(world.extensions[SOURCE_COORDINATE], SOURCE_EMBEDDED_REF);
      assert.equal(world.appData.get("brains"), authoredBrains);
      assert.equal(world.appData.get("extension-install-log"), authoredLog);
      assert.equal(world.appData.has("installed-extensions"), false);
    } finally {
      failing.dispose();
    }

    // The next load of the same project, with the store readable again,
    // applies the rename in full.
    world.unreadableKeys = new Set();
    const served = createHost(world, { transport, embeddedExtensions: [SOURCE_EMBEDDED], catalogMoves });
    try {
      await served.initialize(PROJECT_ID);
      assert.equal(served.projectRecordFailure, undefined);
      assert.deepStrictEqual(Object.keys(world.extensions), [TARGET_COORDINATE]);
      assert.equal(world.extensions[TARGET_COORDINATE], RENAME_REF);
      const storedBrain = (JSON.parse(world.appData.get("brains") ?? "{}") as Record<string, PersistedBrainJson>).b1;
      assert.deepStrictEqual(storedBrain.pages[0].rules[0].when[0], {
        k: "action",
        area: "sensor",
        id: "aaa111",
        ns: TARGET_COORDINATE,
      });
      const log = parseExtensionInstallLog(world.appData.get("extension-install-log"));
      assert.ok(log.length > 1, "the install log kept its authored entry and grew with the move's events");
    } finally {
      served.dispose();
      restoreLocalStorage();
    }
  });

  it("a flip move rewrites the reference but leaves saved-brain namespaces untouched", async () => {
    const restoreLocalStorage = installEmptyLocalStorage();
    const world: ProjectWorld = {
      appData: storedBrains(brainWithSourceRefs()),
      extensions: { [SOURCE_COORDINATE]: SOURCE_EMBEDDED_REF },
    };
    const host = createHost(world, {
      transport: createTestTransport({
        content: {
          [`${SOURCE_COORDINATE}@${FLIP_SHA}`]: {
            "wendoo.json": manifestText("Cutebot"),
            "index.ts": "export const cutebot = 1;\n",
          },
        },
      }),
      embeddedExtensions: [SOURCE_EMBEDDED],
      catalogMoves: { [SOURCE_COORDINATE]: [{ ref: FLIP_REF }] },
    });
    try {
      // A flip keeps the same coordinate key and updates only the reference;
      // brain namespaces are a rename concern and stay at the source coordinate.
      await host.initialize(PROJECT_ID);
      assert.deepStrictEqual(Object.keys(world.extensions), [SOURCE_COORDINATE]);
      assert.equal(world.extensions[SOURCE_COORDINATE], FLIP_REF);
      const storedBrain = (JSON.parse(world.appData.get("brains") ?? "{}") as Record<string, PersistedBrainJson>).b1;
      assert.deepStrictEqual(storedBrain.pages[0].rules[0].when[0], {
        k: "action",
        area: "sensor",
        id: "aaa111",
        ns: SOURCE_COORDINATE,
      });
    } finally {
      host.dispose();
      restoreLocalStorage();
    }
  });
});
