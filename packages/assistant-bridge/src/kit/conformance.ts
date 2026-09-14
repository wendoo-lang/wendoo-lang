import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { IBrainDef } from "@wendoo/core/app";
import { summarizeRun } from "../simulate/summarizer.js";
import type { AdapterExpectation, SimulationRun, SimulationScenario, TargetAdapter } from "../target/adapter.js";
import {
  AdapterNonconformanceCode,
  adapterMethods,
  adapterNonconformance,
  readAdapterArtifact,
  readBuildStamp,
} from "../target/adapter.js";
import { proposeEdit } from "../tools/propose-edit.js";
import { createAuthoringWorkspace, isNestedRulePath, locateRules } from "../tools/workspace.js";
import { USER_TILE_ACTION_KEY, USER_TILE_ID, userTileBundle } from "./user-tile-bundle.js";

/** Which property of a rehearsal adapter a check covers. */
export const ConformanceCheckCode = {
  /** The same seed reproduces the same run, byte for byte. */
  Determinism: "determinism",
  /** The summarized run fits a tool result. */
  Boundedness: "boundedness",
  /** The run observed the WHEN gates of the brain under study. */
  GateEvents: "gate_events",
  /** The run accounted for the nested rules of the brain under study. */
  ChildRuleObservation: "child_rule_observation",
  /** A compiled user tile the request carries resolves in the staged world and its dispatches are observed. */
  UserTileObservation: "user_tile_observation",
  /** The built artifact loads and publishes a conforming adapter in plain Node. */
  HeadlessPurity: "headless_purity",
  /** The built artifact documents its tiles and rehearses away from the tree that built it. */
  SelfContainment: "self_containment",
  /** The built artifact publishes the language build it was built against. */
  BuildStamp: "build_stamp",
} as const;

/** Which property of a rehearsal adapter a check covers. */
export type ConformanceCheckCode = (typeof ConformanceCheckCode)[keyof typeof ConformanceCheckCode];

/** One conformance check's outcome. */
export interface ConformanceCheck {
  readonly code: ConformanceCheckCode;
  readonly ok: boolean;
  /** Human-readable context; the code and `ok` are the contract. */
  readonly detail: string;
}

/** Every conformance check run, and whether all of them held. */
export interface ConformanceReport {
  readonly ok: boolean;
  readonly checks: readonly ConformanceCheck[];
}

/** Largest summarized run a rehearsal may produce, in JSON characters. */
const maxSummaryLength = 16384;

/** What the in-process conformance checks run against. */
export interface AdapterConformanceOptions {
  readonly adapter: TargetAdapter;
  /** A brain that compiles against the adapter's modules and carries at least one rule. */
  readonly brainDef: IBrainDef;
  readonly scenario: SimulationScenario;
  /** Fixed-step thinks each conformance run covers. */
  readonly thinks: number;
}

/** Gather the checks into a report. */
function report(checks: readonly ConformanceCheck[]): ConformanceReport {
  return { ok: checks.every((check) => check.ok), checks };
}

/** What a run recorded, which two runs of one seed must match on exactly. */
function recorded(run: SimulationRun): string {
  const { runId: _addressedAs, ...rest } = run;
  return JSON.stringify(rest);
}

/** Compare two runs of the same seed. */
function determinism(first: SimulationRun, second: SimulationRun): ConformanceCheck {
  const ok = recorded(first) === recorded(second);
  return {
    code: ConformanceCheckCode.Determinism,
    ok,
    detail: ok ? `${first.thinks} thinks reproduced` : "the same seed produced two different runs",
  };
}

/** Measure the summarized run against the tool-result budget. */
function boundedness(run: SimulationRun): ConformanceCheck {
  const length = JSON.stringify(summarizeRun(run)).length;
  return {
    code: ConformanceCheckCode.Boundedness,
    ok: length <= maxSummaryLength,
    detail: `summary is ${length} of at most ${maxSummaryLength} characters`,
  };
}

