import type { ProjectFileChange, ProjectFileSnapshot, ProjectFileSystem } from "@wendoo/app-host";
import type { ConnectionStatus } from "@wendoo/bridge-client";
import type {
  AppClientMessage,
  BridgeSessionErrorCode,
  CompileDiagnosticEntry,
  WsMessage,
} from "@wendoo/bridge-protocol";
import { BridgeProject } from "./bridge-project.js";
import { toFileSystemNotification, toFileSystemSnapshot, toProjectFileChange } from "./project-file-bridge.js";

export type { ProjectFileSystem, ProjectFileChange, ProjectFileSnapshot };
/** Connection status of the underlying bridge session. */
export type AppBridgeState = ConnectionStatus;
/** A single compiler diagnostic entry surfaced through the bridge. */
export type DiagnosticEntry = CompileDiagnosticEntry;

/**
 * App-side handle for a Wendoo bridge session. Owns the lifecycle of the
 * underlying connection and forwards local project file edits to and from the
 * remote peer.
 */
export interface AppBridge {
  /**
   * Open the bridge connection. No-op if already started. A failure that ends
   * the session (reported in `AppBridgeSnapshot.errorCode`) leaves the bridge
   * stopped, so a later call opens a new session.
   */
  start(): void;
  /** Close the bridge connection and release resources. */
  stop(): void;
  /** Request a full project file resync from the peer. */
  requestSync(): Promise<void>;
  /** Read the current connection state. */
  snapshot(): AppBridgeSnapshot;
  /** Subscribe to connection-state changes. Returns an unsubscribe function. */
  onStateChange(listener: (state: AppBridgeState) => void): () => void;
  /** Subscribe to project file changes pushed by the remote peer. */
  onRemoteChange(listener: (change: ProjectFileChange) => void): () => void;
  /**
   * Send a payload message to the peer verbatim. The message's type must lie
   * outside the bridge protocol's namespaces (`BRIDGE_PROTOCOL_NAMESPACES` in
   * `@wendoo/bridge-protocol`). A message sent while the connection is
   * reconnecting is queued and sent once it reopens. Throws when the bridge is
   * not started or its session has ended.
   */
  sendPayload(message: WsMessage): void;
  /**
   * Subscribe to payload messages from the peer: every inbound message whose
   * type lies outside the bridge protocol's namespaces, delivered as received.
   * A message arriving while no listener is attached is dropped, so subscribe
   * before `start()` to receive every one. Returns an unsubscribe function.
   */
  onPayload(listener: (message: WsMessage) => void): () => void;
}

/** Snapshot of the bridge connection state. */
export interface AppBridgeSnapshot {
  status: AppBridgeState;
  /** Code the user pastes into the peer to bind the session, when available. */
  joinCode?: string;
  /** Stable code of the failure that ended the session, if one did. Cleared when the bridge next starts. */
  errorCode?: BridgeSessionErrorCode;
  /**
   * Present, and `true`, while the bridge reports the session's counterpart
   * disconnected. Absent once the counterpart is connected again (the next
   * accepted welcome) and whenever the bridge starts or stops.
   */
  counterpartAway?: true;
}

/** Options for {@link createAppBridge}. */
export interface AppBridgeOptions {
  bridgeUrl: string;
  /** Path of the bridge endpoint the app connects to. Defaults to `"app"`. */
  wsPath?: string;
  filesystem: ProjectFileSystem;
  /** Optional features attached to the bridge for the duration of each session. */
  features?: readonly AppBridgeFeature[];
  /** Persisted token used to rebind to a previously established session. */
  bindingToken?: string;
  /** Callback invoked whenever the server issues an updated binding token. */
  onBindingTokenChange?: (token: string) => void;
}

/**
 * Pluggable extension to {@link AppBridge}. `attach` is invoked when the bridge
 * starts and must return a disposer that cleans up when the bridge stops.
 */
export interface AppBridgeFeature {
  attach(context: AppBridgeFeatureContext): () => void;
}

