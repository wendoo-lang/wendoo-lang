import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { SessionSnapshot } from "@wendoo/bridge-session";
import { ReplErrorCode, runReplCommand } from "./repl-commands.js";
import type { BridgeAdmin } from "./server.js";

/** The time, in epoch milliseconds, the console specs run at. */
const NOW = 1_000_000;

/** A session with an app connected for 90 seconds and an extension disconnected 12 seconds ago. */
const PAIRED: SessionSnapshot = {
  kind: "vscode",
  sessionId: "session-paired",
  joinCode: "amber-owl-lantern",
  roles: [
    { role: "app", state: "connected", memberId: "member-app", since: NOW - 90_000 },
    { role: "extension", state: "lingering", memberId: undefined, since: NOW - 12_000 },
  ],
};

/** A session whose only member left 300 seconds ago. */
const IDLE: SessionSnapshot = {
  kind: "vscode",
  sessionId: "session-idle",
  joinCode: "brisk-fox-meadow",
  roles: [{ role: "app", state: "lingering", memberId: undefined, since: NOW - 300_000 }],
};

/** A session whose two roles are bound, which holds no join code. */
const FULL: SessionSnapshot = {
  kind: "vscode",
  sessionId: "session-full",
  joinCode: undefined,
  roles: [
    { role: "app", state: "connected", memberId: "member-app-2", since: NOW - 5_000 },
    { role: "extension", state: "connected", memberId: "member-extension-2", since: NOW - 4_000 },
  ],
};

/** The session operations over fixed snapshots, recording every id each operation receives. */
class FakeAdmin implements BridgeAdmin {
  readonly ended: string[] = [];
  readonly disconnected: string[] = [];
  private readonly _snapshots: SessionSnapshot[];

  constructor(snapshots: SessionSnapshot[]) {
    this._snapshots = snapshots;
  }

  sessions(): SessionSnapshot[] {
    return this._snapshots;
  }

  endSession(sessionId: string): boolean {
    this.ended.push(sessionId);
    return this._snapshots.some((session) => session.sessionId === sessionId);
  }

  disconnectMember(memberId: string): boolean {
    this.disconnected.push(memberId);
    return this._snapshots.some((session) => session.roles.some((role) => role.memberId === memberId));
  }
}

/** Whether some line of `output` contains every one of `tokens`. */
function hasLineWith(output: string, ...tokens: string[]): boolean {
  return output.split("\n").some((line) => tokens.every((token) => line.includes(token)));
}

/** Runs `line`, asserting that the console answers it with text, and returns that text. */
function answer(line: string, admin: BridgeAdmin): string {
  const output = runReplCommand(line, admin);
  assert.equal(typeof output, "string");
  return output as string;
}

/** Whether `output` starts with one of the console's error codes. */
function isError(output: string): boolean {
  return Object.values(ReplErrorCode).some((code) => output.startsWith(code));
}

describe("console commands", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: NOW });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  it("sessions lists every session's id and join code, and each role with its state, connected member, and time in that state", () => {
    const admin = new FakeAdmin([PAIRED, IDLE, FULL]);

    const output = answer("sessions", admin);

    assert.ok(hasLineWith(output, "session-paired", "amber-owl-lantern"));
    assert.ok(hasLineWith(output, "session-idle", "brisk-fox-meadow"));
    assert.ok(hasLineWith(output, "app", "connected", "member-app", "90s"));
    assert.ok(hasLineWith(output, "extension", "lingering", "12s"));
    assert.ok(hasLineWith(output, "app", "lingering", "300s"));
    assert.ok(hasLineWith(output, "extension", "connected", "member-extension-2", "4s"));
    assert.ok(!hasLineWith(output, "session-full", "undefined"));
    assert.equal(output.split("\n").filter((line) => line.includes("lingering")).length, 2);
    assert.equal(answer("ls", admin), output);
  });

  it("sessions answers an empty relay with a listing naming no session", () => {
    const output = answer("sessions", new FakeAdmin([]));

    assert.notEqual(output.trim(), "");
    assert.ok(!output.includes("connected") && !output.includes("lingering"));
    assert.notEqual(output, answer("sessions", new FakeAdmin([IDLE])));
  });

  it("disconnect <id> disconnects that member and names it, and reports an unknown or missing id by its code", () => {
    const admin = new FakeAdmin([PAIRED]);

    const output = answer("disconnect member-app", admin);
    assert.ok(output.includes("member-app") && !isError(output));
    const unknown = answer("disconnect member-gone", admin);
    assert.ok(unknown.startsWith(ReplErrorCode.NOT_FOUND) && unknown.includes("member-gone"));
    assert.deepEqual(admin.disconnected, ["member-app", "member-gone"]);

    assert.ok(answer("disconnect", admin).startsWith(ReplErrorCode.MISSING_ID));
    assert.deepEqual(admin.disconnected, ["member-app", "member-gone"]);
  });

  it("kill <id> ends that session and names it, and reports an unknown or missing id by its code", () => {
    const admin = new FakeAdmin([PAIRED]);

    const output = answer("kill session-paired", admin);
    assert.ok(output.includes("session-paired") && !isError(output));
    const unknown = answer("kill session-gone", admin);
    assert.ok(unknown.startsWith(ReplErrorCode.NOT_FOUND) && unknown.includes("session-gone"));
    assert.deepEqual(admin.ended, ["session-paired", "session-gone"]);

    assert.ok(answer("kill", admin).startsWith(ReplErrorCode.MISSING_ID));
    assert.deepEqual(admin.ended, ["session-paired", "session-gone"]);
  });

  it("help lists exactly the console's command names, one per line", () => {
    const names = answer("help", new FakeAdmin([]))
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0]);

    assert.deepEqual(names, ["sessions", "ls", "disconnect", "kill", "help", ".exit"]);
  });

  it("reports an unrecognized command by its code without acting", () => {
    const admin = new FakeAdmin([PAIRED]);

    assert.ok(answer("purge session-paired", admin).startsWith(ReplErrorCode.UNKNOWN_COMMAND));
    assert.deepEqual([admin.ended, admin.disconnected], [[], []]);
  });

  it("answers a blank line with nothing", () => {
    const admin = new FakeAdmin([PAIRED]);

    assert.equal(runReplCommand("", admin), undefined);
    assert.equal(runReplCommand("   \n", admin), undefined);
    assert.deepEqual([admin.ended, admin.disconnected], [[], []]);
  });
});
