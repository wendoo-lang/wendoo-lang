import type {
  FileSystemNotification,
  FilesystemChangeMessage,
  FilesystemSyncPayload,
  WsMessage,
} from "@wendoo/bridge-protocol";
import { ErrorCode, ProtocolError } from "../error-codes.js";
import type { FileSystemSnapshot } from "../filesystem.js";
import { ProjectFiles, type ProjectFilesOptions } from "./files.js";
import { ProjectSession } from "./session.js";

/** Options for {@link Project}. */
export interface ProjectOptions<TClient extends WsMessage = WsMessage, TServer extends WsMessage = WsMessage> {
  bridgeUrl: string;
  /** WebSocket path on the bridge server (e.g. `"app"` or `"extension"`). */
  wsPath: string;
  /** Initial filesystem snapshot the project starts with. */
  initialFileSnapshot: FileSystemSnapshot;
  /** Join code the session's hellos present until it accepts a `session:welcome`. */
  joinCode?: string;
  /** Token used to rebind to a previously established session. */
  bindingToken?: string;
}

/**
 * Pairs a {@link ProjectSession} with a {@link ProjectFiles} and translates
 * `filesystem:change` and `filesystem:sync` messages between them.
 *
 * @typeParam TClient - Union of message types this side may send.
 * @typeParam TServer - Union of message types this side may receive.
 */
export class Project<TClient extends WsMessage = WsMessage, TServer extends WsMessage = WsMessage> {
  private _session: ProjectSession<TClient, TServer>;
  private _files: ProjectFiles;
  private readonly _syncListeners = new Set<() => void>();
  // Sequence numbers for message deduplication. _outboundSeq increments on
  // every local change sent to the bridge. _peerSeq tracks the highest seq
  // received from the peer; incoming messages with seq <= _peerSeq are
  // silently dropped to handle duplicate deliveries after reconnection.
  private _outboundSeq = 0;
  private _peerSeq = 0;

  constructor(public readonly options: ProjectOptions<TClient, TServer>) {
    if (!options.bridgeUrl) {
      throw new ProtocolError(ErrorCode.BRIDGE_URL_REQUIRED, "bridgeUrl is required");
    }
    if (!options.wsPath) {
      throw new ProtocolError(ErrorCode.INVALID_CLIENT_ROLE, "wsPath is required");
    }

    this._session = new ProjectSession<TClient, TServer>(
      options.wsPath,
      options.bridgeUrl,
      {
        bindingToken: options.bindingToken,
      },
      options.joinCode
    );
    const filesOptions: ProjectFilesOptions = {
      initialFileSnapshot: options.initialFileSnapshot,
      toRemoteChange: (ev) => this.toRemoteFileChange(ev),
      fromRemoteChange: (ev) => this.fromRemoteFileChange(ev),
    };
    this._files = new ProjectFiles(filesOptions);

    this._session.on("filesystem:change" as TServer["type"], (msg) => {
      const wsMsg = msg as unknown as WsMessage;
      if (!wsMsg.payload) return;
      if (wsMsg.seq !== undefined && wsMsg.seq <= this._peerSeq) return;
      const notification = (msg as unknown as FilesystemChangeMessage).payload!;
      if (wsMsg.id) {
        try {
          this._files.fromRemote.applyNotification(notification);
          this._session.send({ type: "filesystem:change", id: wsMsg.id } as TClient);
        } catch (e) {
          const message = e instanceof ProtocolError ? e.message : "apply failed";
          this._session.send({ type: "session:error", id: wsMsg.id, payload: { message } } as TClient);
        }
      } else {
        this._files.fromRemote.applyNotification(notification);
      }
    });

    this._session.on("filesystem:sync" as TServer["type"], (msg) => {
      const wsMsg = msg as unknown as WsMessage;
      // TODO: Fix this by making sync completion or sync direction a first-class bridge-client/session concept rather than inferring it from raw message shape.
      if (wsMsg.id && !wsMsg.payload) {
        if (wsMsg.seq !== undefined) this._peerSeq = wsMsg.seq;
        const entries = [...this._files.raw.export()];
        this._session.send({
          type: "filesystem:sync",
          id: wsMsg.id,
          payload: { entries },
          seq: this._outboundSeq,
        } as TClient);
        this.emitDidSync();
      }
    });
  }

  get session(): ProjectSession<TClient, TServer> {
    return this._session;
  }

  get files(): ProjectFiles {
    return this._files;
  }

  onDidSync(listener: () => void): () => void {
    this._syncListeners.add(listener);
    return () => {
      this._syncListeners.delete(listener);
    };
  }

  toRemoteFileChange = (ev: FileSystemNotification) => {
    this._outboundSeq++;
    this._session.send({ type: "filesystem:change", payload: ev, seq: this._outboundSeq } as TClient);
  };

  fromRemoteFileChange = (_ev: FileSystemNotification) => {};

  async requestSync(): Promise<void> {
    const response = await this._session.request("filesystem:sync", undefined, this._outboundSeq);
    if (response.type === "session:error" || response.type === "error") {
      const msg = (response.payload as { message?: string } | undefined)?.message ?? "sync failed";
      throw new ProtocolError(ErrorCode.SYNC_FAILED, msg);
    }
    if (response.seq !== undefined) this._peerSeq = response.seq;
    const payload = response.payload as FilesystemSyncPayload | undefined;
    if (payload?.entries) {
      this._files.fromRemote.applyNotification({ action: "import", entries: payload.entries });
    }
    this.emitDidSync();
  }

  private emitDidSync(): void {
    for (const listener of this._syncListeners) {
      listener();
    }
  }
}