/** Context passed to an {@link AppBridgeFeature} on attach. */
export interface AppBridgeFeatureContext {
  snapshot(): AppBridgeSnapshot;
  projectFileSnapshot(): ProjectFileSnapshot;
  onStateChange(listener: (state: AppBridgeState) => void): () => void;
  onRemoteChange(listener: (change: ProjectFileChange) => void): () => void;
  /** Subscribe to full project file sync completions from the peer. */
  onDidSync(listener: () => void): () => void;
  /** Send the diagnostics for `file` to the peer. */
  publishDiagnostics(file: string, diagnostics: readonly DiagnosticEntry[]): void;
  /** Send a compile pass/fail status update for `file` to the peer. */
  publishStatus(update: AppBridgeFeatureStatus): void;
}

/** Per-file compile status published by features through {@link AppBridgeFeatureContext}. */
export interface AppBridgeFeatureStatus {
  file: string;
  /** `true` when the file compiled with no errors. */
  success: boolean;
  diagnosticCount: {
    error: number;
    warning: number;
  };
}

/** Create an {@link AppBridge}. */
export function createAppBridge(options: AppBridgeOptions): AppBridge {
  return new AppBridgeController(options);
}

class AppBridgeController implements AppBridge {
  private readonly _options: AppBridgeOptions;
  private readonly _stateListeners = new Set<(state: AppBridgeState) => void>();
  private readonly _remoteChangeListeners = new Set<(change: ProjectFileChange) => void>();
  private readonly _syncListeners = new Set<() => void>();
  private readonly _payloadListeners = new Set<(message: WsMessage) => void>();
  private readonly _diagnosticVersions = new Map<string, number>();
  private readonly _featureDisposers: (() => void)[] = [];
  private _project: BridgeProject | undefined;
  private _filesystemUnsub: (() => void) | undefined;
  private _projectUnsubs: (() => void)[] = [];
  private _status: AppBridgeState = "disconnected";
  private _joinCode: string | undefined;
  private _errorCode: BridgeSessionErrorCode | undefined;
  private _counterpartAway = false;

  constructor(options: AppBridgeOptions) {
    this._options = options;
  }

  start(): void {
    if (this._project) {
      return;
    }

    this._errorCode = undefined;
    this.attachFeatures();

    const project = new BridgeProject({
      bridgeUrl: this._options.bridgeUrl,
      wsPath: this._options.wsPath,
      initialFileSnapshot: toFileSystemSnapshot(this._options.filesystem.exportSnapshot()),
      bindingToken: this._options.bindingToken,
    });

    this._project = project;
    this._filesystemUnsub = this._options.filesystem.onLocalChange((change) => {
      project.files.toRemote.applyNotification(toFileSystemNotification(change));
    });
    this._projectUnsubs = [
      project.session.addEventListener("status", (status) => {
        this.setStatus(status);
      }),
      project.session.addEventListener("error", (code) => {
        this._errorCode = code;
        this.setStatus("disconnected");
        this.releaseProject();
      }),
      project.session.addEventListener("counterpartAway", () => {
        this.setCounterpartAway(true);
      }),
      project.session.onPayload((message) => {
        this.emitPayload(message);
      }),
      project.session.on("session:welcome", (msg) => {
        const token = (msg.payload as { bindingToken?: string } | undefined)?.bindingToken;
        if (token) {
          this._options.bindingToken = token;
          this._options.onBindingTokenChange?.(token);
        }
        this.setCounterpartAway(false);
      }),
      project.onJoinCodeChange((joinCode) => {
        this.setJoinCode(joinCode);
      }),
      project.onRemoteFileChange((notification) => {
        const change = toProjectFileChange(notification);
        this._options.filesystem.applyRemoteChange(change);
        this.emitRemoteChange(change);
      }),
      project.onDidSync(() => {
        this.emitDidSync();
      }),
    ];

    project.session.start();
  }

  stop(): void {
    const project = this._project;
    if (!project) {
      this.setJoinCode(undefined);
      this.setStatus("disconnected");
      return;
    }

    project.session.stop();
    this.releaseProject();
  }

  async requestSync(): Promise<void> {
    const project = this.requireProject();
    await project.requestSync();
  }

  snapshot(): AppBridgeSnapshot {
    const snapshot: AppBridgeSnapshot = {
      status: this._status,
      joinCode: this._joinCode,
      errorCode: this._errorCode,
    };
    if (this._counterpartAway) {
      snapshot.counterpartAway = true;
    }
    return snapshot;
  }

