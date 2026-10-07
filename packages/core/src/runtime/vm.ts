import { Dict } from "../platform/dict";
import { Error } from "../platform/error";
import { List, type ReadonlyList } from "../platform/list";
import { logger } from "../platform/logger";
import { MathOps } from "../platform/math";
import { StringUtils as SU } from "../platform/string";
import { Time } from "../platform/time";
import { UniqueSet } from "../platform/uniqueset";
import type { FunctionBytecode, Instr } from "./bytecode";
import { Op } from "./bytecode";
import type { BytecodeExecutableAction, ExecutionContext, HostActionBinding } from "./context";
import type { VmEvents } from "./events";
import { HandleOutcome } from "./events";
import type { Program, ProgramStructField } from "./program";
import { resolveProgramTypeId } from "./program";
import { RuleFiringState } from "./rule-services";
import type { BrainInstanceServices, RuntimeLangServices } from "./services";
import type { ITypeRegistry } from "./type-defs";
import { NativeType, type StructTypeDef, type TypeId } from "./type-defs";
import type { AsyncHandle, ErrorValue, HandleId, StructValue, Value } from "./value";
import {
  ErrorCode,
  FALSE_VALUE,
  isBooleanValue,
  isEnumValue,
  isErrValue,
  isFunctionValue,
  isHandleValue,
  isListValue,
  isMapValue,
  isNumberValue,
  isStringValue,
  isStructValue,
  mkNativeStructValue,
  NIL_VALUE,
  TRUE_VALUE,
  UNKNOWN_VALUE,
  ValueDict,
  VOID_VALUE,
} from "./value";
import {
  type Fiber,
  FiberState,
  type Frame,
  HANDLE_BACKPRESSURE_FAULT_ROUNDS,
  type Handler,
  HandleState,
  HandleTable,
  type IFiberScheduler,
  type IVM,
  isOverflowError,
  isUnderflowError,
  type Scheduler,
  throwOverflow,
  throwUnderflow,
  type VmConfig,
  type VmRunResult,
  VmStatus,
} from "./vm-types";

/** Construction options for the VM. All fields are optional. */
export interface VmOptions extends Partial<VmConfig> {
  /** Passive observer for VM runtime lifecycle events. */
  events?: VmEvents;
  /** Pre-populated handle table to inject. When omitted, the VM creates its own. */
  handles?: HandleTable;
}

/**
 * Stack-based bytecode VM
 *
 * Features:
 * - Fibers (lightweight coroutines with isolated stack state)
 * - Async operations via handles with AWAIT suspension/resumption
 * - Structured exception handling (TRY/THROW/FAULT)
 * - Budgeted execution for fairness and DoS protection
 * - Comprehensive bounds checking and validation
 * - Proper lifecycle management and resource cleanup
 * - Slot-indexed variable access via LOAD_VAR_SLOT/STORE_VAR_SLOT
 *
 * Threading Model:
 * - Single-threaded execution per VM instance
 * - No reentrancy: host operations must not call VM methods synchronously
 * - Host completion callbacks enqueue work; scheduler drives execution
 *
 * Safety Guarantees:
 * - All memory accesses are bounds-checked
 * - Stack overflow/underflow detection
 * - Bytecode verification before execution
 * - Configurable resource limits (memory, stack depth, frame depth)
 * - Type-safe value operations
 *
 * Variable Access:
 * - Variables are addressed by compiler-assigned slot ids
 * - Slot ids are operands to LOAD_VAR_SLOT/STORE_VAR_SLOT and index into the
 *   loaded program's variableNames pool
 * - The dispatch loop calls ctx.getVariableBySlot/setVariableBySlot directly
 * - Host functions still address variables by name via ctx.services.brainVars/ruleVars
 *
 * Invariants:
 * - vstack contains only operand stack (variables managed by ExecutionContext)
 * - handlers reference valid frame indices and stack heights
 * - await sites are cleared during exception unwinding
 * - fiber state transitions follow valid state machine
 * - variable resolution chain maintains consistent scoping semantics
 */

///////////////////////////
// Configuration & Limits
///////////////////////////

/** Default tunable values used when no {@link VmConfig} is supplied. */
export const DEFAULT_VM_CONFIG: VmConfig = {
  maxFrameDepth: 256,
  maxStackSize: 4096,
  // Large default (matches maxStackSize); device profiles override it.
  maxLocalsSize: 4096,
  maxHandlers: 64,
  maxHandles: 100000,
  defaultBudget: 1000,
};

///////////////////////////
// Value Model
///////////////////////////

// Short-hand value factory using pooled singletons (TRUE_VALUE, FALSE_VALUE, NIL_VALUE, etc.)
// to avoid allocating new objects on every instruction.
const V = {
  unknown(): Value {
    return UNKNOWN_VALUE;
  },
  void(): Value {
    return VOID_VALUE;
  },
  nil(): Value {
    return NIL_VALUE;
  },
  bool(v: boolean): Value {
    return v ? TRUE_VALUE : FALSE_VALUE;
  },
  num(v: number): Value {
    return { t: NativeType.Number, v };
  },
  str(v: string): Value {
    return { t: NativeType.String, v };
  },
  enum(key: string, typeId: TypeId): Value {
    return { t: NativeType.Enum, typeId, v: key };
  },
  list(items: List<Value>, typeId: TypeId): Value {
    return { t: NativeType.List, typeId, v: items };
  },
  map(entries: ValueDict, typeId: TypeId): Value {
    return { t: NativeType.Map, typeId, v: entries };
  },
  struct(fields: List<Value>, typeId: TypeId): Value {
    return { t: NativeType.Struct, typeId, v: fields };
  },
  func(funcId: number, captures?: List<Value>): Value {
    if (captures !== undefined) {
      return { t: NativeType.Function, funcId, captures };
    }
    return { t: NativeType.Function, funcId };
  },
  handle(id: HandleId): Value {
    return { t: "handle", id };
  },
  err(e: ErrorValue): Value {
    return { t: "err", e };
  },
};

/**
 * Deep-copy a Value for assignment semantics.
 * Primitives (boolean, number, string, enum, nil, void, unknown) are immutable and returned as-is.
 * Struct values are recursively deep-copied: a new StructValue is created with a cloned field list.
 * For native structs, if a `snapshotNative` hook is registered on the type, it is called to
 * materialize the native handle (e.g., resolve a lazy resolver to a concrete value).
 * Otherwise the native handle is copied by reference.
 * A `visited` list prevents infinite loops from circular references.
 */
function deepCopyValue(v: Value, types: ITypeRegistry, ctx: ExecutionContext, visited?: List<Value>): Value {
  if (!isStructValue(v)) {
    // Primitives, enums, nil, void, unknown, handles, errors, functions -- all immutable or VM-internal
    return v;
  }

  // Guard against circular references (linear scan; nesting depth is expected to be very shallow)
  if (!visited) {
    visited = List.empty<Value>();
  }
  for (let i = 0; i < visited.size(); i++) {
    if (visited.get(i) === v) {
      // Circular reference detected -- return the original to avoid infinite recursion.
      return v;
    }
  }
  visited.push(v);

  // Deep-copy the field list.
  const oldFields = v.v;
  const newFields = List.empty<Value>();
  if (oldFields && oldFields.size() > 0) {
    for (let i = 0; i < oldFields.size(); i++) {
      newFields.push(deepCopyValue(oldFields.get(i), types, ctx, visited));
    }
  }

  // Snapshot the native handle if the type has a snapshotNative hook
  let nativeHandle = v.native;
  if (nativeHandle !== undefined) {
    const typeDef = types.get(v.typeId) as StructTypeDef | undefined;
    if (typeDef?.snapshotNative) {
      nativeHandle = typeDef.snapshotNative(v, ctx);
    }
  }

  return { t: NativeType.Struct, typeId: v.typeId, v: newFields, native: nativeHandle };
}

/**
 * Truthiness of a value, as every conditional branch and truthiness-gated WHEN tests it.
 * Unknown, void, nil, `false`, zero, the empty string, empty collections and buffers, and
 * error values are falsy. A struct is truthy unless its type registers an `exists` hook and
 * the hook reports the value's host object gone; the hook is called on every test.
 */
function isTruthy(v: Value, types: ITypeRegistry, ctx: ExecutionContext): boolean {
  switch (v.t) {
    case NativeType.Unknown:
    case NativeType.Void:
    case NativeType.Nil:
      return false;
    case NativeType.Boolean:
      return v.v;
    case NativeType.Number:
      return v.v !== 0;
    case NativeType.String:
      return SU.length(v.v) > 0;
    case NativeType.Enum:
      return true;
    case NativeType.List:
      return v.v.size() > 0;
    case NativeType.Map:
      return v.v.size() > 0;
    case NativeType.Struct: {
      const exists = (types.get(v.typeId) as StructTypeDef | undefined)?.exists;
      return exists === undefined || exists(v, ctx);
    }
    case NativeType.Function:
      return true;
    case NativeType.Buffer:
      return v.v.length() > 0;
    case "handle":
      return true;
    case "err":
      return false;
  }
}

///////////////////////////
// Fiber State Machine
///////////////////////////

const VALID_TRANSITIONS: Record<FiberState, UniqueSet<FiberState>> = {
  [FiberState.RUNNABLE]: new UniqueSet([FiberState.WAITING, FiberState.DONE, FiberState.FAULT, FiberState.CANCELLED]),
  [FiberState.WAITING]: new UniqueSet([FiberState.RUNNABLE, FiberState.CANCELLED, FiberState.FAULT]),
  [FiberState.DONE]: new UniqueSet([]),
  [FiberState.FAULT]: new UniqueSet([]),
  [FiberState.CANCELLED]: new UniqueSet([]),
};

///////////////////////////
// VM Core
///////////////////////////

/**
 * Concrete bytecode {@link IVM} implementation: spawns and runs fibers against a compiled {@link Program}.
 *
 * The VM trusts the bytecode it receives. The compiler is the sole guarantor
 * of validity; there is no static verification layer. Malformed bytecode
 * surfaces as a `ScriptError` fault on the offending fiber, never as a
 * platform-level throw escaping `runFiber`.
 */
export class VM implements IVM {
  private config: VmConfig;
  private runtime: RuntimeLangServices;
  private events?: VmEvents;
  private nextInternalFiberId = -1;
  public handles: HandleTable;

  constructor(
    private prog: Program,
    services: RuntimeLangServices,
    options?: VmOptions
  ) {
    this.runtime = services;
    const events = options?.events;
    const injectedHandles = options?.handles;
    const configOverrides: Partial<VmConfig> = {};
    if (options?.maxFrameDepth !== undefined) configOverrides.maxFrameDepth = options.maxFrameDepth;
    if (options?.maxStackSize !== undefined) configOverrides.maxStackSize = options.maxStackSize;
    if (options?.maxLocalsSize !== undefined) configOverrides.maxLocalsSize = options.maxLocalsSize;
    if (options?.maxHandlers !== undefined) configOverrides.maxHandlers = options.maxHandlers;
    if (options?.maxHandles !== undefined) configOverrides.maxHandles = options.maxHandles;
    if (options?.defaultBudget !== undefined) configOverrides.defaultBudget = options.defaultBudget;
    if (options?.debugStackChecks !== undefined) configOverrides.debugStackChecks = options.debugStackChecks;
    this.config = { ...DEFAULT_VM_CONFIG, ...configOverrides };
    this.handles = injectedHandles ?? new HandleTable(this.config.maxHandles);
    this.events = events;

    this.handles.events.on("completed", (handleId) => {
      this.reportHandleSettle(handleId);
    });
  }

  /**
   * Report one settled handle to {@link VmEvents.onHandleSettle}. Only handles
   * created by an asynchronous host-action dispatch carry an action key, so
   * every reported settle joins a dispatch report.
   */
  private reportHandleSettle(handleId: HandleId): void {
    const listener = this.events?.onHandleSettle;
    if (!listener) return;
    const handle = this.handles.get(handleId);
    if (!handle || handle.actionKey === undefined) return;
    if (handle.state === HandleState.PENDING) return;
    const outcome =
      handle.state === HandleState.RESOLVED
        ? HandleOutcome.RESOLVED
        : handle.state === HandleState.REJECTED
          ? HandleOutcome.REJECTED
          : HandleOutcome.CANCELLED;
    listener({ handleId, outcome, actionKey: handle.actionKey });
  }

  /**
   * Release VM-owned transient runtime state.
   * Safe to call more than once.
   */
  shutdown(): void {
    this.handles.clear();
  }

