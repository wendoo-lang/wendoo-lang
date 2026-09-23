import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileContentToWire } from "@wendoo/app-host";
import type {
  FileContentPayload,
  FolderAppMessage,
  FolderCompilerFilesMessage,
  FolderHostMessage,
  FolderOpenExternalDocumentMessage,
  FolderSessionErrorCode as FolderSessionErrorCodeType,
  FolderVolumeWriteMessage,
} from "@wendoo/bridge-protocol";
import {
  FOLDER_SESSION_PROTOCOL_VERSION,
  FolderSessionErrorCode,
  INSTALLED_EXTENSIONS_METADATA_PATH,
} from "@wendoo/bridge-protocol";
import {
  decodeInstalledSnapshotFiles,
  INSTALLED_EXTENSIONS_APP_DATA_KEY,
  parseInstalledExtensionSnapshots,
} from "./fetched-extension-snapshots.js";
import type { FolderHostPort } from "./folder-host-session.js";
import { connectFolderHostSession, FolderSessionError } from "./folder-host-session.js";

const PROJECT_ID = "the-folder-project";

/** The first bytes of a real PNG: signature plus the IHDR chunk header. */
const ICON_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const MANIFEST_TEXT = JSON.stringify({ name: "Hosted Project", version: "0.1.0" });

const POSITION_ORIGIN = "example-org/position-ext";
const POSITION_REFERENCE = `gh:${POSITION_ORIGIN}@v0.1.0`;

/**
 * A host-side fake answering the handshake and capturing every app message,
 * optionally offering an on-disk installed-extensions tree with the welcome
 * and optionally declaring a protocol version other than the app's.
 */
