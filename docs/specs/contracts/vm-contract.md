# VM Contract

The implementation contract shared between the TypeScript reference VM
(`packages/core/src/runtime/vm.ts`) and the eventual C++ MCU
port. Covers opcode set, operand semantics, value model, numeric
semantics, calling convention, fiber scheduling, error model, feature
flags, and resource limits. Does
_not_ cover wire format; the
[Binary format appendix](#binary-format-appendix) is reserved for the
MCU binary layout once that container format is specified.

When this spec and the code disagree, the spec is wrong; fix it in
the same change.

## Trust model

The VM trusts the bytecode it receives. There is no static
verification layer; the compiler is the sole guarantor of validity.
Malformed bytecode -- out-of-bounds operands, unknown opcodes, jump
targets past end-of-function, mismatched call arities, etc. --
surfaces as a `ScriptError` fault on the offending fiber. No
platform-level throw escapes `runFiber`.

## Single-entry guarantee

The VM is **single-entry**. Only the wendoo host loop may call
`brain.think()`, `scheduler.tick()`, `runFiber()`, or
resolve / reject async handles. These entry points are mutually
exclusive in time -- one is active at a time, on one thread of
execution, with no nesting.

The design rule that produces this property:

```
ISR / event source / CODAL / browser callback  ->  enqueue only
wendoo host loop                             ->  drain, resolve,
                                                    schedule, execute
```

Anything outside the host loop -- a microbit fiber, a CODAL ISR, a
DOM event handler, a `setTimeout` callback, an MQTT message
listener -- only ever **enqueues** work onto a host-owned queue
(typically a handle-completion queue or a deferred-event queue).
The host loop is the sole consumer of those queues and the sole
caller of the VM entry points listed above. This rule applies
identically on Node, browser, and the C++ MCU port -- the names of
the outer event sources differ, the rule does not.

The "enqueue only" constraint is transitive. Any callback the host
fans out to from inside a host call -- e.g. CODAL `MessageBus::send`
delivering to immediate listeners synchronously, an `EventEmitter`
firing handlers inline, a Promise `.then` resolved while a host
function is executing -- is also forbidden from re-entering the VM.
Such callbacks are allowed to run inline because they themselves
only enqueue: the work they post is observed by the host loop on
its next drain, after `runFiber()` returns. The VM is not
re-entered. The single-entry guarantee survives intact even though
the call graph fans out arbitrarily, because the only edges that
return _into_ the VM are the four entry points, and only the host
loop ever takes those edges.

A `HostSyncFn.exec` or `HostAsyncFn.exec` body MUST NOT invoke any
of these entry points, directly or transitively. The operand stack,
fiber state, scheduler queue, and any host-call argument view
(`ReadonlyList<Value>`) are owned by the active
dispatcher and are valid only for the synchronous duration of the
host call. Re-entry corrupts all of these without diagnostic.

This is a contract, not a runtime check. It is enforced by code
review at the small set of host-function registration sites in
`packages/core/src/runtime/*` and at the public seam in
`packages/core/src/wendoo.ts`. User TS code never registers host
functions and is not subject to this rule.

### Optional re-entry guard

Implementations MAY install a cheap dispatcher-level re-entry guard
to surface contract violations as a deterministic fault rather than
silent stack corruption. The recommended shape is a single `inVm`
boolean (or equivalent flag) on the VM, set on entry to any of the
four entry points named above and cleared on exit; re-entry while the
flag is set raises a fatal `VmReentry` fault (not a recoverable
`ScriptError`, because the operand stack and any active argument view
are in an indeterminate state). The check is one branch on the
dispatch entry path, not per-instruction.

## Construction and services boundary

This section pins the VM's external surface: the constructor, the
service aggregate it consumes, the passive event aggregate it emits
through, and the import firewall that holds them in place.

### Construction signature

The VM is constructed as
`new VM(program: Program, services: RuntimeLangServices, options?: VmOptions)`.
The VM consumes only the `runtime` service tier; the `shared`, `app`,
and `brain` tiers reach host functions through
`ExecutionContext.services` (the full `PlatformServices`) carried on
each fiber, not through VM construction.
`options.events?: VmEvents` is the passive observer slot; omitting
`options` (or omitting `options.events`) must yield identical
program execution and identical host-visible side effects. The
remaining `VmOptions` fields (`handles?`, plus `Partial<VmConfig>`
overrides) tune resource shapes and do not change the boundary.

### `PlatformServices` responsibilities

The VM accepts the `runtime` tier (`RuntimeLangServices`) at
construction and consumes no other tier directly. The full
`PlatformServices` aggregate -- `runtime` plus the `shared`, `app`, and
`brain` tiers -- reaches host functions through
`ExecutionContext.services`. The members the VM and the host calls it
dispatches consume:

- `runtime.functions: IFunctionRegistry` -- resolved by `HOST_CALL`
  and `HOST_CALL_ASYNC` dispatch to obtain the host function record
  for a given function id.
- `runtime.types: ITypeRegistry` -- consulted by VM value copying
  and struct field access paths to look up type definitions, native
  snapshot functions, and field getters/setters.
- `runtime.actions: IBrainActionRegistry` -- used while constructing
  the loaded `Program` action table; bytecode-action dispatch executes
  `Program.actions` by slot and does not resolve descriptors on the hot
  path. Host-action dispatch (`HOST_ACTION_CALL` / `HOST_ACTION_CALL_ASYNC`)
  resolves the binding by stable id via `getById(actionId)`.
- `runtime.operatorTable: IOperatorTable` -- used by runtime helper
  functions that are registered as host functions; primitive
  operator dispatch remains monomorphized into host calls.
- `shared.conversions: IConversionRegistry` -- used by registered
  runtime conversion functions and mirrored by the edit-time language
  services.
- `app.rng: IRngServices` -- the brain-scoped random-number stream.
- `brain.program`, `brain.brainVars`, `brain.ruleVars`,
  `brain.pages`, and `brain.callsite` -- the id-keyed brain-instance
  state surface described below.

Scope rule (binding on every future addition): `PlatformServices`
covers only runtime registries, shared runtime/edit registries,
host-injected app services, and the runtime state members enumerated in the
[Runtime state surface](#runtime-state-surface) section. The VM
does **not** receive a program verifier; the reference VM trusts its
in-process compiler, and verification is reserved for ports that
accept bytecode from an untrusted source.

### `VmEvents` permissions and prohibitions

`VmEvents` is the optional passive observer aggregate. Its methods
are:

- `onFiberFault?(payload: FiberFaultEvent)` -- a fiber faulted;
  payload is `{ fiberId, err }`.
- `onFiberDone?(payload: FiberDoneEvent)` -- a fiber completed
  normally; payload is `{ fiberId, retv }`.
- `onFiberCancelled?(payload: FiberCancelledEvent)` -- a fiber was
  cancelled; payload is `{ fiberId }`.
- `onFiberWaiting?(payload: FiberWaitingEvent)` -- a fiber
  transitioned to waiting on a handle; payload is
  `{ fiberId, handleId }`.

**Passivity property.** An event observer is *passive* iff:

1. `vm.ts` never reads from `events` to make a control-flow
   decision (no branches, no return values consumed).
2. Final `Program` state and any host-visible side effects are
   identical for any two executions of the same program that
   differ only in their `VmEvents` argument (including
   `undefined`).

**Event-payload content rule.** Each event payload contains only
values already locally available at the emit site. Nothing is
computed, looked up, or allocated solely to satisfy an event.
Payloads carry only ids and primitive values that are expressible
through the runtime state surface. Payloads do **not** carry
references to authoring-graph objects.

Both rules bind every future event method added to `VmEvents` by
any downstream spec.

### Import-firewall rule

The runtime is a closed module: its source files may value-depend
only on other runtime files and on the platform-abstraction layer
(no upward imports into the brain, compiler, or app layers). The TS
reference enforces this through a build-time import allow-list and a
test-suite gate; ports are expected to maintain the same closure by
whatever mechanism their build system provides.

### Out of scope for this boundary

This section does not cover runtime state shape or host ABI
portability. Runtime state shape is documented in the
[Runtime state surface](#runtime-state-surface) section
below, which builds on this boundary.

### Maintenance rule

Any subsequent spec that modifies the VM constructor signature,
adds or removes a `PlatformServices` field, adds or removes a
`VmEvents` method, or changes the firewall rule **must update this
section in lock-step** with the code change. Per the workflow
convention, update `docs/specs/contracts/vm-contract.md` as part of the
same unit when the change is contract-shaping.

## Runtime state surface

`ExecutionContext` and the `PlatformServices` runtime state members form
the portable runtime boundary. Every operation here is expressible by a
static-allocation, no-GC implementation.

### `ExecutionContext` shape

`ExecutionContext` carries:

- `services: PlatformServices` -- the runtime service aggregate below.
- `getVariableBySlot(slotId)` / `setVariableBySlot(slotId, value)` --
  slot-indexed brain-global access; back `LOAD_VAR_SLOT` / `STORE_VAR_SLOT`.
- `getSystemVarBySlot(slotId)` / `setSystemVarBySlot(slotId, value)` --
  slot-indexed access to the brain-global System store; back
  `LOAD_SYSTEM_VAR` / `STORE_SYSTEM_VAR`. The setter writes by reference (no
  deep-copy); reads of an unwritten slot return `NIL_VALUE`.
- `currentCallSiteId?: number` -- bound before every host call and lifecycle
  hook dispatch; `undefined` outside those boundaries.
- `currentRuleFuncId?: number` -- `undefined` means no active rule; `0` is
  a valid rule id.
- `time`, `dt`, `currentTick` -- per-tick scalars stamped before each
  `think()` call.
- `data?: unknown` -- opaque per-tick application payload. The
  reference VM exposes this as a TS field; ports may render it as a
  `void*` user-data slot, a generic parameter, or another idiomatic
  pass-through. The contract is only that an opaque slot exists.

Every field is a scalar id, a primitive, a slot accessor, or a service
reference. No field holds an authoring-graph object, and there is no
`currentFiberId`; fiber identity is scheduler-internal.

### `PlatformServices` runtime state members

These id-keyed members live under `services.brain`:

- `program` -- `getRuleFuncIdForFunc(funcId)`: owning rule id or `undefined`.
  `getEnumSymbolValue(typeId, key)`: the declared primitive value of enum symbol
  `key` on type `typeId`, or `undefined` when the loaded program's type table
  carries no such enum entry or symbol.
  `getPrecedingSiblingRuleFuncId(ruleFuncId)`: the rule directly above it at
  its own nesting level under the same parent, or `undefined` for the first
  rule at a level; derived from `Program.ruleAncestors` for child rules and
  from the page's root-rule run for root rules.
- `brainVars` -- `getByName` / `setByName` / `clearByName`: brain-global vars.
- `ruleVars` -- same three, keyed by `(ruleFuncId, name)`. `undefined`
  ruleFuncId: reads return `NIL_VALUE`, writes are no-ops; store walks
  `Program.ruleAncestors` for inherited values.
- `ruleFiring` -- `get(ruleFuncId)` / `set(ruleFuncId, state)`: the per-rule
  firing record written at the WHEN boundary opcodes (see
  [Section boundary markers](#section-boundary-markers)). An unwritten record
  reads `DidFire`; an `undefined` ruleFuncId write is a no-op.
- `ruleCompletion` -- `hasLiveSubtree(ruleFuncId)`: true while any fiber in that
  rule's cluster is live (runnable or waiting), cluster membership being the
  static rule ancestry. `getWatcher(ruleFuncId)` / `setWatcher(ruleFuncId,
  handleId)` / `clearWatcher(ruleFuncId)`: the rule's single watcher slot,
  filled by the rule trigger host action and read and cleared by the settle
  walk (see [Fiber scheduling](#fiber-scheduling)).
  `isAbandoned(ruleFuncId)` / `markAbandoned(ruleFuncId)` /
  `clearAbandoned(ruleFuncId)`: the rule's abandonment mark, set by the settle
  walk on a fault or a cancellation anywhere in the rule's cluster and cleared
  when a fiber is spawned at that rule's own entry point, which begins its next
  firing. All three are runtime-internal: never serialized, never traced.
- `pages` -- `getCurrentPageId()`, `getPreviousPageId()`,
  `requestPageChange(pageIndex)`, `requestPageChangeByPageId(pageId)`,
  `requestPageRestart()`. A page change takes effect at the next think, and
  requesting the active page restarts it instead. A request that names no page
  -- a `pageIndex` outside the program's pages, or a `pageId` no page carries
  -- is a **no-op**: nothing is pending, the active page stays active, and no
  fiber of it is cancelled. A `switch page` reading nil in every argument slot
  -- the buffer an unsupplied argument leaves behind -- is a
  `requestPageRestart()` of the active page, not a page change.
- `callsite` -- `ensure(id)`, `reset(id)`, `getSlot(id, slotIdx)`,
  `setSlot(id, slotIdx, value)`, `getHostState(id)`, `setHostState(id,
  value)`, `clearHostState(id)`.

The brain-scoped random stream lives at `services.app.rng` and exposes
`next(): number` in `[0, 1)`.

Every member operates on ids, names, and primitives. Time, clock,
and platform-entity services are not `PlatformServices` members.
Action dispatch does not consult `services.brain`: bytecode action
dispatch resolves from `Program.actions` by slot, and host action
dispatch resolves from `services.runtime.actions` by stable id.

### Callsite-id binding discipline

Before dispatching `HOST_CALL`, `HOST_CALL_ASYNC`, `HOST_ACTION_CALL`,
`HOST_ACTION_CALL_ASYNC`, or any lifecycle hook
(`onInitialized` / `onPageEntered` / `onPageExited`), the VM binds
`currentCallSiteId` and `currentRuleFuncId` on `ExecutionContext`. Host
functions reach per-callsite host state through
`services.brain.callsite.{getHostState, setHostState, clearHostState}`,
keyed by `ctx.currentCallSiteId`; accessing host state when
`currentCallSiteId` is `undefined` is an error. Host functions never
dereference an authoring-graph object.

### Action call state model

`ACTION_CALL` and `ACTION_CALL_ASYNC` both route per-callsite state-slot
traffic through `services.brain.callsite.{getSlot, setSlot}` keyed by
`(callSiteId, slotIdx)`, backing `LOAD_CALLSITE_VAR` / `STORE_CALLSITE_VAR`.
`services.brain.callsite.reset(callSiteId)` drops both slots and host state
together; `services.brain.callsite.clearHostState(callSiteId)` drops only
the host-owned cell.

`ACTION_CALL_ASYNC` (bytecode) allocates a `HandleId` and spawns a child
fiber; `HOST_ACTION_CALL_ASYNC` (host) allocates a `HandleId` and calls
`execAsync(ctx, args, handleId)`. Both paths resolve through
`handles.events.on("completed", ...)`. **Host obligation:** every
`execAsync` call must eventually resolve, reject, or cancel the `HandleId`.
A synchronous throw is rolled back (the host opcode frees the handle in a
`try/catch`); a silent drop leaves it pending indefinitely unless the host
later resolves, rejects, or cancels it. `HandleTable.gc()` only reclaims
terminal handles that have no waiters.

**Backpressure on handle exhaustion.** When an async dispatch
(`HOST_CALL_ASYNC`, `ACTION_CALL_ASYNC`, `HOST_ACTION_CALL_ASYNC`) cannot
allocate a handle because the `HandleTable` is at `maxHandles`, the fiber
parks and retries the same dispatch on a later think; it does not fault. The
op checks handle capacity BEFORE any side effect -- before snapshotting or
popping args, before allocating the handle, before spawning a child fiber or
calling `execAsync`, and before advancing the pc -- and, when full, returns
the fiber to the run queue for the next round with its pc unchanged. Because
nothing was consumed on the failed attempt, the retry is an exact
re-execution of the identical instruction; once an in-flight async settles a
slot, it succeeds. Independent async breadth therefore spills across thinks in
bounded waves, losing no action and bounding live capped handles to
`maxHandles` at any breadth. A drained child rule that backpressures re-enters
the NEXT round (not a same-think retry), since handles free only across
thinks. Below the cap the path is unreachable, so a brain that never exhausts
handles behaves identically. For independent breadth over hosts that settle,
`maxHandles` is a latency knob, not a correctness cliff: the longest run of
consecutive retries is bounded by the breadth over the cap.
(Fiber-pool exhaustion at `ACTION_CALL_ASYNC` is separate and still faults
`StackOverflow`.)

**Uncapped handles.** A `HostActionBinding` may set `uncappedHandles`. Its
`HOST_ACTION_CALL_ASYNC` dispatches then skip the capacity check entirely and
allocate handles that are not counted while live, so they never consume or
backpressure against `maxHandles`. The flag is only correct on an action whose
live pending handles the runtime already bounds by construction; `maxHandles`
then measures concurrent host work alone. The rule-trigger sensor sets it: a
waiting `then` parks on its subject's watcher slot, a rule holds at most one
watcher, and the live trigger-handle count is therefore bounded by the
program's rule count. Every other handle path is capped. `HandleTable`
exposes the capped count separately from its total size, and only the capped
count gates `hasCapacity()`.

**Starvation faults.** A dispatch that keeps backpressuring is not retried
forever. When one fiber re-executes the same dispatch pc without a free handle
for `HANDLE_BACKPRESSURE_FAULT_ROUNDS` consecutive rounds, the runtime faults
that fiber `ErrorCode.StackOverflow` through the ordinary fault path: the
fault reaches `Scheduler.onFiberFault`, marks the rule's cluster abandoned, and
cascades the skip down any `then` chain watching it. A dispatch that allocates
clears the count, and a backpressure at a different pc restarts it. The
threshold sits far above any bounded-wave spill (whose run is the breadth over
the cap, itself bounded by `maxFibers`), so it fires only when a host has
stopped honouring its obligation to settle. Both VMs use the same constant.

### Id-spaces

Rule ids and program-local bytecode action slots are compiler-assigned and
stable for the lifetime of a compiled `Program`. `0` is a valid `RuleId`;
`undefined` is the only "no rule" sentinel. Fiber ids are scheduler-internal;
the contract does not specify their allocation scheme. `HandleId`s come from
the `HandleTable`.

Host function ids (the `funcId` operand of `HOST_CALL` / `HOST_CALL_ASYNC`)
and host action ids (the `actionId` operand of `HOST_ACTION_CALL` /
`HOST_ACTION_CALL_ASYNC`) are separate spaces of author-assigned stable ids,
declared as explicitly-valued enum members and validated by the registries at
registration: each id must be a non-negative integer, unique within its
space, and inside its owner's reserved range. The shared funcId space is
partitioned by owner: core owns `[0, TARGET_FUNC_ID_BASE)` and the active
target owns `[TARGET_FUNC_ID_BASE, ...)`. There is no program-dependent
funcId region: every funcId a serialized program carries is a core or target
id, so a fresh runtime resolves all of them without any compile-session
registrations. Enum operators and conversions are not program-dependent:
every enum type's `==` / `!=` overload entries dispatch to the shared core
host functions `OpEqualToEnum` / `OpNotEqualToEnum`, which compare symbol
identity (same enum type, same symbol; on the TS reference VM the symbol
key, on an integer-identity port the symbol ordinal) and evaluate false for
operands that are not two values of one enum type; every enum type's
enum->string and enum->number conversion entries dispatch to the shared core
host functions `ConvEnumToString` / `ConvEnumToNumber`, which resolve the
symbol's declared primitive value at runtime (through the runtime's type
registry for registered enum types, else through the loaded program's type
table, which carries per-symbol values) and fault the host call when the
operand is not an enum value or its symbol value does not resolve.
`ConvEnumToNumber` faults on a string-valued enum; the compiler only emits
it for numeric-valued enums.
The host-action space partitions at `TARGET_ACTION_ID_BASE` (core below,
target at and above). `TARGET_FUNC_ID_BASE = 1024` and
`TARGET_ACTION_ID_BASE = 1024` are exported from core
(`runtime/abi-ids.ts`). An id, once assigned, is never changed or reused;
removing a registration leaves a permanent gap. Serialized programs record
these ids verbatim, so they are stable across separate builds by
construction.

### Orchestrator opacity

The runtime orchestrator that owns the VM, scheduler, brain-instance
variable storage, and page-lifecycle state exposes an id-only public
surface. No orchestrator method accepts or returns an authoring-graph
reference, and the active-fiber set the scheduler exchanges with the
orchestrator carries fiber ids only.

### Out of scope for this section

`functions`, `types`, and `VmEvents` are covered by
[Construction and services boundary](#construction-and-services-boundary).
The runtime state members above extend that aggregate without redefining the
registry surface. Conversions and operators belong to `services.shared` and
`services.runtime` respectively, not to the brain-instance state surface.

### Maintenance rule

Any subsequent spec that adds or removes a `PlatformServices` runtime
state member, changes the `ExecutionContext` field set or its exported helpers,
changes the callsite-id or rule-id binding discipline, changes the action
state-slot keying, changes the `HandleId` host-obligation contract, or
changes Brain's runtime-facing surface **must update this section in
lock-step** with the code change, in the same unit.

## Opcode completeness

Every conforming VM implementation -- the TypeScript reference VM
and any port (notably the C++ MCU port) -- implements every opcode
listed in this spec. Subsetting is not permitted.

The compiler is **target-unaware**: it emits the same bytecode
regardless of the eventual host. It does not consult a target
descriptor, does not gate opcode emission on host capability, and
does not lower a single source construct into different opcodes for
different targets. A compile-time `CompileTarget` descriptor would
create pressure for per-target lowering branches and, because no
configuration runs the TS VM in a mode that faithfully mimics a
different port, divergence on fault shape and check timing would be
invisible.

Not all opcodes are reachable from all host configurations, but
every conforming VM must be able to execute any of them:

- **Async opcodes** are emitted only when a host function or action
  declares `isAsync: true`. A host that registers no async
  functions will never receive bytecode that uses them, but must
  still implement them.
- **`try` / `throw` / `yield` opcodes** are part of the opcode set
  and must be implemented by every conforming VM.

---

## Opcode reference

One row per opcode: mnemonic, numeric code, operand widths, stack
effect, side effects, fault conditions.

> **Source of truth.** The numeric assignments below are the
> contract; the canonical TS expression of the same assignments is
> the `Op` enum in `packages/core/src/runtime/bytecode.ts`. Any
> divergence between the table and the enum is a bug in one of the
> two; reconcile in the same change. The one admitted exception is a
> number this contract assigns ahead of its implementation: such a row
> says so in its prose, and the enum is appended at the recorded
> number rather than at a number of its own choosing.

### Conventions

These conventions apply to every row in every group below; rows omit
what would otherwise repeat in every cell.

- **Operand encoding.** Every operand is a u16 unless a row says
  otherwise. Operand cells use the form `name (slot)` where `slot`
  is `a`, `b`, or `c` (the three operand fields on `Instr`); the
  type is u16 by default.
- **Stack-effect notation.** `[x, y, z] -> [w]` reads bottom-to-top
  with the rightmost element being the top of stack. An empty `[]`
  on either side means "no change at that boundary."
- **Universal faults.** Every opcode raises `StackUnderflow` if the
  dispatcher cannot pop the operands its stack effect requires, and
  raises `ScriptError` if a constant-pool, function-table, or
  type-table operand is out of range. Per-row "Faults" cells list
  only opcode-specific failures beyond these.
- **PC advance.** Every opcode advances the program counter by one
  instruction unless its row says otherwise (`JMP`, `RET`, etc. are
  the obvious exceptions).
- **Side effects.** Side effects beyond the stack effect (deep
  copies, host calls, scheduler interaction, type-registry lookups)
  are described in the prose paragraph following each table, not in
  the table itself.

### Stack manipulation

| Mnemonic         | Numeric | Operands     | Stack effect           | Faults |
| ---------------- | ------- | ------------ | ---------------------- | ------ |
| `PUSH_CONST_VAL` | 0       | `k` (`a`)    | `[] -> [value]`        | -      |
| `POP`            | 1       | none         | `[value] -> []`        | -      |
| `DUP`            | 2       | none         | `[value] -> [value, value]` | - |
| `SWAP`           | 3       | none         | `[a, b] -> [b, a]`     | -      |
| `PUSH_CONST_NUM` | 4       | `k` (`a`)    | `[] -> [number]`       | -      |
| `PUSH_CONST_STR` | 5       | `k` (`a`)    | `[] -> [string]`       | -      |
| `STACK_SET_REL`  | 6       | `d` (`a`)    | `[value] -> []`        | `ScriptError` if `d` exceeds the post-pop top index (out-of-bounds write). |

`PUSH_CONST_VAL`, `PUSH_CONST_NUM`, and `PUSH_CONST_STR` each address
their own independent constant sub-pool: `k` indexes
`Program.constantPools.values`, `.numbers`, and `.strings`
respectively. The numeric and string pushes wrap the raw constant in
a `NumberValue` / `StringValue` at runtime; `PUSH_CONST_VAL` pushes
the residual-pool entry directly. See
[Constant pool layout](#constant-pool-layout) for the pool partitioning.

`POP` discards the top of stack. `DUP` re-pushes the top of stack
(by reference; struct values are not deep-copied). `SWAP` exchanges
the top two values.

`STACK_SET_REL` pops one value off the operand stack, then writes
it to `vstack[top - d]` where `top` is the index of the topmost
element after the pop. `d = 0` writes the popped value to the new
topmost slot (a meaningful instruction under the top-element
convention -- not a no-op). Used to populate fixed-width arg
buffers at call sites; see [Calling convention](#calling-convention).

### Variable access

| Mnemonic         | Numeric | Operands       | Stack effect    | Faults |
| ---------------- | ------- | -------------- | --------------- | ------ |
| `LOAD_VAR_SLOT`  | 10      | `slotId` (`a`) | `[] -> [value]` | `ScriptError` if `slotId >= program.variableNames.size()`. |
| `STORE_VAR_SLOT` | 11      | `slotId` (`a`) | `[value] -> []` | `ScriptError` if `slotId >= program.variableNames.size()`. |
| `LOAD_SYSTEM_VAR`  | 12    | `slotId` (`a`) | `[] -> [value]` | -- (out-of-range / unwritten reads observe `NIL_VALUE`). |
| `STORE_SYSTEM_VAR` | 13    | `slotId` (`a`) | `[value] -> []` | -- (grows the store lazily on out-of-range writes). |

Variable access is slot-keyed at dispatch time. `slotId` is a
program-scoped index into `Program.variableNames`; the runtime hosts
a parallel value list of the same length. The dispatch loop performs
no name lookup for variable access -- name -> slot resolution is the
compiler's job, performed once at program build, and re-bound to the
host's value list at program load via the orchestrator's
variable-table install step.

Every slot is seeded at program load with its starting value, so a
`LOAD_VAR_SLOT` before any store observes that value. The starting values
travel with the program: `Program.variableInitValues` holds, per slot, an
index into `constantPools.values` or a none-marker, and a conforming VM
materializes the referenced constant into the slot at load. A VM applies no
zero policy of its own; the brain compiler resolves each slot type's zero and
emits the constant, so a slot whose entry is the none-marker starts `NIL`.
The type table is fixed: `Number` starts `0`, `Boolean` starts `false`,
`String` starts `""`, and every other type starts `NIL`.

`STORE_VAR_SLOT` deep-copies struct values before writing
(consulting `ITypeRegistry`); primitive values are written by
reference. The slot list grows lazily on out-of-range writes from
host code -- the bytecode path bounds-checks first and faults --
but bytecode reads/writes always observe a slot already sized to
`Program.variableNames.size()`.

Name-keyed access remains available to host code via
`services.brain.brainVars.{getByName, setByName, clearByName}`. A host that
writes through a name not present in `variableNames` allocates a
fresh slot at the end of the value list; that slot is not addressable
from bytecode (no `LOAD_VAR_SLOT` operand can target it) and is
dropped on the next variable-table install (i.e. hot-reload).

#### System namespace

`LOAD_SYSTEM_VAR` / `STORE_SYSTEM_VAR` address a separate, brain-global System
store -- one value slot per registered System (a user-code shared singleton),
backing `ctx.getSystemVarBySlot` / `ctx.setSystemVarBySlot`. The store is
distinct from the `variableNames` pool: System slots have their own index space,
are not present in `variableNames`, and are not reachable from brain-editor
code. `slotId` is a program-scoped index assigned by the linker, which resolves
each System's exported-symbol identity to one shared store slot across every
artifact that references it.

Unlike `STORE_VAR_SLOT`, `STORE_SYSTEM_VAR` writes **by reference -- no
deep-copy**. A System's state is held in place, so a struct field written
through a method (`STRUCT_SET_FIELD` on the loaded state struct) persists in the
store without a store-back. `LOAD_SYSTEM_VAR` of an unwritten or out-of-range
slot yields `NIL_VALUE`; the store grows lazily on out-of-range writes. The
store is sized to the program's registered System count (carve-on-demand), not a
fixed cap.

A linked program carries a `systems` registry: one entry per reachable System,
each with a `storeSlot` and an optional `initFuncId` and `thinkFuncId`. The
entries are kept in registration order. A System is included in a program only
when reachable -- the tree-shaker marks a System's wrappers reachable when a
reachable function references its `storeSlot` -- so a brain that touches no code
referencing a System neither registers nor runs it.

The orchestrator runs the registry in two phases, both **page-independent** (a
System is a brain-level service, not owned by a page):

- **Startup-init:** before the first page activation, rule, or `think`, run each
  registered System's `initFuncId` once, in registration order. The init
  function builds the initial state struct into the System slot and then runs
  the user `init`.
- **Per-think tick:** every `think`, after rule evaluation (`scheduler.tick()`)
  and before GC, run each registered System's `thinkFuncId`, in registration
  order, regardless of the active page.

Both wrapper functions receive the injected context as their sole argument and
must run to completion without suspending (they may not `AWAIT`). System state
persists for the brain-instance lifetime; a page switch neither resets nor
re-inits it.

### Control flow

| Mnemonic       | Numeric | Operands         | Stack effect    | Faults |
| -------------- | ------- | ---------------- | --------------- | ------ |
| `JMP`          | 20      | `rel: i16` (`a`) | `[] -> []`      | -      |
| `JMP_IF_FALSE` | 21      | `rel: i16` (`a`) | `[value] -> []` | -      |
| `JMP_IF_TRUE`  | 22      | `rel: i16` (`a`) | `[value] -> []` | -      |

`rel` is a signed PC delta relative to the current instruction's
address. `JMP` always sets `pc = pc + rel`. `JMP_IF_FALSE` pops the
top of stack and jumps when the value is falsy (otherwise advances
to `pc + 1`); `JMP_IF_TRUE` is the symmetric truthy branch.
Truthiness follows the value-model rule defined in
[Value model](#value-model): unknown, void, nil, `false`, numeric `0`,
the empty string, empty lists, empty maps, and error values are falsy.
Enums, structs, function values, handle values, nonzero numbers,
non-empty strings, and non-empty collections are truthy.

### Function calls

| Mnemonic | Numeric | Operands                              | Stack effect                           | Faults |
| -------- | ------- | ------------------------------------- | -------------------------------------- | ------ |
| `CALL`   | 30      | `funcId` (`a`), `argc` (`b`)          | `[arg0, ..., arg(argc-1)] -> []`       | `ScriptError` if `funcId` is out of bounds or `argc != callee.numParams`. `StackOverflow` if frame depth would exceed `maxFrameDepth`. |
| `RET`    | 31      | none                                  | `[retv] -> []` (caller frame: `[] -> [retv]`) | -      |
| `SPAWN_RULE` | 32  | `funcId` (`a`)                        | `[] -> []`                             | `StackOverflow` on fiber-pool exhaustion. |

`CALL` pops `argc` values right-to-left into the callee's local-slot
0..argc-1, pushes a new frame whose `pc` starts at 0, and resumes
execution in the callee. The arg values are not duplicated on the
operand stack; they are moved into locals.

`RET` pops one return value, discards the current frame, restores
the caller's stack base, and pushes the return value onto the
caller's operand stack. If `RET` runs in the root frame, the fiber
transitions to `DONE` and any owning async-action handle is
resolved with the return value.

`SPAWN_RULE` spawns a child-rule fiber running `funcId` (a rule entry)
and holds it in the tick's spawn drain, then continues at the next
instruction in the spawning fiber without awaiting and without pushing
anything. The compiler emits one `SPAWN_RULE` per child rule at the
parent rule's tail, after the parent's `DO` section (including any async
action and its `AWAIT`) and before the WHEN-false skip target, so a child
rule is reached only if its parent fired and only after the parent's own
slice -- including the resolution of the parent's own `AWAIT` -- is
complete. Every rule at every nesting level runs in its own fiber:
sibling child rules are concurrent, and a child's `AWAIT` parks only that
child. The spawned child drains within the SAME think as its parent's
slice, as a synchronous depth-first cascade -- unless it parks on `AWAIT`
or `YIELD`, which keeps it cross-think; see
[Fiber scheduling](#fiber-scheduling) for the drain order, re-fire
quiescence, and cancellation rules.

### Host calls

| Mnemonic          | Numeric | Operands                                          | Stack effect                                | Faults |
| ----------------- | ------- | ------------------------------------------------- | ------------------------------------------- | ------ |
| `HOST_CALL`       | 40      | `fnId` (`a`), `argc` (`b`), `callSiteId` (`c`)    | `[arg0, ..., arg(argc-1)] -> [result]`      | `ScriptError` if `fnId` is out of bounds; host-thrown errors propagate as `ScriptError`. |
| `HOST_CALL_ASYNC` | 41      | `fnId` (`a`), `argc` (`b`), `callSiteId` (`c`)    | `[arg0, ..., arg(argc-1)] -> [handle]`      | Same as `HOST_CALL`; a full handle table backpressures (parks and retries next think), it does not fault. |

Both opcodes bind `currentCallSiteId` and `currentRuleFuncId` on
`ExecutionContext` before dispatch; see
[Calling convention](#host-call-layout) for the full arg-buffer
shape, sync-vs-async lifetime contract, and the host re-entry rule.

### Action calls

| Mnemonic            | Numeric | Operands                                              | Stack effect                                | Faults |
| ------------------- | ------- | ----------------------------------------------------- | ------------------------------------------- | ------ |
| `ACTION_CALL`            | 42      | `actionSlot` (`a`), `argc` (`b`), `callSiteId` (`c`)  | `[arg0, ..., arg(argc-1)] -> [result]`      | `ScriptError` if `actionSlot` is out of bounds or the program defines no actions. |
| `ACTION_CALL_ASYNC`      | 43      | `actionSlot` (`a`), `argc` (`b`), `callSiteId` (`c`)  | `[arg0, ..., arg(argc-1)] -> [handle]`      | Same as `ACTION_CALL`; a full handle table backpressures (parks and retries next think), faulting `StackOverflow` after `HANDLE_BACKPRESSURE_FAULT_ROUNDS` starved rounds or on fiber-pool exhaustion. |
| `HOST_ACTION_CALL`       | 44      | `actionId` (`a`), `argc` (`b`), `callSiteId` (`c`)    | `[arg0, ..., arg(argc-1)] -> [result]`      | `ScriptError` if no action holds `actionId`, the resolved action is not host-backed, it is async, or its `execSync` is missing. |
| `HOST_ACTION_CALL_ASYNC` | 45      | `actionId` (`a`), `argc` (`b`), `callSiteId` (`c`)    | `[arg0, ..., arg(argc-1)] -> [handle]`      | Same as `HOST_ACTION_CALL` but faults if the action is sync or its `execAsync` is missing; a full handle table backpressures (parks and retries next think), faulting `StackOverflow` only after `HANDLE_BACKPRESSURE_FAULT_ROUNDS` starved rounds. A binding declaring `uncappedHandles` skips the capacity check and allocates outside the cap. |

`actionSlot` indexes `Program.actions`, which holds bytecode actions
only; `ACTION_CALL` / `ACTION_CALL_ASYNC` fault if the indexed entry is
not a bytecode action. Host actions are invoked by id through
`HOST_ACTION_CALL` / `HOST_ACTION_CALL_ASYNC` and carry no `Program.actions`
entry. See [Calling convention](#host-call-layout) for the shared arg-buffer
shape and [Action call state model](#action-call-state-model) for
state-slot routing and `HandleId` allocation.

`HOST_ACTION_CALL` / `HOST_ACTION_CALL_ASYNC` dispatch a host action by
its stable registry `actionId` (assigned at registration; see
[Id-spaces](#id-spaces)) rather than by a program-local slot: the VM
resolves the binding via `services.runtime.actions.getById(actionId)`,
validates it is host-backed with the opcode-matching sync/async-ness, and
invokes `execSync` / `execAsync` with the same arg-buffer, callsite
binding, and `HandleId` discipline as a host function call. They carry no
`Program.actions` entry.

#### Rule trigger host action

This contract does not enumerate host actions; their ids and bodies
belong to the modules that register them. One is specified here because
the scheduler participates in settling it: the **rule trigger**,
`actionId` 9, backed by core host function id 107. It is asynchronous,
takes no arguments, and is dispatched through `HOST_ACTION_CALL_ASYNC`
immediately before the WHEN expression of a rule whose trigger mode is
`then`; the rule consumes the handle with an ordinary `AWAIT`.

The action reads the calling rule's **subject** -- the immediately
preceding sibling, resolved through
`services.brain.program.getPrecedingSiblingRuleFuncId` -- and answers
one of three ways:

- **Immediate true**, when the subject completed this think: its firing
  record reads `DidFire`, no fiber in its subtree is live, and it carries
  no abandonment mark. The `AWAIT` falls through without suspending.
- **A pending handle**, while any fiber in the subject's subtree is
  live. Before returning it, the action writes the *calling* rule's own
  firing record as `DidNotFire`, so a chain-gated sibling below it
  evaluates during the wait. The handle occupies the subject's watcher
  slot; see [Fiber scheduling](#fiber-scheduling).
- **Immediate false**, when the subject is settled without a firing (its
  record reads `DidNotFire`) or its firing was abandoned: a fault or a
  cancellation anywhere in its cluster left it marked, so an emptied
  subtree it fired into is not a completion.

A pending handle resolves with the subject's final outcome: `true` when
the subject's subtree emptied after a firing, `false` when the subject's
evaluation ended without firing, its cluster faulted, or it was
cancelled. Page cancellation cancels the waiting fiber like any child
fiber; its pending trigger handle is settled by the cancelled subject
cluster's settle walk, resolving `false` -- the ordinary skip -- so the
handle never reports a distinct cancelled state and nothing leaks.

The trigger's binding declares `uncappedHandles`, so its handles are
allocated outside the `maxHandles` accounting. A rule holds at most one
watcher, so the live trigger-handle count is bounded by the program's rule
count; a `then` chain's length is therefore bounded by fibers and memory,
never by the profile's concurrent-handle cap.

### Async and cooperative scheduling

| Mnemonic | Numeric | Operands | Stack effect      | Faults |
| -------- | ------- | -------- | ----------------- | ------ |
| `AWAIT`  | 50      | none     | `[handle] -> [value]` (or fault on rejection) | `ScriptError` if the top of stack is not a handle value, or the handle id is unknown. The fiber must be suspendable. |
| `YIELD`  | 51      | none     | `[] -> []`        | The fiber must be suspendable. |

`AWAIT` pops one handle value. If the handle is already resolved,
the resolved value is pushed and execution continues in the same
tick. If rejected or cancelled, the rejection error enters the
exception path (caught by an active `TRY`, otherwise faulting the
fiber). If still pending, the fiber transitions to `WAITING` and
records its resume PC, stack height, and frame depth; the scheduler
resumes the fiber when the handle completes.

`YIELD` is a cooperative suspension point that does not allocate a
handle: the fiber's slice ends and the scheduler re-enqueues it.
Ticks are rounds (see [Fiber scheduling](#fiber-scheduling)), so the
fiber resumes at the next instruction on the **next tick**, never
later in the same tick.

Both opcodes require the fiber to be suspendable (i.e. not running
inside a non-suspendable host frame). Use in a non-suspendable
context faults the fiber with `ScriptError`.

### Exception handling

| Mnemonic  | Numeric | Operands              | Stack effect    | Faults |
| --------- | ------- | --------------------- | --------------- | ------ |
| `TRY`     | 60      | `catchRel: i16` (`a`) | `[] -> []`      | `StackOverflow` if the handler stack would exceed `maxHandlers`. |
| `END_TRY` | 61      | none                  | `[] -> []`      | -      |
| `THROW`   | 62      | none                  | `[value] -> []` | `ScriptError` if the popped value is not an error value (the dispatch loop wraps the non-error value into a `ScriptError` payload before unwinding). |

`TRY` pushes a handler entry recording the catch PC
(`pc + catchRel`), the current operand-stack height, and the
current frame depth. `END_TRY` pops the topmost handler entry
without altering the operand stack.

`THROW` pops one value. If it is an error value, that error becomes
the in-flight exception; otherwise the dispatch loop synthesizes a
`ScriptError` whose detail captures the popped value. The dispatch
loop unwinds operand stack and frames to the depths recorded by the
topmost matching handler, sets `pc = catchPc`, and pushes the error
value onto the operand stack at the handler's entry. With no active
handler, the fiber transitions to `FAULT` and any owning
async-action handle is rejected with the error.

### Section boundary markers

| Mnemonic                 | Numeric | Operands            | Stack effect         | Faults |
| ------------------------ | ------- | ------------------- | -------------------- | ------ |
| `WHEN_START`             | 70      | none                | `[] -> []`           | -      |
| `WHEN_END`               | 71      | `endRel: i16` (`a`) | `[whenResult] -> []` | -      |
| `DO_START`               | 72      | none                | `[] -> []`           | -      |
| `DO_END`                 | 73      | none                | `[] -> []`           | -      |
| `WHEN_END_PRESENT`       | 74      | `endRel: i16` (`a`) | `[whenResult] -> []` | -      |
| `WHEN_END_CHAIN`         | 172     | `endRel: i16` (`a`) | `[whenResult] -> []` | -      |
| `WHEN_END_PRESENT_CHAIN` | 173     | `endRel: i16` (`a`) | `[whenResult] -> []` | -      |

`DO_START` and `DO_END` are pure markers: they advance the PC by one
and have no other effect. They exist so the compiled bytecode
preserves the source-level rule structure for diagnostics and debug
walkers; conforming VMs must execute them without observable side
effect.

`WHEN_START` opens the WHEN section. It has no stack effect, but it is
not a pure marker: it writes the current rule's firing record as
`Evaluating`.

**The firing record.** Every rule carries one three-state value --
`Evaluating`, `DidFire`, `DidNotFire` -- held in
`services.brain.ruleFiring` and keyed by rule funcId. `WHEN_START`
writes `Evaluating`; each of the four gates below writes its computed
outcome, `DidFire` or `DidNotFire` (an `otherwise` chain gate writes a
chain-aware value derived from it, see below). The gates already
compute that outcome, so the record stores it and never re-derives it
from the WHEN value: the captured value is the pre-gate value, and
re-deriving would report the wrong answer for a presence-gated sensor
delivering a present-but-falsy value. A rule with no record reads
`DidFire`, which is what an empty-WHEN rule observes -- such a rule
emits no WHEN boundary opcodes and never writes a record, and an empty
WHEN means always. The store is allocated with the brain instance and
lives exactly as long as it; a brain re-initialization rebuilds it at
that initial value. Records are runtime-internal: not serialized and not
traced.

`WHEN_END` is the conditional gate. It pops the result of the
WHEN expression block and writes it into the current rule's reserved
`__whenResult` rule variable (every rule captures, before the gate
below), so a DO-side actuator that received no explicit argument can
read it back. Then, if the result is truthy, execution continues into
the DO block (PC advances by one); if falsy, PC advances by `endRel`,
skipping the DO block and any nested boundaries. Either way it writes
the rule's firing record with the gate outcome. The capture and the
record write are side effects only; the stack effect is unchanged.

`WHEN_END_PRESENT` is the presence-gated form of the WHEN boundary. It
captures `__whenResult` identically to `WHEN_END` (every rule captures,
before the gate), with the same operand and stack effect. It differs only
in the gate condition: the DO block runs when the WHEN result is *present*
(any non-nil value, including a falsy `0`, `""`, `false`, or empty
collection), and is skipped by `endRel` only when the result is nil
(absent). Both gate modes are static, compile-time properties of the rule:
the compiler emits `WHEN_END_PRESENT` only when a rule's WHEN root
expression is exactly a sensor whose tile declares the `PresenceGated`
capability, and `WHEN_END` for every other rule. A presence-gated sensor
used inside an expression (e.g. `(sensor) > 100`) is not the bare root, so
that rule emits `WHEN_END` and gates on truthiness of the expression
result. `isTruthy` is unchanged.

`WHEN_END_CHAIN` and `WHEN_END_PRESENT_CHAIN` are the chain-gate
variants, emitted in place of their base gates for a rule whose
trigger mode is `otherwise`. Each carries the same single signed
`endRel` operand, captures `__whenResult` identically, computes its
fired outcome exactly as its base gate does (`WHEN_END_CHAIN` on
truthiness, `WHEN_END_PRESENT_CHAIN` on presence), and advances or
skips by `endRel` on that same condition. They differ only in the
value written to the firing record, which is chain-aware. The rule's
**subject** is the immediately preceding sibling, resolved at the gate
through `services.brain.program.getPrecedingSiblingRuleFuncId`. With
`S` the subject's record, the gate writes:

- `DidFire` when the rule fired;
- `DidNotFire` when the rule did not fire and `S` is `DidNotFire`;
- `S` unchanged otherwise (the rule did not fire and `S` is `DidFire`
  or `Evaluating`).

Read down a run of chain-gated rules, `DidNotFire` therefore means "no
rule in the run up to and including this one fired this think", which
is what makes a flat run of `otherwise` rules an if / else-if / else
ladder. Conforming VMs implement both variants; the reference
implementations land in a subsequent change built to the numbers
recorded above.

### Frame locals

| Mnemonic      | Numeric | Operands     | Stack effect    | Faults |
| ------------- | ------- | ------------ | --------------- | ------ |
| `LOAD_LOCAL`  | 130     | `idx` (`a`)  | `[] -> [value]` | `ScriptError` if `idx >= frame.locals.size()`. |
| `STORE_LOCAL` | 131     | `idx` (`a`)  | `[value] -> []` | `ScriptError` if `idx >= frame.locals.size()`. |

Frame locals are indexed slots on the current call frame, sized at
frame creation from `FunctionBytecode.numLocals` (defaults to
`numParams`). Locals 0..numParams-1 are populated from call args
on entry; the remaining slots are nil-initialized.

### Per-callsite state slots

| Mnemonic             | Numeric | Operands     | Stack effect    | Faults |
| -------------------- | ------- | ------------ | --------------- | ------ |
| `LOAD_CALLSITE_VAR`  | 140     | `idx` (`a`)  | `[] -> [value]` | `ScriptError` if no callsite is bound and the local fallback array is unavailable, or if `idx` is out of bounds in the fallback array. |
| `STORE_CALLSITE_VAR` | 141     | `idx` (`a`)  | `[value] -> []` | Same as `LOAD_CALLSITE_VAR`. |

Per-callsite storage backs `let` / `const` variables declared at
action scope. Reads and writes route through
`services.brain.callsite.{getSlot, setSlot}` keyed by
`(currentCallSiteId, idx)`; callsite-id binding follows the
[Callsite-id binding discipline](#callsite-id-binding-discipline)
and the [Action call state model](#action-call-state-model).

### Type introspection

| Mnemonic      | Numeric | Operands    | Stack effect       | Faults |
| ------------- | ------- | ----------- | ------------------ | ------ |
| `TYPE_CHECK`  | 150     | `tag` (`a`) | `[value] -> [bool]` | -     |
| `INSTANCE_OF` | 151     | `t` (`a`)   | `[value] -> [bool]` | `ScriptError` if `t` is out of range in the program type table. |

`TYPE_CHECK` compares the popped value's tag (`Value.t`) to the
operand and pushes the boolean result.

`INSTANCE_OF` reads the target type from program type-table entry
`t` (see [Program type table](#program-type-table)) and pushes
`true` when the popped value is a struct value of that exact type
(on the TS reference VM, `typeId` string equality; on an integer-
identity port, type-handle equality). Non-struct values always
yield `false`.

### Indirect function calls

| Mnemonic             | Numeric | Operands     | Stack effect                                       | Faults |
| -------------------- | ------- | ------------ | -------------------------------------------------- | ------ |
| `CALL_INDIRECT`      | 160     | `argc` (`a`) | `[func, arg0, ..., arg(argc-1)] -> []`             | `ScriptError` if the popped function reference is not a `FunctionValue`, the resolved `funcId` is out of bounds, or `argc != callee.numParams`. `StackOverflow` if frame depth would exceed `maxFrameDepth`. |
| `CALL_INDIRECT_ARGS` | 161     | `argc` (`a`) | `[func, arg0, ..., arg(argc-1)] -> []`             | Same as `CALL_INDIRECT` minus the arity check; surplus args are dropped and missing args are nil-padded to `callee.numParams`. |

`CALL_INDIRECT` resolves a `FunctionValue` from the operand stack
(below the args), enforces strict arity, and otherwise behaves like
`CALL`. Captured environment from the `FunctionValue` is bound to
the new frame.

`CALL_INDIRECT_ARGS` is the lenient variant: it accepts any
positive `argc`, truncates excess args, and nil-pads missing args
to match the callee's declared `numParams`. Used when the call site
cannot statically prove an exact arity (e.g. variadic-style
internal helpers).

### Closures

| Mnemonic       | Numeric | Operands                                | Stack effect                                            | Faults |
| -------------- | ------- | --------------------------------------- | ------------------------------------------------------- | ------ |
| `MAKE_CLOSURE` | 170     | `funcId` (`a`), `captureCount` (`b`)    | `[capture0, ..., capture(captureCount-1)] -> [func]`    | -      |
| `LOAD_CAPTURE` | 171     | `captureIdx` (`a`)                      | `[] -> [value]`                                         | `ScriptError` if the current frame has no captures, or `captureIdx >= captures.size()`. |

`MAKE_CLOSURE` pops `captureCount` values right-to-left to preserve
push order, and pushes a `FunctionValue` bound to `funcId` whose
`captures` field carries the popped values. The resulting value is
callable through `CALL_INDIRECT` / `CALL_INDIRECT_ARGS`; the new
frame's `captures` field aliases the closure's captures.

`LOAD_CAPTURE` reads the current frame's capture by index; only
frames created by an indirect call from a closure value carry a
captures list.

### List operations

| Mnemonic      | Numeric | Operands              | Stack effect                          | Faults |
| ------------- | ------- | --------------------- | ------------------------------------- | ------ |
| `LIST_NEW`    | 90      | `_` (`a`), `k?` (`b`) | `[] -> [list]`                        | -      |
| `LIST_PUSH`   | 91      | none                  | `[list, item] -> [list]`              | `ScriptError` if the popped list is not a list value. |
| `LIST_GET`    | 92      | none                  | `[list, index] -> [value]`            | `ScriptError` if not a list, or `index` is not a number. Out-of-bounds reads return `nil`. |
| `LIST_SET`    | 93      | none                  | `[list, index, value] -> [list]`      | `ScriptError` if not a list, or `index` is not a number. |
| `LIST_LEN`    | 94      | none                  | `[list] -> [number]`                  | `ScriptError` if not a list. |
| `LIST_POP`    | 95      | none                  | `[list] -> [value]`                   | `ScriptError` if not a list. Empty-list pop yields `nil`. |
| `LIST_SHIFT`  | 96      | none                  | `[list] -> [value]`                   | `ScriptError` if not a list. Empty-list shift yields `nil`. |
| `LIST_REMOVE` | 97      | none                  | `[list, index] -> [value]`            | `ScriptError` if not a list, or `index` is not a number. |
| `LIST_INSERT` | 98      | none                  | `[list, index, value] -> []`          | `ScriptError` if not a list, or `index` is not a number. |
| `LIST_SWAP`   | 99      | none                  | `[list, i, j] -> []`                  | `ScriptError` if not a list, or either index is not a number. |

`LIST_NEW`'s `b` operand is optional: when present, it indexes the
program type table for the list's type (faulting `ScriptError` when
out of range); when omitted, the typeId defaults to
`list:<unknown>`. The `a` operand is reserved.

All in-place list mutations (`LIST_PUSH`, `LIST_SET`, `LIST_INSERT`,
`LIST_SWAP`, `LIST_POP`, `LIST_SHIFT`, `LIST_REMOVE`) modify the
target list value directly; the list reference is the same value
seen elsewhere on the stack and in variables. Numeric indices are
floored to integers before indexing.

### Map operations

| Mnemonic     | Numeric | Operands              | Stack effect                  | Faults |
| ------------ | ------- | --------------------- | ----------------------------- | ------ |
| `MAP_NEW`    | 100     | `_` (`a`), `k?` (`b`) | `[] -> [map]`                 | -      |
| `MAP_SET`    | 101     | none                  | `[map, key, value] -> [map]`  | `ScriptError` if the popped value is not a map, or `key` is not a string or number. |
| `MAP_GET`    | 102     | none                  | `[map, key] -> [value]`       | Same constraints as `MAP_SET`. Missing keys yield `nil`. |
| `MAP_HAS`    | 103     | none                  | `[map, key] -> [bool]`        | Same constraints as `MAP_SET`. |
| `MAP_DELETE` | 104     | none                  | `[map, key] -> [map]`         | Same constraints as `MAP_SET`. |

`MAP_NEW`'s `b` operand has the same optional type-table-index
behavior as `LIST_NEW`'s; the default typeId is `map:<unknown>`.
Map keys are restricted to string and number values; key equality
follows the underlying platform `Dict` semantics (numbers compare
by value, strings by character sequence).

### Struct operations

| Mnemonic             | Numeric | Operands                          | Stack effect                                                            | Faults |
| -------------------- | ------- | --------------------------------- | ----------------------------------------------------------------------- | ------ |
| `STRUCT_NEW`         | 110     | `_` (`a`), `t?` (`b`)             | `[] -> [struct]`                                                        | `ScriptError` if `a` is non-zero (reserved) or `t` is out of range in the program type table. |
| `RESERVED_111`       | 111     | none (reserved)                   | reserved opcode number, no handler                                     | The VM has no handler; the dispatcher faults `ScriptError` ("Unknown opcode") if one is encountered. |
| `RESERVED_112`       | 112     | none (reserved)                   | reserved opcode number, no handler                                     | The VM has no handler; the dispatcher faults `ScriptError` ("Unknown opcode") if one is encountered. |
| `STRUCT_COPY_EXCEPT` | 113     | `numExclude` (`a`), `t?` (`b`)    | `[source, key0, ..., key(numExclude-1)] -> [struct]`                    | `ScriptError` if any exclude key is not a string, or the source value is not a struct. |
| `STRUCT_GET_FIELD`   | 114     | `fieldId` (`a`)                   | `[struct] -> [value]`                                                   | `ScriptError` if the source is not a struct. |
| `STRUCT_SET_FIELD`   | 115     | `fieldId` (`a`)                   | `[struct, value] -> [struct]`                                           | `ScriptError` if the source is not a struct, or the registered `fieldSetter` returns `false`. |
| `STRUCT_DEEP_COPY`   | 116     | none                              | `[value] -> [copy]`                                                     | Never faults. |

`STRUCT_NEW`'s `b` operand, when present, indexes the program type
table for the struct's type (faulting `ScriptError` when out of
range); when omitted, the typeId defaults to `struct:<anonymous>`.
The dispatcher pre-allocates a field list sized to the type's field
storage (`maxFieldId + 1` slots; empty for an anonymous struct) and
pushes the empty struct. Field population is id-based: the compiler
follows `STRUCT_NEW` with one `STRUCT_SET_FIELD <fieldId>` per
initialized field. The `a` operand is reserved and must be 0.

`RESERVED_111` / `RESERVED_112` are reserved opcode numbers with no VM
handler. Their enum members and empty `OPERAND_SCHEMA` entries are kept so
the remaining struct opcodes keep their numbers and the binary codec
round-trips the reserved numbers. The VM has no dispatch case for them, so
executing one faults `ScriptError` ("Unknown opcode").

`STRUCT_COPY_EXCEPT` builds a new struct value (typed by the
optional `b` operand, or carried over from the source's typeId
when no replacement type is given) by copying all fields of `source`
except those whose names appear in the popped exclude key set. It is
the dynamic-key fallback of the name-keyed field-access family
(`GET_FIELD` / `SET_FIELD`): the compiler emits it only when an
exclusion key or the rest type is unknowable at compile time
(computed property keys). A statically-typed object-rest copy does
not use it; it lowers to `STRUCT_NEW` plus per-field
`STRUCT_GET_FIELD` / `STRUCT_SET_FIELD` id-based copies.

`STRUCT_GET_FIELD` / `STRUCT_SET_FIELD` are the id-keyed field-access
opcodes the compiler emits when it statically knows the field. The
operand is the field's numeric `fieldId` (its
`StructFieldDef.fieldIndex`). Dispatch: if the source's registered
`StructTypeDef` has a `fieldGetter` / `fieldSetter`, the opcode calls
it with the `fieldId` (this is how native-backed structs project host
objects); otherwise it reads or writes `StructValue.v` at the
`fieldId` slot. Closed structs store field values in
`StructValue.v: List<Value>` indexed by `fieldId`; missing list
entries read as `nil`. `STRUCT_SET_FIELD` is a **pure store -- it does
not copy** the value (JavaScript-style reference semantics); a
`fieldSetter` that returns `false` faults the fiber.

`STRUCT_DEEP_COPY` pops a value and pushes a deep copy of it. It
copies struct values recursively (a new `StructValue` with a cloned
field list, and a snapshotted native handle when the type registers
`snapshotNative`); lists, maps, and primitives pass through unchanged
(reference/immutable). It is the explicit primitive a front-end emits
before `STRUCT_SET_FIELD` when it wants struct *value* semantics on
assignment.

### Generic field access

| Mnemonic    | Numeric | Operands | Stack effect                              | Faults |
| ----------- | ------- | -------- | ----------------------------------------- | ------ |
| `GET_FIELD` | 120     | none     | `[source, fieldName] -> [value]`          | `ScriptError` if `fieldName` is not a string. Non-struct sources yield `nil`. |
| `SET_FIELD` | 121     | none     | `[source, fieldName, value] -> [source]`  | `ScriptError` if `fieldName` is not a string, the source is not a struct, or the registered `fieldSetter` returns `false`. |

`GET_FIELD` / `SET_FIELD` are the name-keyed field-access opcodes,
emitted when the field is selected by a runtime-computed key (the
field name is on the stack). They resolve the name to its numeric
`fieldId` through `StructTypeDef.fieldIndexByName`, then dispatch
through the same id-based path as `STRUCT_GET_FIELD` /
`STRUCT_SET_FIELD` (the registered `fieldGetter` / `fieldSetter`
receives the numeric `fieldId`, not the name). For a program-local
struct the name -> id map travels in the program type table (the TYPS
`struct.fields`, see [Program type table](#program-type-table)), so a
separately-built VM resolves the same id without a host type registry.
A name that resolves to no field reads as `nil` (`GET_FIELD`) or is a
no-op (`SET_FIELD`); a non-struct source reads as `nil` (`GET_FIELD`)
or faults (`SET_FIELD`).

`SET_FIELD` deep-copies struct values before storing them, the same
way `STORE_VAR_SLOT` does, so a struct field set through the name-keyed
path cannot become an alias of a struct held elsewhere. (The id-keyed
`STRUCT_SET_FIELD` does not copy; a front-end that wants value
semantics emits `STRUCT_DEEP_COPY` before it.)

---

## Value model

### Struct field indices

Every registered `StructTypeDef` exposes its fields as a
`List<StructFieldDef>`, each carrying a `fieldIndex` that is the
field's **author-assigned** numeric id, supplied at registration
(`StructFieldInput.fieldIndex`) and validated to be a non-negative
integer that is unique within the struct (including across
`addStructFields` extensions). The id is durable: ids are assigned by
hand, are intended to be append-only and never reused after a field is
removed, and are decoupled from declaration position -- so a struct may
have a sparse id set (a removed field leaves a reserved gap), and
`fields.get(i).fieldIndex === i` does **not** hold in general.

`fieldIndex` is also the field's **storage slot**: a struct value's
`StructValue.v: List<Value>` is sized to `maxFieldId + 1`, and
`STRUCT_GET_FIELD <fieldId>` / `STRUCT_SET_FIELD <fieldId>` use the id
directly as the index. Consumers that need a stable per-field id should
use `fieldIndex` rather than the field's name string.

### Constant pool layout

Programs carry an aggregate `constantPools: ConstantPools` whose three
parallel sub-pools each have an independent index space:

- `constantPools.numbers: List<number>` -- raw `number` values pushed by
  `PUSH_CONST_NUM` and wrapped into `NumberValue` at runtime.
- `constantPools.strings: List<string>` -- raw `string` values pushed by
  `PUSH_CONST_STR`. String constants carry data only; type identity
  lives in the [program type table](#program-type-table).
- `constantPools.values: List<Value>` -- residual pool for tagged values
  that do not fit the typed pools (e.g. `BoolValue`, `NilValue`,
  `FunctionValue`, `StructValue`, `BufferValue`). Pushed by `PUSH_CONST_VAL`.

Pool indices are independent: a `PUSH_CONST_NUM 3` and a
`PUSH_CONST_STR 3` reference unrelated entries. The linker and
tree-shaker remap each pool independently; cross-pool offsets are
carried as a `ConstantOffsets` aggregate.

### Buffer values

A `BufferValue` is an immutable sequence of raw bytes (each `0-255`),
the `NativeType.Buffer = 12` native type (appended after
`Function = 11`). It carries no typeId and no nested values; equality is
byte-for-byte content equality. The reference VM backs it with the
platform `IByteArray`; an integer-identity port mirrors the byte run
(constant buffers may borrow the program-image byte slab; host-built
buffers own a managed byte run). There are no buffer opcodes: a buffer
enters the VM only as a `PUSH_CONST_VAL` constant (host-function access
to buffers is a separate host-function surface, not part of this
opcode contract).

In the binary `.mcprogram` value encoding (the `CVAL` section, format
version 4), a buffer is the value tag byte `12`, then a var-uint byte
count, then exactly that many raw bytes (distinct from the UTF-8
length-prefixed string encoding). The tag and encoding are append-only:
a buffer-free program never emits them, and the format version is
unchanged.

### Program type table

Programs carry a type table (`Program.types: List<ProgramTypeEntry>`)
holding one entry per distinct type the program references. Type
identity travels exclusively by table index:

- `INSTANCE_OF.a`, and the optional `b` operands of `LIST_NEW`,
  `MAP_NEW`, `STRUCT_NEW`, and `STRUCT_COPY_EXCEPT`, are type-table
  indices.
- `FunctionBytecode.injectCtxTypeIdx` (the injected execution-context
  struct type of a function) is a type-table index.
- Constant values in `constantPools.values` resolve their typeIds
  through the table on the wire; enum constants carry
  `(type index, symbol ordinal)` pairs.

Entry kinds (child references are table indices strictly less than
the entry's own index, so a single forward pass interns the table):

- `atom { atomId }` -- a core/target nominal type identified by its
  stable type-atom id (declared in `runtime/abi-ids.ts` and the
  target's id declarations; core ids are below
  `TARGET_TYPE_ATOM_BASE = 1024`, target ids at or above it).
- `list { elem }`, `map { key, value }` -- parameterized containers.
- `union { members }` -- members follow the registry's canonical
  sorted member order.
- `function { params, result }` -- structural function type.
- `nullable { base }` -- nullable wrapper.
- `struct { name, maxFieldId, fields }` -- a program-local struct.
  Identity is the table position; `name` is carried for round-trip;
  field storage holds `maxFieldId + 1` slots (`maxFieldId` is -1 for a
  fieldless struct). `fields` is the field name -> id map (a list of
  `{ name, fieldIndex }` pairs) the dynamic computed-key opcodes
  (`GET_FIELD` / `SET_FIELD` / `STRUCT_COPY_EXCEPT`) resolve names
  against; a struct accessed only by static field id may carry none.
  Static `.field` access stays id-based and reads no names.
- `enum { name, symbols }` -- a program-local enum; `symbols` lists
  the symbols in declared order (defining the ordinals used by enum
  constant values), each carrying its key and its declared primitive
  value. All symbols of one enum share a value kind: all string or
  all number (the registry rejects mixed enums at registration).
  Numeric values are at the profile precision. The shared
  `ConvEnumToString` / `ConvEnumToNumber` core host functions read
  these values at runtime.

For an enum type registered as an atom, the registered declaration's
symbol order is the ordinal source and is ABI: append-only, never
reordered, never reused; its symbol values resolve through the
runtime's type registry.

On the TS reference VM each entry resolves to its `TypeId` string and
the runtime keeps string-keyed type identity; an integer-identity
port interns the table once at load (atoms bind to the statically
mirrored atom table; structural and program-local entries become
local handles) and compares types as integers.

#### TYPS binary section

The binary `.mcprogram` form (format version 4) encodes the table as
the `TYPS` section, positioned after `CSTR` and before `CNUM` so the
later sections can reference it. Layout: a var-uint entry count, then
per entry a tag byte followed by its fields (all var-uints):

| Tag | Kind     | Fields |
| --- | -------- | ------ |
| 0   | atom     | `atomId` |
| 1   | list     | `elem` |
| 2   | map      | `key`, `value` |
| 3   | union    | `memberCount`, members |
| 4   | function | `paramCount`, params, `result` |
| 5   | nullable | `base` |
| 6   | struct   | `nameIdx` (CSTR), `slotCount` (= `maxFieldId + 1`), `fieldCount`, then per field `nameIdx` (CSTR) and `fieldId` |
| 7   | enum     | `nameIdx` (CSTR), `symbolCount`, then when `symbolCount > 0` a value-kind byte (`0` number, `1` string) followed per symbol by its key CSTR index and its value (a CNUM-format number entry for kind `0`, a CSTR index for kind `1`) |

TypeId strings are never written; the decoder reconstructs them
(atoms through the runtime's atom registrations, structural entries
through the deterministic composition rules, program-local entries
through their carried names). A reader rejects: an unknown tag byte,
a child reference at or beyond its entry's own index, an atom id not
registered in the decoding runtime, an enum ordinal outside its
type's symbol list, an enum value-kind byte other than `0`/`1`, and
a format version other than its own.

---

## Calling convention

### Host-call layout

Host functions registered through `IFunctionRegistry` are invoked
via the `HOST_CALL` / `HOST_CALL_ASYNC` opcode pair (see the
[Host calls](#host-calls) row in the opcode reference for numeric
assignments and per-row stack effects).

Operands:

- `fnId` is the function id assigned at registration time by
  `IFunctionRegistry`.
- `argc` is the **arg buffer width**. The dispatcher trusts `argc`
  to be the width on the operand stack;
  `argc == fnEntry.callDef.argSlots.size()` is true by construction
  for compiler-emitted call sites. Carried as an operand to avoid the
  registry indirection on the hot dispatch path.
- `callSiteId` is the unique call-site id used by the host to key
  per-call-site state (e.g. timer carry, accumulator state).

Before invoking the host, the dispatcher sets
`fiber.executionContext.currentCallSiteId = callSiteId`.

**Arg buffer.** The compiler reserves `argc` operand-stack slots
immediately preceding the call by emitting `argc` `PUSH_CONST_VAL`
of `NIL_VALUE` followed, for each user-supplied slot, by a
`STACK_SET_REL d` that overwrites the right filler. Slot ids are
indices into `callDef.argSlots`. The host reads slot `i` as
`args.get(i)`. Unsupplied slots are observed as `NIL_VALUE`; check
via `isNilValue(args.get(i))`. There is no `args.has(i)` distinct
from this -- "missing" and "explicitly nil" are not separable in
this ABI.

**Emit-side `d` formula.** Let `N = argc`. After pushing the `N`
NIL fillers the stack top is at the position of the last filler.
For target slot `s` in `0..N-1`, after pushing the user expression
the new top sits one slot above the buffer; after the implicit pop
in `STACK_SET_REL`, the new top is at the position of the last
filler. The d that addresses slot `s` from that new top is:

```
d = (N - 1) - s
```

Slot `0` therefore emits `STACK_SET_REL N-1` (deepest fill); slot
`N-1` emits `STACK_SET_REL 0` (overwrites the topmost filler with
the popped expression -- not a no-op under the top-element
convention). The compiler emits the same
`lower expr; STACK_SET_REL d` pair for every supplied slot
regardless of order; the formula is independent of emission order.

**Sync vs async.** Sync and async hosts share the slot layout but
have different lifetime contracts:

- `HostSyncFn.exec(ctx, args: ReadonlyList<Value>): Value` --
  `args` is a `Sublist` view over the operand stack. The wrapper is
  ephemeral; the sync host must read what it needs into locals and
  return. Individual `Value` heap objects retrieved through
  `args.get(i)` are always safe to retain.
- `HostAsyncFn.exec(ctx, args: ReadonlyList<Value>, handleId)` --
  `args` is an owned snapshot allocated by the dispatcher (a fresh
  `List<Value>`). The async host may close over the wrapper and
  individual values across the async boundary, then resolve or
  reject the handle whenever the work completes.

The dispatcher pops the buffer (or, for async, copies it then
pops) before the host call returns, so the buffer is no longer
visible to the host's continuation.

**Re-entry.** A host `exec` body must not invoke any of the four VM
entry points listed in [Single-entry guarantee](#single-entry-guarantee).
Within the synchronous duration of an `exec` call the host may read
its `args` view and the rest of `ctx`, but must not call back into
`brain.think()`, `scheduler.tick()`, `runFiber()`, or async-handle
resolution. See that section for the full transitive rule.

Action calls (`ACTION_CALL` / `ACTION_CALL_ASYNC` and
`HOST_ACTION_CALL` / `HOST_ACTION_CALL_ASYNC`) use the same
positional buffer shape as host calls. The compiler pushes one
`NIL_VALUE` filler per declared action slot, lowers each supplied
argument expression, and stores it into the slot with
`STACK_SET_REL argc-1-slotId`. Operand `a` is the bytecode action
slot (`ACTION_CALL`) or the stable host action id (`HOST_ACTION_CALL`),
operand `b` is `argc`, and operand `c` is the call-site id.

Host-bound sync actions receive a transient
`ReadonlyList<Value>` stack view and host-bound async actions receive
an owned snapshot, matching the host function lifetime contract
above. Bytecode actions do not receive an args map or list object:
their frame locals are laid out as `ctx` (when injected), then one
local per action slot. `args.<name>` in user-authored action code
lowers directly to that slot local. Reading the whole `args` object
is unsupported.

Sparse, optional, conditional, and repeated slots are represented by
`NIL_VALUE` when absent. There is no per-call presence map, so user
code that needs an omitted value to behave like a default must express
that fallback explicitly, for example with `??`.

**Sync host-call failure.** A synchronous host body reports failure
instead of producing a result, and the failure escapes the dispatch
before the call is observed. The calling fiber faults with the
failure's `ErrorCode` -- `ScriptError` for a plain dispatch-time
exception -- on the direct fault path, not through the fiber's `TRY`
handlers: nothing is pushed, the pc does not advance, and no
action-return event is emitted, so a `HOST_ACTION_CALL` that fails
renders a `fault` record and no `action` record in an observable
trace. The TS reference expresses the failure as a raise out of
`exec`; an implementation whose sync bodies instead return an error
value applies the same ordering, faulting before any observation.

### Operator monomorphization

Arithmetic on primitive `NumberValue` (and other primitive) operands
is monomorphic on the dispatch hot path. Operator overload resolution
happens at compile time: the compiler resolves each operator use to a
concrete `BrainFunctionEntry` and emits `HOST_CALL <fnId>` over the
prescribed NIL+STACK_SET_REL arg-buffer pattern (above). The runtime's
dispatch loop never consults `IOperatorTable`, `IOperatorOverloads`,
or `ITypeRegistry` to dispatch a primitive arithmetic instruction.
The dispatch loop only consults `ITypeRegistry` for struct-shaped
opcodes (e.g. `GET_FIELD`, `SET_FIELD`, `STORE_VAR_SLOT` when
deep-copying a struct value).

---

## Page lifecycle hooks

Every `BytecodeExecutableAction` declares up to three optional
hook function ids that the brain runtime dispatches at well-defined
points in a page's life. Every host-bound action declares up to two
optional host hook callbacks that the brain runtime dispatches at
the same points. These hooks own all per-callsite state setup,
re-setup on respawn, and teardown.

### Bytecode hook fields

`BytecodeExecutableAction` carries:

- `initializerFuncId?: number` -- runs at most once per
  `(brainInstance, callSiteId)` pair, the first time that callsite
  is activated. The compiler emits module-scope `let` / `const`
  initializers (and equivalent static-field initializers) into this
  function. After the first run, the callsite's storage is
  considered initialized and the function is not invoked again for
  the same brain instance, even across page exits and re-entries,
  until the brain itself is shut down.
- `activationFuncId?: number` -- runs every time the page
  containing this callsite becomes active. The compiler reserves
  this slot for an in-action `onPageEntered` handler; without that
  source-level construct, user programs leave it unset.
- `deactivationFuncId?: number` -- runs every time the page
  containing this callsite becomes inactive. The compiler reserves
  this slot for an in-action `onPageExited` handler; without that
  source-level construct, user programs leave it unset.

### Host hook fields

Host-bound actions carry:

- `onInitialized?: (...) => void` -- runs at most once per
  `(brainInstance, callSiteId)` pair, on the first activation
  that allocates the call site, before `onPageEntered` fires
  for the same activation. Symmetric to the bytecode
  `initializerFuncId`. Cleared by
  `services.brain.callsite.reset(callSiteId)` (re-runs on the next
  activation) and by the orchestrator's brain shutdown (re-runs on
  the next brain startup). Soft `requestPageRestart` does not
  re-fire this hook.
- `onPageEntered?: (...) => void` -- runs every time the page
  containing this callsite becomes active.
- `onPageExited?: (...) => void` -- runs every time the page
  containing this callsite becomes inactive.

When `onInitialized` is set, the brain runtime calls
`services.brain.callsite.ensure(callSiteId)` for the host callsite to
detect first-touch; when it is unset, no callsite record is
allocated for the host action and no first-touch dispatch
occurs.

### Brain-instance-scoped lifetime

All callsite storage -- bytecode state slots and host state -- is
scoped to a single brain instance. The runtime contract is:

- Storage is allocated **lazily** on first write
  (`services.brain.callsite.setSlot`, `services.brain.callsite.setHostState`) or
  on the first `services.brain.callsite.ensure(callSiteId)` call for
  actions that declare an `initializerFuncId`.
- `services.brain.callsite.ensure(callSiteId)` returns `true` on the first
  call for a callsite (newly allocated) and `false` thereafter. The
  brain runtime uses this result to dispatch `initializerFuncId`
  exactly once per allocation.
- Storage **persists** across page exits and re-entries within the
  same brain instance. Returning to a page does not reset its
  callsite state.

### Explicit reset primitives

The runtime exposes two primitives for callers (host code and the
brain runtime itself) to discard callsite state explicitly:

- `services.brain.callsite.reset(callSiteId)` -- deallocates the bytecode
  state slot block and the host-side cell for the callsite together.
  The next `services.brain.callsite.ensure` for the same id returns `true`
  and the next page activation re-runs the `initializerFuncId` for
  that callsite.
- `services.brain.callsite.clearHostState(callSiteId)` -- clears the
  host-side state cell for the callsite without affecting bytecode
  state slots.

These primitives are the only sanctioned way to force a re-init
short of tearing down the whole brain.

### Brain shutdown teardown contract

The orchestrator's brain-shutdown operation is the brain-wide
teardown counterpart to allocation. It is required to release every
callsite's storage so that a subsequent brain startup on the same
instance behaves identically to a fresh brain: every
`initializerFuncId` runs again on first activation, and every host
hook re-binds against freshly allocated host state. Implementations
must not leak callsite state across a shutdown / startup boundary.

---

## Numeric semantics and profile precision

Brain-observable numbers are computed at the **device profile's
precision**: f64 (native double) or f32 (IEEE-754 binary32). The
selection is a `ProfileNumerics` instance
(`packages/core/src/runtime/profile-numerics.ts`) chosen once at
environment construction (`AppServices.numerics`) and captured by the
operator, conversion, and math-builtin exec bodies at registration.
There is no ambient or per-call selection; environments with
different precisions coexist in one process.

VM-internal mechanics are profile-invariant: operand-stack indexing,
list/map index coercion, codec encoding, and scheduler bookkeeping do
not vary with the profile. Only host-function results that a brain
can observe go through `ProfileNumerics`.

The f32 rules model a single-precision FPU (e.g. the M4F) bit-exactly:

- **Result rounding.** Every numeric operator result is rounded to the
  nearest binary32 value (`Math.fround` semantics in the TS reference;
  native f32 arithmetic on a device). For `+ - * / %` and `sqrt` on
  f32-representable inputs, rounding the double-precision result is
  provably the correctly-rounded f32 result, so the TS reference and
  native f32 hardware agree bit-for-bit. A result whose magnitude
  exceeds the f32 range rounds to an infinity, matching hardware
  overflow.
- **Bitwise and shift ops** keep i32/ToInt32 coercion semantics
  (precision-independent mechanics), and the i32 result is then stored
  at the profile's precision -- at f32, a result needing more than 24
  mantissa bits rounds.
- **Invalid-operand conventions are unchanged by precision**: NaN
  operands collapse arithmetic to `nil` and comparisons to `false`;
  `div` / `mod` by zero produce `nil`.
- **Constant pools are already profile-rounded** by the binary codec
  (the `.mcprogram` is profile-tagged and an f32 program never carries
  f64 numeric entries), so constants need no runtime rounding.

The transcendental slots (`pow`, `sin`, ...), `formatNumber`, and
`parseNumber` are **not yet pinned**: until the device reference
implementations are chosen, the f32 instance delegates to the host's
double-precision math and rounds numeric results to f32. Their
low-order result bits are therefore not yet part of the cross-VM
parity surface; result rounding, basic arithmetic, `sqrt`, and the
invalid-operand conventions are.

---

## Fiber scheduling

Scheduler behavior is observable (it orders side effects from
different fibers), so it is part of the contract. Conforming VMs
reproduce it exactly.

- **FIFO run queue.** Runnable fibers are dispatched in enqueue
  order. A fiber id appears at most once in the queue.
- **A tick is a round.** `FiberScheduler.tick()` snapshots the
  runnable queue at entry and gives every fiber in the snapshot
  exactly one budget slice (`instrBudget = defaultBudget`). Anything
  enqueued while the round runs -- a `YIELD` or budget-exhaustion
  re-enqueue, a handle-completion resume -- joins the **next** round.
  Fresh child-rule spawns are the exception: they drain within the same
  tick (see **Synchronous child-rule cascade** below). There is no
  per-tick invocation cap: every top-level rule on the active page
  evaluates every think by construction, and `YIELD` deterministically
  resumes on the next tick. Per-tick work is bounded by
  `liveFibers x defaultBudget`.
- **Synchronous child-rule cascade.** A `SPAWN_RULE` does not enqueue
  its child into the run queue; it holds the child in a per-tick spawn
  drain. After each fiber's slice, the tick drains that fiber's freshly
  spawned children depth-first -- a child runs to completion or park,
  its own freshly spawned grandchildren drain before the child's next
  sibling, one subtree finishing before the next begins -- so a whole
  synchronous rule hierarchy runs within one think, in causal order.
  Placing an action in a child rule versus on its parent does not change
  its timing. Only a child that completes frees within the think; a
  child that reaches `AWAIT` (parked), `YIELD`, or budget exhaustion
  takes its normal next-round / handle-wait path and resumes across the
  think boundary, exactly like any other fiber. A brain that spawns no
  child rules never populates the drain, so its tick is byte-identical
  to a scheduler without it.
- **Budgets are profile-pinned.** `defaultBudget` (TS default 1000)
  is the per-slice instruction budget. `hookBudget` (TS default
  10000) is the budget for page-lifecycle hook fibers, which run to
  completion via a direct `runFiber` call outside the tick loop and
  may not suspend. A device profile pins both values and the device
  build mirrors them as build constants; they are not free tuning
  knobs.
- **Rule respawn.** Completed **and faulted** root-rule fibers
  respawn on the next think; a fault kills the fiber, not the rule. A
  root rule does **not** respawn while any live (runnable or waiting)
  child-rule fiber belongs to its subtree: the rule quiesces -- it does
  not re-fire its `WHEN`/`DO` -- while a descendant child it spawned is
  still in flight (e.g. parked awaiting), and re-fires only once the
  whole subtree has settled. Subtree membership is the static rule
  ancestry: a child-rule fiber carries the funcId of the root rule it
  descends from.
- **Every rule is a fiber.** Root rules are spawned one per
  `rootRuleFuncIds` entry on page activation. Child rules (nested in a
  parent's `DO`) are spawned by the parent's `SPAWN_RULE` at its tail,
  fire-and-forget, and run in their own fibers -- so a child rule's
  `AWAIT` parks only that child and sibling child rules are concurrent.
  A synchronous child rule drains within its parent's think (see
  **Synchronous child-rule cascade**); only `AWAIT`, `YIELD`, and budget
  exhaustion cross the think boundary.
- **Cancellation cascade.** Deactivating, restarting, or switching away
  from the active page cancels its root-rule fibers and, via the cascade,
  every live child-rule fiber spawned beneath them -- including a child
  still pending in the current tick's spawn drain. Exactly one page is
  active, so every live child-rule fiber descends from one of its roots;
  cancelling each removes it from the run queue, so the cascade is safe
  when a host body triggers it mid-round or mid-drain. No child fiber is
  orphaned.
- **Settle walk at terminal transitions.** Every fiber terminal
  transition -- `DONE`, `FAULT`, `CANCELLED` -- runs a settle walk: the
  scheduler takes the finishing fiber's rule and walks it and its
  ancestors. A fiber that faulted or was cancelled marks every rule on
  that walk -- exactly the clusters it belonged to -- as an **abandoned
  firing**. Then, for each rule whose subtree has emptied, the walk
  resolves that rule's pending trigger handle, if it holds one, with that
  rule's firing outcome: a `DidFire` record with no abandonment mark
  resolves the handle `true`, and a `DidNotFire` record or an abandoned
  firing resolves it as a skip (`false`). The mark, not the finishing
  fiber's own terminal state, decides the skip, so a fault anywhere in a
  cluster abandons it even when a later fiber empties the cluster `DONE`.
  A rule's mark is cleared when a fiber is spawned at that rule's own
  entry point, which begins its next firing, so the mark always describes
  the rule's current firing. A rule holds at most one **watcher slot**,
  because only the immediately following sibling can watch it. Subtree
  membership is the static rule ancestry -- the same relation **Rule
  respawn** uses for re-fire quiescence, evaluated here for an arbitrary
  rule rather than only for a root, from the fiber table and
  `Program.ruleAncestors`. Watcher slots and abandonment marks, like the
  firing record, are runtime-internal: not serialized, not traced.
- **Handle-completion resume timing.** A fiber made runnable by a handle
  settling joins the run queue and runs in the next round, never the
  current one (the round rule). A handle that settles while a round runs
  (an async-action child completing) resumes its waiter for the next
  round; a handle settled out of band between thinks resumes its waiter
  before the next round opens.
- **`maxFibers` is a generous runaway-spawn guard, not a memory cap.**
  Fibers are allocated on demand; the count is bounded structurally by
  available memory (a fixed-capacity port faults `StackOverflow` at
  spawn when fiber memory is exhausted) and, above that, by `maxFibers`
  -- a deliberately generous ceiling far beyond any reasonable brain
  (default 10000; the microbit-v2 profile pins 100). Exhausting it is a
  loud, deterministic fault -- an `OverflowError` from a host-side
  `spawn`/`addFiber`, surfacing as a `StackOverflow` fault on the
  spawning fiber when the spawn came from bytecode -- never a silent
  skip. On a constrained device, memory is reached first, so the guard
  binds only once per-fiber stacks are small enough that the count
  could otherwise run away.

---

## Feature flags

None, by design. See [Opcode completeness](#opcode-completeness)
for the architectural commitment (every conforming VM implements
every opcode; the compiler is target-unaware).

Runtime feature flags (`fibers`, `structuredExceptions`,
`asyncHandles`) and a compile-time `CompileTarget` capability
descriptor were considered and rejected. Capability differences
between hosts are surfaced through host registration (async
functions / actions) and language-tile gating in the compiler,
not through VM-level flags or compiler-level target awareness.

Two invariants follow from this:

- **Adding an opcode to this spec obligates every conforming VM to implement it.**
  There is no per-host capability gate. Host constraints belong in
  the decision to add an opcode, not in the VM or compiler.
- **Runtime flags do not help C++ ports.**
  A C++ MCU port makes
  capability decisions at build time via `#ifdef` / build
  constants, not by reading a runtime flag. A TS-side runtime
  flag would impose per-opcode dispatch overhead in the TS VM
  with no corresponding mechanism on the C++ side.

Per-deployment caps for memory-constrained hosts are documented
under [Limits](#limits).

---

## Error model

Every fault produced by the VM carries an `ErrorCode` tag:

```ts
type ErrorValue = {
  code: ErrorCode; // numeric, wire-stable
  // implementations may include additional diagnostic fields
};
```

Only `code` is contractual.

`code` is a numeric `ErrorCode`. Values are explicit and never reordered:

| Code             | Numeric | Raised when                                                                                                                                                                                             |
| ---------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Timeout`        | 1       | Reserved; not yet emitted by the runtime.                                                                                                                                                               |
| `Cancelled`      | 2       | A handle is cancelled, or `cancelFiber` is invoked on a runnable/waiting fiber.                                                                                                                         |
| `HostError`      | 3       | An async handle rejects without an explicit error, or the host async path fails.                                                                                                                        |
| `ScriptError`    | 4       | Bytecode-level fault: missing frame, PC out of bounds, unknown opcode, dispatch-time exception, `THROW` of a non-error value.                                                                           |
| `StackOverflow`  | 5       | A configured capacity cap is exceeded: operand stack (`maxStackSize`), total locals (`maxLocalsSize`), frame depth (`maxFrameDepth`), handler stack (`maxHandlers`), pending handles (`maxHandles`), or the `maxFibers` runaway-spawn guard. |
| `StackUnderflow` | 6       | An opcode handler attempts to `pop` or `peek` from an empty operand stack. Indicates malformed bytecode (the compiler should never emit such a sequence).                                               |

The runtime never compares against the string label. Render the label at
the diagnostics boundary via `errorCodeName(code)` (returns `"ScriptError"`,
`"HostError"`, etc.).

### Host fault callback

`Scheduler.onFiberFault?: (fiberId: number, error: ErrorValue) => void`
is invoked exactly once per faulting fiber, after the fiber transitions
to `FAULT` and any associated async-action handle is rejected.

---

## Limits

The runtime exposes six capacity caps. Crossing any of them surfaces
as an `ErrorCode.StackOverflow` fault on the offending fiber (the host
fault callback receives a normal `ErrorValue`; the runtime never throws
out of `runFiber`). Four are per-fiber (`VmConfig`); two are global
(host-owned).

| Cap             | Owner                  | Default             | Triggered when                                                                                                                                       |
| --------------- | ---------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxStackSize`  | `VmConfig` (per fiber) | 4096                | The operand stack would grow past this many values.                                                                                                  |
| `maxLocalsSize` | `VmConfig` (per fiber) | 4096                | A frame push (`CALL` / `CALL_INDIRECT` / `CALL_INDIRECT_ARGS` / `ACTION_CALL` / the entry frame) would carry the fiber's total live locals, summed across every frame, past this many values. |
| `maxFrameDepth` | `VmConfig` (per fiber) | 256                 | A `CALL` / `CALL_INDIRECT` / `CALL_INDIRECT_ARGS` / `ACTION_CALL` would push a frame past this depth.                                                |
| `maxHandlers`   | `VmConfig` (per fiber) | 64                  | A `TRY` would install a handler past this depth on the handler stack.                                                                                |
| `maxHandles`    | `HandleTable` ctor arg | 100000 (production) | A capped `HandleTable.createPending()` is invoked when the table already holds this many capped entries. Reached only by a host driving the table directly: a bytecode dispatch backpressures instead, and faults `StackOverflow` after `HANDLE_BACKPRESSURE_FAULT_ROUNDS` starved rounds. |
| `maxFibers`     | `SchedulerConfig`      | 10000               | `FiberScheduler.addFiber()` (and therefore `spawn()` and async-action fiber creation) is invoked when the scheduler already tracks this many fibers. A generous runaway guard; the microbit-v2 profile pins 100. |

Both kinds of violation surface to the offending fiber as
`ErrorCode.StackOverflow` (or `ErrorCode.StackUnderflow` for operand
underflow). Hosts that drive `HandleTable.createPending` or
`FiberScheduler.spawn` directly may see the limit violation propagate
as a thrown value out of those calls; the wire-level fault code is
still `StackOverflow`.

`maxFibers` lives on `SchedulerConfig` because the scheduler -- not the
VM -- owns the fiber pool.

Operand widths and other numeric ranges (slot ids, function ids,
constant indices) are part of the decoded bytecode contract. The MCU
binary container may encode them differently, but it must decode to the
operand widths documented in the opcode reference above.

### Recommended caps for memory-constrained hosts

The default caps in the table above are sized for a desktop host
running the simulator and authoring tools. An embed host targeting
a memory-constrained deployment (microcontroller, sandboxed plugin,
WASM module with a small heap) is expected to lower most of them.
This subsection describes the _shape_ of that choice. Concrete
numbers belong to the host's build configuration, not this spec.

On the TypeScript reference VM every cap is a **fault gate**: the
backing storage (operand stack, frame stack, handler stack, handle
table, fiber list) is a lazy `List` / `Dict` that grows as values
are pushed. Lowering a cap on the TS VM trades fault threshold for
fault threshold; it does not save heap. A fixed-array port (notably
the C++ MCU port) is expected to use the same cap as a build-time
sizing input, in which case lowering the cap _does_ shrink the
binary's resident memory footprint.

Per cap, an embed host should weigh:

- **`maxStackSize`** -- bounds the operand stack of a single fiber.
  Weigh: deepest expression nesting in user code (each arithmetic
  intermediate consumes one slot) and the widest action call (each
  argument is pushed before `ACTION_CALL`). Per-slot cost on a
  fixed-array port is one `Value` (tagged union). Overflow raises
  `ErrorCode.StackOverflow`. Fault gate on the TS VM; sizing input
  on a fixed-array port.
- **`maxLocalsSize`** -- bounds the combined locals of all live frames
  of a single fiber (each frame contributes its `numLocals`). Weigh:
  deepest call chain multiplied by the per-function local count. Per-slot
  cost on a fixed-array port is one `Value`. Overflow raises
  `ErrorCode.StackOverflow` at the frame push that would cross it. Fault
  gate on the TS VM; sizing input on a fixed-array port.
- **`maxFrameDepth`** -- bounds the call-frame stack of a single
  fiber. Weigh: deepest call chain (recursion, mutual recursion,
  action-call chains via `ACTION_CALL`). Per-frame cost on a
  fixed-array port is one frame record (program counter, frame
  pointer, function id, locals slice header). Overflow raises
  `ErrorCode.StackOverflow`. Fault gate on the TS VM; sizing
  input on a fixed-array port.
- **`maxHandlers`** -- bounds the handler stack of a single fiber
  (one entry per active `TRY`). Weigh: deepest dynamic nesting of
  `TRY` blocks. Per-entry cost on a fixed-array port is one
  handler record (catch program counter, frame depth snapshot,
  handler stack snapshot). Overflow raises `ErrorCode.StackOverflow`.
  Fault gate on the TS VM; sizing input on a fixed-array port.
- **`maxHandles`** -- bounds the capped handles of the global
  `HandleTable`. Weigh: expected count of in-flight async actions
  across all fibers. Each handle is one entry until it resolves and
  is collected. Handles from a binding declaring `uncappedHandles`
  (the rule-trigger sensor) are excluded from the count, so a `then`
  chain's length is bounded by fibers and memory, not by this cap.
  Pure fault gate on the TS VM (the `Dict` is lazy; lowering the
  cap saves zero bytes). On a fixed-array port that pre-allocates
  the handle slab, the cap also sizes the slab. Overflow raises
  `ErrorCode.StackOverflow` from `HandleTable.createPending`.
  Set to `0` to forbid async actions entirely; the host then must
  also refuse to register any async functions.
- **`maxFibers`** -- a generous runaway-spawn guard on the global fiber
  pool owned by the scheduler, not a memory-sizing knob. Fibers are
  allocated on demand, so a fixed-capacity port already faults
  `ErrorCode.StackOverflow` at spawn when fiber memory is exhausted;
  `maxFibers` is a deliberately large ceiling above that (default
  10000, microbit-v2 profile 100) catching a runaway spawn loop
  deterministically. Overflow raises `ErrorCode.StackOverflow` from
  `FiberScheduler.addFiber`. On a constrained device, memory binds
  first, so the guard matters once per-fiber stacks are small enough
  for the count to otherwise run away.

Treat the per-cap costs above as ordering, not absolutes; measured
byte costs for a specific MCU build vary by platform and compiler
settings.

---

## Binary format (appendix)

MCU-targeting binary layout produced by the offline transform.
The TS VM does not consume this format.
