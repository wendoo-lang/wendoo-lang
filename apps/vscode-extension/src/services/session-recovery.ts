import { BridgeSessionErrorCode } from "@wendoo/bridge-protocol";

/** The ways back into a Wendoo session that a recovery notification can offer. */
export const SessionRecoveryAction = {
  /** Connect again presenting the saved binding token. */
  RECONNECT: "reconnect",
  /** Ask for a join code and connect with it. */
  ENTER_JOIN_CODE: "enterJoinCode",
  /** Check for a newer release of this extension. */
  CHECK_FOR_UPDATES: "checkForUpdates",
} as const;

/** Union of all {@link SessionRecoveryAction} values. */
export type SessionRecoveryAction = (typeof SessionRecoveryAction)[keyof typeof SessionRecoveryAction];

/** One action a recovery notification offers: its button label and what choosing it does. */
export interface SessionRecoveryChoice {
  readonly action: SessionRecoveryAction;
  readonly label: string;
}

/** What to tell the user when a session failure ends the connection, and the actions to offer. */
export interface SessionRecoveryOffer {
  readonly message: string;
  readonly choices: readonly SessionRecoveryChoice[];
}

const RECONNECT: SessionRecoveryChoice = { action: SessionRecoveryAction.RECONNECT, label: "Reconnect" };
const ENTER_JOIN_CODE: SessionRecoveryChoice = {
  action: SessionRecoveryAction.ENTER_JOIN_CODE,
  label: "Enter Join Code",
};
const CHECK_FOR_UPDATES: SessionRecoveryChoice = {
  action: SessionRecoveryAction.CHECK_FOR_UPDATES,
  label: "Check for Updates",
};

const OFFERS: Record<BridgeSessionErrorCode, SessionRecoveryOffer> = {
  [BridgeSessionErrorCode.SESSION_REPLACED]: {
    message: "Another VS Code window took over this Wendoo session.",
    choices: [RECONNECT],
  },
  [BridgeSessionErrorCode.SESSION_ENDED]: {
    message: "This Wendoo session was ended.",
    choices: [ENTER_JOIN_CODE, RECONNECT],
  },
  [BridgeSessionErrorCode.JOIN_CODE_UNKNOWN]: {
    message: "That join code was not recognized. Enter the code the Wendoo app shows now.",
    choices: [ENTER_JOIN_CODE],
  },
  [BridgeSessionErrorCode.OUTBOUND_QUEUE_OVERFLOW]: {
    message: "Too many changes piled up while Wendoo was offline, so they were discarded.",
    choices: [RECONNECT],
  },
  [BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH]: {
    message: "This extension and the Wendoo bridge speak different versions. Update the outdated side.",
    choices: [CHECK_FOR_UPDATES, RECONNECT],
  },
};

/** The recovery notification for the session failure `code`: the message to show and the actions to offer. */
export function sessionRecoveryOffer(code: BridgeSessionErrorCode): SessionRecoveryOffer {
  return OFFERS[code];
}