function fakeHostPort(options?: {
  welcomeProtocolVersion?: number;
  extensionsCache?: ReadonlyArray<[string, FileContentPayload]>;
  volumeWriteErrorCode?: FolderSessionErrorCodeType;
  openExternalDocumentErrorCode?: FolderSessionErrorCodeType;
}): FolderHostPort & {
  sent: FolderAppMessage[];
} {
  let listener: ((message: FolderHostMessage) => void) | undefined;
  const sent: FolderAppMessage[] = [];
  return {
    sent,
    postMessage(message: FolderAppMessage): void {
      sent.push(message);
      queueMicrotask(() => {
        if (message.type === "folder:hello") {
          listener?.({
            type: "folder:welcome",
            id: message.id,
            payload: {
              protocolVersion: options?.welcomeProtocolVersion ?? message.payload.protocolVersion,
              projectId: PROJECT_ID,
              manifest: { content: MANIFEST_TEXT, etag: "disk-1" },
              ...(options?.extensionsCache ? { extensionsCache: options.extensionsCache } : {}),
            },
          });
        } else if (message.type === "folder:loadFiles") {
          listener?.({ type: "folder:files", id: message.id, payload: { entries: [] } });
        } else if (message.type === "folder:change" || message.type === "folder:manifestWrite") {
          listener?.({ type: "folder:ack", id: message.id });
        } else if (message.type === "folder:volumeWrite") {
          if (options?.volumeWriteErrorCode) {
            listener?.({
              type: "folder:error",
              id: message.id,
              payload: { code: options.volumeWriteErrorCode, message: "volume write refused" },
            });
          } else {
            listener?.({ type: "folder:ack", id: message.id });
          }
        } else if (message.type === "folder:openExternalDocument") {
          if (options?.openExternalDocumentErrorCode) {
            listener?.({
              type: "folder:error",
              id: message.id,
              payload: { code: options.openExternalDocumentErrorCode, message: "open refused" },
            });
          } else {
            listener?.({ type: "folder:ack", id: message.id });
          }
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

describe("folder session protocol version", () => {
  for (const hostVersion of [FOLDER_SESSION_PROTOCOL_VERSION - 1, FOLDER_SESSION_PROTOCOL_VERSION + 1]) {
    it(`rejects a host speaking version ${hostVersion} with the mismatch code`, async () => {
      const port = fakeHostPort({ welcomeProtocolVersion: hostVersion });

      await assert.rejects(connectFolderHostSession({ port, appName: "test-app" }), (error: unknown) => {
        assert.ok(error instanceof FolderSessionError);
        assert.equal(error.code, FolderSessionErrorCode.PROTOCOL_VERSION_MISMATCH);
        return true;
      });
    });
  }
});

describe("folder session compiler-controlled files publication", () => {
  it("posts the full file set and install provenance as one folder:compilerFiles message", async () => {
    const port = fakeHostPort();
    const session = await connectFolderHostSession({ port, appName: "test-app" });

    session.publishCompilerControlledFiles(
      new Map([
        ["tsconfig.json", "{}"],
        [`.libraries/${POSITION_ORIGIN}/index.ts`, "export const position = 42;\n"],
      ]),
      { [POSITION_ORIGIN]: { reference: POSITION_REFERENCE, specifier: "v0.1.0" } }
    );

    const message = port.sent.find(
      (candidate): candidate is FolderCompilerFilesMessage => candidate.type === "folder:compilerFiles"
    );
    assert.ok(message);
    assert.deepStrictEqual(message.payload.files, [
      ["tsconfig.json", { content: "{}" }],
      [`.libraries/${POSITION_ORIGIN}/index.ts`, { content: "export const position = 42;\n" }],
    ]);
    assert.deepStrictEqual(message.payload.installedExtensions, {
      [POSITION_ORIGIN]: { reference: POSITION_REFERENCE, specifier: "v0.1.0" },
    });
    session.dispose();
  });
});

describe("folder session removable-volume writes", () => {
  it("sends one folder:volumeWrite request and resolves on the host's ack", async () => {
    const port = fakeHostPort();
    const session = await connectFolderHostSession({ port, appName: "test-app" });

    await session.writeRemovableVolumeFile("DATA", "program.hex", ":00000001FF\n");

    const message = port.sent.find(
      (candidate): candidate is FolderVolumeWriteMessage => candidate.type === "folder:volumeWrite"
    );
    assert.ok(message);
    assert.deepStrictEqual(message.payload, {
      volumeName: "DATA",
      filename: "program.hex",
      contents: ":00000001FF\n",
    });
    session.dispose();
  });

  it("rejects with the host-reported code when the volume is not mounted", async () => {
    const port = fakeHostPort({ volumeWriteErrorCode: FolderSessionErrorCode.REMOVABLE_VOLUME_NOT_FOUND });
    const session = await connectFolderHostSession({ port, appName: "test-app" });

    await assert.rejects(session.writeRemovableVolumeFile("DATA", "program.hex", ""), (error: unknown) => {
      assert.ok(error instanceof FolderSessionError);
      assert.equal(error.code, FolderSessionErrorCode.REMOVABLE_VOLUME_NOT_FOUND);
      return true;
    });
    session.dispose();
  });
});

describe("folder session external-document opens", () => {
  it("sends one folder:openExternalDocument request and resolves on the host's ack", async () => {
    const port = fakeHostPort();
    const session = await connectFolderHostSession({ port, appName: "test-app" });

    await session.openExternalDocument("<!doctype html><html></html>");

    const message = port.sent.find(
      (candidate): candidate is FolderOpenExternalDocumentMessage => candidate.type === "folder:openExternalDocument"
    );
    assert.ok(message);
    assert.deepStrictEqual(message.payload, { html: "<!doctype html><html></html>" });
    session.dispose();
  });

  it("rejects with the host-reported code when the document cannot be opened", async () => {
    const port = fakeHostPort({ openExternalDocumentErrorCode: FolderSessionErrorCode.WRITE_FAILED });
    const session = await connectFolderHostSession({ port, appName: "test-app" });

    await assert.rejects(session.openExternalDocument("<html></html>"), (error: unknown) => {
      assert.ok(error instanceof FolderSessionError);
      assert.equal(error.code, FolderSessionErrorCode.WRITE_FAILED);
      return true;
    });
    session.dispose();
  });
});

describe("folder session installed-extensions cache seeding", () => {
  it("rebuilds the store's installed snapshot records from the welcome's tree offer", async () => {
    const port = fakeHostPort({
      extensionsCache: [
        [
          INSTALLED_EXTENSIONS_METADATA_PATH,
          { content: JSON.stringify({ [POSITION_ORIGIN]: { reference: POSITION_REFERENCE, specifier: "v0.1.0" } }) },
        ],
        [
          `.libraries/${POSITION_ORIGIN}/wendoo.json`,
          { content: JSON.stringify({ name: "Position", version: "0.1.0" }) },
        ],
        [`.libraries/${POSITION_ORIGIN}/index.ts`, { content: "export const position = 42;\n" }],
        [`.libraries/${POSITION_ORIGIN}/icon.png`, fileContentToWire(ICON_BYTES)],
      ],
    });
    const session = await connectFolderHostSession({ port, appName: "test-app" });

    const raw = await session.store.loadAppData(PROJECT_ID, INSTALLED_EXTENSIONS_APP_DATA_KEY);
    const snapshots = parseInstalledExtensionSnapshots(raw);
    const record = snapshots[POSITION_ORIGIN];
    assert.ok(record);
    assert.equal(record.reference, POSITION_REFERENCE);
    assert.equal(record.specifier, "v0.1.0");
    const files = decodeInstalledSnapshotFiles(record);
    assert.equal(files.get("/index.ts"), "export const position = 42;\n");
    assert.equal(files.get("/wendoo.json"), JSON.stringify({ name: "Position", version: "0.1.0" }));
    assert.deepEqual(
      [...(files.get("/icon.png") as Uint8Array)],
      [...ICON_BYTES],
      "a library's binary icon survives the welcome tree offer"
    );
    session.dispose();
  });

  it("seeds nothing when the welcome offers no tree or no metadata record", async () => {
    const bare = await connectFolderHostSession({ port: fakeHostPort(), appName: "test-app" });
    assert.equal(await bare.store.loadAppData(PROJECT_ID, INSTALLED_EXTENSIONS_APP_DATA_KEY), undefined);
    bare.dispose();

    const treeOnly = await connectFolderHostSession({
      port: fakeHostPort({
        extensionsCache: [[`.libraries/${POSITION_ORIGIN}/index.ts`, { content: "export const position = 42;\n" }]],
      }),
      appName: "test-app",
    });
    assert.equal(await treeOnly.store.loadAppData(PROJECT_ID, INSTALLED_EXTENSIONS_APP_DATA_KEY), undefined);
    treeOnly.dispose();
  });
});
