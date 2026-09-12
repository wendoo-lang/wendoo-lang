import { Dict } from "../platform/dict";
import { Error } from "../platform/error";
import { EventEmitter, type EventEmitterConsumer } from "../platform/event-emitter";
import { List } from "../platform/list";
import { UniqueSet } from "../platform/uniqueset";
import { createCallsiteStore, type ICallsiteStore } from "./callsite-store";
import type { BytecodeExecutableAction, ExecutionContext } from "./context";
import type { VmEvents } from "./events";
import type { BrainEvents, IBrainRuntime, PageMetadata } from "./host-bindings";
import type { Program } from "./program";
import { NO_VARIABLE_INIT, variableInitAt } from "./program";
import {
  type AbandonedRuleFirings,
  createProgramServices,
  createRuleCompletionServices,
  createRuleFiringServices,
  createRuleVariableServices,
  type RuleFiringStates,
  type RuleVariableStores,
  type RuleWatcherSlots,
} from "./rule-services";
import { createRuntimeServices } from "./runtime-services";
import type { PlatformServices } from "./services";
import { NIL_VALUE, type Value } from "./value";
import { DEFAULT_SCHEDULER_CONFIG, FiberScheduler, type SchedulerConfig, VM } from "./vm";
import type { VmConfig } from "./vm-types";
import { FiberState, VmStatus } from "./vm-types";

/**
 * Runtime entry point for a compiled Wendoo brain. Owns the VM, the fiber
 * scheduler, the page lifecycle FSM, and brain- and rule-scoped variable
 * storage. Built once per linked {@link Program} from a pre-built
 * {@link PlatformServices} aggregate (minus the `brain` tier, which the
 * runtime constructs internally).
 *
 * A runtime-only target instantiates `BrainRuntime` directly from a
 * deserialized `Program` blob and a host-supplied `PlatformServices`
 * view; the authoring-side {@link Brain} facade does the same after
 * running the compile / link / treeshake pipeline, then bridges
 * {@link BrainEvents} to per-page authoring callbacks.
 *
 * The runtime surface (`think`, page-change requests, variable accessors,
 * etc.) is declared on {@link IBrainRuntime}.
 */
export class BrainRuntime implements IBrainRuntime {
  /**
   * Variable storage at the Brain level, indexed by compiler-assigned slot id.
   * Slot ids correspond to positions in the loaded program's variableNames pool;
   * they are the operand of LOAD_VAR_SLOT / STORE_VAR_SLOT. A slot value of
   * `undefined` means the slot holds no value; bytecode reads of such slots
   * observe `NIL_VALUE`.
   */
  private variables: List<Value | undefined> = List.empty();

  /**
   * Starting value of each slot in {@link variables}, or `undefined` for a slot
   * whose type declares none. Slots are seeded with these at program load and
   * returned to them by {@link clearVariable} / {@link clearVariables}.
   */
  private variableZeros: List<Value | undefined> = List.empty();

  /**
   * Map from variable name to slot id. Populated from `Program.variableNames`
   * at program load. Names not in the program may be lazily added by host
   * functions calling the name-keyed `setVariable` API; such slots are addressable
   * by name only (no bytecode operand can target them).
   */
  private varSlotByName: Dict<string, number> = new Dict<string, number>();

  /**
   * Brain-global System state storage, indexed by the linker-assigned store
   * slot (the operand of `LOAD_SYSTEM_VAR` / `STORE_SYSTEM_VAR`). One slot per
   * registered System; shared across all callsites and not reachable from brain
   * code. Writes are by reference (no deep copy), so a System's state struct
   * mutates in place. Grows lazily on out-of-range writes; reads of an unwritten
   * slot observe `NIL_VALUE`.
   */
  private systemStore: List<Value | undefined> = List.empty();

  /**
   * The linked program loaded into the VM.
   */
  private readonly program: Program;

  /**
   * Per-page metadata produced by the linker (root rule funcIds, action call
   * sites, sensors, actuators).
   */
  private readonly pageMetadata: List<PageMetadata>;

  /**
   * Single VM instance for executing all rules.
   */
  private readonly vm: VM;

  /**
   * Single scheduler for managing all fibers.
   */
  private readonly scheduler: FiberScheduler;

  /**
   * Resolved scheduler tunables for this brain instance. Also supplies the
   * instruction budget for page-lifecycle hook fibers.
   */
  private readonly schedulerConfig: SchedulerConfig;

