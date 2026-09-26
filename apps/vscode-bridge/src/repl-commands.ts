import type { SessionSnapshot } from "@wendoo/bridge-session";
import type { BridgeAdmin } from "./server.js";

/** Stable codes that begin the console's answer to a line it could not carry out. */
export const ReplErrorCode = {
  /** The line's first word names no command. */
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  /** The command takes an id and the line gives none. */
  MISSING_ID: "MISSING_ID",
  /** No session or connected member has the id the line gives. */
  NOT_FOUND: "NOT_FOUND",
} as const;

/** One of the {@link ReplErrorCode} values. */
export type ReplErrorCode = (typeof ReplErrorCode)[keyof typeof ReplErrorCode];

/** The console's help text: one line per command, starting with the command's name. */
const HELP = [
  "sessions          List every session: its id, join code, and each role's state, member id, and time in that state",
  "ls                Same as sessions",
  "disconnect <id>   Close the connection of the connected member with that id",
  "kill <id>         End the session with that id at once",
  "help              Show this help",
  ".exit             Shut the service down",
].join("\n");

/**
 * Carries out one line of development-console input against `admin` and
 * returns the text to show, or `undefined` for a blank line. The answer to a
 * line the console could not carry out starts with a {@link ReplErrorCode}.
 */
export function runReplCommand(line: string, admin: BridgeAdmin): string | undefined {
  const [command, id] = line.trim().split(/\s+/);
  switch (command) {
    case "":
      return undefined;
    case "sessions":
    case "ls":
      return listSessions(admin.sessions());
    case "disconnect":
      if (id === undefined) return `${ReplErrorCode.MISSING_ID}: usage: disconnect <member id>`;
      return admin.disconnectMember(id)
        ? `Disconnected member ${id}`
        : `${ReplErrorCode.NOT_FOUND}: no connected member has id ${id}`;
    case "kill":
      if (id === undefined) return `${ReplErrorCode.MISSING_ID}: usage: kill <session id>`;
      return admin.endSession(id) ? `Ended session ${id}` : `${ReplErrorCode.NOT_FOUND}: no session has id ${id}`;
    case "help":
      return HELP;
    default:
      return `${ReplErrorCode.UNKNOWN_COMMAND}: ${command} (type "help" for the commands)`;
  }
}

/**
 * The `sessions` listing: a line per session, then an indented line per
 * role, with a connected role's connection age or how long a lingering role
 * has been disconnected, in whole seconds.
 */
function listSessions(sessions: readonly SessionSnapshot[]): string {
  if (sessions.length === 0) return "(no sessions)";
  const now = Date.now();
  return sessions
    .flatMap((session) => [
      `${session.sessionId}  kind=${session.kind}  joinCode=${session.joinCode ?? "(none)"}`,
      ...session.roles.map((role) => {
        const seconds = Math.round((now - role.since) / 1000);
        return role.state === "connected"
          ? `  ${role.role}  connected  member=${role.memberId}  age=${seconds}s`
          : `  ${role.role}  lingering  disconnected=${seconds}s ago`;
      }),
    ])
    .join("\n");
}
