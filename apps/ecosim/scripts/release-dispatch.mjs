#!/usr/bin/env node
/**
 * Dispatches this app's release workflow, then watches the run it started and
 * exits with that run's own status. Sends a random marker as the workflow's
 * dispatch-id input, which the workflow puts in its run name, and polls the
 * run list until a run carries that marker. Extra arguments are passed to
 * `gh workflow run`, so `npm run release -- -f bump=minor` works.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const REPO = "wendoo-lang/wendoo-lang";
const WORKFLOW = "Release ecosim";

/** Seconds to keep polling for the dispatched run before giving up. */
const APPEAR_TIMEOUT_S = 90;
/** Seconds between polls. */
const POLL_INTERVAL_S = 3;

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

/** Id of the most recent run whose name carries `marker`, or `undefined` when none does yet. */
function findRunId(marker) {
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
  return runs.find((run) => run.displayTitle.includes(marker))?.databaseId;
}

const dispatchId = randomUUID();
const extraArgs = process.argv.slice(2);

console.log(`dispatching "${WORKFLOW}" on ${REPO} (marker ${dispatchId})`);
execFileSync("gh", ["workflow", "run", WORKFLOW, "-R", REPO, "-f", `dispatch-id=${dispatchId}`, ...extraArgs], {
  stdio: "inherit",
});

let runId = findRunId(dispatchId);
const deadline = Date.now() + APPEAR_TIMEOUT_S * 1000;
while (runId === undefined) {
  if (Date.now() > deadline) {
    console.error(`no run carrying marker ${dispatchId} appeared within ${APPEAR_TIMEOUT_S}s.`);
    console.error(`check the Actions tab of ${REPO} for the run.`);
    process.exit(1);
  }
  await delay(POLL_INTERVAL_S * 1000);
  runId = findRunId(dispatchId);
}

console.log(`watching run ${runId}`);
const watch = spawnSync("gh", ["run", "watch", String(runId), "-R", REPO, "--exit-status"], { stdio: "inherit" });
process.exit(watch.status ?? 1);
