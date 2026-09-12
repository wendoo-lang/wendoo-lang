import type { ITileCatalog } from "../brain/interfaces/catalog";
import type { Dict } from "../platform/dict";
import type { List, ReadonlyList } from "../platform/list";
import type { EventEmitterConsumer } from "../util";
import type { HostActionBinding } from "./context";
import type {
  FiberWaitingEvent,
  HandleSettleEvent,
  HostActionDispatchEvent,
  HostActionReturnEvent,
  RuleWhenGateEvent,
} from "./events";
import type { ActionDescriptor, ActionKey, ActionKind, BrainActionCallDef } from "./function-defs";
import type { Program, ProgramArtifact } from "./program";
import type { ITypeRegistry, TypeId } from "./type-defs";
import type { Value } from "./value";

/** Reference to a registered action, by program-local slot and stable key. */
export interface ActionRef {
  slot: number;
  key: ActionKey;
}

/**
 * Identifies one action call site within a brain program, tagged by binding.
 * A `host` call site dispatches its page-lifecycle hooks by stable registry
 * `actionId` (via `IBrainActionRegistry.getById`); a `bytecode` call site
 * dispatches by program-local `actionSlot` into `Program.actions`.
 */
export type ActionCallSiteEntry =
  | { binding: "host"; callSiteId: number; actionId: number }
  | { binding: "bytecode"; callSiteId: number; actionSlot: number };

/**
 * Extended Program interface for compiled brains. Adds rule-to-function mapping
 * and page metadata.
 */
export interface UnlinkedBrainProgram extends Program {
  /**
   * Mapping from rule path to function ID.
   *
   * Key format: "pageIndex/ruleIndex" or "pageIndex/ruleIndex/childIndex/..."
   * Example: "0/0" = Page 0, Rule 0; "0/0/1" = Page 0, Rule 0, Child 1
   */
  ruleIndex: Dict<string, number>;

  /**
   * Program-local action slots referenced by ACTION_CALL instructions.
   */
  actionRefs: List<ActionRef>;

  /**
   * Page metadata for page-switching logic. Each page entry contains the
   * function IDs of its root rules.
   */
  pages: List<PageMetadata>;
}

/** Brain-side action metadata associated with a compiled bytecode action artifact. */
export interface BrainActionMetadata {
  key: ActionKey;
  kind: ActionKind;
  callDef: BrainActionCallDef;
  outputType?: TypeId;
}

/**
 * Value-conversion metadata carried by a compiled `conversion` artifact: the
 * `(fromType, toType)` registry pair and the path-search cost.
 */
export interface ArtifactConversionInfo {
  fromType: TypeId;
  toType: TypeId;
  cost: number;
}

/**
 * Compiled user-authored action: bytecode-relevant {@link ProgramArtifact}
 * fields combined with the brain-side action metadata that names and shapes
 * the action call site.
 */
export interface UserActionArtifact extends ProgramArtifact, BrainActionMetadata {
  /** Present on `conversion`-kind artifacts: the pair and cost to register in the conversion registry. */
  conversion?: ArtifactConversionInfo;
}

/** Action binding implemented by a compiled bytecode artifact. */
export interface BytecodeResolvedAction {
  binding: "bytecode";
  descriptor: ActionDescriptor;
  artifact: ProgramArtifact;
  metadata: BrainActionMetadata;
}

/** Tagged-union of action bindings: host function or compiled bytecode. */
export type ResolvedAction = HostActionBinding | BytecodeResolvedAction;

/**
 * Output of {@link linkBrainProgram}: an executable {@link Program} (with its
 * `actions` slot populated) plus the brain-side rule-to-function mapping and
 * per-page metadata that the brain runtime consumes for page activation and
 * call-site dispatch.
 */
export interface LinkedBrainProgram {
  program: Program;
  ruleIndex: Dict<string, number>;
  pages: List<PageMetadata>;
}

/** Resolves action descriptors to concrete bindings during brain linking. */
export interface BrainActionResolver {
  resolveAction(descriptor: ActionDescriptor): ResolvedAction | undefined;
}