  /**
   * Persistent execution context shared across all fibers. Provides variable
   * access and services to host functions and the VM dispatch loop.
   */
  private readonly executionContext: ExecutionContext;

  /**
   * Brain-instance-scoped owner of per-callsite state. Backs
   * `services.brain.callsite`; cleared on shutdown.
   */
  private readonly callsiteStore: ICallsiteStore;

  /**
   * Per-rule variable storage keyed by rule funcId, then by variable name.
   * Backs `services.brain.ruleVars`. Allocated lazily per rule on first write.
   */
  private readonly ruleVariableStores: RuleVariableStores;

  /**
   * The canonical brain-scheduler interface. Each entry holds the program
   * funcId and the scheduler-assigned fiberId for an active root rule.
   */
  private activeRuleFiberIds: List<{ funcId: number; fiberId: number | undefined }> = List.empty();

  private nextInlineFiberId: number = -1000000;

  /** Emitter backing the {@link events} consumer. */
  private readonly emitter_: EventEmitter<BrainEvents> = new EventEmitter<BrainEvents>();

  // Page lifecycle FSM state
  private enabled: boolean = true;
  private interrupted: boolean = false;
  private currentPageIndex: number = 0;
  private desiredPageIndex: number = 0;
  private previousPageIndex: number = -1;
  private restartPageRequested: boolean = false;
  private lastThinkTime: number = 0;

  /** O(1) lookup from stable pageId (UUID) to page index. */
  private pageIdToIndex: Dict<string, number> = new Dict();

  /** O(1) lookup from page name to page index. */
  private pageNameToIndex: Dict<string, number> = new Dict();

  /**
   * Construct a fully ready-to-`startup()` runtime around a linked,
   * treeshaken {@link Program}.
   *
   * @param program - Linked program loaded into the VM. Variable-name to
   *   slot binding is read from `program.variableNames`.
   * @param pageMetadata - Per-page metadata produced by the linker
   *   (root rule funcIds, action call sites, sensors, actuators).
   * @param hostServices - The three host-supplied platform tiers (`runtime`,
   *   `shared`, `app`). The runtime builds the `brain` tier internally.
   * @param contextData - Application-specific data attached to the
   *   brain's `ExecutionContext`. Host functions read this via `ctx.data`.
   * @param previousVariables - Optional snapshot of the prior runtime's
   *   variable storage, used to carry variable values across a
   *   re-initialization (hot reload).
   * @param schedulerConfig - Optional scheduler tunables for this brain
   *   (fiber slice budget, hook budget, fiber cap). Omitted fields fall
   *   back to {@link DEFAULT_SCHEDULER_CONFIG}. Device profiles pin these
   *   values so the reference VM and a device VM schedule identically.
   */
  constructor(
    program: Program,
    pageMetadata: List<PageMetadata>,
    hostServices: Omit<PlatformServices, "brain">,
    contextData: unknown = undefined,
    previousVariables?: VariableSnapshot,
    vmEvents?: VmEvents,
    schedulerConfig?: Partial<SchedulerConfig> &
      Partial<Pick<VmConfig, "maxStackSize" | "maxLocalsSize" | "maxFrameDepth" | "maxHandlers" | "maxHandles">>
  ) {
    this.program = program;
    this.pageMetadata = pageMetadata;

    const callsiteStore = createCallsiteStore();
    const ruleVariableStores: RuleVariableStores = new Dict();
    // One firing record per rule, keyed by rule funcId and allocated with the
    // runtime: a rule's record lives exactly as long as this brain instance.
    const ruleFiringStates: RuleFiringStates = new Dict();
    const ruleWatcherSlots: RuleWatcherSlots = new Dict();
    const abandonedRuleFirings: AbandonedRuleFirings = new UniqueSet();
    this.callsiteStore = callsiteStore;
    this.ruleVariableStores = ruleVariableStores;

    this.installVariableTable(program, previousVariables);

    for (let i = 0; i < pageMetadata.size(); i++) {
      const meta = pageMetadata.get(i);
      if (meta) {
        this.pageIdToIndex.set(meta.pageId, i);
        this.pageNameToIndex.set(meta.pageName, i);
      }
    }

    const runtimeServices = createRuntimeServices(this, callsiteStore);
    const services: PlatformServices = {
      ...hostServices,
      brain: {
        program: createProgramServices(program, pageMetadata),
        brainVars: runtimeServices.brainVars,
        ruleVars: createRuleVariableServices(program, ruleVariableStores),
        ruleFiring: createRuleFiringServices(ruleFiringStates),
        ruleCompletion: createRuleCompletionServices(ruleWatcherSlots, abandonedRuleFirings, (ruleFuncId: number) =>
          this.scheduler.hasLiveRuleSubtree(ruleFuncId)
        ),
        pages: runtimeServices.brainPages,
        callsite: callsiteStore,
      },
    };

    const emitter = this.emitter_;
    const observedVmEvents: VmEvents = {
      ...vmEvents,
      onRuleWhenGate: (payload) => {
        emitter.emit("rule_when_evaluated", payload);
        vmEvents?.onRuleWhenGate?.(payload);
      },
      onHostActionDispatch: (payload) => {
        emitter.emit("host_action_dispatched", payload);
        vmEvents?.onHostActionDispatch?.(payload);
      },
      onHostActionReturn: (payload) => {
        emitter.emit("host_action_returned", payload);
        vmEvents?.onHostActionReturn?.(payload);
      },
      onFiberWaiting: (payload) => {
        emitter.emit("fiber_waiting", payload);
        vmEvents?.onFiberWaiting?.(payload);
      },
      onHandleSettle: (payload) => {
        emitter.emit("handle_settled", payload);
        vmEvents?.onHandleSettle?.(payload);
      },
    };

    // Thread the per-fiber caps into the VM config; undefined entries fall back
    // to the VM defaults.
    this.vm = new VM(program, services.runtime, {
      events: observedVmEvents,
      maxStackSize: schedulerConfig?.maxStackSize,
      maxLocalsSize: schedulerConfig?.maxLocalsSize,
      maxFrameDepth: schedulerConfig?.maxFrameDepth,
      maxHandlers: schedulerConfig?.maxHandlers,
      maxHandles: schedulerConfig?.maxHandles,
    });
    this.schedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...schedulerConfig };
    this.scheduler = new FiberScheduler(this.vm, this.schedulerConfig);

