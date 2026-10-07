import { Dict } from "../platform/dict";
import { Error } from "../platform/error";
import { EventEmitter } from "../platform/event-emitter";
import type { List, ReadonlyList } from "../platform/list";
import { Time } from "../platform/time";
import { UniqueSet } from "../platform/uniqueset";
import type { ExecutionContext } from "./context";
import type { ActionKey } from "./function-defs";
import { type AsyncHandle, ErrorCode, type ErrorValue, type HandleId, type StructValue, type Value } from "./value";

///////////////////////////
// Capacity-violation signaling
///////////////////////////

/**
 * Thrown by VM-side capacity checks (operand stack push, frame stack push,
 * handler stack push, handle table allocation, fiber pool allocation) when
 * a configured limit would be exceeded. Caught by the VM dispatch loop and
 * converted into an `ErrorCode.StackOverflow` fault on the offending fiber.
 *
 * Hosts that invoke `HandleTable.createPending` or
 * `FiberScheduler.spawn` / `addFiber` directly may receive this thrown
 * value; detect it with {@link isOverflowError}.
 */
export class OverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverflowError";
  }
}

/**
 * Thrown by VM-side underflow checks (operand stack `pop` / `peek` on an
 * empty stack). Caught by the VM dispatch loop and converted into an
 * `ErrorCode.StackUnderflow` fault on the offending fiber.
 */
export class UnderflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnderflowError";
  }
}

/**
 * Throw an {@link OverflowError}. Always surfaces as
 * `ErrorCode.StackOverflow` at the VM dispatch boundary.
 */
export function throwOverflow(message: string): never {
  throw new OverflowError(message);
}

/**
 * Throw an {@link UnderflowError}. Always surfaces as
 * `ErrorCode.StackUnderflow` at the VM dispatch boundary.
 */
export function throwUnderflow(message: string): never {
  throw new UnderflowError(message);
}

/** True if `e` is an {@link OverflowError}. */
export function isOverflowError(e: unknown): e is OverflowError {
  return e instanceof OverflowError;
}

/** True if `e` is an {@link UnderflowError}. */
export function isUnderflowError(e: unknown): e is UnderflowError {
  return e instanceof UnderflowError;
}

///////////////////////////
// Configuration & Limits
///////////////////////////

/** VM tunables: stack/frame/handle/fiber limits and per-tick instruction budget. */
export interface VmConfig {
  /** Maximum number of frames per fiber (recursion limit) */
  maxFrameDepth: number;
  /** Maximum operand stack size per fiber */
  maxStackSize: number;
  /** Maximum total locals across all live frames per fiber */
  maxLocalsSize: number;
  /** Maximum number of handlers per fiber */
  maxHandlers: number;
  /** Maximum number of pending handles */
  maxHandles: number;
  /** Default instruction budget per fiber execution */
  defaultBudget: number;
  /** Enable debug mode: validates stack depth after function calls, warns on potential leaks */
  debugStackChecks?: boolean;
}

///////////////////////////
// Host Function Interface
///////////////////////////

/**
 * Synchronous host function signature.
 *
 * `args` is a positional read-only view (`Sublist`) over the operand
 * stack, sized to the call's argument count. Read by `slotId` --
 * `args.at(getSlotId(callDef, ...))` -- not by name. A call the rule
 * compiler emits carries every slot of `callDef.argSlots`, with an
 * unsupplied slot holding `NIL_VALUE`; a call from other emitters may
 * carry fewer, so a slot past the end reads as `undefined` from `at()`
 * and `get()` faults on it. Treat both `undefined` and `NIL_VALUE` as
 * absent.
 *
 * **Lifetime:** the wrapper is ephemeral. Do not retain `args` past
 * the call. Read what you need into locals and return. Individual
 * `Value` heap objects read from `args` are safe to retain.
 *
 * @param ctx - Execution context providing access to variables, rule, etc.
 * @param args - Positional view of arguments, indexed by slotId.
 * @returns The result value to push onto the stack
 */