/** Mutable registry of resolved actions keyed by `ActionKey`. */
export interface IBrainActionRegistry extends BrainActionResolver {
  /**
   * Register a resolved action. Host bindings must carry an author-assigned
   * stable `id`: a non-negative integer, unique across the registry's host
   * actions, and inside the active registration owner's range. Bytecode
   * bindings carry no id (they dispatch by program-local slot). Throws on
   * a duplicate key or an invalid host-binding id.
   */
  register(action: ResolvedAction): ResolvedAction;
  /**
   * Run `body` with host-binding registrations validated against `owner`'s
   * id range: core `[0, TARGET_ACTION_ID_BASE)`, target
   * `[TARGET_ACTION_ID_BASE, ...)`. The previous owner is restored when
   * `body` returns or throws. The default owner is `target`.
   */
  withOwner<T>(owner: "core" | "target", body: () => T): T;
  getByKey(key: ActionKey): ResolvedAction | undefined;
  /**
   * Resolve a registered host action by its author-assigned stable id.
   * Returns `undefined` when no action holds that id. Backs id-based
   * host-action dispatch.
   */
  getById(id: number): ResolvedAction | undefined;
  size(): number;
}

/** Linker inputs: tile catalogs, the action resolver, and the type registry to bind compiled programs against. */
export interface BrainLinkEnvironment {
  catalogs: ReadonlyList<ITileCatalog>;
  actionResolver: BrainActionResolver;
  /** Type registry used during inference to resolve struct field ids from a field-access object's type. */
  typeRegistry: ITypeRegistry;
}

/** Per-page metadata embedded in a {@link UnlinkedBrainProgram}. */
export interface PageMetadata {
  /** Page index in the brain */
  pageIndex: number;

  /** Stable page identifier (UUID), persists across renames */
  pageId: string;

  /** Page name for debugging */
  pageName: string;

  /** Function IDs of root-level rules in this page (in order) */
  rootRuleFuncIds: List<number>;

  /**
   * All action call sites in this page's rule tree: host call sites
   * (`HOST_ACTION_CALL` / `HOST_ACTION_CALL_ASYNC`) and bytecode call sites
   * (`ACTION_CALL` / `ACTION_CALL_ASYNC`).
   */
  actionCallSites: List<ActionCallSiteEntry>;
}

/** Events emitted by an {@link IBrain}. */
export type BrainEvents = {
  page_activated: { pageIndex: number };
  page_deactivated: { pageIndex: number };
  /**
   * One rule's WHEN gate, reported as the gate decides. Emitted once per rule
   * per think for every rule that reaches its gate: a rule whose WHEN section
   * is empty emits no gate, and a rule skipped because an ancestor did not fire
   * emits none that think.
   */
  rule_when_evaluated: RuleWhenGateEvent;
  /**
   * One action call, host-bound or bytecode-bound, reported as the runtime
   * hands it to the action's body. Both synchronous and asynchronous actions
   * report, each at the moment the call is made. The payload's argument
   * container is only valid during the notification.
   */
  host_action_dispatched: HostActionDispatchEvent;
  /**
   * One action call, host-bound or bytecode-bound, reported as it hands control
   * back to the runtime, carrying the value a synchronous call produced. An
   * asynchronous call reports `result: undefined` here and settles later.
   */
  host_action_returned: HostActionReturnEvent;
  /**
   * One fiber parking on a handle, reported as it parks. The fiber runs nothing
   * further until the handle settles, so the rule the payload names is waiting
   * from this point on.
   */
  fiber_waiting: FiberWaitingEvent;
  /** One asynchronous action call's handle settling, reported before any waiter resumes. */
  handle_settled: HandleSettleEvent;
  /**
   * One root rule held from re-firing this think because a rule below it is
   * still in flight. Emitted once per think for each held root rule.
   */
  root_rule_quiesced: { ruleFuncId: number };
  //  variable_changed: { varId: string; oldValue: Value | undefined; newValue: Value };
};