  spawnFiber(fiberId: number, funcId: number, args: List<Value>, executionContext: ExecutionContext): Fiber {
    if (funcId < 0 || funcId >= this.prog.functions.size()) {
      throw new Error(`Invalid function ID: ${funcId}`);
    }

    const fn = this.prog.functions.get(funcId)!;
    const effectiveArgs = this.prepareArgsForFunction(fn, args, executionContext, fn.name ?? `func[${funcId}]`);

    const vstack = List.empty<Value>();
    const base = 0;

    // Root frame: the entry function's locals alone must fit the cap.
    const rootNumLocals = fn.numLocals ?? fn.numParams;
    if (rootNumLocals > this.config.maxLocalsSize) {
      throwOverflow(`Stack overflow: locals limit ${SU.toString(this.config.maxLocalsSize)} exceeded`);
    }
    const locals = this.allocLocals(fn, effectiveArgs);
    const ruleFuncId = this.resolveDirectRuleFuncId(executionContext, funcId);
    if (ruleFuncId !== undefined) {
      // Entering a rule at its own entry point starts that rule's next firing,
      // so any abandonment mark left by the previous one stops applying here.
      executionContext.services.brain.ruleCompletion.clearAbandoned(ruleFuncId);
    }

    const now = Time.nowMs();
    const fiber: Fiber = {
      id: fiberId,
      state: FiberState.RUNNABLE,
      vstack,
      frames: List.from([
        {
          funcId,
          pc: 0,
          base,
          locals,
          ruleFuncId,
        },
      ]),
      handlers: List.empty<Handler>(),
      instrBudget: 0,
      createdAt: now,
      lastRunAt: now,
      executionContext,
      ruleFuncId,
    };

    return fiber;
  }

  runFiber(fiber: Fiber, scheduler: Scheduler): VmRunResult {
    if (fiber.state !== FiberState.RUNNABLE) {
      throw new Error(`Cannot run fiber ${fiber.id} in state ${fiber.state}`);
    }
    if (fiber.instrBudget <= 0) {
      throw new Error(`Cannot run fiber ${fiber.id} with non-positive budget ${fiber.instrBudget}`);
    }

    fiber.lastRunAt = Time.nowMs();
    this.syncExecutionContextFromTopFrame(fiber);

    while (fiber.instrBudget > 0) {
      // If the fiber was cancelled mid-execution (e.g., by a HOST_CALL that
      // triggered a page change), stop immediately.
      if (fiber.state !== FiberState.RUNNABLE) {
        return { status: VmStatus.DONE };
      }

      fiber.instrBudget--;

      if (fiber.pendingInjectedThrow) {
        fiber.pendingInjectedThrow = false;
        const err = fiber.lastError ?? this.makeError(ErrorCode.ScriptError, "Unknown error");
        const caught = this.throwValue(fiber, err);
        if (!caught) {
          this.transitionState(fiber, FiberState.FAULT);
          this.rejectAsyncActionHandle(fiber, err);
          this.events?.onFiberFault?.({ fiberId: fiber.id, err });
          return { status: VmStatus.FAULT, error: err };
        }
        continue;
      }

      const frame = this.topFrame(fiber);
      if (!frame) {
        const err = this.makeError(ErrorCode.ScriptError, "No frame on stack");
        this.faultFiber(fiber, err, scheduler);
        return { status: VmStatus.FAULT, error: err };
      }

      const fn = this.prog.functions.get(frame.funcId)!;
      if (frame.pc < 0 || frame.pc >= fn.code.size()) {
        const err = this.makeError(
          ErrorCode.ScriptError,
          `PC out of bounds: ${frame.pc} not in [0, ${fn.code.size()})`,
          {
            site: { funcId: frame.funcId, pc: frame.pc },
          }
        );
        this.faultFiber(fiber, err, scheduler);
        return { status: VmStatus.FAULT, error: err };
      }

      const ins = fn.code.get(frame.pc)!;
      const result = this.executeInstruction(fiber, ins, frame, fn, scheduler);
      if (result) return result;
    }

    return { status: VmStatus.YIELDED };
  }

  private executeInstruction(
    fiber: Fiber,
    ins: Instr,
    frame: Frame,
    fn: FunctionBytecode,
    scheduler: Scheduler
  ): VmRunResult | undefined {
    try {
      switch (ins.op) {
        case Op.PUSH_CONST_VAL:
          return this.execPushConst(fiber, ins, frame);
        case Op.PUSH_CONST_NUM:
          return this.execPushConstNum(fiber, ins, frame);
        case Op.PUSH_CONST_STR:
          return this.execPushConstStr(fiber, ins, frame);
        case Op.POP:
          return this.execPop(fiber, frame);
        case Op.DUP:
          return this.execDup(fiber, frame);
        case Op.SWAP:
          return this.execSwap(fiber, frame);
        case Op.LOAD_VAR_SLOT:
          return this.execLoadVar(fiber, ins, frame);
        case Op.STORE_VAR_SLOT:
          return this.execStoreVar(fiber, ins, frame);
        case Op.LOAD_SYSTEM_VAR:
          return this.execLoadSystemVar(fiber, ins, frame);
        case Op.STORE_SYSTEM_VAR:
          return this.execStoreSystemVar(fiber, ins, frame);
        case Op.JMP:
          return this.execJmp(fiber, ins, frame);
        case Op.JMP_IF_FALSE:
          return this.execJmpIfFalse(fiber, ins, frame);
        case Op.JMP_IF_TRUE:
          return this.execJmpIfTrue(fiber, ins, frame);
        case Op.CALL:
          return this.execCall(fiber, ins, frame);
        case Op.RET:
          return this.execRet(fiber, scheduler);
        case Op.SPAWN_RULE:
          return this.execSpawnRule(fiber, ins, frame, scheduler);
        case Op.HOST_CALL:
          return this.execHostCall(fiber, ins, frame);
        case Op.HOST_CALL_ASYNC:
          return this.execHostCallAsync(fiber, ins, frame, scheduler);
        case Op.ACTION_CALL:
          return this.execActionCall(fiber, ins, frame);
        case Op.ACTION_CALL_ASYNC:
          return this.execActionCallAsync(fiber, ins, frame, scheduler);
        case Op.HOST_ACTION_CALL:
          return this.execHostActionCall(fiber, ins, frame);
        case Op.HOST_ACTION_CALL_ASYNC:
          return this.execHostActionCallAsync(fiber, ins, frame);
        case Op.STACK_SET_REL:
          return this.execStackSetRel(fiber, ins, frame);
        case Op.AWAIT:
          return this.execAwait(fiber, frame, scheduler);
        case Op.YIELD:
          this.assertCanSuspend(fiber, Op.YIELD);
          frame.pc++;
          return { status: VmStatus.YIELDED };
        case Op.TRY:
          return this.execTry(fiber, ins, frame);
        case Op.END_TRY:
          return this.execEndTry(fiber, frame);
        case Op.THROW:
          return this.execThrow(fiber, frame, scheduler);
        case Op.WHEN_START:
          return this.execWhenStart(fiber, ins, frame);
        case Op.WHEN_END:
          return this.execWhenEnd(fiber, ins, frame);
        case Op.WHEN_END_PRESENT:
          return this.execWhenEndPresent(fiber, ins, frame);
        case Op.WHEN_END_CHAIN:
          return this.execWhenEndChain(fiber, ins, frame);
        case Op.WHEN_END_PRESENT_CHAIN:
          return this.execWhenEndPresentChain(fiber, ins, frame);
        case Op.DO_START:
          return this.execDoStart(fiber, ins, frame);
        case Op.DO_END:
          return this.execDoEnd(fiber, frame);
        case Op.LIST_NEW:
          return this.execListNew(fiber, ins, frame);
        case Op.LIST_PUSH:
          return this.execListPush(fiber, frame);
        case Op.LIST_GET:
          return this.execListGet(fiber, frame);
        case Op.LIST_SET:
          return this.execListSet(fiber, frame);
        case Op.LIST_LEN:
          return this.execListLen(fiber, frame);
        case Op.LIST_POP:
          return this.execListPop(fiber, frame);
        case Op.LIST_SHIFT:
          return this.execListShift(fiber, frame);
        case Op.LIST_REMOVE:
          return this.execListRemove(fiber, frame);
        case Op.LIST_INSERT:
          return this.execListInsert(fiber, frame);
        case Op.LIST_SWAP:
          return this.execListSwap(fiber, frame);
        case Op.MAP_NEW:
          return this.execMapNew(fiber, ins, frame);
        case Op.MAP_SET:
          return this.execMapSet(fiber, frame);
        case Op.MAP_GET:
          return this.execMapGet(fiber, frame);
        case Op.MAP_HAS:
          return this.execMapHas(fiber, frame);
        case Op.MAP_DELETE:
          return this.execMapDelete(fiber, frame);
        case Op.STRUCT_NEW:
          return this.execStructNew(fiber, ins, frame);
        case Op.STRUCT_COPY_EXCEPT:
          return this.execStructCopyExcept(fiber, ins, frame);
        case Op.STRUCT_GET_FIELD:
          return this.execStructGetField(fiber, ins, frame);
        case Op.STRUCT_SET_FIELD:
          return this.execStructSetField(fiber, ins, frame);
        case Op.STRUCT_DEEP_COPY:
          return this.execStructDeepCopy(fiber, frame);
        case Op.GET_FIELD:
          return this.execGetField(fiber, frame);
        case Op.SET_FIELD:
          return this.execSetField(fiber, frame);
        case Op.LOAD_LOCAL:
          return this.execLoadLocal(fiber, ins, frame);
        case Op.STORE_LOCAL:
          return this.execStoreLocal(fiber, ins, frame);
        case Op.LOAD_CALLSITE_VAR:
          return this.execLoadCallsiteVar(fiber, ins, frame);
        case Op.STORE_CALLSITE_VAR:
          return this.execStoreCallsiteVar(fiber, ins, frame);
        case Op.TYPE_CHECK:
          return this.execTypeCheck(fiber, ins, frame);
        case Op.INSTANCE_OF:
          return this.execInstanceOf(fiber, ins, frame);
        case Op.CALL_INDIRECT:
          return this.execCallIndirect(fiber, ins, frame);
        case Op.CALL_INDIRECT_ARGS:
          return this.execCallIndirectArgs(fiber, ins, frame);
        case Op.MAKE_CLOSURE:
          return this.execMakeClosure(fiber, ins, frame);
        case Op.LOAD_CAPTURE:
          return this.execLoadCapture(fiber, ins, frame);
        default: {
          const err = this.makeError(ErrorCode.ScriptError, `Unknown opcode: ${ins.op}`, {
            site: { funcId: frame.funcId, pc: frame.pc },
          });
          this.faultFiber(fiber, err, scheduler);
          return { status: VmStatus.FAULT, error: err };
        }
      }
    } catch (e) {
      if (isOverflowError(e)) {
        const err = this.makeError(ErrorCode.StackOverflow, e.message, {
          site: { funcId: frame.funcId, pc: frame.pc },
        });
        this.faultFiber(fiber, err, scheduler);
        return { status: VmStatus.FAULT, error: err };
      }
      if (isUnderflowError(e)) {
        const err = this.makeError(ErrorCode.StackUnderflow, e.message, {
          site: { funcId: frame.funcId, pc: frame.pc },
        });
        this.faultFiber(fiber, err, scheduler);
        return { status: VmStatus.FAULT, error: err };
      }
      const err = this.makeError(ErrorCode.ScriptError, `Internal error: ${SU.toString(e)}`, {
        detail: e,
        site: { funcId: frame.funcId, pc: frame.pc },
      });
      this.faultFiber(fiber, err, scheduler);
      return { status: VmStatus.FAULT, error: err };
    }
  }

  private execPushConst(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const k = ins.a ?? 0;
    if (k < 0 || k >= this.prog.constantPools.values.size()) {
      throw new Error(`PUSH_CONST_VAL: constant index ${k} out of bounds`);
    }
    this.push(fiber, this.prog.constantPools.values.get(k)!);
    frame.pc++;
    return undefined;
  }

  private execPushConstNum(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const k = ins.a ?? 0;
    if (k < 0 || k >= this.prog.constantPools.numbers.size()) {
      throw new Error(`PUSH_CONST_NUM: constant index ${k} out of bounds`);
    }
    this.push(fiber, V.num(this.prog.constantPools.numbers.get(k)!));
    frame.pc++;
    return undefined;
  }

  private execPushConstStr(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const k = ins.a ?? 0;
    if (k < 0 || k >= this.prog.constantPools.strings.size()) {
      throw new Error(`PUSH_CONST_STR: constant index ${k} out of bounds`);
    }
    this.push(fiber, V.str(this.prog.constantPools.strings.get(k)!));
    frame.pc++;
    return undefined;
  }

  private execPop(fiber: Fiber, frame: Frame): undefined {
    this.pop(fiber);
    frame.pc++;
    return undefined;
  }

  private execDup(fiber: Fiber, frame: Frame): undefined {
    const v = this.peek(fiber);
    this.push(fiber, v);
    frame.pc++;
    return undefined;
  }

  private execSwap(fiber: Fiber, frame: Frame): undefined {
    const a = this.pop(fiber);
    const b = this.pop(fiber);
    this.push(fiber, a);
    this.push(fiber, b);
    frame.pc++;
    return undefined;
  }

