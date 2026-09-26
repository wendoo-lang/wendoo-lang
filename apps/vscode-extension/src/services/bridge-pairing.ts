import type { ProjectSession } from "@wendoo/bridge-client";
import type { ExtensionClientMessage, ExtensionServerMessage } from "@wendoo/bridge-protocol";

/**
 * Whether a bridge session is paired with a Wendoo app, read from its session
 * signals: paired from each accepted `session:welcome` until the bridge
 * reports the app away or the session's connection changes. Hands the binding
 * token every welcome carries to `saveToken`.
 */
export class BridgePairing {
  private _paired = false;
  private readonly _listeners = new Set<() => void>();
  private readonly _unsubscribes: (() => void)[];

  /**
   * @param session - The session whose signals to read.
   * @param saveToken - Receives the binding token of every accepted welcome.
   */
  constructor(
    session: ProjectSession<ExtensionClientMessage, ExtensionServerMessage>,
    saveToken: (token: string) => void
  ) {
    this._unsubscribes = [
      session.on("session:welcome", (msg) => {
        if (msg.payload.bindingToken) {
          saveToken(msg.payload.bindingToken);
        }
        this.setPaired(true);
      }),
      session.addEventListener("counterpartAway", () => {
        this.setPaired(false);
      }),
      session.addEventListener("status", () => {
        this.setPaired(false);
      }),
    ];
  }

  /** `true` while the session is paired with a connected app. */
  get paired(): boolean {
    return this._paired;
  }

  /** Subscribes to changes of {@link paired}. Returns an unsubscribe function. */
  onDidChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  /** Stops reading the session's signals and drops every listener. */
  dispose(): void {
    for (const unsubscribe of this._unsubscribes.splice(0)) {
      unsubscribe();
    }
    this._listeners.clear();
  }

  private setPaired(paired: boolean): void {
    if (this._paired === paired) return;
    this._paired = paired;
    for (const listener of this._listeners) {
      listener();
    }
  }
}
