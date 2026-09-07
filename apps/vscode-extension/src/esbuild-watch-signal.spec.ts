import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const ESBUILD_SCRIPT = path.join(__dirname, "..", "esbuild.mjs");

/**
 * The stdout/stderr token the workbench's background task matcher
 * (`endsPattern: "build finished"`) reads as readiness before launching the
 * web extension host against `dist/`. The watch script must emit it only
 * after a build that produced a fresh bundle; emitting it for a failed build
 * launches the host over a stale bundle.
 */
const READY_TOKEN = "build finished";

/** Marker esbuild prints with each build error at the script's log level. */
const ERROR_MARKER = "[ERROR]";

/** How long after an error marker the token may still arrive before the run counts as quiet. */
const POST_ERROR_GRACE_MS = 2000;

/** Upper bound on one observed watch startup. */
const DEADLINE_MS = 20000;

/** What the first watch build reported, with the full process transcript. */
interface FirstBuildObservation {
  outcome: "ready" | "failed-quietly" | "deadline";
  transcript: string;
}

/** Write a minimal extension project whose entry is `entrySource` and return its root. */
function scratchProject(entrySource: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "wendoo-esbuild-watch-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src", "extension.ts"), entrySource);
  return root;
}

/**
 * Start the watch script in `root` and observe its first build: resolves
 * `ready` when the readiness token appears, `failed-quietly` when a build
 * error appears and the token stays absent through the grace period, and
 * `deadline` when neither happens in time. Kills the watcher before
 * resolving.
 */
function observeFirstWatchBuild(root: string): Promise<FirstBuildObservation> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ESBUILD_SCRIPT, "--watch"], { cwd: root });
    let transcript = "";
    let graceTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const settle = (outcome: FirstBuildObservation["outcome"]): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      clearTimeout(deadlineTimer);
      child.kill();
      resolve({ outcome, transcript });
    };

    const deadlineTimer = setTimeout(() => {
      settle("deadline");
    }, DEADLINE_MS);

    const absorb = (chunk: Buffer): void => {
      transcript += chunk.toString();
      if (transcript.includes(READY_TOKEN)) {
        settle("ready");
        return;
      }
      if (transcript.includes(ERROR_MARKER) && graceTimer === undefined) {
        graceTimer = setTimeout(() => {
          settle("failed-quietly");
        }, POST_ERROR_GRACE_MS);
      }
    };
    child.stdout.on("data", absorb);
    child.stderr.on("data", absorb);
  });
}

describe("esbuild watch readiness signal", () => {
  it("does not signal readiness when the first watch build fails", async () => {
    const root = scratchProject('import { probe } from "@wendoo/spec-unresolvable-package";\nexport { probe };\n');
    try {
      const observed = await observeFirstWatchBuild(root);
      assert.notEqual(observed.outcome, "deadline", `watch produced neither signal:\n${observed.transcript}`);
      assert.equal(
        observed.outcome,
        "failed-quietly",
        `a failed build emitted the readiness token, so the workbench would launch over a stale bundle:\n${observed.transcript}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signals readiness when the first watch build succeeds", async () => {
    const root = scratchProject('export const probe = "ok";\n');
    try {
      const observed = await observeFirstWatchBuild(root);
      assert.equal(
        observed.outcome,
        "ready",
        `a clean build never emitted the readiness token:\n${observed.transcript}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
