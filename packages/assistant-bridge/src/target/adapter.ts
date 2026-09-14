import type { CoreBuild } from "@wendoo/core";
import type { CompiledActionBundle, IBrainDef, WendooModule } from "@wendoo/core/app";

/**
 * Version of the adapter contract this package defines. A loader compares it
 * against the version an artifact was built with and refuses a mismatch.
 * Increment it whenever {@link TargetAdapter} or the shapes it exchanges change
 * in a way an already-built artifact cannot satisfy.
 */
export const ADAPTER_CONTRACT_VERSION = 10;

/**
 * Read the language build an imported artifact module publishes as its optional
 * `buildStamp` export. Returns `undefined` for an artifact that exports none and
 * for one whose export is not a language build, so a caller treats both as an
 * artifact that states no vintage.
 */
export function readBuildStamp(artifactModule: unknown): CoreBuild | undefined {
  const published = (artifactModule as { buildStamp?: unknown } | undefined)?.buildStamp;
  if (typeof published !== "object" || published === null) return undefined;
  const { coreVersion, coreDistHash } = published as Partial<CoreBuild>;
  if (typeof coreVersion !== "string" || typeof coreDistHash !== "string") return undefined;
  return { coreVersion, coreDistHash };
}

/** Facts about a target world that a session states to the model before it plans. */
export interface TargetManifest {
  /** Target platform name, as the model should read it. */
  readonly target: string;
  /**
   * What the person is programming, as a noun phrase the prompt reads inline,
   * for example "their creature".
   */
  readonly thing: string;
  /** What the target's body provides, one plain sentence per entry. */
  readonly provides: readonly string[];
}

/**
 * One percept kind a target reads out of a scenario, named and explained by the
 * target itself.
 */
export interface ScenarioInputKind {
  /** Name a {@link ScenarioInput} gives as its `kind`, spelled exactly. */
  readonly name: string;
  /**
   * One plain sentence stating what an entry of this kind delivers in this
   * world: what its value means, the range it is read over, and whether it is a
   * level that holds or a single arrival.
   */
  readonly description: string;
}

/**
 * One observable state channel of the subject, named and explained by the
 * target itself.
 */
export interface SubjectStateChannel {
  /** Name a state delta reports this channel under, spelled exactly. */
  readonly name: string;
  /**
   * One plain sentence stating what this channel shows and how to read its
   * value: what the encoding means, and what a value of it tells the reader.
   */
  readonly description: string;
  /**
   * What this channel contributes to the state a run is at, derived from the
   * value it reports. Two thinks are at the same state when every channel
   * contributes the same thing, so a value carrying anything that moves on its
   * own -- a counter, a timestamp -- derives that part away here. Absent
   * contributes the reported value itself.
   *
   * @param reported The value the channel reported, as it stands in
   * {@link ThinkObservation.state} after the `name=` prefix.
   */
  readonly identityValue?: (reported: string) => string;
}

/**
 * One scripted percept a scenario delivers into the staged world. The target's
 * adapter interprets it; nothing here presumes what a kind senses.
 */
export interface ScenarioInput {
  /** What is delivered, from {@link TargetAdapter.inputKinds}. */
  readonly kind: string;
  /** Zero-based think this input is applied before. */
  readonly at: number;
  /**
   * What `kind` is delivered. A kind that describes a level holds this value
   * until another entry of the same kind changes it; a kind that describes an
   * arrival delivers it once, on this think alone. The kind's own description
   * says which it is.
   */
  readonly value: number | boolean | string;
}

/**
 * The staged world one rehearsal runs: the core scenario shape every target
 * shares. A target extends it by registering its own input kinds; the seed and
 * the subject are always present.
 */
export interface SimulationScenario {
  /** Seed for every random choice the run makes; the same seed reproduces the run exactly. */
  readonly seed: number;
  /** Population role the brain under study drives, from {@link TargetAdapter.subjects}. */
  readonly subject: string;
  /**
   * Percepts the run scripts, in any order; the run delivers each at its own
   * `at`. Absent when the run scripts none.
   */
  readonly inputs?: readonly ScenarioInput[];
}