  private execLoadVar(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const slotId = ins.a ?? 0;
    if (slotId < 0 || slotId >= this.prog.variableNames.size()) {
      throw new Error(`LOAD_VAR_SLOT: slot index ${slotId} out of bounds`);
    }
    const value = fiber.executionContext.getVariableBySlot(slotId);
    this.push(fiber, value);
    frame.pc++;
    return undefined;
  }

  private execStoreVar(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const slotId = ins.a ?? 0;
    if (slotId < 0 || slotId >= this.prog.variableNames.size()) {
      throw new Error(`STORE_VAR_SLOT: slot index ${slotId} out of bounds`);
    }
    const value = deepCopyValue(this.pop(fiber), this.runtime.types, fiber.executionContext);
    fiber.executionContext.setVariableBySlot(slotId, value);
    frame.pc++;
    return undefined;
  }

  private execLoadSystemVar(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const slotId = ins.a ?? 0;
    this.push(fiber, fiber.executionContext.getSystemVarBySlot(slotId));
    frame.pc++;
    return undefined;
  }

  private execStoreSystemVar(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const slotId = ins.a ?? 0;
    fiber.executionContext.setSystemVarBySlot(slotId, this.pop(fiber));
    frame.pc++;
    return undefined;
  }

  private execLoadLocal(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const idx = ins.a ?? 0;
    if (idx < 0 || idx >= frame.locals.size()) {
      throw new Error(`LOAD_LOCAL: index ${idx} out of bounds [0, ${frame.locals.size()})`);
    }
    this.push(fiber, frame.locals.get(idx)!);
    frame.pc++;
    return undefined;
  }

  private execStoreLocal(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const idx = ins.a ?? 0;
    if (idx < 0 || idx >= frame.locals.size()) {
      throw new Error(`STORE_LOCAL: index ${idx} out of bounds [0, ${frame.locals.size()})`);
    }
    frame.locals.set(idx, this.pop(fiber));
    frame.pc++;
    return undefined;
  }

  private execLoadCallsiteVar(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const idx = ins.a ?? 0;
    const callSiteId = this.getCurrentActionCallSiteId(fiber, "LOAD_CALLSITE_VAR");
    if (callSiteId === -1 && fiber.callsiteVars) {
      if (idx < 0 || idx >= fiber.callsiteVars.size()) {
        throw new Error(`LOAD_CALLSITE_VAR: index ${idx} out of bounds [0, ${fiber.callsiteVars.size()})`);
      }
      this.push(fiber, fiber.callsiteVars.get(idx)!);
      frame.pc++;
      return undefined;
    }
    const value = fiber.executionContext.services.brain.callsite.getSlot(callSiteId, idx);
    this.push(fiber, value);
    frame.pc++;
    return undefined;
  }

  private execStoreCallsiteVar(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const idx = ins.a ?? 0;
    const callSiteId = this.getCurrentActionCallSiteId(fiber, "STORE_CALLSITE_VAR");
    const value = this.pop(fiber);
    if (callSiteId === -1 && fiber.callsiteVars) {
      if (idx < 0 || idx >= fiber.callsiteVars.size()) {
        throw new Error(`STORE_CALLSITE_VAR: index ${idx} out of bounds [0, ${fiber.callsiteVars.size()})`);
      }
      fiber.callsiteVars.set(idx, value);
      frame.pc++;
      return undefined;
    }
    fiber.executionContext.services.brain.callsite.setSlot(callSiteId, idx, value);
    frame.pc++;
    return undefined;
  }

  private execMakeClosure(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const funcId = ins.a ?? 0;
    const captureCount = ins.b ?? 0;

    // Captures were pushed left-to-right but must be popped right-to-left.
    // Pre-fill with nil, then overwrite in reverse order to restore the
    // original ordering in the captures list.
    const captures = List.empty<Value>();
    for (let i = 0; i < captureCount; i++) {
      captures.push(V.nil());
    }
    for (let i = captureCount - 1; i >= 0; i--) {
      captures.set(i, this.pop(fiber));
    }

    this.push(fiber, V.func(funcId, captures));
    frame.pc++;
    return undefined;
  }

  private execLoadCapture(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const captureIdx = ins.a ?? 0;
    if (!frame.captures || captureIdx < 0 || captureIdx >= frame.captures.size()) {
      throw new Error(
        `LOAD_CAPTURE: index ${SU.toString(captureIdx)} out of bounds [0, ${SU.toString(frame.captures?.size() ?? 0)})`
      );
    }
    this.push(fiber, frame.captures.get(captureIdx)!);
    frame.pc++;
    return undefined;
  }

  private execTypeCheck(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const value = this.pop(fiber);
    this.push(fiber, V.bool(value.t === (ins.a ?? 0)));
    frame.pc++;
    return undefined;
  }

  private execInstanceOf(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const value = this.pop(fiber);
    const typeIdx = ins.a ?? 0;
    const types = this.prog.types;
    if (!types || typeIdx < 0 || typeIdx >= types.size()) {
      throw new Error(`INSTANCE_OF: type-table index ${typeIdx} out of bounds`);
    }
    const targetTypeId = types.get(typeIdx)!.typeId;
    const result = isStructValue(value) && value.typeId === targetTypeId;
    this.push(fiber, V.bool(result));
    frame.pc++;
    return undefined;
  }

  private execCallIndirect(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const argc = ins.a ?? 0;

    // Arguments are on the stack above the function reference.
    // Pop args first (right-to-left), then pop the function value.
    const args = List.empty<Value>();
    for (let i = 0; i < argc; i++) {
      args.push(V.nil());
    }
    for (let i = argc - 1; i >= 0; i--) {
      args.set(i, this.pop(fiber));
    }

    const funcRef = this.pop(fiber);
    if (!isFunctionValue(funcRef)) {
      throw new Error(`CALL_INDIRECT: expected FunctionValue on stack, got ${SU.toString(funcRef.t)}`);
    }

    const calleeId = funcRef.funcId;
    if (calleeId < 0 || calleeId >= this.prog.functions.size()) {
      throw new Error(`CALL_INDIRECT: function ${SU.toString(calleeId)} out of bounds`);
    }

    if (fiber.frames.size() >= this.config.maxFrameDepth) {
      throwOverflow(`Stack overflow: frame depth limit ${SU.toString(this.config.maxFrameDepth)} exceeded`);
    }

    const callee = this.prog.functions.get(calleeId)!;
    if (argc !== callee.numParams) {
      throw new Error(`CALL_INDIRECT: argc ${SU.toString(argc)} != numParams ${SU.toString(callee.numParams)}`);
    }
    this.assertLocalsCapacity(fiber, callee.numLocals ?? callee.numParams);

    const caller = this.topFrame(fiber);
    if (caller) caller.pc++;

    const base = fiber.vstack.size();
    const locals = this.allocLocals(callee, args);

    const newFrame: Frame = {
      funcId: calleeId,
      pc: 0,
      base,
      locals,
      ruleFuncId: this.resolveCalleeRuleFuncId(fiber.executionContext, caller, calleeId),
    };
    if (funcRef.captures) {
      newFrame.captures = funcRef.captures;
    }
    fiber.frames.push(newFrame);
    return undefined;
  }

  private execCallIndirectArgs(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const argc = ins.a ?? 0;

    const args = List.empty<Value>();
    for (let i = 0; i < argc; i++) {
      args.push(V.nil());
    }
    for (let i = argc - 1; i >= 0; i--) {
      args.set(i, this.pop(fiber));
    }

    const funcRef = this.pop(fiber);
    if (!isFunctionValue(funcRef)) {
      throw new Error(`CALL_INDIRECT_ARGS: expected FunctionValue on stack, got ${SU.toString(funcRef.t)}`);
    }

    const calleeId = funcRef.funcId;
    if (calleeId < 0 || calleeId >= this.prog.functions.size()) {
      throw new Error(`CALL_INDIRECT_ARGS: function ${SU.toString(calleeId)} out of bounds`);
    }

    if (fiber.frames.size() >= this.config.maxFrameDepth) {
      throwOverflow(`Stack overflow: frame depth limit ${SU.toString(this.config.maxFrameDepth)} exceeded`);
    }

    const callee = this.prog.functions.get(calleeId)!;
    const needed = callee.numParams;

    while (args.size() > needed) {
      args.pop();
    }
    while (args.size() < needed) {
      args.push(V.nil());
    }
    this.assertLocalsCapacity(fiber, callee.numLocals ?? callee.numParams);

    const caller = this.topFrame(fiber);
    if (caller) caller.pc++;

    const base = fiber.vstack.size();
    const locals = this.allocLocals(callee, args);

    const newFrame: Frame = {
      funcId: calleeId,
      pc: 0,
      base,
      locals,
      ruleFuncId: this.resolveCalleeRuleFuncId(fiber.executionContext, caller, calleeId),
    };
    if (funcRef.captures) {
      newFrame.captures = funcRef.captures;
    }
    fiber.frames.push(newFrame);
    return undefined;
  }

  private execJmp(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const rel = (ins.a ?? 0) | 0;
    frame.pc = frame.pc + rel;
    return undefined;
  }

  private execJmpIfFalse(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const rel = (ins.a ?? 0) | 0;
    const v = this.pop(fiber);
    frame.pc = isTruthy(v, this.runtime.types, fiber.executionContext) ? frame.pc + 1 : frame.pc + rel;
    return undefined;
  }

  private execJmpIfTrue(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const rel = (ins.a ?? 0) | 0;
    const v = this.pop(fiber);
    frame.pc = isTruthy(v, this.runtime.types, fiber.executionContext) ? frame.pc + rel : frame.pc + 1;
    return undefined;
  }

  private execCall(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const calleeId = ins.a ?? 0;
    const argc = ins.b ?? 0;
    this.doCall(fiber, calleeId, argc);
    return undefined;
  }

  private execRet(fiber: Fiber, scheduler: Scheduler): VmRunResult | undefined {
    const retv = this.pop(fiber);
    const done = this.doRet(fiber, retv);
    if (done) {
      this.transitionState(fiber, FiberState.DONE);
      this.resolveAsyncActionHandle(fiber, retv);
      this.events?.onFiberDone?.({ fiberId: fiber.id, retv });
      return { status: VmStatus.DONE, result: retv };
    }
    return undefined;
  }

  private execSpawnRule(fiber: Fiber, ins: Instr, frame: Frame, scheduler: Scheduler): undefined {
    const childFuncId = ins.a ?? 0;
    if (!scheduler.spawnChildRule) {
      throw new Error("SPAWN_RULE: scheduler cannot spawn child-rule fibers");
    }
    // Fire-and-forget: spawn the child rule in its own fiber, tagged with this
    // subtree's root rule (this fiber's own root, or its rule funcId when it is
    // the root), and continue without awaiting. The child runs in a later round
    // (the round-tick rule). Nothing is pushed.
    const subtreeRootFuncId = fiber.rootRuleFuncId ?? fiber.frames.get(0)!.funcId;
    scheduler.spawnChildRule(childFuncId, subtreeRootFuncId, fiber.executionContext);
    frame.pc++;
    return undefined;
  }

  private execHostCall(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const fnId = ins.a ?? 0;
    const argc = ins.b ?? 0;
    const callSiteId = ins.c ?? 0;

    const fnEntry = this.runtime.functions.getSyncById(fnId);
    if (!fnEntry) {
      throw new Error(`HOST_CALL: no sync host function registered under id ${fnId}`);
    }

    const stackSize = fiber.vstack.size();
    if (argc < 0 || argc > stackSize) {
      throwUnderflow(`HOST_CALL: argc ${argc} exceeds stack size ${stackSize}`);
    }

    this.bindExecutionContext(fiber, frame, callSiteId);

    const args = fiber.vstack.subview(stackSize - argc, argc);
    const result = fnEntry.fn.exec(fiber.executionContext, args);

    for (let i = 0; i < argc; i++) {
      fiber.vstack.pop();
    }
    this.push(fiber, result);
    frame.pc++;
    this.syncExecutionContextFromTopFrame(fiber);
    return undefined;
  }

  /**
   * Builds the {@link AsyncHandle} handed to an async host body for `id`. Each
   * settle method is a no-op when the handle is no longer pending (already
   * settled, cancelled with its fiber, or cleared on shutdown).
   */
  private makeAsyncHandle(id: HandleId): AsyncHandle {
    const handles = this.handles;
    const pending = (): boolean => handles.get(id)?.state === HandleState.PENDING;
    return {
      id,
      resolve(value: Value): void {
        if (pending()) handles.resolve(id, value);
      },
      reject(code: ErrorCode, message = ""): void {
        if (pending()) handles.reject(id, { code, message });
      },
      cancel(message?: string): void {
        if (pending()) handles.cancel(id, message);
      },
    };
  }

