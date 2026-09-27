import type { FolderAppDataCodec, FolderHostMessage, FolderHostPort, FolderHostSession } from "@wendoo/bridge-app";
import {
  connectFolderHostSession,
  FOLDER_HOST_MODE_FOLDER,
  FOLDER_HOST_MODE_GLOBAL,
  FOLDER_HOST_MODE_URL_PARAM,
} from "@wendoo/bridge-app";
import { name as appName } from "../../package.json";
import { ecosimAppChunkFromAppData, translateEcosimAppChunk } from "./project-io";

/**
 * True when the page carries the folder host-mode bootstrap flag -- as the
 * URL search parameter or as the host-defined global: the app is embedded by
 * a host that owns the project as a workspace folder.
 */
export function isFolderHostMode(
  search: string = window.location.search,
  hostGlobals: Readonly<Record<string, unknown>> = globalThis as Record<string, unknown>
): boolean {
  if (new URLSearchParams(search).get(FOLDER_HOST_MODE_URL_PARAM) === FOLDER_HOST_MODE_FOLDER) {
    return true;
  }
  return hostGlobals[FOLDER_HOST_MODE_GLOBAL] === FOLDER_HOST_MODE_FOLDER;
}

/** Visibility of the app's top-level chrome sections. */
export interface AppChrome {
  /** Project and workspace menus: new, browse, import, export; workspace switching, PINs, and management. */
  readonly showProjectMenu: boolean;
  /** Dev Panel: the VS Code bridge with its join-code flow, and the build-issues console. */
  readonly showBridgePanel: boolean;
  /** Global app settings button. */
  readonly showSettings: boolean;
  /** Docs panel links to the app's standalone docs pages. */
  readonly showDocsPageLinks: boolean;
}

/**
 * The chrome contract for an app mode. Default (browser) mode shows the full
 * project-management chrome; folder host mode hides it.
 */
export function appChromeForMode(folderHostMode: boolean): AppChrome {
  return folderHostMode
    ? {
        showProjectMenu: false,
        showBridgePanel: false,
        showSettings: false,
        showDocsPageLinks: false,
      }
    : {
        showProjectMenu: true,
        showBridgePanel: true,
        showSettings: true,
        showDocsPageLinks: true,
      };
}

/**
 * Translates the sim's app-data entries (desired counts and obstacles) to and
 * from its session chunk in the manifest's `app` map. The chunk has the shape
 * a `.wendoo` export carries.
 */
export const ecosimFolderAppDataCodec: FolderAppDataCodec = {
  chunkFromAppData(appData: ReadonlyMap<string, string>): unknown {
    return ecosimAppChunkFromAppData(appData);
  },
  appDataFromChunk(chunk: unknown): Record<string, string> {
    return translateEcosimAppChunk(chunk).appData ?? {};
  },
};

function isFolderHostMessage(value: unknown): value is FolderHostMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && type.startsWith("folder:");
}

/**
 * A {@link FolderHostPort} over the embedding page: messages post to the
 * parent window (the host's webview wrapper relays them), and folder-session
 * messages arriving on this window are delivered to the listener.
 */
export function createWebviewFolderHostPort(): FolderHostPort {
  return {
    postMessage(message): void {
      window.parent.postMessage(message, "*");
    },
    onMessage(listener): () => void {
      const handler = (event: MessageEvent): void => {
        const data: unknown = event.data;
        if (isFolderHostMessage(data)) {
          listener(data);
        }
      };
      window.addEventListener("message", handler);
      return () => {
        window.removeEventListener("message", handler);
      };
    },
  };
}

/**
 * Open the sim's folder session: the handshake over `port` plus this app's
 * name and app-data codec. Rejects with `FolderSessionError` carrying the
 * host's code when the host refuses the hello, among them
 * `PROTOCOL_VERSION_NEWER` when this build's protocol version is newer than
 * the host's.
 */
export async function connectEcosimFolderSession(
  port: FolderHostPort = createWebviewFolderHostPort()
): Promise<FolderHostSession> {
  return connectFolderHostSession({ port, appName, appDataCodec: ecosimFolderAppDataCodec });
}