/** One rehearsal request. */
export interface SimulationRequest {
  /** Brain the subject role executes for this run. */
  readonly brainDef: IBrainDef;
  readonly scenario: SimulationScenario;
  /** Number of fixed-step thinks to run. */
  readonly thinks: number;
  /**
   * Durable ids of rules to leave out of this run's build. An excluded rule and
   * its whole subtree are absent from the program, so they report nothing and
   * run nothing, and a brain whose every build error falls in an excluded rule
   * still runs. Every other rule keeps the id it reports observations under.
   * Absent when the run excludes nothing.
   */
  readonly excludedRules?: readonly string[];
  /**
   * Compiled user actions and the tiles they back, as the authoring
   * environment holds them. The run installs this before it reads the
   * document, so a tile the document names that no target module registers --
   * a project-authored tile, or one an installed library contributes --
   * resolves in the staged world. Absent when the authoring environment
   * carries no compiled actions.
   */
  readonly actionBundle?: CompiledActionBundle;
}

/** One rule's WHEN gate on one think. */
export interface GateObservation {
  /** Durable id of the rule whose gate this is, as the document carries it. */
  readonly ruleId: string;
  /** `true` when the gate passed and the rule's DO section ran. */
  readonly fired: boolean;
  /** The value the WHEN section produced, rendered compactly. */
  readonly result: string;
}

/**
 * How a dispatched call ended, or that it had not ended when the run did. A
 * call the runtime makes synchronously ends as it is made and reports no
 * outcome at all.
 *
 * `dropped`, `preempted`, and `background-end` name endings of the OPERATION a
 * call starts, and only the target that ran the operation reports one.
 */
export const DispatchOutcome = {
  /** The call produced a value. */
  Resolved: "resolved",
  /** The call failed with an error. */
  Rejected: "rejected",
  /** The call was cancelled before it produced anything. */
  Cancelled: "cancelled",
  /** The call had not ended when the run did, so nothing about its ending is known. */
  Pending: "pending",
  /** The world would not run the operation, so nothing happened. */
  Dropped: "dropped",
  /** Another call interrupted the operation this one started, before it finished. */
  Preempted: "preempted",
  /** The operation this call started ran to its own end after the call returned. */
  BackgroundEnd: "background-end",
} as const;

/** How a dispatched call ended, or that it had not ended when the run did. */
export type DispatchOutcome = (typeof DispatchOutcome)[keyof typeof DispatchOutcome];

/**
 * How an operation ended, as the target that ran it reports. A target publishes
 * one through its rehearsal staging, and a published ending stands in place of
 * whatever the call's handle settle said about the call.
 */
export type OperationEnding =
  | typeof DispatchOutcome.Dropped
  | typeof DispatchOutcome.Preempted
  | typeof DispatchOutcome.BackgroundEnd;

/** One host action the brain under study dispatched on one think. */
export interface DispatchObservation {
  /** Stable action key, for example `actuator.move`. */
  readonly action: string;
  /**
   * The values the call REQUESTED for every argument slot it filled, rendered
   * as `name=value` in slot order. Empty when the call filled none.
   */
  readonly args: readonly string[];
  /** Durable id of the rule the dispatch was attributed to, absent when the runtime could not attribute it. */
  readonly ruleId?: string;
  /**
   * What the call reported back, as `output=value`, named by the first output
   * the action declares. Absent for an action that declares no output.
   */
  readonly output?: string;
  /**
   * How the call ended. Absent when the ending is unremarkable: a synchronous
   * call, which ends as it is made, and an asynchronous call that resolved on
   * the same think it was made. An {@link OperationEnding} the target published
   * about the operation the call started stands here in place of the call's own
   * ending.
   */
  readonly outcome?: DispatchOutcome;
  /**
   * Thinks between the call and the ending {@link outcome} names, present only
   * when that ending fell on a later think than the call.
   */
  readonly settledAfter?: number;
}