  private execHostCallAsync(fiber: Fiber, ins: Instr, frame: Frame, _scheduler: Scheduler): VmRunResult | undefined {
    this.assertCanSuspend(fiber, Op.HOST_CALL_ASYNC);

    const fnId = ins.a ?? 0;
    const argc = ins.b ?? 0;
    const callSiteId = ins.c ?? 0;

    const fnEntry = this.runtime.functions.getAsyncById(fnId);
    if (!fnEntry) {
      throw new Error(`HOST_CALL_ASYNC: no async host function registered under id ${fnId}`);
    }

    const stackSize = fiber.vstack.size();
    if (argc < 0 || argc > stackSize) {
      throwUnderflow(`HOST_CALL_ASYNC: argc ${argc} exceeds stack size ${stackSize}`);
    }

    // Backpressure on handle exhaustion: with no free handle, yield without
    // advancing the pc, so the fiber re-enters the run queue and re-executes this
    // same dispatch next round. The check precedes every side effect (no args
    // popped, no handle allocated, no action started, pc unchanged), so the retry
    // is an exact re-execution once an in-flight async settles a slot.
    if (!this.handles.hasCapacity()) {
      return this.backpressureOnHandles(fiber, frame);
    }
    this.clearHandleBackpressure(fiber);

    const args = List.empty<Value>();
    for (let i = 0; i < argc; i++) {
      args.push(fiber.vstack.get(stackSize - argc + i)!);
    }
    for (let i = 0; i < argc; i++) {
      fiber.vstack.pop();
    }

    const hid = this.handles.createPending();
    this.push(fiber, V.handle(hid));

    this.bindExecutionContext(fiber, frame, callSiteId);

    fnEntry.fn.exec(fiber.executionContext, args, this.makeAsyncHandle(hid));
    frame.pc++;
    this.syncExecutionContextFromTopFrame(fiber);
    return undefined;
  }

  private execStackSetRel(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const d = ins.a ?? 0;
    const v = this.pop(fiber);
    const newTop = fiber.vstack.size() - 1;
    if (d < 0 || d > newTop) {
      throw new Error(`STACK_SET_REL: offset ${d} out of bounds [0, ${newTop}]`);
    }
    fiber.vstack.set(newTop - d, v);
    frame.pc++;
    return undefined;
  }

  private getExecutableAction(actionSlot: number, opName: string): BytecodeExecutableAction {
    const actions = this.prog.actions;
    if (!actions) {
      throw new Error(`${opName}: program does not define executable actions`);
    }
    if (actionSlot < 0 || actionSlot >= actions.size()) {
      throw new Error(`${opName}: action slot ${actionSlot} out of bounds`);
    }

    return actions.get(actionSlot)!;
  }

  private execActionCall(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const actionSlot = ins.a ?? 0;
    const argc = ins.b ?? 0;
    const callSiteId = ins.c ?? 0;

    const stackSize = fiber.vstack.size();
    if (argc < 0 || argc > stackSize) {
      throwUnderflow(`ACTION_CALL: argc ${argc} exceeds stack size ${stackSize}`);
    }

    // Sync vs async dispatch is determined by the opcode (ACTION_CALL here), not by the action.
    const action = this.getExecutableAction(actionSlot, "ACTION_CALL");

    const args = this.snapshotStackArgs(fiber, argc, "ACTION_CALL");
    for (let i = 0; i < argc; i++) {
      fiber.vstack.pop();
    }
    this.enterBytecodeActionFrame(fiber, frame, action, args, callSiteId, actionSlot);
    this.events?.onHostActionDispatch?.({
      descriptor: action.descriptor,
      args,
      ruleFuncId: fiber.executionContext.currentRuleFuncId,
    });
    return undefined;
  }

  private execActionCallAsync(fiber: Fiber, ins: Instr, frame: Frame, scheduler: Scheduler): VmRunResult | undefined {
    this.assertCanSuspend(fiber, Op.ACTION_CALL_ASYNC);

    const actionSlot = ins.a ?? 0;
    const argc = ins.b ?? 0;
    const callSiteId = ins.c ?? 0;

    const stackSize = fiber.vstack.size();
    if (argc < 0 || argc > stackSize) {
      throwUnderflow(`ACTION_CALL_ASYNC: argc ${argc} exceeds stack size ${stackSize}`);
    }

    // Sync vs async dispatch is determined by the opcode (ACTION_CALL_ASYNC here), not by the action.
    const action = this.getExecutableAction(actionSlot, "ACTION_CALL_ASYNC");
    const actionKey = action.descriptor.key;

    // Backpressure on handle exhaustion: with no free handle, yield without
    // advancing the pc, so the fiber re-enters the run queue and re-executes this
    // same dispatch next round. The check precedes every side effect (no args
    // popped, no child fiber spawned, no handle allocated, pc unchanged), so the
    // retry is an exact re-execution once an in-flight async settles a slot.
    if (!this.handles.hasCapacity()) {
      return this.backpressureOnHandles(fiber, frame);
    }
    this.clearHandleBackpressure(fiber);

    const args = this.snapshotStackArgs(fiber, argc, "ACTION_CALL_ASYNC");
    for (let i = 0; i < argc; i++) {
      fiber.vstack.pop();
    }
    const childFiber = this.spawnBytecodeActionFiber(fiber, action, args, callSiteId, actionSlot);
    if (!scheduler.addFiber) {
      throw new Error(`ACTION_CALL_ASYNC: scheduler cannot add child fibers for ${actionKey}`);
    }

    const hid = this.handles.createPending(actionKey);
    childFiber.asyncResultHandleId = hid;

    try {
      scheduler.addFiber(childFiber);
    } catch (error) {
      this.handles.delete(hid);
      throw error;
    }

    this.push(fiber, V.handle(hid));
    this.bindExecutionContext(fiber, frame, callSiteId);
    this.events?.onHostActionDispatch?.({
      descriptor: action.descriptor,
      args,
      ruleFuncId: fiber.executionContext.currentRuleFuncId,
      handleId: hid,
    });
    this.events?.onHostActionReturn?.({
      binding: "bytecode",
      actionId: actionSlot,
      callSiteId,
      args,
      result: undefined,
    });
    frame.pc++;
    this.syncExecutionContextFromTopFrame(fiber);
    return undefined;
  }

  /**
   * Resolve a host action by its stable registry id and validate it against the
   * opcode. Faults (surfacing as a `ScriptError`) when no action holds the id,
   * the resolved action is not host-backed, or its sync/async-ness does not
   * match the opcode that issued the call.
   */
  /**
   * Records that the dispatch at `frame.pc` found no free async handle and
   * returns the fiber's yield result. Faults `ErrorCode.StackOverflow` once the
   * same dispatch has backpressured {@link HANDLE_BACKPRESSURE_FAULT_ROUNDS}
   * consecutive rounds.
   */
  private backpressureOnHandles(fiber: Fiber, frame: Frame): VmRunResult {
    const rounds = fiber.handleBackpressurePc === frame.pc ? (fiber.handleBackpressureRounds ?? 0) + 1 : 1;
    fiber.handleBackpressurePc = frame.pc;
    fiber.handleBackpressureRounds = rounds;
    if (rounds >= HANDLE_BACKPRESSURE_FAULT_ROUNDS) {
      throwOverflow(`Async handle starvation: no free handle for ${HANDLE_BACKPRESSURE_FAULT_ROUNDS} rounds`);
    }
    return { status: VmStatus.YIELDED };
  }

  /** Clears the backpressure run recorded by {@link backpressureOnHandles}. */
  private clearHandleBackpressure(fiber: Fiber): void {
    fiber.handleBackpressurePc = undefined;
    fiber.handleBackpressureRounds = 0;
  }

  private resolveHostAction(actionId: number, wantAsync: boolean, opName: string): HostActionBinding {
    const action = this.runtime.actions.getById(actionId);
    if (!action) {
      throw new Error(`${opName}: no action registered with id ${actionId}`);
    }
    if (action.binding !== "host") {
      throw new Error(`${opName}: action id ${actionId} (${action.descriptor.key}) is not a host action`);
    }
    if (action.descriptor.isAsync !== wantAsync) {
      const needed = action.descriptor.isAsync ? "HOST_ACTION_CALL_ASYNC" : "HOST_ACTION_CALL";
      throw new Error(`${opName}: host action ${action.descriptor.key} requires ${needed}`);
    }
    return action;
  }

  private execHostActionCall(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const actionId = ins.a ?? 0;
    const argc = ins.b ?? 0;
    const callSiteId = ins.c ?? 0;

    const stackSize = fiber.vstack.size();
    if (argc < 0 || argc > stackSize) {
      throwUnderflow(`HOST_ACTION_CALL: argc ${argc} exceeds stack size ${stackSize}`);
    }

    const action = this.resolveHostAction(actionId, false, "HOST_ACTION_CALL");
    if (!action.execSync) {
      throw new Error(`HOST_ACTION_CALL: host action ${action.descriptor.key} is missing execSync`);
    }

    this.bindExecutionContext(fiber, frame, callSiteId);

    const args = fiber.vstack.subview(stackSize - argc, argc);
    this.events?.onHostActionDispatch?.({
      descriptor: action.descriptor,
      args,
      ruleFuncId: fiber.executionContext.currentRuleFuncId,
    });
    const result = action.execSync(fiber.executionContext, args);
    this.events?.onHostActionReturn?.({ binding: "host", actionId, callSiteId, args, result });
    for (let i = 0; i < argc; i++) {
      fiber.vstack.pop();
    }
    this.push(fiber, result);
    frame.pc++;
    this.syncExecutionContextFromTopFrame(fiber);
    return undefined;
  }

  private execHostActionCallAsync(fiber: Fiber, ins: Instr, frame: Frame): VmRunResult | undefined {
    this.assertCanSuspend(fiber, Op.HOST_ACTION_CALL_ASYNC);

    const actionId = ins.a ?? 0;
    const argc = ins.b ?? 0;
    const callSiteId = ins.c ?? 0;

    const stackSize = fiber.vstack.size();
    if (argc < 0 || argc > stackSize) {
      throwUnderflow(`HOST_ACTION_CALL_ASYNC: argc ${argc} exceeds stack size ${stackSize}`);
    }

    const action = this.resolveHostAction(actionId, true, "HOST_ACTION_CALL_ASYNC");
    if (!action.execAsync) {
      throw new Error(`HOST_ACTION_CALL_ASYNC: host action ${action.descriptor.key} is missing execAsync`);
    }

    // Backpressure on handle exhaustion: with no free handle, yield without
    // advancing the pc, so the fiber re-enters the run queue and re-executes this
    // same dispatch next round. The check precedes every side effect (no args
    // popped, no handle allocated, no action started, pc unchanged), so the retry
    // is an exact re-execution once an in-flight async settles a slot. An action
    // declaring `uncappedHandles` skips the check and allocates outside the cap.
    const capped = action.uncappedHandles !== true;
    if (capped && !this.handles.hasCapacity()) {
      return this.backpressureOnHandles(fiber, frame);
    }
    this.clearHandleBackpressure(fiber);

    const args = List.empty<Value>();
    for (let i = 0; i < argc; i++) {
      args.push(fiber.vstack.get(stackSize - argc + i)!);
    }
    for (let i = 0; i < argc; i++) {
      fiber.vstack.pop();
    }

    const hid = this.handles.createPending(action.descriptor.key, capped);
    this.push(fiber, V.handle(hid));

    this.bindExecutionContext(fiber, frame, callSiteId);

    this.events?.onHostActionDispatch?.({
      descriptor: action.descriptor,
      args,
      ruleFuncId: fiber.executionContext.currentRuleFuncId,
      handleId: hid,
    });
    try {
      action.execAsync(fiber.executionContext, args, this.makeAsyncHandle(hid));
    } catch (error) {
      this.handles.delete(hid);
      throw error;
    }
    this.events?.onHostActionReturn?.({ binding: "host", actionId, callSiteId, args, result: undefined });
    frame.pc++;
    this.syncExecutionContextFromTopFrame(fiber);
    return undefined;
  }

  private execAwait(fiber: Fiber, frame: Frame, scheduler: Scheduler): VmRunResult | undefined {
    this.assertCanSuspend(fiber, Op.AWAIT);

    const hv = this.pop(fiber);
    if (!isHandleValue(hv)) {
      throw new Error("AWAIT: expected handle value");
    }

    const h = this.handles.get(hv.id);
    if (!h) {
      throw new Error(`AWAIT: unknown handle ${hv.id}`);
    }

    if (h.state === HandleState.RESOLVED) {
      this.push(fiber, h.result ?? V.nil());
      frame.pc++;
      return undefined;
    }

    if (h.state === HandleState.REJECTED || h.state === HandleState.CANCELLED) {
      const err: ErrorValue = h.error ?? this.makeError(ErrorCode.HostError, "Handle failed without error");
      const caught = this.throwValue(fiber, err);
      if (!caught) {
        this.transitionState(fiber, FiberState.FAULT);
        this.rejectAsyncActionHandle(fiber, err);
        this.events?.onFiberFault?.({ fiberId: fiber.id, err });
        return { status: VmStatus.FAULT, error: err };
      }
      return undefined;
    }

    this.transitionState(fiber, FiberState.WAITING);
    fiber.await = {
      resumePc: frame.pc + 1,
      stackHeight: fiber.vstack.size(),
      frameDepth: fiber.frames.size(),
      handleId: hv.id,
    };

    h.waiters.add(fiber.id);
    this.events?.onFiberWaiting?.({
      fiberId: fiber.id,
      handleId: hv.id,
      ruleFuncId: this.resolveFrameRuleFuncId(fiber.executionContext, frame),
    });

    return { status: VmStatus.WAITING, handleId: hv.id };
  }