/** Confirm the run observed the WHEN gates of the brain under study. */
function gateEvents(run: SimulationRun): ConformanceCheck {
  const gates = run.observations.reduce((total, think) => total + think.gates.length, 0);
  return {
    code: ConformanceCheckCode.GateEvents,
    ok: gates > 0,
    detail: `${gates} gate observations over ${run.thinks} thinks`,
  };
}

/**
 * Durable ids of every rule nested under another in `brainDef` that carries at
 * least one tile, in document order.
 */
function actingNestedRuleIds(brainDef: IBrainDef): string[] {
  return locateRules(brainDef)
    .filter(
      (located) =>
        isNestedRulePath(located.rulePath) && located.rule.when().tiles().size() + located.rule.do().tiles().size() > 0
    )
    .map((located) => located.ruleId);
}

/**
 * Confirm the run named every nested rule of `brainDef` that carries tiles, in
 * a gate or a dispatch. Passes when the brain nests no such rule.
 */
function childRuleObservation(brainDef: IBrainDef, run: SimulationRun): ConformanceCheck {
  const nested = actingNestedRuleIds(brainDef);
  if (nested.length === 0) {
    return {
      code: ConformanceCheckCode.ChildRuleObservation,
      ok: true,
      detail: "the brain under study nests no rule that carries tiles",
    };
  }
  const named = new Set<string>();
  for (const think of run.observations) {
    for (const gate of think.gates) named.add(gate.ruleId);
    for (const dispatch of think.dispatches) {
      if (dispatch.ruleId !== undefined) named.add(dispatch.ruleId);
    }
  }
  const silent = nested.filter((ruleId) => !named.has(ruleId));
  return {
    code: ConformanceCheckCode.ChildRuleObservation,
    ok: silent.length === 0,
    detail:
      silent.length === 0
        ? `${nested.length} nested rules accounted for`
        : `nothing was observed of nested rules ${silent.join(", ")}`,
  };
}

/** Name the user-tile check opens its throwaway document under. */
const userTileBrainName = "user-tile";

/** A failed user-tile check carrying `detail`. */
function noUserTile(detail: string): ConformanceCheck {
  return { code: ConformanceCheckCode.UserTileObservation, ok: false, detail };
}

/**
 * Rehearse a document written against a compiled action bundle the adapter's
 * own modules do not carry: a single rule whose DO side drives one user-authored
 * actuator, with the bundle travelling on the request. The staged world must
 * resolve the tile from that bundle and report the calls it made, so a target
 * that stages its world without the request's compiled actions fails here.
 */