/** A page change the brain under study made. */
export interface PageSwitchObservation {
  /** Zero-based index of the page left, absent when the run began on the page entered. */
  readonly from?: number;
  /** Zero-based index of the page entered. */
  readonly to: number;
}

/** Everything observed of the brain under study during one think. */
export interface ThinkObservation {
  readonly gates: readonly GateObservation[];
  readonly dispatches: readonly DispatchObservation[];
  /**
   * Durable ids of the rules parked on an asynchronous call at the end of this
   * think, in the order they parked. Absent when no rule was parked; a running
   * rule is named nowhere.
   */
  readonly waiting?: readonly string[];
  /**
   * Durable ids of the root rules held from re-firing this think because a rule
   * below them was still in flight, in document order. Absent when none was
   * held.
   */
  readonly quiesced?: readonly string[];
  /** The page change this think began with; absent when the brain stayed on its page. */
  readonly pageSwitch?: PageSwitchObservation;
  /**
   * Declared state channels whose value changed on this think, as `name=value`,
   * in the order the target reports them. Every declared channel appears on the
   * first think, which carries the value each started the run at. Absent when
   * no channel changed; a channel absent from a think held its last value.
   */
  readonly state?: readonly string[];
}

/** What the staged world looked like, independent of the brain under study. */
export interface WorldObservation {
  /** Brain-driven participants standing when the run started. */
  readonly initialPopulation: number;
  /** Brain-driven participants standing when the run ended. */
  readonly finalPopulation: number;
  /** Distinct brains that executed during the run, the subject's included. */
  readonly brainsExecuted: number;
}

/** One completed rehearsal. */
export interface SimulationRun {
  /**
   * Id this rehearsal is addressed by, unique among the runs of the adapter
   * that produced it and stable across reruns of the same sequence.
   */
  readonly runId: string;
  /** Thinks the subject actually executed; at most the requested count. */
  readonly thinks: number;
  /** One entry per executed think, in order. */
  readonly observations: readonly ThinkObservation[];
  readonly world: WorldObservation;
}

/**
 * Everything a harness needs of a target to author for it: what to tell the
 * model about the world, what to install so the editor's tools see the world's
 * tiles, the documentation those tiles carry, and how to rehearse a brain in
 * the world headlessly.
 *
 * An artifact publishing an adapter exports a `createTargetAdapter` function
 * returning one.
 */
export interface TargetAdapter {
  /**
   * Contract version the artifact was built against; a loader refuses a value
   * other than the {@link ADAPTER_CONTRACT_VERSION} it holds.
   */
  readonly contractVersion: number;
  /**
   * Wendoo identity of the target this artifact is, as the `identity` its
   * target's own `wendoo.json` declares, injected at build time.
   */
  readonly targetIdentity: string;
  /** Facts about this world, stated to the model before it plans. */
  manifest(): TargetManifest;
  /** Wendoo modules this target installs into an authoring environment, beyond core's own. */
  modules(): readonly WendooModule[];
  /** The documentation markdown this target ships for its own tiles, keyed by tile id. */
  tileDocs(): ReadonlyMap<string, string>;
  /** Population roles a scenario may name as its subject. */
  subjects(): readonly string[];
  /** Scenario input kinds this target reads; empty when it scripts no percepts. */
  inputKinds(): readonly ScenarioInputKind[];
  /**
   * State channels of the subject this target reports per think; empty when it
   * reports none. A run's {@link ThinkObservation.state} names only these.
   */
  stateChannels(): readonly SubjectStateChannel[];
  /**
   * Run one rehearsal. Throws a `ScenarioRejection` if `scenario.subject` is
   * not one of {@link subjects} or an input names a kind outside
   * {@link inputKinds}, and a `RehearsalRejection` if the staged world holds no
   * tile for something the document names, or if the brain does not build once
   * {@link SimulationRequest.excludedRules} has been applied.
   */
  run(request: SimulationRequest): Promise<SimulationRun>;
}

/**
 * The adapter surface an artifact must carry: every member name a host calls on
 * a {@link TargetAdapter}.
 */