  onStateChange(listener: (state: AppBridgeState) => void): () => void {
    this._stateListeners.add(listener);
    return () => {
      this._stateListeners.delete(listener);
    };
  }

  onRemoteChange(listener: (change: ProjectFileChange) => void): () => void {
    this._remoteChangeListeners.add(listener);
    return () => {
      this._remoteChangeListeners.delete(listener);
    };
  }

  sendPayload(message: WsMessage): void {
    this.requireProject().session.sendPayload(message);
  }

  onPayload(listener: (message: WsMessage) => void): () => void {
    this._payloadListeners.add(listener);
    return () => {
      this._payloadListeners.delete(listener);
    };
  }

  private attachFeatures(): void {
    if (this._featureDisposers.length > 0) {
      return;
    }

    const features = this._options.features ?? [];
    const context: AppBridgeFeatureContext = {
      snapshot: () => this.snapshot(),
      projectFileSnapshot: () => this._options.filesystem.exportSnapshot(),
      onStateChange: (listener) => this.onStateChange(listener),
      onRemoteChange: (listener) => this.onRemoteChange(listener),
      onDidSync: (listener) => this.onDidSync(listener),
      publishDiagnostics: (file, diagnostics) => {
        this.publishDiagnostics(file, diagnostics);
      },
      publishStatus: (update) => {
        this.publishStatus(update);
      },
    };

    for (const feature of features) {
      this._featureDisposers.push(feature.attach(context));
    }
  }

  private disposeFeatures(): void {
    for (const dispose of this._featureDisposers.splice(0)) {
      dispose();
    }
  }

  private onDidSync(listener: () => void): () => void {
    this._syncListeners.add(listener);
    return () => {
      this._syncListeners.delete(listener);
    };
  }

  private emitDidSync(): void {
    for (const listener of this._syncListeners) {
      listener();
    }
  }

  private emitPayload(message: WsMessage): void {
    for (const listener of this._payloadListeners) {
      listener(message);
    }
  }

  private emitRemoteChange(change: ProjectFileChange): void {
    for (const listener of this._remoteChangeListeners) {
      listener(change);
    }
  }

  private publishDiagnostics(file: string, diagnostics: readonly DiagnosticEntry[]): void {
    const project = this._project;
    if (!project || this._status !== "connected") {
      return;
    }

    const version = (this._diagnosticVersions.get(file) ?? 0) + 1;
    this._diagnosticVersions.set(file, version);

    const message: AppClientMessage = {
      type: "compile:diagnostics",
      payload: {
        file,
        version,
        diagnostics: [...diagnostics],
      },
    };

    project.session.send(message);
  }

  private publishStatus(update: AppBridgeFeatureStatus): void {
    const project = this._project;
    if (!project || this._status !== "connected") {
      return;
    }

    const message: AppClientMessage = {
      type: "compile:status",
      payload: {
        file: update.file,
        success: update.success,
        diagnosticCount: {
          error: update.diagnosticCount.error,
          warning: update.diagnosticCount.warning,
        },
      },
    };

    project.session.send(message);
  }

  private setStatus(status: AppBridgeState): void {
    if (this._status === status) {
      return;
    }

    this._status = status;
    for (const listener of this._stateListeners) {
      listener(status);
    }
  }

  private setJoinCode(joinCode: string | undefined): void {
    if (this._joinCode === joinCode) {
      return;
    }

    this._joinCode = joinCode;
    for (const listener of this._stateListeners) {
      listener(this._status);
    }
  }

  private setCounterpartAway(away: boolean): void {
    if (this._counterpartAway === away) {
      return;
    }

    this._counterpartAway = away;
    for (const listener of this._stateListeners) {
      listener(this._status);
    }
  }

  private releaseProject(): void {
    this.disposeProjectBindings();
    this._project = undefined;
    this.setJoinCode(undefined);
    this.setCounterpartAway(false);
    this.disposeFeatures();
  }

  private disposeProjectBindings(): void {
    this._filesystemUnsub?.();
    this._filesystemUnsub = undefined;

    for (const unsub of this._projectUnsubs.splice(0)) {
      unsub();
    }
  }

  private requireProject(): BridgeProject {
    if (!this._project) {
      throw new Error("Bridge not started");
    }

    return this._project;
  }
}
