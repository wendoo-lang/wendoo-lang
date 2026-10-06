---
applyTo: "packages/core/src/runtime/**"
---

<!-- Last reviewed: 2026-05-04 -->

# VM Runtime

The brain VM (`packages/core/src/runtime/`) is a stack-based bytecode virtual machine with fiber-based concurrency. Brain orchestration files (`brain.ts`, `page.ts`, `rule.ts`) live in `packages/core/src/brain/`. See also `brain.instructions.md` for the broader brain architecture (tiles, parser, compiler, value model).

## Execution Model

- **Stack-based** bytecode VM with **fibers** (lightweight coroutines)
- **Budget-limited** execution: each fiber has `instrBudget` decremented per instruction
- Single-threaded -- one fiber runs at a time

## Key Files

All files below are under `packages/core/src/runtime/` unless noted otherwise.

- `vm.ts` - `VM` class and `FiberScheduler`
- `vm-types.ts` - `Fiber`, `Frame`, `FiberState`, `IFiberScheduler`, and related interfaces
- `bytecode.ts` - `Op` enum, `FunctionBytecode`, `ConstantPools`, instruction encoding
- `program.ts` - `Program` and `ProgramArtifact` interfaces
- `host-bindings.ts` - `UnlinkedBrainProgram`, `LinkedBrainProgram`, `PageMetadata`, `IBrain`, `BrainEvents`, `ActionCallSiteEntry`
- `linker.ts` - `linkBrainProgram` (splices action artifacts into a compiled program)
- `context.ts` - `ExecutionContext`, `HostActionBinding`, `BytecodeExecutableAction`, `ExecutableAction`
- `services.ts` - `PlatformServices` aggregate and sub-service interfaces (`IProgramServices`, `IBrainVariableServices`, `IRuleVariableServices`, etc.)
- `functions.ts` - `FunctionRegistry` for host functions
- `operators.ts` - `OperatorTable`, `OperatorOverloads`
- `conversions.ts` - Type conversion registry
- `type-system.ts` - `TypeRegistry`
- `value.ts` - `Value` tagged-union and singleton constants
- `context-types.ts` - Context, SelfContext, EngineContext struct type registration
- `callsite-store.ts` - Per-call-site state store (`ICallsiteStore`)
- `runtime-services.ts` / `rule-services.ts` - Factory helpers that build the `PlatformServices` adapters
- `tree-shaker.ts` - `treeshakeProgram` (dead-code elimination on linked programs)
- `action-registry.ts` - Action registration helpers
- `sensors/` / `actuators/` - Core sensor and actuator implementations
- `packages/core/src/brain/brain.ts` - `Brain` class: page/rule orchestration, variable storage, think() loop
- `packages/core/src/brain/page.ts` / `rule.ts` - Page and Rule runtime instances

## Opcodes

The full opcode reference -- numeric assignments, operand layout,
stack effects, fault conditions, and per-group prose -- lives in
[docs/specs/contracts/vm-contract.md](../../docs/specs/contracts/vm-contract.md)
under "Opcode reference". The TS expression of the same numeric
assignments is the `Op` enum in
`packages/core/src/runtime/bytecode.ts`. When changing an opcode in
either place, update both in the same unit.

### Frame and capture layout

`Frame` carries:

- `locals: List<Value>` -- indexed slots sized by `fn.numLocals ?? fn.numParams`. Args fill slots 0..numParams-1; rest are nil.
- `captures?: List<Value>` -- closure capture list set when entering a closure function via an indirect call.

## Key Data Structures

### Program vs UnlinkedBrainProgram / LinkedBrainProgram

`Program` (base, in `program.ts`): `{ version, functions, constantPools, variableNames, entryPoint?, actions?, ruleFuncIds?, ruleAncestors? }`

- `constantPools: ConstantPools` -- three typed sub-pools: `numbers`, `strings`, `values`
- `actions?: List<ExecutableAction>` -- bound action slots populated by the linker
- `ruleFuncIds?: UniqueSet<number>` -- identifies which function IDs are rule entry points
- `ruleAncestors?: Dict<number, number>` -- maps child rule funcId to parent rule funcId; backs the ancestor-walk in `IRuleVariableServices`

`UnlinkedBrainProgram` (in `host-bindings.ts`): extends `Program` with `ruleIndex: Dict<string, number>` and `pages: List<PageMetadata>`. Emitted by the brain compiler before action linking.

`LinkedBrainProgram` (in `host-bindings.ts`): the post-linker output; contains `program: Program` plus `ruleIndex` and `pages`. The `Brain` unpacks this and holds each field separately.

`PageMetadata` (in `host-bindings.ts`): `{ pageIndex, pageId, pageName, rootRuleFuncIds, actionCallSites, sensors, actuators }`

- `actionCallSites: List<ActionCallSiteEntry>` -- all `ACTION_CALL` / `ACTION_CALL_ASYNC` call sites in the page's rule tree (replaces the old `hostCallSites`)

### FunctionBytecode

```typescript
interface FunctionBytecode {
  code: List<Instr>;
  numParams: number;
  numLocals?: number;   // total local slots; defaults to numParams
  name?: string;
  maxStackDepth?: number;
  injectCtxTypeId?: TypeId; // if set, VM wraps ExecutionContext as arg[0] native struct
}
```

### Fiber

```typescript
interface Fiber {
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
  executionContext: ExecutionContext;
  callsiteVars?: List<Value>;
  asyncResultHandleId?: HandleId; // set on ACTION_CALL_ASYNC child fibers; cleared on resolve/reject/cancel
}
```

### Value Types