export const adapterMethods = [
  "manifest",
  "modules",
  "tileDocs",
  "subjects",
  "inputKinds",
  "stateChannels",
  "run",
] as const;

/** Why an artifact could not stand in as a target adapter. */
export const AdapterNonconformanceCode = {
  /** The artifact module exports no `createTargetAdapter` function. */
  MissingFactory: "adapter_missing_factory",
  /** The artifact produced something other than an object. */
  NotAnObject: "adapter_not_an_object",
  /** The object is missing one or more of {@link adapterMethods}. */
  MissingMembers: "adapter_missing_members",
  /** The artifact was built against a different {@link ADAPTER_CONTRACT_VERSION}. */
  ContractVersionMismatch: "adapter_contract_version_mismatch",
  /** The artifact reports a target identity other than the one the loader expected. */
  IdentityMismatch: "adapter_identity_mismatch",
} as const;

/** Why an artifact could not stand in as a target adapter. */
export type AdapterNonconformanceCode = (typeof AdapterNonconformanceCode)[keyof typeof AdapterNonconformanceCode];

/** One reason an artifact does not conform, machine-readable first. */
export interface AdapterNonconformance {
  readonly code: AdapterNonconformanceCode;
  /** Human-readable context; the code is the contract. */
  readonly detail: string;
}

/** What an artifact is checked against beyond the interface itself. */
export interface AdapterExpectation {
  /**
   * Wendoo identity the artifact must report: the `identity` the target's
   * own `wendoo.json` declares.
   */
  readonly targetIdentity: string;
}

/**
 * Check `candidate` against the adapter interface, the contract version this
 * package defines, and `expectation`. Returns the first reason it does not
 * conform, or `undefined` when it does.
 */
export function adapterNonconformance(
  expectation: AdapterExpectation,
  candidate: unknown
): AdapterNonconformance | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return { code: AdapterNonconformanceCode.NotAnObject, detail: `adapter is ${typeof candidate}` };
  }
  const adapter = candidate as Partial<TargetAdapter>;

  const missing = adapterMethods.filter((name) => typeof adapter[name] !== "function");
  if (missing.length > 0) {
    return { code: AdapterNonconformanceCode.MissingMembers, detail: `missing ${missing.join(", ")}` };
  }
  if (adapter.contractVersion !== ADAPTER_CONTRACT_VERSION) {
    return {
      code: AdapterNonconformanceCode.ContractVersionMismatch,
      detail: `adapter was built for contract ${String(adapter.contractVersion)}; this loader holds ${ADAPTER_CONTRACT_VERSION}`,
    };
  }
  if (adapter.targetIdentity !== expectation.targetIdentity) {
    return {
      code: AdapterNonconformanceCode.IdentityMismatch,
      detail: `adapter reports target identity ${JSON.stringify(adapter.targetIdentity)}; ${JSON.stringify(expectation.targetIdentity)} was expected`,
    };
  }
  return undefined;
}

/** The adapter an artifact publishes, or why it publishes none usable. */
export type AdapterArtifactResult =
  | { readonly ok: true; readonly adapter: TargetAdapter }
  | { readonly ok: false; readonly nonconformance: AdapterNonconformance };

/**
 * Read the adapter out of an imported artifact module: call the
 * `createTargetAdapter` it exports and check what it returns against
 * `expectation`. Propagates whatever the factory throws.
 */
export function readAdapterArtifact(artifactModule: unknown, expectation: AdapterExpectation): AdapterArtifactResult {
  const factory = (artifactModule as { createTargetAdapter?: unknown } | undefined)?.createTargetAdapter;
  if (typeof factory !== "function") {
    return {
      ok: false,
      nonconformance: {
        code: AdapterNonconformanceCode.MissingFactory,
        detail: "the module exports no createTargetAdapter function",
      },
    };
  }
  const candidate = (factory as () => unknown)();
  const nonconformance = adapterNonconformance(expectation, candidate);
  return nonconformance ? { ok: false, nonconformance } : { ok: true, adapter: candidate as TargetAdapter };
}