/**
 * Runtime surface of a Wendoo brain: every observable behavior reachable
 * during a tick (variable storage, page lifecycle FSM, scheduler-driven
 * `think`, event channel) without any authoring-side compile / link / edit
 * concerns. Implemented by `BrainRuntime` in `runtime/brain-runtime.ts`.
 *
 * `IBrainRuntime` exists so that runtime-only targets can satisfy this
 * contract without ever touching `packages/core/src/brain/`. The
 * dependency-cruiser firewall test (`__firewall__.spec.ts`) enforces
 * that no value-import under `runtime/` resolves into `brain/`; any
 * method added here must be implementable on `BrainRuntime` without
 * crossing that boundary.
 */
export interface IBrainRuntime {
  /** Event stream for brain lifecycle notifications (page activated / deactivated). */
  events(): EventEmitterConsumer<BrainEvents>;
  /**
   * Current value of the named variable. A variable whose type declares a
   * starting value holds that value until something writes to it; `undefined`
   * means the name has no slot, or its type declares no starting value and
   * nothing has written to it.
   */
  getVariable(varId: string): Value | undefined;
  setVariable(varId: string, value: Value): void;
  /** Reset the named variable to its type's starting value, or to holding no value when its type declares none. */
  clearVariable(varId: string): void;
  /** Reset every variable, each per {@link clearVariable}. */
  clearVariables(): void;
  /**
   * Read a variable by its compiler-assigned slot id. Returns the slot's
   * starting value until something writes to it, and `NIL_VALUE` when the slot
   * is out of range or its type declares no starting value.
   */
  getVariableBySlot(slotId: number): Value;
  /** Linked executable program currently loaded into the brain's VM. */
  getProgram(): Program | undefined;
  /** Per-page metadata for the loaded program (page activation, call sites, sensors, actuators). */
  getPages(): List<PageMetadata>;
  /**
   * Begin execution. Activates the first page and resets all FSM state.
   * Must be called after {@link IBrain.initialize} and before `think`.
   */
  startup(): void;
  /**
   * Halt execution. Runs deactivation hooks for the current page, cancels
   * all active fibers, and clears callsite and variable state.
   */
  shutdown(): void;
  /**
   * Advance the brain by one tick.
   *
   * @param currentTime - Monotonically increasing wall-clock time in seconds.
   */
  think(currentTime: number): void;
  /** Enable or disable the brain's tick loop. A disabled brain skips all execution in `think`. */
  setEnabled(enabled: boolean): void;
  /** Returns `true` if the brain is enabled (default). */
  isEnabled(): boolean;
  /** Pause execution until `clearInterrupt` is called. */
  interrupt(): void;
  /** Resume execution after a call to `interrupt`. */
  clearInterrupt(): void;
  /** Returns `true` if the brain has been interrupted and has not yet been cleared. */
  isInterrupted(): boolean;
  /**
   * Request a page change by zero-based page index. If `pageIndex` equals the
   * current page, triggers a restart instead. An index outside the brain's
   * pages is a no-op: the current page stays active.
   */
  requestPageChange(pageIndex: number): void;
  /**
   * Request a page change by stable page identifier (UUID), falling back to a
   * page-name lookup. A no-op when no page carries the identifier or the name.
   */
  requestPageChangeByPageId(pageId: string): void;
  /** Request a page change by page name. A no-op when no page carries the name. */
  requestPageChangeByName(name: string): void;
  /** Request that the current page restart at the next tick. */
  requestPageRestart(): void;
  /** Returns the stable page identifier (UUID) of the current page, or `""` if none. */
  getCurrentPageId(): string;
  /** Returns the stable page identifier (UUID) of the most recently deactivated page. */
  getPreviousPageId(): string;
}

export interface IBrain extends IBrainRuntime {
  /**
   * Initialize the brain and set context data. Must be called before startup().
   *
   * @param contextData - Application-specific data to attach to the brain's execution context
     (e.g., game entity, DOM context). This will be available to all host functions via ctx.data.
   */
  initialize(contextData?: unknown): void;
}

export interface IBrainPage {
  brain(): IBrain;
}

export interface IBrainRule {
  page(): IBrainPage;
  ancestor(): IBrainRule | undefined;
  getVariable<T extends Value>(varName: string): T | undefined;
  setVariable(varName: string, value: Value): void;
  clearVariable(varName: string): void;
  clearVariables(): void;
  children(): List<IBrainRule>;
}