    const runtime = this;
    this.executionContext = {
      services,
      getVariableBySlot(slotId: number): Value {
        return runtime.getVariableBySlot(slotId);
      },
      setVariableBySlot(slotId: number, value: Value): void {
        runtime.setVariableBySlot(slotId, value);
      },
      getSystemVarBySlot(slotId: number): Value {
        return runtime.getSystemVarBySlot(slotId);
      },
      setSystemVarBySlot(slotId: number, value: Value): void {
        runtime.setSystemVarBySlot(slotId, value);
      },
      time: 0,
      dt: 0,
      currentTick: 0,
      data: contextData,
    };
  }

  /**
   * Linked executable program loaded into the VM.
   */
  getProgram(): Program | undefined {
    return this.program;
  }

  /**
   * Per-page metadata for the loaded program.
   */
  getPages(): List<PageMetadata> {
    return this.pageMetadata;
  }

  /**
   * Event stream for brain lifecycle notifications.
   */
  events(): EventEmitterConsumer<BrainEvents> {
    return this.emitter_.consumer();
  }

  /**
   * Get a variable value by its name. The brain looks up the slot id assigned
   * to the name (either by the loaded program or lazily by a previous host
   * write) and returns the slot's current value. A variable of a type with a
   * starting value returns that value until something writes to it. Returns
   * `undefined` only when the name has no slot, or when its type declares no
   * starting value and nothing has written to it.
   *
   * @param varId - Variable name
   * @returns The variable's current value, or undefined per the rule above
   */
  getVariable<T extends Value>(varId: string): T | undefined {
    const slotId = this.varSlotByName.get(varId);
    if (slotId === undefined) return undefined;
    if (slotId >= this.variables.size()) return undefined;
    return this.variables.get(slotId) as T | undefined;
  }

  /**
   * Set a variable value by its name. If the name is not yet bound to a slot,
   * a new slot is allocated and `varSlotByName` is extended. Slots allocated
   * this way are not addressable from bytecode (no `LOAD_VAR_SLOT` operand can
   * target them) -- only host functions that use the name-keyed API can read
   * them back.
   *
   * @param varId - Variable name
   * @param value - The value to store
   */
  setVariable(varId: string, value: Value): void {
    const existingSlot = this.varSlotByName.get(varId);
    if (existingSlot !== undefined) {
      this.variables.set(existingSlot, value);
      return;
    }
    const newSlot = this.variables.size();
    this.variables.push(value);
    this.variableZeros.push(undefined);
    this.varSlotByName.set(varId, newSlot);
  }

  /**
   * Clear a variable by its name. Resets the underlying slot to its type's
   * starting value, or to holding no value when the type declares none; the
   * slot itself is retained so subsequent bytecode operands remain valid (a
   * slot holding no value reads as `NIL_VALUE`).
   *
   * @param varId - Variable name
   */
  clearVariable(varId: string): void {
    const slotId = this.varSlotByName.get(varId);
    if (slotId === undefined) return;
    if (slotId < this.variables.size()) {
      this.variables.set(slotId, this.zeroForSlot(slotId));
    }
  }

  /**
   * Reset every slot to its type's starting value, or to holding no value when
   * the type declares none, while preserving the program-derived slot layout
   * (slot ids and `varSlotByName` mappings remain stable).
   */
  clearVariables(): void {
    for (let i = 0; i < this.variables.size(); i++) {
      this.variables.set(i, this.zeroForSlot(i));
    }
  }

  /** Starting value of `slotId`, or `undefined` when its type declares none. */
  private zeroForSlot(slotId: number): Value | undefined {
    if (slotId < 0 || slotId >= this.variableZeros.size()) return undefined;
    return this.variableZeros.get(slotId);
  }

  /**
   * Read a variable by its compiler-assigned slot id. Returns the slot's
   * starting value until something writes to it, and `NIL_VALUE` when the slot
   * is out of range or its type declares no starting value. Called by the
   * VM dispatch loop on every `LOAD_VAR_SLOT`.
   */
  getVariableBySlot(slotId: number): Value {
    if (slotId < 0 || slotId >= this.variables.size()) return NIL_VALUE;
    const v = this.variables.get(slotId);
    return v === undefined ? NIL_VALUE : v;
  }

  /**
   * Write a variable by its compiler-assigned slot id. Called by the VM
   * dispatch loop on every `STORE_VAR_SLOT`. Out-of-range slot ids are
   * a compiler / linker bug; the VM enforces bounds against
   * `program.variableNames.size()` before calling this.
   */
  setVariableBySlot(slotId: number, value: Value): void {
    if (slotId < 0) return;
    while (this.variables.size() <= slotId) {
      this.variables.push(undefined);
    }
    this.variables.set(slotId, value);
  }

  /**
   * Read a System's state by its store slot. Returns `NIL_VALUE` if the slot is
   * out of range or has never been written. Called by the VM on `LOAD_SYSTEM_VAR`.
   */
  getSystemVarBySlot(slotId: number): Value {
    if (slotId < 0 || slotId >= this.systemStore.size()) return NIL_VALUE;
    const v = this.systemStore.get(slotId);
    return v === undefined ? NIL_VALUE : v;
  }

  /**
   * Write a System's state by its store slot. Grows the store lazily. Writes by
   * reference (no deep copy): a System's state struct mutates in place. Called
   * by the VM on `STORE_SYSTEM_VAR`.
   */
  setSystemVarBySlot(slotId: number, value: Value): void {
    if (slotId < 0) return;
    while (this.systemStore.size() <= slotId) {
      this.systemStore.push(undefined);
    }
    this.systemStore.set(slotId, value);
  }

  /**
   * Returns a snapshot of the current variable storage for carry-forward
   * across a re-initialization. The snapshot holds live references to the
   * current `variables` list and `varSlotByName` map; the caller consumes
   * it immediately to construct the next runtime and then drops the old
   * runtime.
   */
  snapshotVariables(): VariableSnapshot {
    return { values: this.variables, slotsByName: this.varSlotByName };
  }

  // -------------------------------------------------------------------------
  // Activation / deactivation hook drivers
  // -------------------------------------------------------------------------

  /**
   * Run the host-binding activation hook for a call site.
   */
  private runHostActivationHook(callSiteId: number, onPageEntered: (ctx: ExecutionContext) => void): void {
    const executionContext = this.executionContext;
    const previousCallSiteId = executionContext.currentCallSiteId;
    const previousRuleFuncId = executionContext.currentRuleFuncId;

    executionContext.currentCallSiteId = callSiteId;
    executionContext.currentRuleFuncId = undefined;

    try {
      onPageEntered(executionContext);
    } finally {
      executionContext.currentCallSiteId = previousCallSiteId;
      executionContext.currentRuleFuncId = previousRuleFuncId;
    }
  }

  /**
   * Run the host-binding initializer hook for a call site.
   */
  private runHostInitializerHook(callSiteId: number, onInitialized: (ctx: ExecutionContext) => void): void {
    const executionContext = this.executionContext;
    const previousCallSiteId = executionContext.currentCallSiteId;
    const previousRuleFuncId = executionContext.currentRuleFuncId;

    executionContext.currentCallSiteId = callSiteId;
    executionContext.currentRuleFuncId = undefined;

    try {
      onInitialized(executionContext);
    } finally {
      executionContext.currentCallSiteId = previousCallSiteId;
      executionContext.currentRuleFuncId = previousRuleFuncId;
    }
  }

  /**
   * Run the bytecode initializer hook for an action.
   */
  private runBytecodeInitializerHook(action: BytecodeExecutableAction, actionSlot: number, callSiteId: number): void {
    if (action.initializerFuncId === undefined) return;
    this.runBytecodeHook(action, actionSlot, callSiteId, action.initializerFuncId, "initialization");
  }

  /**
   * Run the bytecode activation hook for an action.
   */
  private runBytecodeActivationHook(action: BytecodeExecutableAction, actionSlot: number, callSiteId: number): void {
    if (action.activationFuncId === undefined) return;
    this.runBytecodeHook(action, actionSlot, callSiteId, action.activationFuncId, "activation");
  }

  /**
   * Run the bytecode deactivation hook for an action.
   */
  private runBytecodeDeactivationHook(action: BytecodeExecutableAction, actionSlot: number, callSiteId: number): void {
    if (action.deactivationFuncId === undefined) return;
    this.runBytecodeHook(action, actionSlot, callSiteId, action.deactivationFuncId, "deactivation");
  }

  /**
   * Run the host-binding deactivation hook for a call site.
   */
  private runHostDeactivationHook(callSiteId: number, onPageExited: (ctx: ExecutionContext) => void): void {
    const executionContext = this.executionContext;
    const previousCallSiteId = executionContext.currentCallSiteId;
    const previousRuleFuncId = executionContext.currentRuleFuncId;

    executionContext.currentCallSiteId = callSiteId;
    executionContext.currentRuleFuncId = undefined;

    try {
      onPageExited(executionContext);
    } finally {
      executionContext.currentCallSiteId = previousCallSiteId;
      executionContext.currentRuleFuncId = previousRuleFuncId;
    }
  }

  /**
   * Spawn a synchronous fiber for a hook function and run it to completion.
   * Throws a platform {@link Error} if the fiber faults or suspends.
   */
  private runBytecodeHook(
    action: BytecodeExecutableAction,
    actionSlot: number,
    callSiteId: number,
    funcId: number,
    label: string
  ): void {
    const executionContext = this.executionContext;
    const vm = this.vm;
    const scheduler = this.scheduler;

    const hookContext: ExecutionContext = {
      ...executionContext,
      currentCallSiteId: callSiteId,
      currentRuleFuncId: undefined,
    };
    const hookFiber = vm.spawnFiber(this.nextInlineFiberId--, funcId, List.empty(), hookContext);
    const hookFrame = hookFiber.frames.get(0)!;
    hookFrame.actionBinding = {
      actionSlot,
      actionKey: action.descriptor.key,
      callSiteId,
      isAsync: false,
    };
    hookFiber.instrBudget = this.schedulerConfig.hookBudget;

    const result = vm.runFiber(hookFiber, scheduler);
    if (result.status === VmStatus.FAULT) {
      throw new Error(`Page ${label} for action '${action.descriptor.key}' faulted: ${result.error.message}`);
    }
    if (result.status !== VmStatus.DONE) {
      throw new Error(`Page ${label} for action '${action.descriptor.key}' cannot suspend`);
    }
  }

  /**
   * Wire variable storage to `program`'s `variableNames` pool.
   * Allocates one slot per pool entry, builds a fresh name->slot map,
   * resolves each slot's starting value from `program.variableInitValues`,
   * and copies any previously-set values forward by name -- preserving values
   * for variables that exist in both the previous and the new program.
   * Variables present only in the previous program are dropped; variables
   * new to the program start at their type's starting value, or hold no value
   * when the type declares none.
   */
  private installVariableTable(program: Program, previousVariables?: VariableSnapshot): void {
    const previousValues = previousVariables?.values ?? List.empty<Value | undefined>();
    const previousSlots = previousVariables?.slotsByName ?? new Dict<string, number>();

    const programVariableNames = program.variableNames;
    const newSize = programVariableNames.size();
    const newValues = List.empty<Value | undefined>();
    const newZeros = List.empty<Value | undefined>();
    const newSlots = new Dict<string, number>();
    for (let i = 0; i < newSize; i++) {
      const name = programVariableNames.get(i)!;
      newSlots.set(name, i);
      const initIdx = variableInitAt(program, i);
      const zero = initIdx === NO_VARIABLE_INIT ? undefined : program.constantPools.values.get(initIdx);
      newZeros.push(zero);
      const oldSlot = previousSlots.get(name);
      if (oldSlot !== undefined && oldSlot < previousValues.size()) {
        newValues.push(previousValues.get(oldSlot));
      } else {
        newValues.push(zero);
      }
    }

    this.variables = newValues;
    this.variableZeros = newZeros;
    this.varSlotByName = newSlots;
  }

  // -------------------------------------------------------------------------
  // Page lifecycle FSM
  // -------------------------------------------------------------------------

  /** Enable or disable the brain's tick loop. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Returns `true` if the brain is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Pause execution until `clearInterrupt` is called. */
  interrupt(): void {
    this.interrupted = true;
  }

  /** Resume execution after a call to `interrupt`. */
  clearInterrupt(): void {
    this.interrupted = false;
  }

  /** Returns `true` if the brain has been interrupted and has not yet been cleared. */
  isInterrupted(): boolean {
    return this.interrupted;
  }

  /**
   * Request a page change by zero-based page index. If `pageIndex` equals the
   * current page, triggers a restart instead. An index outside the brain's
   * pages is a no-op: the current page stays active and no request is pending.
   */
  requestPageChange(pageIndex: number): void {
    if (pageIndex < 0 || pageIndex >= this.pageMetadata.size()) {
      return;
    }
    if (pageIndex === this.currentPageIndex) {
      this.requestPageRestart();
      return;
    }
    this.desiredPageIndex = pageIndex;
    this.cancelActiveFibers();
  }

  /**
   * Request a page change by stable page identifier (UUID), falling back to a
   * page-name lookup. A no-op when no page carries the identifier or the name.
   */
  requestPageChangeByPageId(pageId: string): void {
    const idx = this.pageIdToIndex.get(pageId);
    if (idx !== undefined) {
      this.requestPageChange(idx);
      return;
    }
    this.requestPageChangeByName(pageId);
  }

  /** Request a page change by page name. A no-op when no page carries the name. */
  requestPageChangeByName(name: string): void {
    const idx = this.pageNameToIndex.get(name);
    if (idx !== undefined) {
      this.requestPageChange(idx);
    }
  }

  /** Request that the current page restart at the next tick. */
  requestPageRestart(): void {
    this.restartPageRequested = true;
    this.cancelActiveFibers();
  }

  /** Returns the stable page identifier (UUID) of the current page, or `""` if none. */
  getCurrentPageId(): string {
    if (!this.isValidPageIndex(this.currentPageIndex)) return "";
    const meta = this.pageMetadata.get(this.currentPageIndex);
    return meta ? meta.pageId : "";
  }

  /** Returns the stable page identifier (UUID) of the most recently deactivated page. */
  getPreviousPageId(): string {
    if (!this.isValidPageIndex(this.previousPageIndex)) {
      return this.getCurrentPageId();
    }
    const meta = this.pageMetadata.get(this.previousPageIndex);
    return meta ? meta.pageId : this.getCurrentPageId();
  }

  /**
   * Begin execution. Activates the first page and resets all FSM state.
   * Must be called after construction and before `think`.
   */
  startup(): void {
    this.currentPageIndex = this.desiredPageIndex = 0;
    this.previousPageIndex = -1;
    this.restartPageRequested = false;
    this.lastThinkTime = 0;
    this.interrupted = false;

    this.runSystemInits();

    if (this.pageMetadata.size() > 0) {
      this.activatePage(0);
    }
  }

  /**
   * Halt execution. Runs deactivation hooks for the current page, cancels
   * all active fibers, and clears callsite and variable state.
   */
  shutdown(): void {
    this.deactivateCurrentPage();
    this.vm.shutdown();
    this.callsiteStore.clearAll();
    this.ruleVariableStores.clear();
    this.clearVariables();
  }

  /**
   * Advance the brain by one tick.
   *
   * @param currentTime - Monotonically increasing wall-clock time in seconds.
   */
  think(currentTime: number): void {
    if (!this.enabled || this.interrupted || !this.pageMetadata.size()) return;

    if (this.restartPageRequested) {
      this.restartPageRequested = false;
    }

    if (this.currentPageIndex !== this.desiredPageIndex) {
      this.deactivateCurrentPage();

      this.previousPageIndex = this.currentPageIndex;
      this.currentPageIndex = this.desiredPageIndex;

      if (this.isValidPageIndex(this.currentPageIndex)) {
        this.activatePage(this.currentPageIndex);
      }
    }

    if (this.isValidPageIndex(this.currentPageIndex)) {
      const dt = this.lastThinkTime === 0 ? 0 : currentTime - this.lastThinkTime;
      this.thinkPage(currentTime, dt);
    }

    this.lastThinkTime = currentTime;
  }

  /**
   * Activate a page by running its action hooks and spawning fibers for root rules.
   * Emits `page_activated` after fibers are spawned; the facade's event subscriber
   * calls `BrainPage.activate()` synchronously inside the emit.
   */
  private activatePage(pageIndex: number): void {
    const meta = this.pageMetadata.at(pageIndex);
    if (!meta) return;

    this.activeRuleFiberIds = List.empty();

    for (let i = 0; i < meta.actionCallSites.size(); i++) {
      const site = meta.actionCallSites.get(i)!;

      if (site.binding === "host") {
        const action = this.executionContext.services.runtime.actions.getById(site.actionId);
        if (!action || action.binding !== "host") {
          continue;
        }
        if (action.onInitialized) {
          const newlyAllocated = this.callsiteStore.ensure(site.callSiteId);
          if (newlyAllocated) {
            this.runHostInitializerHook(site.callSiteId, action.onInitialized);
          }
        }
        if (action.onPageEntered) {
          this.runHostActivationHook(site.callSiteId, action.onPageEntered);
        }
        continue;
      }

      const actions = this.program.actions;
      const action = actions ? actions.get(site.actionSlot) : undefined;
      if (!action) {
        continue;
      }
      if (action.initializerFuncId !== undefined) {
        const newlyAllocated = this.callsiteStore.ensure(site.callSiteId);
        if (newlyAllocated) {
          this.runBytecodeInitializerHook(action, site.actionSlot, site.callSiteId);
        }
      }
      if (action.activationFuncId !== undefined) {
        this.runBytecodeActivationHook(action, site.actionSlot, site.callSiteId);
      }
    }

    this.executionContext.currentCallSiteId = undefined;
    this.executionContext.currentRuleFuncId = undefined;

    for (let i = 0; i < meta.rootRuleFuncIds.size(); i++) {
      const funcId = meta.rootRuleFuncIds.get(i)!;
      const fiberId = this.scheduler.spawn(funcId, List.empty(), this.executionContext);
      this.activeRuleFiberIds.push({ funcId, fiberId });
    }

    this.emitter_.emit("page_activated", { pageIndex });
  }

  /**
   * Cancel all active fibers for the current page: every root-rule fiber and,
   * via the cascade, every child-rule fiber spawned beneath them.
   */
  private cancelActiveFibers(): void {
    for (let i = 0; i < this.activeRuleFiberIds.size(); i++) {
      const entry = this.activeRuleFiberIds.get(i)!;
      if (entry.fiberId !== undefined) {
        this.scheduler.cancel(entry.fiberId);
      }
    }
    this.scheduler.cancelChildRuleFibers();
  }

  /**
   * Deactivate the current page by running its actions' deactivation hooks
   * and then cancelling its fibers. Emits `page_deactivated` after hooks and
   * fiber-cancel; the facade's event subscriber calls `BrainPage.deactivate()`
   * synchronously inside the emit.
   */
  private deactivateCurrentPage(): void {
    this.runDeactivationHooksForCurrentPage();

    this.cancelActiveFibers();
    this.activeRuleFiberIds = List.empty();
    this.executionContext.currentCallSiteId = undefined;
    this.executionContext.currentRuleFuncId = undefined;

    if (this.isValidPageIndex(this.currentPageIndex)) {
      this.emitter_.emit("page_deactivated", { pageIndex: this.currentPageIndex });
    }
  }

  private runDeactivationHooksForCurrentPage(): void {
    if (!this.isValidPageIndex(this.currentPageIndex)) return;
    const meta = this.pageMetadata.at(this.currentPageIndex);
    if (!meta) return;

    for (let i = 0; i < meta.actionCallSites.size(); i++) {
      const site = meta.actionCallSites.get(i)!;

      if (site.binding === "host") {
        const action = this.executionContext.services.runtime.actions.getById(site.actionId);
        if (action && action.binding === "host" && action.onPageExited) {
          this.runHostDeactivationHook(site.callSiteId, action.onPageExited);
        }
        continue;
      }

      const actions = this.program.actions;
      const action = actions ? actions.get(site.actionSlot) : undefined;
      if (!action) continue;
      if (action.deactivationFuncId !== undefined) {
        this.runBytecodeDeactivationHook(action, site.actionSlot, site.callSiteId);
      }
    }
  }

  /**
   * Execute one frame of the current page's rules.
   */
  private thinkPage(currentTime: number, dt: number): void {
    this.executionContext.time = currentTime;
    this.executionContext.dt = dt;
    this.executionContext.currentTick += 1;

    for (let i = 0; i < this.activeRuleFiberIds.size(); i++) {
      const entry = this.activeRuleFiberIds.get(i)!;
      // A root rule re-fires only once it is dead and no descendant child-rule
      // fiber is still in flight (the rule quiesces while a child it spawned is
      // parked).
      const dead = this.shouldRespawnFiber(entry.fiberId);
      const heldByDescendant = dead && this.scheduler.hasLiveDescendantOfRoot(entry.funcId);

      if (heldByDescendant) {
        this.emitter_.emit("root_rule_quiesced", { ruleFuncId: entry.funcId });
        continue;
      }
      if (dead) {
        const newFiberId = this.scheduler.spawn(entry.funcId, List.empty(), this.executionContext);
        entry.fiberId = newFiberId;
      }
    }

    this.scheduler.tick();
    this.runSystemThinks();
    this.scheduler.gc();
  }

  /**
   * Run every registered System's `init` once, in registration order. State
   * persists for the brain instance lifetime; `init` runs before the first
   * page activation, rule, or `think`.
   */
  private runSystemInits(): void {
    const systems = this.program.systems;
    if (!systems) return;
    for (let i = 0; i < systems.size(); i++) {
      const initFuncId = systems.get(i)!.initFuncId;
      if (initFuncId !== undefined) {
        this.runSystemFunction(initFuncId, "init");
      }
    }
  }

  /**
   * Run every registered System's `think` once, in registration order. Runs
   * every think regardless of the active page; state persists across page
   * switches.
   */
  private runSystemThinks(): void {
    const systems = this.program.systems;
    if (!systems) return;
    for (let i = 0; i < systems.size(); i++) {
      const thinkFuncId = systems.get(i)!.thinkFuncId;
      if (thinkFuncId !== undefined) {
        this.runSystemFunction(thinkFuncId, "think");
      }
    }
  }

  /**
   * Spawn a synchronous fiber for a System lifecycle function and run it to
   * completion. The function receives the injected `ctx` as its sole argument.
   * Throws a platform {@link Error} if the fiber faults or suspends (a System
   * `init` / `think` may not await).
   */
  private runSystemFunction(funcId: number, label: string): void {
    const fiber = this.vm.spawnFiber(this.nextInlineFiberId--, funcId, List.empty(), this.executionContext);
    fiber.instrBudget = this.schedulerConfig.hookBudget;

    const result = this.vm.runFiber(fiber, this.scheduler);
    if (result.status === VmStatus.FAULT) {
      throw new Error(`System ${label} faulted: ${result.error.message}`);
    }
    if (result.status !== VmStatus.DONE) {
      throw new Error(`System ${label} cannot suspend`);
    }
  }

  /**
   * Check if a fiber needs to be respawned (completed, faulted, or cancelled).
   */
  private shouldRespawnFiber(fiberId: number | undefined): boolean {
    if (fiberId === undefined) return true;
    const fiber = this.scheduler.getFiber(fiberId);
    if (!fiber) return true;

    return fiber.state === FiberState.DONE || fiber.state === FiberState.FAULT || fiber.state === FiberState.CANCELLED;
  }

  private isValidPageIndex(pageIndex: number): boolean {
    return pageIndex >= 0 && pageIndex < this.pageMetadata.size();
  }
}

/**
 * Snapshot of a {@link BrainRuntime}'s variable storage. Carries forward
 * variable values across a re-initialization: the next runtime's
 * constructor receives this snapshot and keeps every value whose
 * variable name still exists in the new `program.variableNames`.
 *
 * Slots in `values` are indexed by the slot id assigned by the prior
 * program; `slotsByName` maps each variable name to its slot id in that
 * snapshot. Both sides are needed because slot ids are program-local
 * and not stable across recompiles.
 */
export interface VariableSnapshot {
  values: List<Value | undefined>;
  slotsByName: Dict<string, number>;
}
