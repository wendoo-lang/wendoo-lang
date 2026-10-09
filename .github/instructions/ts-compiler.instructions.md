---
applyTo: "packages/ts-compiler/**"
---

# TS-Compiler Operating Principles

The ts-compiler turns user-authored TypeScript into Wendoo programs, tiles,
and type-registry entries. Its users are learners writing what they believe is
ordinary TypeScript; the product's credibility rests on that belief holding.
These principles bind every change in the package. They complement the global
instructions; where the global rules say how to write code, this file says what
a compiler feature must satisfy before it is done.

## The Trust Contract

The compiler behaves like the regular TypeScript compiler in the general case,
and it never fails silently.

- Every construct on a shipped surface either WORKS with TypeScript semantics
  or fails with a precise, deterministic diagnostic. "Neither supported nor
  blocked" may not survive a change; blocking precisely is always an
  acceptable interim.
- Compile outcomes are order-independent. Reordering declarations, moving them
  between modules, or changing import order never changes the result. A shape
  TypeScript itself rejects (for example a use-before-declaration reference)
  fails with TypeScript's own error; matching tsc is the contract, not a
  loophole.
- Outcomes do not depend on compile history. The registry persists across
  programs in a session (register-if-absent); a program must compile
  identically against a fresh registry and a warm one.
- A misleading diagnostic is a failure. Messages describe the user's actual
  situation, never the resolver's internal state. "Unknown type" is only
  correct when the type is genuinely unknown.

## Pin or Block

Accidental success is a defect, not a feature. Any construct the compiler
accepts must be pinned by a test -- at the compile level (registered shape,
diagnostics, emitted structure) and at runtime where the construct produces
values a brain can observe. If a construct cannot be supported yet, it must be
rejected deterministically with its own diagnostic. Code that happens to
compile in one arrangement, with no test holding it in place, is where later
breakage comes from.

Every new or changed failure branch in lowering, descriptor extraction, or
emission pushes its own precise diagnostic and has a test asserting that
emission. The suite-level ratchet in `src/testsupport/` enforces that every
`LoweringDiagCode` is asserted-emitted or allowlisted, and the allowlist only
shrinks. Diagnostic codes are append-only: new codes take the next id, retired
codes become `UnusedN` free slots, and ids are never renumbered.

## Definition of Done: the Interaction Sweep

A type-system construct is not done when its own happy path works; it is done
when its boundary with the rest of the type system is accounted for. Before
declaring a construct complete, sweep its interactions with the existing
kinds:

- user classes, interfaces, type aliases, enums, and `StructType({...})`
  declarations
- System state shapes
- conversions and the name surfaces that accept type references
- optional/nullable and union spellings of the construct's types
- same-module and cross-module layouts, declared above and below the
  reference, in both import directions

Each combination ends in exactly one of three states: tested working, tested
blocked with a precise diagnostic, or explicitly named out of scope in the
work summary. An unnamed combination is an unnoticed gap by definition.

## Parallel Paths Propagate

The named-type registration paths -- classes, interfaces, type aliases, and
`StructType` declarations -- are structural siblings. A defect found and fixed
in one is presumed present in the others until checked; auditing the siblings
is part of the same change, not a follow-up. The same applies to any family of
parallel lowering paths (argument kinds, literal forms, accessor read and
write).

## Member-Chain Stores

A field store through a member chain (`a.b.x = v` and its compound forms)
follows generic TypeScript wherever a link is a TypeScript construct, and
adds write-back only where a link is a Wendoo hooked field.

- A link through a field of a struct type with field hooks reads a copy, so
  the store writes each such intermediate back through the field setter,
  innermost first. A read-only hooked link refuses the store with
  `ReadOnlyFieldAssignment`.
- A link through a TS-authored class accessor keeps generic TypeScript
  semantics: the getter is called, its result is mutated, and the setter is
  not called. The compiler neither refuses the store nor writes back through
  the setter.
- A read-only PLAIN link (a `readonly` field of a struct type without field
  hooks) stays assignable-through: `readonly` is shallow, so `a.ro.x = v`
  stores into the value `a.ro` holds.

## Probe Before Believing

Claims about current behavior come from compiled probes, not from reading the
code. Before building on or reporting what the compiler does today, write the
test that compiles real user-code sources through the project harness
(`UserTileProject`) and observe the outcome -- red first when the work is a
fix, so the change is demonstrated red-to-green. Code reading proposes;
probes decide. This applies to one's own predictions as much as to anchors
inherited from a plan or kickoff.

## Type Registration Pipeline

The registration sequence inside `lowerProgram` is load-bearing. Field and
reference resolution reads the live registry, so a consumer sequenced before
its dependencies register is an order bug waiting for a layout that exposes
it.

Current sequence: collection of module-level declarations across the entry and
every imported module; `StructType` registration; enum registration;
reservation of ALL classes, interfaces, and type aliases; finalization of all
three kinds; then System binding and state processing (a resolution consumer:
state field types resolve against the completed registry); then body lowering.

Three registration mechanisms exist, and every named-type kind uses one of the
first two:

- `StructType({...})` declarations: gather every declaration first, then
  resolve and register in dependency order; containment cycles are rejected
  with `StructTypeRecursiveField` (struct fields hold values by copy, so a
  struct cannot contain its own type).
- Classes, interfaces, and type aliases: reserve-all-then-finalize-all;
  recursion is legal (a nullable self-reference is the linked-node pattern),
  and every reservation precedes any finalization so cross-kind fields
  resolve in any order.
- Checker-derived structural types (object literals, intersections, instance
  types): registered on demand during lowering, deduplicated by name.
  Instance types of `StructType` declarations resolve to the declared struct,
  never to a parallel structural registration.

A new named-type kind joins reserve/finalize or gather-then-register; a
single-pass resolve-at-extraction scheme is not an option, because it leaks
visit order into compile outcomes. A new resolution consumer is sequenced
after the reservations it depends on. Changing this sequence or adding a kind
updates this section in the same change.