export type HostSyncFn = {
  onInitialized?: (ctx: ExecutionContext) => void;
  onPageEntered?: (ctx: ExecutionContext) => void;
  onPageExited?: (ctx: ExecutionContext) => void;
  exec: (ctx: ExecutionContext, args: ReadonlyList<Value>) => Value;
};

/**
 * Asynchronous host function signature.
 *
 * `args` is an owned positional snapshot (a freshly-allocated
 * `List<Value>`) sized to the call's argument count. Read by `slotId`
 * -- `args.at(getSlotId(callDef, ...))` -- not by name. A call the
 * rule compiler emits carries every slot of `callDef.argSlots`, with
 * an unsupplied slot holding `NIL_VALUE`; a call from other emitters
 * may carry fewer, so a slot past the end reads as `undefined` from
 * `at()` and `get()` faults on it. Treat both `undefined` and
 * `NIL_VALUE` as absent.
 *
 * **Lifetime:** the wrapper is owned. Free to retain `args` and `handle` and
 * close over individual values across the async boundary; settle the handle
 * via {@link AsyncHandle} whenever the async work completes.
 *
 * @param ctx - Execution context providing access to variables, rule, etc.
 * @param args - Positional snapshot of arguments, indexed by slotId.
 * @param handle - Bound settle handle for resolving the async operation
 */
export type HostAsyncFn = {
  onInitialized?: (ctx: ExecutionContext) => void;
  onPageEntered?: (ctx: ExecutionContext) => void;
  onPageExited?: (ctx: ExecutionContext) => void;
  exec: (ctx: ExecutionContext, args: ReadonlyList<Value>, handle: AsyncHandle) => void;
};

/**
 * Field getter function for native-backed struct types.
 * Called when reading a field whose `StructTypeDef` has a `fieldGetter` registered,
 * dispatched by the field's numeric `fieldId` (its `StructFieldDef.fieldIndex`).
 * The source is the StructValue; ctx provides the execution context for resolver-based natives.
 */
export type StructFieldGetterFn = (source: StructValue, fieldId: number, ctx: ExecutionContext) => Value | undefined;

/**
 * Field setter function for native-backed struct types.
 * Called when writing a field whose `StructTypeDef` has a `fieldSetter` registered,
 * dispatched by the field's numeric `fieldId` (its `StructFieldDef.fieldIndex`).
 * Returns true if the field was successfully set (false rejects the write, e.g. a read-only field).
 */
export type StructFieldSetterFn = (
  source: StructValue,
  fieldId: number,
  value: Value,
  ctx: ExecutionContext
) => boolean;

/**
 * Snapshot function for native-backed struct types.
 * Called during deep-copy (assignment) to materialize a lazy `native` handle.
 * Receives the source StructValue and the current ExecutionContext.
 * Returns the resolved native value to store in the copied struct.
 */
export type StructSnapshotNativeFn = (source: StructValue, ctx: ExecutionContext) => unknown;

/**
 * Existence hook for native-backed struct types.
 * Called by every truthiness test of a value whose `StructTypeDef` has `exists` registered.
 * Receives the source StructValue and the current ExecutionContext.
 * Returns false when the host object behind the value is gone, which makes the value falsy.
 * Read-only: it must not change host state, and its answer may differ between calls.
 */
export type StructExistsFn = (source: StructValue, ctx: ExecutionContext) => boolean;

/** Tagged-union of host function bindings: synchronous or asynchronous. */
export type HostFn = HostSyncFn | HostAsyncFn;

///////////////////////////
// VM Execution Results
///////////////////////////

/** Status of a single fiber-execution slice. */
export enum VmStatus {
  DONE = "DONE",
  YIELDED = "YIELDED",
  WAITING = "WAITING",
  FAULT = "FAULT",
}

