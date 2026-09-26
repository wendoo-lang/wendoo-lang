import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { SessionSnapshot } from "@wendoo/bridge-session";
import { within } from "@wendoo/bridge-session/testing";
import { startRepl } from "./repl.js";
import type { BridgeAdmin } from "./server.js";

describe("console shell", () => {
  it("runs each input line as a console command and calls the exit hook when the console exits", async () => {
    const ended: string[] = [];
    const admin: BridgeAdmin = {
      sessions: (): SessionSnapshot[] => [],
      endSession: (sessionId) => {
        ended.push(sessionId);
        return true;
      },
      disconnectMember: () => false,
    };
    const input = new PassThrough();
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk: Buffer) => {
      written += chunk.toString();
    });
    let exits = 0;
    const exited = new Promise<void>((resolve) => {
      startRepl({
        admin,
        input,
        output,
        onExit: () => {
          exits++;
          resolve();
        },
      });
    });

    input.write("kill session-1\n");
    input.write(".exit\n");
    await within(exited, "the console to exit");

    assert.equal(exits, 1);
    assert.deepEqual(ended, ["session-1"]);
    assert.ok(written.includes("session-1"));
  });
});
