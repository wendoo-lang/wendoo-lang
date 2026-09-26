import { type AppBridgeState, BridgeSessionErrorCode } from "@wendoo/bridge-app";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

/**
 * What the VS Code bridge section shows about the connection:
 *
 * - `off` -- the bridge is not connected and no failure is held;
 * - `connecting` -- the bridge is opening or reopening its connection;
 * - `waiting` -- connected, with VS Code not in the session yet or away;
 * - `connected` -- the session is connected with VS Code;
 * - `held` -- a failure ended the connection, which stays down until the
 *   person acts on the notice.
 */
export type BridgeConnectionView = "off" | "connecting" | "waiting" | "connected" | "held";

/** The {@link BridgeConnectionView} for a reading of the bridge's status, pairing, and error code. */
export function bridgeConnectionView(
  status: AppBridgeState,
  paired: boolean,
  errorCode: BridgeSessionErrorCode | undefined
): BridgeConnectionView {
  if (errorCode !== undefined) return "held";
  if (status === "connecting" || status === "reconnecting") return "connecting";
  if (status === "disconnected") return "off";
  return paired ? "connected" : "waiting";
}

/** Props of {@link BridgeConnectionStatus}. */
export interface BridgeConnectionStatusProps {
  status: AppBridgeState;
  /** Whether the session is connected with VS Code. */
  paired: boolean;
  /** Stable code of the failure that ended the latest connection, if one did. */
  errorCode: BridgeSessionErrorCode | undefined;
  /** The join code to enter in VS Code, while the session has one. */
  joinCode: string | undefined;
  /** Connects the bridge again. */
  onReconnect: () => void;
}

const STATUS_LABELS: Record<BridgeConnectionView, string> = {
  off: "disconnected",
  connecting: "connecting",
  waiting: "waiting for VS Code",
  connected: "connected",
  held: "disconnected",
};

/** What the hold notice says for `code`. */
function holdMessage(code: BridgeSessionErrorCode): string {
  switch (code) {
    case BridgeSessionErrorCode.SESSION_REPLACED:
      return "Another tab took over this project's VS Code connection.";
    case BridgeSessionErrorCode.SESSION_ENDED:
      return "VS Code ended the session.";
    case BridgeSessionErrorCode.OUTBOUND_QUEUE_OVERFLOW:
      return "Changes piled up while VS Code was offline, so they were discarded.";
    case BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH:
      return "This app and the VS Code bridge speak different versions. Reload to update the app.";
    default:
      return "The VS Code connection stopped.";
  }
}

/**
 * The VS Code bridge connection readout: the status, the join code to enter
 * in VS Code with a copy affordance while there is one, and, when a failure
 * holds the connection down, a notice carrying its stable code with the way
 * back -- reconnecting, or reloading the app after a version rejection.
 */
export function BridgeConnectionStatus({
  status,
  paired,
  errorCode,
  joinCode,
  onReconnect,
}: BridgeConnectionStatusProps) {
  const [copied, setCopied] = useState(false);
  const view = bridgeConnectionView(status, paired, errorCode);
  const color =
    view === "connected"
      ? "text-success"
      : view === "connecting" || view === "waiting"
        ? "text-warning"
        : "text-muted-foreground";

  return (
    <>
      <output data-testid="bridge-status" data-state={view} className={`text-xs font-mono ${color}`}>
        {view === "connecting" ? status : STATUS_LABELS[view]}
      </output>
      {errorCode !== undefined && (
        <div data-testid="bridge-hold-notice" data-code={errorCode} className="space-y-1.5 text-xs">
          <p>{holdMessage(errorCode)}</p>
          {errorCode === BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH ? (
            <button
              type="button"
              data-testid="bridge-reload"
              className="rounded border px-2 py-0.5 transition-colors hover:bg-muted"
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload
            </button>
          ) : (
            <button
              type="button"
              data-testid="bridge-reconnect"
              className="rounded border px-2 py-0.5 transition-colors hover:bg-muted"
              onClick={onReconnect}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      {joinCode && (status === "connected" || status === "reconnecting") && (
        <div className="flex items-center gap-1.5">
          <span data-testid="bridge-join-code" className="text-xs font-mono text-foreground truncate">
            {joinCode}
          </span>
          <button
            type="button"
            className="shrink-0 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            aria-label={copied ? "Copied to clipboard" : "Copy join code"}
            onClick={() => {
              void navigator.clipboard.writeText(joinCode);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
        </div>
      )}
    </>
  );
}