  private execTry(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    if (fiber.handlers.size() >= this.config.maxHandlers) {
      throwOverflow(`Handler limit exceeded: ${this.config.maxHandlers}`);
    }

    const catchRel = (ins.a ?? 0) | 0;
    const catchPc = frame.pc + catchRel;

    fiber.handlers.push({
      catchPc,
      stackHeight: fiber.vstack.size(),
      frameDepth: fiber.frames.size(),
    });

    frame.pc++;
    return undefined;
  }

  private execEndTry(fiber: Fiber, frame: Frame): undefined {
    fiber.handlers.pop();
    frame.pc++;
    return undefined;
  }

  private execThrow(fiber: Fiber, frame: Frame, scheduler: Scheduler): VmRunResult | undefined {
    const v = this.pop(fiber);
    const err: ErrorValue = isErrValue(v)
      ? v.e
      : this.makeError(ErrorCode.ScriptError, "THROW requires error value", {
          detail: v,
          site: { funcId: frame.funcId, pc: frame.pc },
        });

    const caught = this.throwValue(fiber, err);
    if (!caught) {
      this.transitionState(fiber, FiberState.FAULT);
      this.rejectAsyncActionHandle(fiber, err);
      this.events?.onFiberFault?.({ fiberId: fiber.id, err });
      return { status: VmStatus.FAULT, error: err };
    }
    return undefined;
  }

  // Boundaries
  private execWhenStart(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    // The WHEN section will push exactly one value onto the stack; the gate at
    // its end pops it. The rule's firing record reads EVALUATING from here until
    // that gate writes the outcome.
    const ruleFuncId = this.resolveFrameRuleFuncId(fiber.executionContext, frame);
    fiber.executionContext.services.brain.ruleFiring.set(ruleFuncId, RuleFiringState.EVALUATING);

    frame.pc++;
    return undefined;
  }

  /**
   * Body shared by the four WHEN gates. Pops the WHEN result, captures it into
   * the rule's reserved `__whenResult` variable (every rule captures, whatever
   * the gate decides), computes the fired outcome, writes the firing record, and
   * advances the PC by one on a fire or by the signed `a` offset on a skip,
   * which lands past the DO section and any nested boundaries.
   *
   * @param presenceGated - Gate on the WHEN result being present (non-nil), so a
   *   present falsy value fires. Otherwise the gate is on truthiness.
   * @param chained - Write the chain-aware firing record of an `otherwise` rule.
   *   Otherwise the record is the rule's own outcome.
   */
  private execWhenGate(fiber: Fiber, ins: Instr, frame: Frame, presenceGated: boolean, chained: boolean): undefined {
    const whenResult = this.pop(fiber);

    const brain = fiber.executionContext.services.brain;
    const ruleFuncId = this.resolveFrameRuleFuncId(fiber.executionContext, frame);
    brain.ruleVars.setByName(ruleFuncId, "__whenResult", whenResult);

    const fired = presenceGated
      ? whenResult.t !== NativeType.Nil
      : isTruthy(whenResult, this.runtime.types, fiber.executionContext);
    brain.ruleFiring.set(
      ruleFuncId,
      chained
        ? this.chainedFiringState(brain, ruleFuncId, fired)
        : fired
          ? RuleFiringState.DID_FIRE
          : RuleFiringState.DID_NOT_FIRE
    );
    this.events?.onRuleWhenGate?.({ ruleFuncId, result: whenResult, fired });

    frame.pc += fired ? 1 : (ins.a ?? 0);
    return undefined;
  }

  /**
   * The firing record a chain gate writes: `DidFire` when the rule fired, and on
   * a rule that did not fire the record of its subject -- the rule directly
   * above it at its own nesting level. A rule with no subject records its own
   * outcome.
   */
  private chainedFiringState(
    brain: BrainInstanceServices,
    ruleFuncId: number | undefined,
    fired: boolean
  ): RuleFiringState {
    if (fired) return RuleFiringState.DID_FIRE;
    const subjectFuncId =
      ruleFuncId === undefined ? undefined : brain.program.getPrecedingSiblingRuleFuncId(ruleFuncId);
    if (subjectFuncId === undefined) return RuleFiringState.DID_NOT_FIRE;
    return brain.ruleFiring.get(subjectFuncId);
  }

  private execWhenEnd(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    return this.execWhenGate(fiber, ins, frame, false, false);
  }

  private execWhenEndPresent(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    return this.execWhenGate(fiber, ins, frame, true, false);
  }

  private execWhenEndChain(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    return this.execWhenGate(fiber, ins, frame, false, true);
  }

  private execWhenEndPresentChain(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    return this.execWhenGate(fiber, ins, frame, true, true);
  }

  private execDoStart(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    frame.pc++;
    return undefined;
  }

  private execDoEnd(fiber: Fiber, frame: Frame): undefined {
    frame.pc++;
    return undefined;
  }

  // List operations
  private execListNew(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    let typeId: TypeId = "list:<unknown>";
    if (ins.b !== undefined) {
      typeId = resolveProgramTypeId(this.prog.types, ins.b);
    }
    this.push(fiber, V.list(List.empty<Value>(), typeId));
    frame.pc++;
    return undefined;
  }