/** Result of running a fiber: completed, voluntarily yielded, blocked on a handle, or faulted. */
export type VmRunResult =
  | { status: VmStatus.DONE; result?: Value }
  | { status: VmStatus.YIELDED }
  | { status: VmStatus.WAITING; handleId: HandleId }
  | { status: VmStatus.FAULT; error: ErrorValue };

///////////////////////////
// Fiber State Machine
///////////////////////////

/** Lifecycle states of a {@link Fiber}. */
export enum FiberState {
  RUNNABLE = "RUNNABLE",
  WAITING = "WAITING",
  DONE = "DONE",
  FAULT = "FAULT",
  CANCELLED = "CANCELLED",
}

/** Per-frame binding describing the action and call-site whose state slots back this frame. */
export interface ActionFrameBinding {
  /** Index of the bound action in `Program.actions`. */
  actionSlot: number;
  actionKey: string;
  callSiteId: number;
  isAsync: boolean;
}

/** Single call frame on a fiber's frame stack. */
export interface Frame {
  funcId: number;
  pc: number;
  base: number;
  locals: List<Value>;
  captures?: List<Value>;
  ruleFuncId?: number;
  actionBinding?: ActionFrameBinding;
}

/** Active try/catch handler installed by `TRY` and removed by `END_TRY`. */
export interface Handler {
  catchPc: number;
  stackHeight: number;
  frameDepth: number;
}

/** State recorded when a fiber blocks on a handle, used to resume execution. */
export interface AwaitSite {
  resumePc: number;
  stackHeight: number;
  frameDepth: number;
  handleId: HandleId;
}

/** A single VM execution thread: stacks, frames, handlers, and execution context. */
export interface Fiber {
  id: number;
  state: FiberState;
  vstack: List<Value>;
  frames: List<Frame>;
  handlers: List<Handler>;
  await?: AwaitSite;
  lastError?: ErrorValue;
  pendingInjectedThrow?: boolean;
  instrBudget: number;
  createdAt: number;
  lastRunAt: number;
  /**
   * Execution context for this fiber.
   * Provides access to the rule, variables, and other execution state.
   */
  executionContext: ExecutionContext;
  /**
   * Legacy direct state-slot seeding path for wrapper-oriented runtime/tests.
   * Core action dispatch binds state through action frames instead.
   */
  callsiteVars?: List<Value>;
  /**
   * The `HandleId` of the pending async-action result handle for a child fiber
   * spawned by `ACTION_CALL_ASYNC`. Set on spawn by `spawnBytecodeActionFiber`;
   * cleared by `resolveAsyncActionHandle`, `rejectAsyncActionHandle`, or
   * `cancelAsyncActionHandle`. Never holds an authoring-object reference.
   */
  asyncResultHandleId?: HandleId;
  /**
   * Function id of the root rule whose subtree this child-rule fiber belongs to,
   * set when spawned by `SPAWN_RULE`. `undefined` for root-rule, async-action
   * child, and hook fibers, so its presence marks a child-rule fiber.
   */
  rootRuleFuncId?: number;
  /**
   * Function id of the rule this fiber runs: its own rule for a root- or
   * child-rule fiber, the calling rule for an async-action child fiber, and
   * `undefined` for a fiber outside any rule. Set at spawn and retained through
   * the fiber's terminal transition, after its frames are gone.
   */
  ruleFuncId?: number;
  /**
   * Program counter of the async dispatch this fiber last parked on for want of
   * a free async handle, paired with {@link handleBackpressureRounds}. Absent
   * until the fiber first backpressures.
   */
  handleBackpressurePc?: number;
  /**
   * Consecutive rounds this fiber has re-executed the dispatch at
   * {@link handleBackpressurePc} without a free handle. Reset to zero by a
   * dispatch that allocates, and by a backpressure at a different pc. Reaching
   * {@link HANDLE_BACKPRESSURE_FAULT_ROUNDS} faults the fiber
   * `ErrorCode.StackOverflow`.
   */
  handleBackpressureRounds?: number;
}

