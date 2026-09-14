---
applyTo: "**"
---

<!-- Last reviewed: 2026-07-17 -->

# Global Instructions

These rules apply to every agent working anywhere in this repository. This file
is the canonical home of the comment guidelines, the ASCII-only rule, the
zero-noise check policy, the display-prose test rule, and the broad-view rule.

## Code Examples and Documentation

Place ad-hoc feature documentation and example files in a `generated-docs/`
folder at the project root, never in a `src` folder, so their non-source,
generated status is clear. Include the creation date in the file name, for
example `example-feature-2026-05-10.ts` or `docs-feature-2026-05-10.md`.

## Comments in Source Files

This codebase is used for teaching, so API documentation is desired. Document
exported types, functions, classes, and non-trivial fields with JSDoc that
explains what they are and how to use them, so a reader can understand the code
without external context.

What to write:

- JSDoc on exported symbols, including types, interfaces, classes, functions,
  and public methods, describing purpose, inputs, outputs, and invariants.
- Field-level JSDoc on non-obvious properties, including units, formats,
  allowed values, and nullability semantics.
- Brief inline comments where the logic itself is non-obvious and a reader
  would genuinely benefit from a hint about intent or an invariant.

What not to write:

- Rationale or history-lesson comments. Do not explain why a file is structured
  a certain way, why a refactor was done, or what constraints drove a past
  design decision.
- Comments that just restate what the code literally does.
- Stub-style placeholder comments that stand in for unwritten future code.

Avoid design-justification comments that explain why the current shape was
chosen rather than what it is. A reader who has never seen the alternative gains
nothing from them.

Watch for JSDoc that justifies a design decision when it should simply describe
the symbol. Apply the removal test: cover the comment with your hand and re-read
the code. If a reader cannot figure out what the field or function is, or how to
use it correctly, without the comment, keep it. If covering the comment only
removes justification of the current design, delete it.