async function userTileObservation(options: AdapterConformanceOptions): Promise<ConformanceCheck> {
  const { adapter } = options;
  const workspace = createAuthoringWorkspace(adapter, userTileBrainName);
  const actionBundle = userTileBundle();
  workspace.environment.replaceActionBundle(actionBundle);

  const ruleId = locateRules(workspace.brainDef)[0]?.ruleId;
  if (ruleId === undefined) return noUserTile("a fresh document holds no rule to author into");
  const placed = proposeEdit(workspace, { op: "placeTile", ruleId, side: "do", tileId: USER_TILE_ID });
  if (!placed.ok) return noUserTile(`the editor refused the user tile: ${JSON.stringify(placed)}`);

  let run: SimulationRun;
  try {
    run = await adapter.run({
      brainDef: workspace.brainDef,
      scenario: options.scenario,
      thinks: options.thinks,
      actionBundle,
    });
  } catch (cause) {
    return noUserTile(`the run refused the document: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  const dispatched = run.observations.reduce(
    (total, think) => total + think.dispatches.filter((dispatch) => dispatch.action === USER_TILE_ACTION_KEY).length,
    0
  );
  return {
    code: ConformanceCheckCode.UserTileObservation,
    ok: dispatched > 0,
    detail:
      dispatched > 0
        ? `${dispatched} calls of the carried user action observed over ${run.thinks} thinks`
        : `nothing was observed of ${USER_TILE_ACTION_KEY} over ${run.thinks} thinks`,
  };
}

/**
 * Run the checks a target's adapter must pass to be rehearsable: the same seed
 * reproduces the same run, the summarized run fits a tool result, the run
 * observes the brain's WHEN gates, it accounts for the brain's nested rules, and
 * it resolves and observes a compiled user tile the request carries. Runs the
 * adapter three times.
 */
export async function checkAdapterConformance(options: AdapterConformanceOptions): Promise<ConformanceReport> {
  const request = { brainDef: options.brainDef, scenario: options.scenario, thinks: options.thinks };
  const first = await options.adapter.run(request);
  const second = await options.adapter.run(request);
  return report([
    determinism(first, second),
    boundedness(first),
    gateEvents(first),
    childRuleObservation(options.brainDef, first),
    await userTileObservation(options),
  ]);
}

const run = promisify(execFile);

/** What a freshly loaded artifact reported about the adapter it publishes. */
interface LoadedArtifact {
  /** `true` when the module exports a `createTargetAdapter` function. */
  readonly hasFactory: boolean;
  /** `typeof` what the factory returned. */
  readonly produced: string;
  readonly contractVersion?: unknown;
  readonly targetIdentity?: unknown;
  /** The names from {@link adapterMethods} the produced object carries as functions. */
  readonly methods: readonly string[];
}

/** The script the child process runs to load one artifact and report its adapter. */
function loadScript(artifactUrl: URL): string {
  return `
    const members = ${JSON.stringify(adapterMethods)};
    const artifact = await import(${JSON.stringify(artifactUrl.href)});
    const factory = artifact.createTargetAdapter;
    if (typeof factory !== "function") {
      process.stdout.write(JSON.stringify({ hasFactory: false, produced: "undefined", methods: [] }));
    } else {
      const adapter = factory();
      const object = typeof adapter === "object" && adapter !== null ? adapter : {};
      process.stdout.write(JSON.stringify({
        hasFactory: true,
        produced: typeof adapter,
        contractVersion: object.contractVersion,
        targetIdentity: object.targetIdentity,
        methods: members.filter((name) => typeof object[name] === "function"),
      }));
    }
  `;
}

/** The adapter shape `loaded` describes, as an object the conformance check can read. */
function standIn(loaded: LoadedArtifact): unknown {
  if (loaded.produced !== "object") return undefined;
  const object: Record<string, unknown> = {
    contractVersion: loaded.contractVersion,
    targetIdentity: loaded.targetIdentity,
  };
  for (const name of loaded.methods) object[name] = () => undefined;
  return object;
}

/**
 * Load `artifactUrl` in a fresh Node process with no DOM and no bundler, and
 * check the adapter it publishes against `expectation`. This is the headless
 * purity a target's own gate runs against its built artifact.
 */
export async function checkArtifactLoads(artifactUrl: URL, expectation: AdapterExpectation): Promise<ConformanceCheck> {
  let loaded: LoadedArtifact;
  try {
    const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", loadScript(artifactUrl)]);
    loaded = JSON.parse(stdout) as LoadedArtifact;
  } catch (cause) {
    return {
      code: ConformanceCheckCode.HeadlessPurity,
      ok: false,
      detail: `${artifactUrl.href} did not load: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  if (!loaded.hasFactory) {
    return {
      code: ConformanceCheckCode.HeadlessPurity,
      ok: false,
      detail: `${AdapterNonconformanceCode.MissingFactory}: ${artifactUrl.href} exports no createTargetAdapter function`,
    };
  }

  const nonconformance = adapterNonconformance(expectation, standIn(loaded));
  return {
    code: ConformanceCheckCode.HeadlessPurity,
    ok: nonconformance === undefined,
    detail: nonconformance
      ? `${nonconformance.code}: ${nonconformance.detail}`
      : `${artifactUrl.href} loaded and published a conforming adapter`,
  };
}

/** Name the self-containment check opens its throwaway document under. */
const selfContainmentBrainName = "self-containment";

/** Seed the self-containment rehearsal draws from. */
const selfContainmentSeed = 1;

/** Fixed-step thinks the self-containment rehearsal covers. */
const selfContainmentThinks = 20;

/**
 * A report carrying the self-containment check that failed with `detail`,
 * behind the headless purity check when one was reached.
 */
function notSelfContained(loaded: ConformanceCheck | undefined, detail: string): ConformanceReport {
  const selfContainment: ConformanceCheck = { code: ConformanceCheckCode.SelfContainment, ok: false, detail };
  return report(loaded === undefined ? [selfContainment] : [loaded, selfContainment]);
}

/**
 * Copy the artifact file at `artifactPath` into a fresh directory outside every
 * build tree and exercise it there: load it in a plain Node process, read the
 * tile documentation it resolves, rehearse an empty brain in its world, and
 * read the build stamp it publishes. Anything the artifact still reaches for
 * beside its old location -- a package it did not bundle, a documentation tree,
 * a shipped asset -- is missing at the copy, so the check fails. Only the
 * artifact file itself is copied.
 *
 * Reports the headless purity of the copy, its self-containment, and its build
 * stamp. Nothing the copy loaded outlives the call: the copy and its module
 * tree are removed before the report is returned.
 *
 * @param artifactPath Absolute path of the built ES module publishing the adapter.
 */
export async function checkArtifactSelfContained(
  artifactPath: string,
  expectation: AdapterExpectation
): Promise<ConformanceReport> {
  const copyRoot = await mkdtemp(join(tmpdir(), "wendoo-artifact-"));
  let loaded: ConformanceCheck | undefined;
  try {
    const copied = join(copyRoot, basename(artifactPath));
    await copyFile(artifactPath, copied);
    const copiedUrl = pathToFileURL(copied);

    loaded = await checkArtifactLoads(copiedUrl, expectation);
    if (!loaded.ok) return report([loaded]);

    const artifactModule: unknown = await import(copiedUrl.href);
    const result = readAdapterArtifact(artifactModule, expectation);
    if (!result.ok) {
      return notSelfContained(loaded, `${result.nonconformance.code}: ${result.nonconformance.detail}`);
    }
    const { adapter } = result;

    const documentedTiles = adapter.tileDocs().size;
    if (documentedTiles === 0) return notSelfContained(loaded, `${copiedUrl.href} resolved no tile documentation`);

    const subject = adapter.subjects()[0];
    if (subject === undefined) return notSelfContained(loaded, `${copiedUrl.href} offers no subject to rehearse`);

    const workspace = createAuthoringWorkspace(adapter, selfContainmentBrainName);
    await adapter.run({
      brainDef: workspace.brainDef,
      scenario: { seed: selfContainmentSeed, subject },
      thinks: selfContainmentThinks,
    });

    const buildStamp = readBuildStamp(artifactModule);
    return report([
      loaded,
      {
        code: ConformanceCheckCode.SelfContainment,
        ok: true,
        detail: `${basename(artifactPath)} documented ${documentedTiles} tiles and rehearsed ${subject} away from its build tree`,
      },
      {
        code: ConformanceCheckCode.BuildStamp,
        ok: buildStamp !== undefined,
        detail:
          buildStamp === undefined
            ? `${basename(artifactPath)} publishes no build stamp, so it states no language build`
            : `built against core ${buildStamp.coreVersion} at ${buildStamp.builtAt}`,
      },
    ]);
  } catch (cause) {
    return notSelfContained(loaded, `${artifactPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  } finally {
    await rm(copyRoot, { recursive: true, force: true });
  }
}