/**
 * Consecutive rounds one fiber may re-execute the same async dispatch without a
 * free async handle before the runtime faults it `ErrorCode.StackOverflow`.
 * A dispatch that allocates clears the count.
 */
export const HANDLE_BACKPRESSURE_FAULT_ROUNDS = 8192;

///////////////////////////
// Async Handle Management
///////////////////////////

/** Lifecycle states of an async {@link Handle}. */
export enum HandleState {
  PENDING = "PENDING",
  RESOLVED = "RESOLVED",
  REJECTED = "REJECTED",
  CANCELLED = "CANCELLED",
}

/** Async operation handle: state, result/error, and the set of waiting fibers. */
export interface Handle {
  id: HandleId;
  state: HandleState;
  result?: Value;
  error?: ErrorValue;
  waiters: UniqueSet<number>;
  createdAt: number;
  /**
   * Key of the host action whose asynchronous dispatch created this handle.
   * Absent on a handle created by any other path.
   */
  actionKey?: ActionKey;
  /**
   * Whether this handle counts against the table's `maxHandles` cap. True for
   * a handle backing a device or host operation; false for a handle whose live
   * count the runtime already bounds by construction.
   */
  capped: boolean;
}

/** Events emitted by a {@link HandleTable}. */
export type HandleTableEvents = {
  /**
   * Emitted when a handle completes (resolved, rejected, or cancelled)
   */
  completed: HandleId;
};

/** Tracks pending async operations: creates handles, resolves/rejects/cancels them, and notifies waiters. */
export class HandleTable {
  private nextId = 1;
  private handles = new Dict<HandleId, Handle>();
  private cappedCount = 0;
  private eventEmitter = new EventEmitter<HandleTableEvents>();
  public readonly events = this.eventEmitter.consumer();

  constructor(public readonly maxHandles: number) {}

  /**
   * True when a {@link createPending} of a capped handle would succeed right
   * now: the live capped-handle count is below {@link maxHandles}. Uncapped
   * handles are excluded from the count and always allocate. Non-mutating; an
   * async dispatch checks it to decide whether to allocate or to park and retry
   * next round.
   */
  hasCapacity(): boolean {
    return this.cappedCount < this.maxHandles;
  }

  /** Count of live handles that count against {@link maxHandles}. */
  cappedSize(): number {
    return this.cappedCount;
  }

  /**
   * Allocate a pending handle. Pass `actionKey` when the handle backs an
   * asynchronous host-action call, so its settle can name the action. Pass
   * `capped` false to keep the handle out of the {@link maxHandles} accounting;
   * a capped allocation past the cap throws an overflow.
   */
  createPending(actionKey?: ActionKey, capped = true): HandleId {
    if (capped && this.cappedCount >= this.maxHandles) {
      throwOverflow(`Handle limit exceeded: ${this.maxHandles}`);
    }

    const id = this.nextId++;
    this.handles.set(id, {
      id,
      state: HandleState.PENDING,
      waiters: new UniqueSet<number>(),
      createdAt: Time.nowMs(),
      actionKey,
      capped,
    });
    if (capped) {
      this.cappedCount++;
    }
    return id;
  }

  get(id: HandleId): Handle | undefined {
    return this.handles.get(id);
  }

  getOrThrow(id: HandleId): Handle {
    const h = this.get(id);
    if (!h) throw new Error(`Unknown handle ${id}`);
    return h;
  }

  has(id: HandleId): boolean {
    return this.handles.has(id);
  }

  resolve(id: HandleId, result: Value): void {
    const h = this.getOrThrow(id);
    if (h.state !== HandleState.PENDING) {
      throw new Error(`Cannot resolve handle ${id} in state ${h.state}`);
    }
    h.state = HandleState.RESOLVED;
    h.result = result;
    this.eventEmitter.emit("completed", id);
  }

  reject(id: HandleId, err: ErrorValue): void {
    const h = this.getOrThrow(id);
    if (h.state !== HandleState.PENDING) {
      throw new Error(`Cannot reject handle ${id} in state ${h.state}`);
    }
    h.state = HandleState.REJECTED;
    h.error = err;
    this.eventEmitter.emit("completed", id);
  }

