import type { FileSystemSnapshot } from "@wendoo/bridge-client";
import { Project, type ProjectOptions } from "@wendoo/bridge-client";
import type { AppClientMessage, AppServerMessage, FileSystemNotification } from "@wendoo/bridge-protocol";
import { CompilationManager, type CompilationProvider } from "./compilation.js";

/** Options for {@link BridgeProject}. */
export interface BridgeProjectOptions {
  bridgeUrl: string;
  /** Path of the bridge endpoint to connect to. Defaults to `"app"`. */
  wsPath?: string;
  initialFileSnapshot: FileSystemSnapshot;
  /** Join code the session's hellos present until it accepts a welcome, joining the session that holds it. */
  joinCode?: string;
  /** Token used to rebind to a previously established session. */
  bindingToken?: string;
  /** Optional provider that compiles project files and emits diagnostics over the bridge. */
  compilationProvider?: CompilationProvider;
}

/**
 * App-side bridge {@link Project} that exposes the join code and an optional
 * compilation manager.
 */
export class BridgeProject extends Project<AppClientMessage, AppServerMessage> {
  private _joinCode: string | undefined;
  private readonly _joinCodeListeners = new Set<(joinCode: string | undefined) => void>();
  private readonly _sessionUnsubs: (() => void)[] = [];
  private readonly _compilation: CompilationManager | undefined;
  private readonly _remoteFileChangeListeners = new Set<(ev: FileSystemNotification) => void>();

  constructor(options: BridgeProjectOptions) {
    const projectOptions: ProjectOptions<AppClientMessage, AppServerMessage> = {
      ...options,
      wsPath: options.wsPath ?? "app",
    };
    super(projectOptions);
    this.wireJoinCode();

    if (options.compilationProvider) {
      this._compilation = new CompilationManager(
        options.compilationProvider,
        (msg) => this.session.send(msg),
        () => this.session.status === "connected"
      );

      this._sessionUnsubs.push(
        this.onDidSync(() => {
          this._compilation?.sendDiagnostics();
        })
      );
    }

    this.fromRemoteFileChange = (ev: FileSystemNotification) => {
      if (this._compilation) {
        this._compilation.handleFileChange(ev);
      }
      for (const fn of this._remoteFileChangeListeners) {
        fn(ev);
      }
    };
  }

  get compilation(): CompilationManager | undefined {
    return this._compilation;
  }

  get joinCode(): string | undefined {
    return this._joinCode;
  }

  onJoinCodeChange(fn: (joinCode: string | undefined) => void): () => void {
    this._joinCodeListeners.add(fn);
    return () => {
      this._joinCodeListeners.delete(fn);
    };
  }

  onRemoteFileChange(fn: (ev: FileSystemNotification) => void): () => void {
    this._remoteFileChangeListeners.add(fn);
    return () => {
      this._remoteFileChangeListeners.delete(fn);
    };
  }

  private wireJoinCode(): void {
    this._sessionUnsubs.push(
      this.session.on("session:welcome", (msg) => {
        this.setJoinCode(msg.payload.joinCode);
      })
    );
    this._sessionUnsubs.push(
      this.session.on("session:joinCode", (msg) => {
        this.setJoinCode(msg.payload.joinCode);
      })
    );
  }

  private setJoinCode(joinCode: string | undefined): void {
    if (this._joinCode === joinCode) return;
    this._joinCode = joinCode;
    for (const fn of this._joinCodeListeners) {
      fn(joinCode);
    }
  }
}
