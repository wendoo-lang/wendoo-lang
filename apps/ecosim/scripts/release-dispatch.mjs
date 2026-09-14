#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
/**
 * Dispatches the "Release ecosim" GitHub workflow and watches the run it
 * started, exiting with the run's own status. Extra arguments are passed to
 * `gh workflow run`, so `npm run release -- -f bump=minor` works.
 *
 * The dispatch API returns no run id, so the script sends a random marker as
 * the workflow's dispatch-id input, which the workflow embeds in its run
 * name; the run is then found by that marker and watched.
 */
import { randomUUID } from "node:crypto";

const REPO = "wendoo-lang/wendoo-lang";
const WORKFLOW = "Release ecosim";

/** Seconds to keep polling for the dispatched run before giving up. */
const APPEAR_TIMEOUT_S = 90;
/** Seconds between polls. */
const POLL_INTERVAL_S = 3;

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function sleep(seconds) {
  spawnSync("sleep", [String(seconds)]);
}

const dispatchId = randomUUID();
const extraArgs = process.argv.slice(2);

console.log(`dispatching "${WORKFLOW}" on ${REPO} (marker ${dispatchId})`);
execFileSync("gh", ["workflow", "run", WORKFLOW, "-R", REPO, "-f", `dispatch-id=${dispatchId}`, ...extraArgs], {
  stdio: "inherit",
});

let runId;
const deadline = Date.now() + APPEAR_TIMEOUT_S * 1000;
while (runId === undefined) {
  if (Date.now() > deadline) {
    console.error(`no run carrying marker ${dispatchId} appeared within ${APPEAR_TIMEOUT_S}s.`);
    console.error(`check the Actions tab of ${REPO} for the run.`);
    process.exit(1);
  }
  sleep(POLL_INTERVAL_S);
  const runs = ghJson([
    "run",
    "list",
    "-R",
    REPO,
    "--workflow",
    WORKFLOW,
    "--limit",
    "20",
    "--json",
    "databaseId,displayTitle",
  ]);
  runId = runs.find((run) => run.displayTitle.includes(dispatchId))?.databaseId;
}

console.log(`watching run ${runId}`);
const watch = spawnSync("gh", ["run", "watch", String(runId), "-R", REPO, "--exit-status"], { stdio: "inherit" });
process.exit(watch.status ?? 1);