  private execListPush(fiber: Fiber, frame: Frame): undefined {
    const item = this.pop(fiber);
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_PUSH: requires list");
    }
    // Mutate in place for performance
    list.v.push(item);
    this.push(fiber, list);
    frame.pc++;
    return undefined;
  }

  private execListGet(fiber: Fiber, frame: Frame): undefined {
    const index = this.pop(fiber);
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_GET: requires list");
    }
    if (!isNumberValue(index)) {
      throw new Error("LIST_GET: index must be number");
    }
    const idx = MathOps.floor(index.v);
    const item = list.v.at(idx);
    this.push(fiber, item ?? V.nil());
    frame.pc++;
    return undefined;
  }

  private execListSet(fiber: Fiber, frame: Frame): undefined {
    const value = this.pop(fiber);
    const index = this.pop(fiber);
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_SET: requires list");
    }
    if (!isNumberValue(index)) {
      throw new Error("LIST_SET: index must be number");
    }
    const idx = MathOps.floor(index.v);
    // Mutate in place for performance
    list.v.set(idx, value);
    this.push(fiber, list);
    frame.pc++;
    return undefined;
  }

  private execListLen(fiber: Fiber, frame: Frame): undefined {
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_LEN: requires list");
    }
    this.push(fiber, V.num(list.v.size()));
    frame.pc++;
    return undefined;
  }

  private execListPop(fiber: Fiber, frame: Frame): undefined {
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_POP: requires list");
    }
    const val = list.v.pop();
    this.push(fiber, val ?? V.nil());
    frame.pc++;
    return undefined;
  }

  private execListShift(fiber: Fiber, frame: Frame): undefined {
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_SHIFT: requires list");
    }
    const val = list.v.shift();
    this.push(fiber, val ?? V.nil());
    frame.pc++;
    return undefined;
  }

  private execListRemove(fiber: Fiber, frame: Frame): undefined {
    const index = this.pop(fiber);
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_REMOVE: requires list");
    }
    if (!isNumberValue(index)) {
      throw new Error("LIST_REMOVE: index must be number");
    }
    const idx = MathOps.floor(index.v);
    const val = list.v.remove(idx);
    this.push(fiber, val ?? V.nil());
    frame.pc++;
    return undefined;
  }

  private execListInsert(fiber: Fiber, frame: Frame): undefined {
    const value = this.pop(fiber);
    const index = this.pop(fiber);
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_INSERT: requires list");
    }
    if (!isNumberValue(index)) {
      throw new Error("LIST_INSERT: index must be number");
    }
    const idx = MathOps.floor(index.v);
    list.v.insert(idx, value);
    frame.pc++;
    return undefined;
  }

  private execListSwap(fiber: Fiber, frame: Frame): undefined {
    const j = this.pop(fiber);
    const i = this.pop(fiber);
    const list = this.pop(fiber);
    if (!isListValue(list)) {
      throw new Error("LIST_SWAP: requires list");
    }
    if (!isNumberValue(i)) {
      throw new Error("LIST_SWAP: index i must be number");
    }
    if (!isNumberValue(j)) {
      throw new Error("LIST_SWAP: index j must be number");
    }
    list.v.swap(MathOps.floor(i.v), MathOps.floor(j.v));
    frame.pc++;
    return undefined;
  }

  // Map operations
  private execMapNew(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    let typeId: TypeId = "map:<unknown>";
    if (ins.b !== undefined) {
      typeId = resolveProgramTypeId(this.prog.types, ins.b);
    }
    this.push(fiber, V.map(new ValueDict(), typeId));
    frame.pc++;
    return undefined;
  }

  private execMapSet(fiber: Fiber, frame: Frame): undefined {
    const value = this.pop(fiber);
    const key = this.pop(fiber);
    const map = this.pop(fiber);
    if (!isMapValue(map)) {
      throw new Error("MAP_SET: requires map");
    }
    if (!isStringValue(key) && !isNumberValue(key)) {
      throw new Error("MAP_SET: key must be string or number");
    }
    // Mutate in place for performance
    map.v.set(key.v, value);
    this.push(fiber, map);
    frame.pc++;
    return undefined;
  }

  private execMapGet(fiber: Fiber, frame: Frame): undefined {
    const key = this.pop(fiber);
    const map = this.pop(fiber);
    if (!isMapValue(map)) {
      throw new Error("MAP_GET: requires map");
    }
    if (!isStringValue(key) && !isNumberValue(key)) {
      throw new Error("MAP_GET: key must be string or number");
    }
    const value = map.v.get(key.v);
    this.push(fiber, value ?? V.nil());
    frame.pc++;
    return undefined;
  }

  private execMapHas(fiber: Fiber, frame: Frame): undefined {
    const key = this.pop(fiber);
    const map = this.pop(fiber);
    if (!isMapValue(map)) {
      throw new Error("MAP_HAS: requires map");
    }
    if (!isStringValue(key) && !isNumberValue(key)) {
      throw new Error("MAP_HAS: key must be string or number");
    }
    this.push(fiber, V.bool(map.v.has(key.v)));
    frame.pc++;
    return undefined;
  }

  private execMapDelete(fiber: Fiber, frame: Frame): undefined {
    const key = this.pop(fiber);
    const map = this.pop(fiber);
    if (!isMapValue(map)) {
      throw new Error("MAP_DELETE: requires map");
    }
    if (!isStringValue(key) && !isNumberValue(key)) {
      throw new Error("MAP_DELETE: key must be string or number");
    }
    // Mutate in place for performance
    map.v.delete(key.v);
    this.push(fiber, map);
    frame.pc++;
    return undefined;
  }

  // Struct operations

  /**
   * The program-local struct type-table entry for `typeId`, or undefined when
   * the program type table has no struct entry with that typeId.
   */
  private programStructEntry(typeId: TypeId): { maxFieldId: number; fields: List<ProgramStructField> } | undefined {
    const types = this.prog.types;
    if (types === undefined) {
      return undefined;
    }
    for (let i = 0; i < types.size(); i++) {
      const entry = types.get(i)!;
      if (entry.tag === "struct" && entry.typeId === typeId) {
        return entry;
      }
    }
    return undefined;
  }

  /** Field name -> id list for `typeId`, from the runtime registry when present, else the program type table. */
  private structFieldList(typeId: TypeId): List<ProgramStructField> | undefined {
    const typeDef = this.runtime.types.get(typeId) as StructTypeDef | undefined;
    if (typeDef !== undefined) {
      return typeDef.fields.map((field) => ({ name: field.name, fieldIndex: field.fieldIndex }));
    }
    return this.programStructEntry(typeId)?.fields;
  }

  private findStructField(typeId: TypeId, fieldName: string): number | undefined {
    const typeDef = this.runtime.types.get(typeId) as StructTypeDef | undefined;
    const fromRegistry = typeDef?.fieldIndexByName.get(fieldName);
    if (fromRegistry !== undefined) {
      return fromRegistry;
    }
    const fields = this.programStructEntry(typeId)?.fields;
    if (fields !== undefined) {
      for (let i = 0; i < fields.size(); i++) {
        const field = fields.get(i)!;
        if (field.name === fieldName) {
          return field.fieldIndex;
        }
      }
    }
    return undefined;
  }

  private makeStructFields(typeId: TypeId): List<Value> {
    const fields = List.empty<Value>();
    const typeDef = this.runtime.types.get(typeId) as StructTypeDef | undefined;
    // Storage holds the highest field id + 1 slots; a field id indexes its slot
    // directly and retired ids leave nil holes.
    let slotCount = 0;
    if (typeDef !== undefined) {
      typeDef.fields.forEach((field) => {
        if (field.fieldIndex + 1 > slotCount) {
          slotCount = field.fieldIndex + 1;
        }
      });
    } else {
      const entry = this.programStructEntry(typeId);
      if (entry !== undefined) {
        slotCount = entry.maxFieldId + 1;
      }
    }
    for (let i = 0; i < slotCount; i++) {
      fields.push(NIL_VALUE);
    }
    return fields;
  }

  private execStructNew(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    if (ins.a !== undefined && ins.a !== 0) {
      throw new Error(`STRUCT_NEW: reserved operand a must be 0 (got ${ins.a})`);
    }
    let typeId = "struct:<anonymous>";
    if (ins.b !== undefined) {
      typeId = resolveProgramTypeId(this.prog.types, ins.b);
    }

    const fields = this.makeStructFields(typeId);
    this.push(fiber, V.struct(fields, typeId));
    frame.pc++;
    return undefined;
  }

  /**
   * Read a struct field by its numeric id: dispatch to the native `fieldGetter` when
   * one is registered, else read the indexed storage slot. Shared by `STRUCT_GET_FIELD`
   * and the name-keyed `GET_FIELD` shim.
   */
  private readStructFieldById(source: StructValue, fieldId: number, fiber: Fiber): Value {
    const typeDef = this.runtime.types.get(source.typeId) as StructTypeDef | undefined;
    if (typeDef?.fieldGetter) {
      return typeDef.fieldGetter(source, fieldId, fiber.executionContext) ?? V.nil();
    }
    return source.v?.at(fieldId) ?? V.nil();
  }

  /**
   * Write a struct field by its numeric id (a pure store -- no value copy): dispatch to
   * the native `fieldSetter` when one is registered (throwing if it rejects the write),
   * else write the indexed storage slot. Shared by `STRUCT_SET_FIELD` and the name-keyed
   * `SET_FIELD` shim.
   */
  private writeStructFieldById(source: StructValue, fieldId: number, value: Value, fiber: Fiber): void {
    const typeDef = this.runtime.types.get(source.typeId) as StructTypeDef | undefined;
    if (typeDef?.fieldSetter) {
      const ok = typeDef.fieldSetter(source, fieldId, value, fiber.executionContext);
      if (!ok) {
        throw new Error(`STRUCT_SET_FIELD: cannot set field id ${fieldId} on type ${source.typeId}`);
      }
      return;
    }
    source.v?.set(fieldId, value);
  }

  private execStructGetField(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const fieldId = ins.a ?? 0;
    const struct = this.pop(fiber);
    if (!isStructValue(struct)) {
      throw new Error("STRUCT_GET_FIELD: requires struct");
    }
    this.push(fiber, this.readStructFieldById(struct, fieldId, fiber));
    frame.pc++;
    return undefined;
  }

  private execStructSetField(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const value = this.pop(fiber);
    const struct = this.pop(fiber);
    if (!isStructValue(struct)) {
      throw new Error("STRUCT_SET_FIELD: requires struct");
    }
    this.writeStructFieldById(struct, ins.a ?? 0, value, fiber);
    this.push(fiber, struct);
    frame.pc++;
    return undefined;
  }

  private execStructDeepCopy(fiber: Fiber, frame: Frame): undefined {
    const value = this.pop(fiber);
    this.push(fiber, deepCopyValue(value, this.runtime.types, fiber.executionContext));
    frame.pc++;
    return undefined;
  }

  private execStructCopyExcept(fiber: Fiber, ins: Instr, frame: Frame): undefined {
    const numExclude = ins.a ?? 0;
    const exclude = new Dict<string, boolean>();
    for (let i = 0; i < numExclude; i++) {
      const key = this.pop(fiber);
      if (!isStringValue(key)) {
        throw new Error("STRUCT_COPY_EXCEPT: exclude key must be string");
      }
      exclude.set(key.v, true);
    }
    const source = this.pop(fiber);
    if (!isStructValue(source)) {
      throw new Error("STRUCT_COPY_EXCEPT: requires struct");
    }

    let typeId = "struct:<anonymous>";
    if (ins.b !== undefined) {
      typeId = resolveProgramTypeId(this.prog.types, ins.b);
    }

    let resultTypeId = typeId;
    let fields = this.makeStructFields(resultTypeId);
    const sourceFields = this.structFieldList(source.typeId);
    if (source.v && sourceFields && fields.size() === 0) {
      resultTypeId = source.typeId;
      fields = List.empty<Value>();
      for (let i = 0; i < source.v.size(); i++) {
        fields.push(source.v.get(i));
      }
    }
    if (source.v && sourceFields) {
      for (let i = 0; i < sourceFields.size(); i++) {
        const field = sourceFields.get(i)!;
        if (exclude.has(field.name)) {
          if (resultTypeId === source.typeId) {
            fields.set(field.fieldIndex, NIL_VALUE);
          }
        } else {
          const targetFieldIndex = this.findStructField(resultTypeId, field.name);
          if (targetFieldIndex !== undefined) {
            fields.set(targetFieldIndex, source.v.get(field.fieldIndex));
          }
        }
      }
    }

    this.push(fiber, V.struct(fields, resultTypeId));
    frame.pc++;
    return undefined;
  }

  // GET_FIELD is the dynamic (runtime-computed-key) struct read: resolve the field name
  // to its numeric id, then dispatch through the same id-based path as STRUCT_GET_FIELD.
  private execGetField(fiber: Fiber, frame: Frame): undefined {
    const fieldName = this.pop(fiber);
    const source = this.pop(fiber);

    if (!isStringValue(fieldName)) {
      throw new Error("GET_FIELD: field name must be string");
    }

    let result: Value;
    if (isStructValue(source)) {
      const fieldId = this.findStructField(source.typeId, fieldName.v);
      result = fieldId !== undefined ? this.readStructFieldById(source, fieldId, fiber) : V.nil();
    } else {
      result = NIL_VALUE;
    }

    this.push(fiber, result);
    frame.pc++;
    return undefined;
  }

  // SET_FIELD is the dynamic (runtime-computed-key) struct write: resolve the field name
  // to its numeric id, then dispatch through the same id-based path as STRUCT_SET_FIELD.
  // It deep-copies the value (struct value-semantics) for the name-keyed callers that
  // still emit it; STRUCT_SET_FIELD itself is a pure store.
  private execSetField(fiber: Fiber, frame: Frame): undefined {
    const value = deepCopyValue(this.pop(fiber), this.runtime.types, fiber.executionContext);
    const fieldName = this.pop(fiber);
    const source = this.pop(fiber);

    if (!isStringValue(fieldName)) {
      throw new Error("SET_FIELD: field name must be string");
    }

    if (!isStructValue(source)) {
      throw new Error(`SET_FIELD: cannot set field '${fieldName.v}' on type ${source.t}`);
    }

    const fieldId = this.findStructField(source.typeId, fieldName.v);
    if (fieldId !== undefined) {
      this.writeStructFieldById(source, fieldId, value, fiber);
    }
    this.push(fiber, source);
    frame.pc++;
    return undefined;
  }

  private prepareArgsForFunction(
    fn: FunctionBytecode,
    args: ReadonlyList<Value>,
    executionContext: ExecutionContext,
    label: string
  ): ReadonlyList<Value> {
    if (fn.injectCtxTypeIdx !== undefined) {
      const expectedArgs = fn.numParams - 1;
      if (args.size() !== expectedArgs) {
        throw new Error(
          `Argument count mismatch for ${label}: expected ${expectedArgs} (ctx injected), got ${args.size()}`
        );
      }

      const ctxStruct = mkNativeStructValue(
        resolveProgramTypeId(this.prog.types, fn.injectCtxTypeIdx),
        executionContext
      );
      const effectiveArgs = List.empty<Value>();
      effectiveArgs.push(ctxStruct);
      for (let i = 0; i < args.size(); i++) {
        effectiveArgs.push(args.get(i)!);
      }
      return effectiveArgs;
    }

    if (args.size() !== fn.numParams) {
      throw new Error(`Argument count mismatch for ${label}: expected ${fn.numParams}, got ${args.size()}`);
    }

    return args;
  }

  private resolveDirectRuleFuncId(executionContext: ExecutionContext, funcId: number): number | undefined {
    return executionContext.services.brain.program.getRuleFuncIdForFunc(funcId);
  }

  private resolveFrameRuleFuncId(executionContext: ExecutionContext, frame: Frame | undefined): number | undefined {
    if (!frame) {
      return undefined;
    }
    if (frame.ruleFuncId !== undefined) {
      return frame.ruleFuncId;
    }
    return this.resolveDirectRuleFuncId(executionContext, frame.funcId);
  }

  private resolveCalleeRuleFuncId(
    executionContext: ExecutionContext,
    caller: Frame | undefined,
    calleeId: number
  ): number | undefined {
    return (
      this.resolveDirectRuleFuncId(executionContext, calleeId) ?? this.resolveFrameRuleFuncId(executionContext, caller)
    );
  }

  private bindExecutionContext(fiber: Fiber, frame: Frame, callSiteId: number): void {
    fiber.executionContext.currentCallSiteId = callSiteId;
    fiber.executionContext.currentRuleFuncId = this.resolveFrameRuleFuncId(fiber.executionContext, frame);
  }

  private syncExecutionContextFromTopFrame(fiber: Fiber): void {
    const topFrame = this.topFrame(fiber);
    if (!topFrame) {
      fiber.executionContext.currentCallSiteId = undefined;
      fiber.executionContext.currentRuleFuncId = undefined;
      return;
    }

    const actionBinding = this.getCurrentActionBinding(fiber);
    fiber.executionContext.currentCallSiteId = actionBinding?.callSiteId;
    fiber.executionContext.currentRuleFuncId = this.resolveFrameRuleFuncId(fiber.executionContext, topFrame);
  }

  private getCurrentActionBinding(fiber: Fiber) {
    for (let i = fiber.frames.size() - 1; i >= 0; i--) {
      const frame = fiber.frames.get(i)!;
      if (frame.actionBinding) {
        return frame.actionBinding;
      }
    }
    return undefined;
  }

  private getCurrentActionCallSiteId(fiber: Fiber, opName: string): number {
    const actionBinding = this.getCurrentActionBinding(fiber);
    if (actionBinding) {
      return actionBinding.callSiteId;
    }

    if (fiber.callsiteVars) {
      return -1;
    }

    throw new Error(`${opName}: no action state is bound to the current frame chain`);
  }

  private assertCanSuspend(fiber: Fiber, op: Op): void {
    const actionBinding = this.getCurrentActionBinding(fiber);
    if (actionBinding && !actionBinding.isAsync) {
      throw new Error(`${Op[op]}: sync bytecode action '${actionBinding.actionKey}' cannot suspend`);
    }
  }

  private snapshotStackArgs(fiber: Fiber, argc: number, opName: string): List<Value> {
    const stackSize = fiber.vstack.size();
    if (argc < 0 || argc > stackSize) {
      throwUnderflow(`${opName}: argc ${argc} exceeds stack size ${stackSize}`);
    }

    const args = List.empty<Value>();
    for (let i = 0; i < argc; i++) {
      args.push(fiber.vstack.get(stackSize - argc + i)!);
    }
    return args;
  }

  private enterBytecodeActionFrame(
    fiber: Fiber,
    callerFrame: Frame,
    action: BytecodeExecutableAction,
    args: ReadonlyList<Value>,
    callSiteId: number,
    actionSlot: number
  ): void {
    if (fiber.frames.size() >= this.config.maxFrameDepth) {
      throwOverflow(`Stack overflow: frame depth limit ${this.config.maxFrameDepth} exceeded`);
    }

    const fn = this.prog.functions.get(action.entryFuncId)!;
    const effectiveArgs = this.prepareArgsForFunction(
      fn,
      args,
      fiber.executionContext,
      `ACTION_CALL:${action.descriptor.key}`
    );
    const ruleFuncId = this.resolveFrameRuleFuncId(fiber.executionContext, callerFrame);
    this.assertLocalsCapacity(fiber, fn.numLocals ?? fn.numParams);
    const base = fiber.vstack.size();
    const locals = this.allocLocals(fn, effectiveArgs);

    callerFrame.pc++;
    fiber.executionContext.currentCallSiteId = callSiteId;
    fiber.executionContext.currentRuleFuncId = ruleFuncId;
    fiber.frames.push({
      funcId: action.entryFuncId,
      pc: 0,
      base,
      locals,
      ruleFuncId,
      actionBinding: {
        actionSlot,
        actionKey: action.descriptor.key,
        callSiteId,
        isAsync: false,
      },
    });
  }

  private spawnBytecodeActionFiber(
    parentFiber: Fiber,
    action: BytecodeExecutableAction,
    args: List<Value>,
    callSiteId: number,
    actionSlot: number
  ): Fiber {
    const childContext: ExecutionContext = { ...parentFiber.executionContext };
    const childFiber = this.spawnFiber(this.nextInternalFiberId--, action.entryFuncId, args, childContext);
    const ruleFuncId = this.resolveFrameRuleFuncId(parentFiber.executionContext, this.topFrame(parentFiber));
    const childFrame = this.topFrame(childFiber)!;

    childContext.currentCallSiteId = callSiteId;
    childContext.currentRuleFuncId = ruleFuncId;
    childFrame.ruleFuncId = ruleFuncId;
    childFiber.ruleFuncId = ruleFuncId;
    childFrame.actionBinding = {
      actionSlot,
      actionKey: action.descriptor.key,
      callSiteId,
      isAsync: true,
    };

    return childFiber;
  }

  private onFrameExited(fiber: Fiber, frame: Frame): void {
    this.syncExecutionContextFromTopFrame(fiber);
  }

  /**
   * Report the hand-back of a synchronous bytecode-action call whose frame has
   * just been popped with `result`. Call only for a frame that still has a
   * caller below it: a hook frame and an asynchronous action's child frame are
   * their fiber's entry frame and are not dispatch hand-backs. The reported
   * args are the body's parameter slots, skipping an injected context slot.
   */
  private reportBytecodeActionReturn(frame: Frame, result: Value): void {
    const actionBinding = frame.actionBinding;
    if (!actionBinding || actionBinding.isAsync) {
      return;
    }
    const listener = this.events?.onHostActionReturn;
    if (!listener) {
      return;
    }

    const fn = this.prog.functions.at(frame.funcId);
    if (!fn) {
      return;
    }
    const firstParam = fn.injectCtxTypeIdx !== undefined ? 1 : 0;
    const args = List.empty<Value>();
    for (let i = firstParam; i < fn.numParams; i++) {
      args.push(frame.locals.get(i)!);
    }
    listener({
      binding: "bytecode",
      actionId: actionBinding.actionSlot,
      callSiteId: actionBinding.callSiteId,
      args,
      result,
    });
  }

  private resolveAsyncActionHandle(fiber: Fiber, result: Value): void {
    const handleId = fiber.asyncResultHandleId;
    if (handleId === undefined) {
      return;
    }

    fiber.asyncResultHandleId = undefined;
    const handle = this.handles.get(handleId);
    if (!handle || handle.state !== HandleState.PENDING) {
      return;
    }

    this.handles.resolve(handleId, result);
  }

  private rejectAsyncActionHandle(fiber: Fiber, err: ErrorValue): void {
    const handleId = fiber.asyncResultHandleId;
    if (handleId === undefined) {
      return;
    }

    fiber.asyncResultHandleId = undefined;
    const handle = this.handles.get(handleId);
    if (!handle || handle.state !== HandleState.PENDING) {
      return;
    }

    this.handles.reject(handleId, err);
  }

  private cancelAsyncActionHandle(fiber: Fiber): void {
    const handleId = fiber.asyncResultHandleId;
    if (handleId === undefined) {
      return;
    }

    fiber.asyncResultHandleId = undefined;
    const handle = this.handles.get(handleId);
    if (!handle || handle.state !== HandleState.PENDING) {
      return;
    }

    this.handles.cancel(handleId);
  }

  resumeFiberFromHandle(fiber: Fiber, handleId: HandleId, scheduler: Scheduler): void {
    if (fiber.state !== FiberState.WAITING) {
      return;
    }

    if (!fiber.await || fiber.await.handleId !== handleId) {
      return;
    }

    const h = this.handles.get(handleId);
    if (!h) {
      const err: ErrorValue = this.makeError(ErrorCode.HostError, `Handle ${handleId} no longer exists`);
      fiber.lastError = err;
      fiber.pendingInjectedThrow = true;
      fiber.await = undefined;
      this.transitionState(fiber, FiberState.RUNNABLE);
      scheduler.enqueueRunnable(fiber.id);
      return;
    }

    const a = fiber.await;
    while (fiber.frames.size() > a.frameDepth) {
      fiber.frames.pop();
    }
    while (fiber.vstack.size() > a.stackHeight) {
      fiber.vstack.pop();
    }

    const frame = this.topFrame(fiber);
    if (frame) {
      frame.pc = a.resumePc;
    }

    fiber.await = undefined;
    this.transitionState(fiber, FiberState.RUNNABLE);

    if (h.state === HandleState.RESOLVED) {
      this.push(fiber, h.result ?? V.nil());
    } else {
      const err: ErrorValue =
        h.error ??
        (h.state === HandleState.CANCELLED
          ? this.makeError(ErrorCode.Cancelled, "Operation cancelled")
          : this.makeError(ErrorCode.HostError, "Operation failed"));
      fiber.lastError = err;
      fiber.pendingInjectedThrow = true;
    }

    scheduler.enqueueRunnable(fiber.id);
  }

  cancelFiber(fiber: Fiber, scheduler: Scheduler): void {
    if (fiber.state === FiberState.DONE || fiber.state === FiberState.FAULT || fiber.state === FiberState.CANCELLED) {
      return;
    }

    if (fiber.state === FiberState.WAITING && fiber.await) {
      const h = this.handles.get(fiber.await.handleId);
      if (h) {
        h.waiters.delete(fiber.id);
      }
      fiber.await = undefined;
    }

    this.transitionState(fiber, FiberState.CANCELLED);
    fiber.lastError = this.makeError(ErrorCode.Cancelled, "Fiber cancelled");
    this.cancelAsyncActionHandle(fiber);
    this.events?.onFiberCancelled?.({ fiberId: fiber.id });
  }

  private topFrame(fiber: Fiber): Frame | undefined {
    const n = fiber.frames.size();
    return n > 0 ? fiber.frames.get(n - 1) : undefined;
  }

  private peek(fiber: Fiber): Value {
    const n = fiber.vstack.size();
    if (n <= 0) {
      throwUnderflow("Stack underflow: cannot peek empty stack");
    }
    return fiber.vstack.get(n - 1)!;
  }

  private pop(fiber: Fiber): Value {
    if (fiber.vstack.size() <= 0) {
      throwUnderflow("Stack underflow: cannot pop empty stack");
    }
    return fiber.vstack.pop()!;
  }

  private push(fiber: Fiber, v: Value): void {
    if (fiber.vstack.size() >= this.config.maxStackSize) {
      throwOverflow(`Stack overflow: limit ${this.config.maxStackSize} exceeded`);
    }
    fiber.vstack.push(v);
  }

  private allocLocals(fn: FunctionBytecode, args: ReadonlyList<Value>): List<Value> {
    const numLocals = fn.numLocals ?? fn.numParams;
    const locals = List.empty<Value>();
    for (let i = 0; i < numLocals; i++) {
      locals.push(i < args.size() ? args.get(i)! : V.nil());
    }
    return locals;
  }

  /**
   * Faults with an {@link OverflowError} when pushing a frame with `numLocals`
   * locals would carry the fiber's total live locals (summed across every live
   * frame) past `maxLocalsSize`.
   */
  private assertLocalsCapacity(fiber: Fiber, numLocals: number): void {
    let total = 0;
    for (let i = 0; i < fiber.frames.size(); i++) {
      total += fiber.frames.get(i)!.locals.size();
    }
    if (total + numLocals > this.config.maxLocalsSize) {
      throwOverflow(`Stack overflow: locals limit ${SU.toString(this.config.maxLocalsSize)} exceeded`);
    }
  }

  private doCall(fiber: Fiber, calleeId: number, argc: number): void {
    if (calleeId < 0 || calleeId >= this.prog.functions.size()) {
      throw new Error(`CALL: function ${calleeId} out of bounds`);
    }

    if (fiber.frames.size() >= this.config.maxFrameDepth) {
      throwOverflow(`Stack overflow: frame depth limit ${this.config.maxFrameDepth} exceeded`);
    }

    const callee = this.prog.functions.get(calleeId)!;
    if (argc !== callee.numParams) {
      throw new Error(`CALL: argc ${argc} != numParams ${callee.numParams}`);
    }
    this.assertLocalsCapacity(fiber, callee.numLocals ?? callee.numParams);

    // Pop arguments from stack in correct order
    const args = List.empty<Value>();
    for (let i = 0; i < argc; i++) {
      args.push(V.nil());
    }
    for (let i = argc - 1; i >= 0; i--) {
      args.set(i, this.pop(fiber));
    }

    const caller = this.topFrame(fiber);
    if (caller) caller.pc++;

    const base = fiber.vstack.size();
    const locals = this.allocLocals(callee, args);

    fiber.frames.push({
      funcId: calleeId,
      pc: 0,
      base,
      locals,
      ruleFuncId: this.resolveCalleeRuleFuncId(fiber.executionContext, caller, calleeId),
    });
  }

  private doRet(fiber: Fiber, retv: Value): boolean {
    const frame = fiber.frames.pop();
    if (!frame) {
      this.push(fiber, retv);
      return true;
    }

    this.onFrameExited(fiber, frame);
    if (fiber.frames.size() > 0) {
      this.reportBytecodeActionReturn(frame, retv);
    }

    // Debug mode: check for stack leaks before cleanup
    if (this.config.debugStackChecks) {
      const expectedStackSize = frame.base + 1; // base + return value that was just popped
      const actualStackSize = fiber.vstack.size();
      if (actualStackSize > frame.base) {
        const leaked = actualStackSize - frame.base;
        const fn = this.prog.functions.at(frame.funcId);
        const fnName = fn?.name ?? `func[${frame.funcId}]`;
        logger.warn(
          `[VM] Stack leak detected in ${fnName}: expected stack at ${frame.base}, found ${actualStackSize} (${leaked} extra values). Cleaning up.`
        );
      }
    }

    while (fiber.vstack.size() > frame.base) {
      fiber.vstack.pop();
    }

    if (fiber.frames.size() === 0) {
      this.push(fiber, retv);
      return true;
    }

    this.push(fiber, retv);
    return false;
  }

  private throwValue(fiber: Fiber, err: ErrorValue): boolean {
    fiber.await = undefined;

    while (fiber.handlers.size() > 0) {
      const h = fiber.handlers.pop()!;

      while (fiber.frames.size() > h.frameDepth) {
        const exited = fiber.frames.pop();
        if (exited) {
          this.onFrameExited(fiber, exited);
        }
      }
      while (fiber.vstack.size() > h.stackHeight) {
        fiber.vstack.pop();
      }

      this.push(fiber, V.err(err));

      const frame = this.topFrame(fiber);
      if (frame) {
        frame.pc = h.catchPc;
      }

      return true;
    }

    fiber.lastError = err;
    return false;
  }

  private transitionState(fiber: Fiber, newState: FiberState): void {
    const validTransitions = VALID_TRANSITIONS[fiber.state];
    if (!validTransitions.has(newState)) {
      throw new Error(`Invalid state transition: ${fiber.state} -> ${newState}`);
    }
    fiber.state = newState;

    if (newState === FiberState.DONE || newState === FiberState.FAULT || newState === FiberState.CANCELLED) {
      this.settleRuleWatchers(fiber, newState);
    }
  }

  /**
   * The settle walk, run at every fiber terminal transition. Takes the
   * finishing fiber's rule and walks it and its ancestors. A fiber that faulted
   * or was cancelled marks every rule on that walk -- the whole set of clusters
   * it belonged to -- as an abandoned firing. Then, for each rule whose cluster
   * has emptied, resolves the pending trigger handle in that rule's watcher slot
   * and clears the slot: `true` on a `DidFire` record with no abandonment mark,
   * `false` otherwise.
   *
   * Call only once `fiber.state` is terminal.
   */
  private settleRuleWatchers(fiber: Fiber, cause: FiberState): void {
    const brain = fiber.executionContext.services.brain;
    const abandoning = cause !== FiberState.DONE;

    let ruleFuncId = fiber.ruleFuncId;
    while (ruleFuncId !== undefined) {
      if (abandoning) {
        brain.ruleCompletion.markAbandoned(ruleFuncId);
      }
      const handleId = brain.ruleCompletion.getWatcher(ruleFuncId);
      if (handleId !== undefined && !brain.ruleCompletion.hasLiveSubtree(ruleFuncId)) {
        const fired =
          !brain.ruleCompletion.isAbandoned(ruleFuncId) &&
          brain.ruleFiring.get(ruleFuncId) === RuleFiringState.DID_FIRE;
        brain.ruleCompletion.clearWatcher(ruleFuncId);
        if (this.handles.get(handleId)?.state === HandleState.PENDING) {
          this.handles.resolve(handleId, fired ? TRUE_VALUE : FALSE_VALUE);
        }
      }
      ruleFuncId = this.ruleParentFuncId(ruleFuncId);
    }
  }

  /**
   * The parent rule of `ruleFuncId` in the loaded program's rule-ancestor table.
   * Returns `undefined` for a root rule and for a funcId the table does not
   * declare.
   */
  ruleParentFuncId(ruleFuncId: number): number | undefined {
    const ancestors = this.prog.ruleAncestors;
    return ancestors !== undefined ? ancestors.get(ruleFuncId) : undefined;
  }

  private faultFiber(fiber: Fiber, err: ErrorValue, scheduler: Scheduler): void {
    fiber.lastError = err;
    this.transitionState(fiber, FiberState.FAULT);
    this.rejectAsyncActionHandle(fiber, err);
    this.events?.onFiberFault?.({ fiberId: fiber.id, err });
  }

  /**
   * Construct an {@link ErrorValue} for an in-VM fault. Allocates a fresh
   * object carrying `message`, `detail`, and `site`.
   */
  private makeError(
    code: ErrorCode,
    message: string,
    opts?: { detail?: unknown; site?: { funcId: number; pc: number } }
  ): ErrorValue {
    const err: ErrorValue = { code: code, message };
    if (opts?.detail !== undefined) err.detail = opts.detail;
    if (opts?.site !== undefined) err.site = opts.site;
    return err;
  }
}