  cancel(id: HandleId, message = "Cancelled"): void {
    const h = this.getOrThrow(id);
    if (h.state !== HandleState.PENDING) {
      throw new Error(`Cannot cancel handle ${id} in state ${h.state}`);
    }
    h.state = HandleState.CANCELLED;
    h.error = { code: ErrorCode.Cancelled, message };
    this.eventEmitter.emit("completed", id);
  }

  delete(id: HandleId): void {
    const h = this.handles.get(id);
    if (!h) return;
    if (h.capped) {
      this.cappedCount--;
    }
    this.handles.delete(id);
  }

  clear(): void {
    this.handles.clear();
    this.cappedCount = 0;
  }

  gc(): number {
    let removed = 0;
    for (const [id, h] of this.handles.entries().toArray()) {
      if (h.state !== HandleState.PENDING && h.waiters.size() === 0) {
        if (h.capped) {
          this.cappedCount--;
        }
        this.handles.delete(id);
        removed++;
      }
    }
    return removed;
  }

  size(): number {
    return this.handles.size();
  }
}

///////////////////////////
// Scheduler Interface
///////////////////////////

/** Minimal scheduler hooks the VM uses to enqueue, complete, and look up fibers. */
export interface Scheduler {
  /**
   * Called by the VM when an async-result handle transitions to a terminal state
   * (resolved, rejected, or cancelled). The scheduler resumes any fiber awaiting
   * this handle. The parameter is a `HandleId` only; no authoring-object reference.
   */
  onHandleCompleted: (handleId: HandleId) => void;
  /**
   * Marks a fiber as ready to run. The parameter is a fiber id only; the
   * scheduler looks up the `Fiber` struct by id when it needs the full record.
   */
  enqueueRunnable: (fiberId: number) => void;
  /**
   * Looks up a live fiber by its numeric id. Returns `undefined` when the fiber
   * has been removed from the scheduler (done, cancelled, or gc'd).
   */
  getFiber: (fiberId: number) => Fiber | undefined;
  /**
   * Registers a newly-constructed child `Fiber` runtime struct with the scheduler.
   * The argument is the VM-owned `Fiber` record, not an authoring object.
   * Present only on schedulers that support child-fiber spawning
   * (`ACTION_CALL_ASYNC` bytecode branch).
   */
  addFiber?: (fiber: Fiber) => void;
  /**
   * Spawns a fire-and-forget child-rule fiber for `funcId`, tagged with
   * `subtreeRootFuncId` (its root rule), and enqueued for the next round.
   * Present only on schedulers that support child-rule spawning (`SPAWN_RULE`).
   */
  spawnChildRule?: (funcId: number, subtreeRootFuncId: number, executionContext: ExecutionContext) => void;
}

///////////////////////////
// VM Interface
///////////////////////////

/**
 * Interface for the VM implementation
 *
 * Defines the public API for the bytecode virtual machine that executes
 * compiled programs with fiber-based concurrency and async operations.
 */
export interface IVM {
  /**
   * Handle table for managing async operations
   */
  readonly handles: HandleTable;

  /**
   * Spawn a new fiber with the given function ID and arguments
   * @param fiberId - Unique identifier for the fiber
   * @param funcId - Function ID to execute
   * @param args - Arguments to pass to the function
   * @param executionContext - Execution context for this fiber
   * @returns The newly spawned fiber
   */
  spawnFiber(fiberId: number, funcId: number, args: List<Value>, executionContext: ExecutionContext): Fiber;

  /**
   * Run a fiber until it yields, waits, completes, or faults
   * @param fiber - The fiber to run
   * @param scheduler - Scheduler for managing fiber lifecycle events
   * @returns Result of the execution
   */
  runFiber(fiber: Fiber, scheduler: Scheduler): VmRunResult;