Primitives: `Unknown`, `Void`, `Nil`, `Boolean`, `Number`, `String`, `Enum`
Collections: `List` (`{ t: NativeType.List; typeId; v: List<Value> }`), `Map`, `Struct`
Callable: `FunctionValue` (`{ t: NativeType.Function; funcId: number; captures?: List<Value> }`)
VM-internal (not user-visible): handle, err

Singletons: `UNKNOWN_VALUE`, `VOID_VALUE`, `NIL_VALUE`, `TRUE_VALUE`, `FALSE_VALUE`

### StructValue and Field Hooks

`STRUCT_GET`/`STRUCT_SET` resolve field names through `StructTypeDef.fieldIndexByName` and then access `struct.v` (the indexed `List<Value>`).
`GET_FIELD`/`SET_FIELD` go through `fieldGetter`/`fieldSetter` hooks registered on the `StructTypeDef` when present, enabling native-backed struct types; otherwise they use `fieldIndexByName`.

## Fiber Lifecycle

`FiberState`: `RUNNABLE -> WAITING -> RUNNABLE`, `RUNNABLE -> DONE`, `RUNNABLE -> FAULT`, or `-> CANCELLED`

`VmRunResult`:
- `DONE` (with optional result)
- `YIELDED` (budget exhausted; scheduler re-enqueues)
- `WAITING` (suspended on a handle; resumed via `onHandleCompleted`)
- `FAULT` (with `ErrorValue`)

## Variable Access

Variable access is **slot-keyed at dispatch time**. The `LOAD_VAR_SLOT` and `STORE_VAR_SLOT` opcodes carry a `slotId: u16` operand which is a program-scoped index into `Program.variableNames`. The dispatch loop calls `ExecutionContext.getVariableBySlot(slotId)` / `setVariableBySlot(slotId, value)` -- it performs no `Dict.get(name)` lookup for variable access.

`Brain` owns the value list:

- `Brain.variables: List<Value | undefined>` -- one entry per slot. `undefined` means the slot holds no value; bytecode reads observe `NIL_VALUE`. At program load each slot is seeded with its type's starting value from `Program.variableInitValues`, so only a slot whose type declares none starts `undefined`.
- `Brain.varSlotByName: Dict<string, number>` -- name -> slot map, rebuilt at program load from `Program.variableNames` via the private `installVariableTable(program)` helper. Hot-reload copies values forward by name; variables present only in the previous program are dropped.

Starting values are resolved entirely by the brain compiler: it reads the slot type's `TypeDef.zero`, interns the value into `constantPools.values`, and records the pool index per slot in `Program.variableInitValues`. `Number`, `Boolean`, and `String` declare a zero (`0`, `false`, `""`); every other type starts nil. No VM applies a zero policy of its own -- each only seeds from that list, so all VMs agree by construction.

Name-keyed access is available to host code via `Brain` / `IBrain`: `getVariable`, `setVariable`, `clearVariable`, `clearVariables`. Writing through `setVariable(name, value)` for a name not present in `variableNames` lazy-extends the value list with a fresh slot; that slot is **not addressable from bytecode** and is dropped on the next `installVariableTable` call.

Rule-level variables are separate from brain variables and are stored per-rule in `Brain.ruleVariableStores`. They are accessed through `PlatformServices.ruleVars` (`IRuleVariableServices`). Reads walk the ancestor chain declared in `Program.ruleAncestors` -- a read on a child rule resolves up through parent rules until a value is found or all ancestors are exhausted.

## FiberScheduler

- `tick()` -- dequeues up to `maxFibersPerTick` RUNNABLE fibers, sets `instrBudget = defaultBudget`, calls `vm.runFiber`; re-enqueues on YIELDED
- `onHandleCompleted` -- resumes all waiting fibers for a handle via `vm.resumeFiberFromHandle`
- `gc()` -- removes DONE/FAULT/CANCELLED fibers
- Defaults: `maxFibersPerTick: 64`, `defaultBudget: 1000`, `autoGcHandles: true`

## Brain.think() Loop

1. Handle pending page restart (`restartPageRequested` flag). Fibers were already cancelled by `requestPageRestart()`; the flag is cleared here and `thinkPage()` detects and respawns them. Deactivate/activate is intentionally skipped so callsite state, action instances, and page events are preserved.
2. Handle page change (deactivate current page, emit `page_deactivated` event, activate new page, emit `page_activated` event).
3. `thinkPage()`: update `executionContext.time/dt/currentTick`, respawn any completed/faulted/cancelled root-rule fibers, call `scheduler.tick()`, then `scheduler.gc()`.

Page activation calls `onPageEntered` for each `actionCallSites` entry (host-backed actions) and runs activation hooks for bytecode-backed actions, then spawns one fiber per `rootRuleFuncIds`.

## OperatorOverloads

`OperatorOverloads.binary`/`unary` auto-register the `HostFn` in the `FunctionRegistry` under a generated name (`$$op_{op}_{types}_to_{resultType}`) and add the overload to the `OperatorTable`. Before registering anything they refuse an operator id the table does not hold and an overload over operand types the operator already holds, by `OperatorOverloadErrorCode`; the earlier overload stands. Resolve with `OperatorOverloads.resolve(id, argTypes)`.

## TypeRegistry

Notable methods: `addEnumType` (auto-registers eq/neq), `addNullableType` (wraps base type as nullable), `getOrCreateUnionType` (normalizes, dedupes, sorts; 2-member unions with Nil become `NullableTypeDef`), `addStructMethods`, `removeUserTypes` (removes module-scoped user types with `::` in name), `isStructurallyCompatible`.