///////////////////////////
// Fiber Scheduler
///////////////////////////

/** Tunables for {@link FiberScheduler}. */
export interface SchedulerConfig {
  /** Instruction budget granted to each fiber's slice of a tick. */
  defaultBudget: number;
  /**
   * Instruction budget granted to a page-lifecycle hook fiber. Hook fibers
   * run to completion outside the tick loop via a direct `runFiber` call.
   */
  hookBudget: number;
  autoGcHandles: boolean;
  /**
   * Maximum number of fibers the scheduler tracks at once. Checked at spawn;
   * exceeding it throws an {@link OverflowError}, surfacing as a `StackOverflow`
   * fault when the spawn came from bytecode.
   */
  maxFibers: number;
}

/** Default values for {@link SchedulerConfig}. */
export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  defaultBudget: 1000,
  hookBudget: 10000,
  autoGcHandles: true,
  maxFibers: 10000,
};

/** Concrete cooperative {@link IFiberScheduler}: maintains a fiber pool and dispatches budgeted execution slices on each `tick()`. */
export class FiberScheduler implements IFiberScheduler {
  private config: SchedulerConfig;
  private fibers = new Dict<number, Fiber>();
  private runQueue = List.empty<number>();
  // Child-rule fibers spawned during the current tick, held out of the run queue.
  // They drain within this same tick (a synchronous same-think cascade). Empty
  // whenever no SPAWN_RULE ran this tick, which keeps `tick()` byte-identical for
  // a brain that spawns no child rules.
  private pendingSpawns = List.empty<number>();
  private nextFiberId = 1;