  /**
   * Resume a fiber that was waiting on an async handle
   * @param fiber - The fiber to resume
   * @param handleId - Handle that completed
   * @param scheduler - Scheduler for managing fiber lifecycle events
   */
  resumeFiberFromHandle(fiber: Fiber, handleId: HandleId, scheduler: Scheduler): void;

  /**
   * Cancel a running or waiting fiber
   * @param fiber - The fiber to cancel
   * @param scheduler - Scheduler for managing fiber lifecycle events
   */
  cancelFiber(fiber: Fiber, scheduler: Scheduler): void;
}

///////////////////////////
// Fiber Scheduler Interface
///////////////////////////

/** Counters returned by {@link IFiberScheduler.getStats}. */
export interface FiberSchedulerStats {
  totalFibers: number;
  runnableFibers: number;
  waitingFibers: number;
  doneFibers: number;
  faultedFibers: number;
  cancelledFibers: number;
  pendingHandles: number;
}

/**
 * Interface for the fiber scheduler implementation
 *
 * Manages fiber execution, queuing, and lifecycle. The scheduler
 * coordinates between the VM and fibers, handling execution budgets
 * and cooperative multitasking.
 */
export interface IFiberScheduler extends Scheduler {
  /**
   * Spawn a new fiber to execute the specified function
   * @param funcId - Function ID to execute
   * @param args - Arguments to pass to the function
   * @param executionContext - Execution context for this fiber
   * @returns The newly created fiber ID
   */
  spawn(funcId: number, args: List<Value>, executionContext: ExecutionContext): number;

  /**
   * Add an existing fiber to the scheduler
   * @param fiber - Fiber to add
   */
  addFiber: (fiber: Fiber) => void;

  /**
   * Spawn a fire-and-forget child-rule fiber for `funcId`, tagged with its root
   * rule, and enqueued for the next round.
   * @param funcId - Rule entry function to run
   * @param subtreeRootFuncId - Funcid of the root rule whose subtree it belongs to
   * @param executionContext - Execution context for the child fiber
   */
  spawnChildRule: (funcId: number, subtreeRootFuncId: number, executionContext: ExecutionContext) => void;

  /**
   * Remove a fiber from the scheduler
   * @param fiberId - ID of fiber to remove
   */
  removeFiber(fiberId: number): void;

  /**
   * Cancel a fiber's execution
   * @param fiberId - ID of fiber to cancel
   */
  cancel(fiberId: number): void;

  /**
   * Cancel every live child-rule fiber (those spawned via `SPAWN_RULE`). Used
   * by the page-scoped cancellation cascade when the active page deactivates,
   * restarts, or is switched away; exactly one page is active, so every live
   * child-rule fiber belongs to it. Root-rule, async-action child, and hook
   * fibers are left untouched.
   */
  cancelChildRuleFibers(): void;

  /**
   * Returns true when a live (runnable or waiting) child-rule fiber belongs to
   * the subtree of the root rule `rootRuleFuncId`. Used to hold a root rule's
   * re-fire while any of its descendant child rules is still in flight.
   */
  hasLiveDescendantOfRoot(rootRuleFuncId: number): boolean;

  /**
   * Returns true when any live (runnable or waiting) fiber belongs to
   * `ruleFuncId`'s cluster: a fiber whose own rule is `ruleFuncId` or descends
   * from it through the program's rule-ancestor chain.
   */
  hasLiveRuleSubtree(ruleFuncId: number): boolean;

  /**
   * Execute one scheduler tick: every fiber runnable at tick entry gets
   * exactly one budget slice; fibers enqueued during the tick run in the
   * next tick.
   * @returns Number of fibers executed in this tick
   */
  tick(): number;

  /**
   * Get statistics about current scheduler state
   * @returns Statistics object
   */
  getStats(): FiberSchedulerStats;

  /**
   * Garbage collect completed/faulted/cancelled fibers
   * @returns Number of fibers removed
   */
  gc(): number;
}