Scope each comment to its own symbol. Document what the symbol is, its inputs,
outputs, and errors -- the symbol itself, not what it is not or what a
neighboring symbol does. Keep a cross-reference only when a reader cannot use
this symbol correctly without it -- a required companion call or a precondition
established elsewhere -- and state it as a plain instruction ("call `init()`
first"). A comment that contrasts the symbol against an alternative, or redirects
the reader to a different API for a related task, pulls in scope the reader did
not ask about and invites tangential questions.

- Prefer a comment that states what the symbol does and how it fails:
  `Compiles and links a brain and returns the linked program. Throws if it fails
  to compile or link.`

## ASCII-Only Text in Comments and Documentation

Use only keyboard-typable ASCII characters in code comments, markdown
documentation, and string literals used for logging or display. Do not use
Unicode arrows, em dashes, bullet characters, box-drawing characters, or other
non-keyboard symbols.

Common substitutions:

- `->` instead of Unicode right arrows
- `<-` instead of Unicode left arrows
- `--` instead of em dash
- `-` instead of en dash, bullet characters, or middle dots
- `|` instead of box-drawing vertical lines
- `-` instead of box-drawing horizontal lines
- `[x]` instead of checkmark emoji
- `[ok]` instead of checkmark symbols

## Communication Style

Be direct and matter-of-fact. Lead with solutions and information, and skip
agreement or reinforcement filler that only validates the user's statement.

Write high-signal: lead with the artifact or decision, then the reasoning that
supports it. Show shapes -- file names, config snippets, tables, numbered
lists -- instead of describing them in prose, and give each item enough
rationale to be judged without a follow-up question: a sentence or two, not a
bare fragment and not a paragraph. Structure reports for scanning, but write
complete sentences within the structure. Both failure modes are real: a page of
prose the reader must parse for the meaningful bits, and fragments so terse the
reader has to ask what they mean.

## Temporary Files and Deletion Discipline

Never run `rm -rf`, `rm -r`, or any recursive or wildcard deletion you compose
yourself. No cleanup convenience justifies the risk of wiping unexamined
content. Established package scripts that clean their own build output are
unaffected; the ban is on deletion commands an agent writes.

- Create temporary files in the session scratchpad, never in the repo tree.
- Track every temporary file you create by exact path, and delete each one
  individually (`rm <exact-path>`) when done with it.
- Never delete a file or directory you did not create this session.

## Generated Files -- Do Not Read

Never read `packages/ts-compiler/src/compiler/lib-dts.generated.ts` when
exploring the codebase. It is a machine-generated file that repackages
TypeScript's `lib.d.ts` as a string constant. It contains no project logic and
is extremely large. Skip it in all searches and explorations.

## After Making Code Changes

After making code changes in this workspace, run `npm run typecheck` and
`npm run check` in the package directory where the files were modified. This
runs TypeScript (type checking) and Biome (linter/formatter) to ensure code
validity and style consistency.

### Zero-Noise Policy for `npm run check`

The passing bar for `npm run check` is the summary line only:

```
Checked N files in Nms. No fixes applied.
```

Any output beyond that line -- errors, warnings, or infos -- means the check has
failed. Infos are not acceptable noise; treat them identically to errors.

Write code that is clean from the first run rather than fixing biome output
reactively. Patterns to avoid proactively:

- `findIndex((v) => v === x)` triggers `lint/complexity/useIndexOf`. When
  testing `findIndex` specifically, use a real predicate (`v > x`,
  `v.startsWith(...)`, etc.) rather than an equality check.
- Arrow callbacks to `forEach` that return a value trigger
  `lint/suspicious/useIterableCallbackReturn`. Use a block body `{ stmt; }`
  instead of an expression arrow.
- `biome check --write` only applies safe auto-fixes. Unsafe fixes are silently
  skipped and leave residual infos. Never rely on `--write` to clean up code
  you wrote.

### Lockfiles Follow package.json

After editing the dependency list of any `package.json`, run
`npm run lockfiles:sync` from the repository root. Release workflows install
with `npm ci`, which fails when a lockfile no longer records the resolution its
`package.json` asks for, and CI runs `npm run lockfiles:check` on every push.
The check reports which lockfiles are out of step and leaves the working tree
exactly as it found it.

## Tests Never Key on Display Prose

Static display chrome -- placeholders, labels, button captions, tooltips,
aria-labels, and any other user-facing wording -- is not a test contract.
Do not assert it in tests: wording changes freely and will be localized, and
a test keyed to it breaks without any behavior change.

- Assert structure and behavior instead: the element exists (queried by role
  or a test id), its disabled/enabled state, the callback fired, the value
  produced.
- Dynamic data rendered into output IS assertable: a resolved reference, a
  version, an error code, a file path. These are machine forms produced by
  the behavior under test.
- Error and diagnostic assertions match stable codes, never message prose.

## Report Every Issue With A Proposed Time

When you notice a problem you are not fixing -- a defect adjacent to your change, a value that
should be a token, a stale comment, a duplicated computation, a pin that encodes a bug -- say so
in your report AND propose when it should be fixed.

Every such finding gets two things:

- one line saying what it is, concretely enough to act on without rediscovering it;
- a proposed slot: "fix now", "fold into <named work>", "its own slice, after <thing>", or
  "leave permanently, because <reason>".

"Leave permanently" is a legitimate answer. Silence is not. A finding recorded without a proposed
time reads as trivia, gets filed, and accumulates -- six such items piled up from a single report
before anyone noticed they were unscheduled.

When proposing, separate findings that can be fixed WITHOUT CHANGING BEHAVIOUR OR APPEARANCE from
those that cannot. The first group can usually just be done; only the second needs someone's
judgement. Saying which is which turns "these all need decisions" into a much shorter list that
actually does.

A FINDING THAT UNDERMINES YOUR OWN WORK IS NOT A FINDING, IT IS A BLOCKER. The rule above is for
problems ADJACENT to what you are doing. If what you notice invalidates your own premise -- the
input you were told to derive from turns out to be wrong, the thing you are measuring is not what
it appears to be, the approach you were given cannot produce a good result -- then stop and
resolve it, or stop and report it. DO NOT RECORD IT AND PROCEED. A decision you have predicted
will be wrong is a decision you must not make; noting the prediction does not license it.

This has already cost a full cycle: an agent asked to derive a colour from each app's palette
discovered that the tokens it was deriving from are declared but painted by nothing, wrote that
down as a finding, derived from them anyway, and produced a result rejected on sight.

## New Exported Concepts Name Their Owner

Every new exported type, constant, or helper is a placement decision.
When a change adds exported declarations, the report states, for each,
the package that owns the concept and a one-sentence ownership argument.
The tests a placement must pass:

- The symbol is named for the concept it is, never for a consumer or a
  transport that happens to touch it first.
- The producer of a value lives in the package that owns the concept.
- Dependency edges point from consumer to owner, never the reverse.
- Knowledge about a format or domain lives in the package that defines
  that format, and other packages consume it rather than restating it.

A placement that fails any of these is fixed before the change
completes, or reported as a finding with a proposed time -- never left
silent. When the right owner is genuinely contested, stop and present
the options rather than defaulting to wherever the edit happened to be.

## Broad View Before Acting

Before making any change that touches more than one call site, method
signature, or data flow, read all involved files end-to-end and explicitly
identify every invariant the change must preserve: ordering, symmetry,
consistency across parallel code paths, and structural conventions.

Examples of invariants to check:

- If two methods delegate to the same set of components, they must call them in
  the same order.
- If a refactor introduces a new interface, all implementations must be
  symmetric.
- If a pattern exists across parallel code paths, changes must preserve that
  parallelism.

If a proposed change would violate any identified invariant, reject it and find
an approach that does not.

The goal is not just to fix the immediate problem. Leave the code cleaner and
more coherent than it was found. If the task reveals a structural issue adjacent
to the immediate change, address it as part of the same change when doing so is
within scope.