  constructor(
    private vm: VM,
    config?: Partial<SchedulerConfig>
  ) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
    this.vm.handles.events.on("completed", (handleId) => this.onHandleCompleted(handleId));
  }

  spawn(funcId: number, args: List<Value>, executionContext: ExecutionContext): number {
    const fiberId = this.nextFiberId++;
    const fiber = this.vm.spawnFiber(fiberId, funcId, args, executionContext);
    this.addFiber(fiber);
    return fiberId;
  }

  addFiber = (fiber: Fiber): void => {
    this.registerFiber(fiber);
    this.enqueueRunnable(fiber.id);
  };

  /**
   * Records a newly constructed fiber in the fiber table, enforcing the
   * `maxFibers` cap. Leaves the fiber out of the run queue; the caller decides
   * whether it joins the run queue ({@link addFiber}) or the same-think spawn
   * drain ({@link spawnChildRule}).
   */
  private registerFiber(fiber: Fiber): void {
    if (this.fibers.size() >= this.config.maxFibers) {
      throwOverflow(`Fiber limit exceeded: ${this.config.maxFibers}`);
    }
    this.fibers.set(fiber.id, fiber);
  }

  removeFiber(fiberId: number): void {
    this.fibers.delete(fiberId);
  }

  getFiber = (fiberId: number): Fiber | undefined => {
    return this.fibers.get(fiberId);
  };

  enqueueRunnable = (fiberId: number): void => {
    const fiber = this.getFiber(fiberId);
    if (!fiber) return;

    if (fiber.state !== FiberState.RUNNABLE) return;

    if (this.runQueue.contains(fiberId)) return;

    this.runQueue.push(fiberId);
  };

  onHandleCompleted = (handleId: HandleId): void => {
    const h = this.vm.handles.get(handleId);
    if (!h) return;

    const waiters = List.empty<number>();
    h.waiters.forEach((fid) => {
      waiters.push(fid);
    });
    h.waiters.clear();

    for (let i = 0; i < waiters.size(); i++) {
      const fiberId = waiters.get(i)!;
      const fiber = this.getFiber(fiberId);
      if (fiber) {
        this.vm.resumeFiberFromHandle(fiber, handleId, this);
      }
    }

    // A settle with waiters has been consumed by their resume, so it can be
    // collected now. A settle with no waiters happened before its AWAIT (a
    // handle resolved during dispatch); it must survive for that AWAIT to read,
    // so it is left for the think-boundary sweep in gc() after AWAIT consumes it.
    if (this.config.autoGcHandles && waiters.size() > 0 && h.state !== HandleState.PENDING) {
      this.vm.handles.delete(handleId);
    }
  };

  cancel(fiberId: number): void {
    const fiber = this.getFiber(fiberId);
    if (fiber) {
      this.vm.cancelFiber(fiber, this);
    }
  }

  /**
   * Spawns a fire-and-forget child-rule fiber for `funcId`, tagged with
   * `subtreeRootFuncId` (the funcId of the root rule whose subtree it belongs
   * to), and holds it in the same-think spawn drain. The child runs later in the
   * current `tick()`, after its parent's slice, as a synchronous cascade.
   */
  spawnChildRule = (funcId: number, subtreeRootFuncId: number, executionContext: ExecutionContext): void => {
    const fiberId = this.nextFiberId++;
    const fiber = this.vm.spawnFiber(fiberId, funcId, List.empty(), executionContext);
    fiber.rootRuleFuncId = subtreeRootFuncId;
    this.registerFiber(fiber);
    this.pendingSpawns.push(fiberId);
  };

  hasLiveDescendantOfRoot(rootRuleFuncId: number): boolean {
    for (const [, fiber] of this.fibers.entries().toArray()) {
      if (
        fiber.rootRuleFuncId === rootRuleFuncId &&
        (fiber.state === FiberState.RUNNABLE || fiber.state === FiberState.WAITING)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * True when any live (runnable or waiting) fiber belongs to `ruleFuncId`'s
   * cluster: its own fiber, or a fiber whose rule reaches `ruleFuncId` by
   * walking the program's rule-ancestor chain. Child-rule fibers held in the
   * current tick's spawn drain are runnable and count.
   */
  hasLiveRuleSubtree(ruleFuncId: number): boolean {
    for (const [, fiber] of this.fibers.entries().toArray()) {
      if (fiber.state !== FiberState.RUNNABLE && fiber.state !== FiberState.WAITING) {
        continue;
      }
      let cur = fiber.ruleFuncId;
      while (cur !== undefined) {
        if (cur === ruleFuncId) return true;
        cur = this.vm.ruleParentFuncId(cur);
      }
    }
    return false;
  }

  /**
   * Cancels every live child-rule fiber (those carrying a `rootRuleFuncId`). The
   * page-scoped cancellation cascade: exactly one page is active, so every live
   * child-rule fiber descends from one of its root rules. Cancelling marks each
   * `CANCELLED`; `tick` skips cancelled fibers still in the run queue, so the
   * cascade is safe mid-round.
   */
  cancelChildRuleFibers(): void {
    for (const [, fiber] of this.fibers.entries().toArray()) {
      if (
        fiber.rootRuleFuncId !== undefined &&
        (fiber.state === FiberState.RUNNABLE || fiber.state === FiberState.WAITING)
      ) {
        this.vm.cancelFiber(fiber, this);
      }
    }
  }

  /**
   * Executes one round: every fiber in the runnable queue at entry receives
   * exactly one `defaultBudget` slice, in FIFO order. After each slice, the
   * child rules that slice spawned drain within this same tick as a synchronous
   * cascade ({@link drainSpawnedSubtrees}). Fibers enqueued while the round runs
   * for another reason -- a `YIELD` or budget-exhaustion re-enqueue, a handle
   * resume -- stay queued and run in the next tick.
   *
   * @returns Number of fibers that received a slice this tick, including drained
   * child-rule fibers.
   */
  tick(): number {
    let executed = 0;
    const roundSize = this.runQueue.size();

    for (let i = 0; i < roundSize; i++) {
      const fiberId = this.runQueue.shift()!;
      const fiber = this.getFiber(fiberId);

      if (!fiber || fiber.state !== FiberState.RUNNABLE) {
        continue;
      }

      fiber.instrBudget = this.config.defaultBudget;
      const result = this.vm.runFiber(fiber, this);
      this.routeSliceResult(fiberId, result);
      executed++;

      executed += this.drainSpawnedSubtrees();
    }

    return executed;
  }

  /**
   * Routes the outcome of a single fiber slice. A `YIELDED` fiber (a `YIELD`
   * opcode or budget exhaustion) re-enters the run queue for the next round. A
   * `WAITING`, `DONE`, or `FAULT` fiber needs no queue action: the VM parked it
   * on its handle or transitioned it terminal during the slice.
   */
  private routeSliceResult(fiberId: number, result: VmRunResult): void {
    switch (result.status) {
      case VmStatus.YIELDED:
        this.enqueueRunnable(fiberId);
        break;
      case VmStatus.WAITING:
      case VmStatus.DONE:
      case VmStatus.FAULT:
        break;
    }
  }

  /**
   * Runs the child-rule fibers spawned during the just-finished slice as a
   * same-think synchronous cascade, depth-first: each child receives a budget
   * slice, and any grandchildren it spawns drain immediately -- before that
   * child's next sibling -- so one subtree completes before the next begins. A
   * child that completes frees within this tick; a child that parks on `AWAIT`,
   * yields, or exhausts its budget takes its normal next-round or handle-wait
   * path, unchanged.
   *
   * @returns Number of child-rule slices run.
   */
  private drainSpawnedSubtrees(): number {
    if (this.pendingSpawns.size() === 0) {
      return 0;
    }
    let executed = 0;
    const children = this.pendingSpawns;
    this.pendingSpawns = List.empty<number>();

    for (let i = 0; i < children.size(); i++) {
      const childId = children.get(i)!;
      const fiber = this.getFiber(childId);
      if (!fiber || fiber.state !== FiberState.RUNNABLE) {
        continue;
      }

      fiber.instrBudget = this.config.defaultBudget;
      const result = this.vm.runFiber(fiber, this);
      this.routeSliceResult(childId, result);
      executed++;

      executed += this.drainSpawnedSubtrees();
    }

    return executed;
  }

  getStats(): {
    totalFibers: number;
    runnableFibers: number;
    waitingFibers: number;
    doneFibers: number;
    faultedFibers: number;
    cancelledFibers: number;
    pendingHandles: number;
  } {
    let runnable = 0;
    let waiting = 0;
    let done = 0;
    let faulted = 0;
    let cancelled = 0;

    for (const [, fiber] of this.fibers.entries().toArray()) {
      switch (fiber.state) {
        case FiberState.RUNNABLE:
          runnable++;
          break;
        case FiberState.WAITING:
          waiting++;
          break;
        case FiberState.DONE:
          done++;
          break;
        case FiberState.FAULT:
          faulted++;
          break;
        case FiberState.CANCELLED:
          cancelled++;
          break;
      }
    }

    return {
      totalFibers: this.fibers.size(),
      runnableFibers: runnable,
      waitingFibers: waiting,
      doneFibers: done,
      faultedFibers: faulted,
      cancelledFibers: cancelled,
      pendingHandles: this.vm.handles.size(),
    };
  }

  gc(): number {
    let removed = 0;
    for (const [id, fiber] of this.fibers.entries().toArray()) {
      if (fiber.state === FiberState.DONE || fiber.state === FiberState.FAULT || fiber.state === FiberState.CANCELLED) {
        this.fibers.delete(id);
        removed++;
      }
    }
    // Sweep settled handles consumed by an AWAIT this round but left live because
    // they had no waiter when they settled (resolved during dispatch). Pending
    // handles and those still awaited are retained.
    if (this.config.autoGcHandles) {
      removed += this.vm.handles.gc();
    }
    return removed;
  }
}
