# Spec: shapers (WHEN-side signal shapers)

A core, target-agnostic tile-language feature: a new tile category for transforming a rule's
firing signal on the WHEN side.

## What a shaper is

A **shaper** is a **unary signal transform placed on the WHEN side of a rule, after a
sensor**. It consumes the preceding signal and produces a transformed signal; the rule fires
on the final signal of the chain:

```
WHEN  <sensor>  <shaper>  [<shaper> ...]   ->  rule fires on the final signal
```

Examples:

```
WHEN gesture tilt-left toggle      // each tilt-left toggles a held on/off bit
WHEN logo pressed latch            // a press goes true and the latch holds it
WHEN gesture shake once            // fire once per shake (a single-tick pulse)
WHEN see carnivore invert          // fires while NOT seeing a carnivore
```

Category properties:

- **WHEN-side only.** Shapers are not valid in a rule's `do` / actuator position.
- **Top-level, never in an expression.** A shaper post-processes the rule's signal; it does
  not embed inside boolean/value expressions.
- **Transforms, does not originate.** A shaper operates on the signal it is given; with no
  preceding signal it is invalid (it cannot be the sole WHEN element). This includes a child
  rule whose WHEN holds only a shaper: the empty-WHEN ancestor fall-through supplies a
  rule's WHEN *result*, not its firing signal, so a shaper cannot transform an ancestor's
  signal and an empty-WHEN-plus-shaper child is invalid.
- **Unary on the signal** (one signal in, one out) - and a shaper **may also take its own
  arguments** (modifiers + parameters), distinct from the signal (see Arguments).
- **Chainable (pipeline).** Multiple shapers compose left-to-right; order is significant.
  There is no chain-length cap. Each chain position is its own call site: two `toggle`
  shapers in one chain hold two independent bits.
- **May be stateful** (per call site): `once`/`latch`/`toggle` keep a bit; the timing
  shapers keep timestamps; `invert` is stateless. State lifecycle is uniform (see State
  lifecycle).
- **Synchronous.** A shaper evaluates within the think and never parks - no handles, no
  await. The WHEN side is a per-think sampling of the signal; time-dependent behavior is
  expressed by the timing shapers sampling the current time, and completion-driven
  behavior is ordinary rule sequencing (an awaited actuator parks only its own rule's
  fiber; the actions and child rules after it run on completion while other rules
  continue concurrently).

## The signal model

The WHEN side evaluates to a **value**; truthiness - or presence, for presence-gated
sensors - is applied at the WHEN boundary, and the rule's **WHEN result** captures the
pre-truthiness value. Shapers insert **between the sensor's value and that boundary**: each
shaper consumes the upstream signal (the value together with its truthiness/presence) and
produces the chain's next signal. The final signal decides whether the rule fires.

### The WHEN result of a shaped rule

- On a firing tick where the upstream value is **currently present**, the upstream value
  passes through unchanged as the rule's WHEN result. (`once` fires on the rising edge -
  the tick the value arrives - so the value is present and delivered.)
- On a firing tick with **no current upstream value** - a held `latch` after the input
  fell, an `invert` firing because nothing is there - the WHEN result is **absent**.
- A shaper therefore **preserves the upstream result type, weakened to maybe-absent**. A
  consumer that declares a required WHEN-result type is compatible with a shaped WHEN
  exactly when it is compatible with the upstream type - except under `invert`, which fires
  precisely when no value is present, so a required-type consumer under `invert` is
  rejected.

## Shapers are regular intrinsics over the action calling convention

Shapers are **regular intrinsics**, not a closed set of fixed native primitives. The
mechanism is the **bytecode-action calling convention** - the same convention conversions
ride: slot-indexed arguments via the core call-spec grammar, per-call-site state keyed by
`callSiteId`, `ctx` access (time, variables), and a body that may be a host function or
bytecode, per shaper. A shaper body has the full capability of the language. No new opcode
and no VM-contract change: the brain compiler emits the shaper as an action-convention call
that consumes the upstream signal and produces the transformed signal.

Because the convention is bytecode-capable by construction, user-defined shapers are a
future registration surface over the same convention (deferred; see Deferred).

## Arguments (modifiers + parameters)

A shaper **takes arguments just like a sensor does** - modifiers and parameters, declared
with the same core call-spec grammar (`bag`/`choice`/`optional`/`mod`/`param`, slot-indexed
via `mkCallDef`). A shaper's full runtime inputs are: the upstream signal, its own
slot-indexed arg buffer, its per-call-site state, and `ctx`. Built-ins may take no
arguments (`invert`) or some; the mechanism supports them uniformly.

## Built-in shapers

The calling convention is the substance; each built-in is small. The core set has two
families.

**Logic, edge, and memory:**

- **`invert`** - stateless logical NOT of the signal (fires while the input does not).
- **`once`** - a one-shot monostable: **fire once** when the input goes true - a
  single-tick pulse on the rising edge, then false until the next rising edge. Converts a
  level into a fire-once edge. Per-call-site state (the previous input level).
- **`latch`** - **hold**: go true on the input's rising edge and stay true until the page
  (re-)activates (see State lifecycle). Per-call-site state.
- **`toggle`** - **alternate** a held bit on each rising edge (on, off, on, ...): a T
  flip-flop. Per-call-site state (the bit).

**Timing** - each takes a single duration parameter and samples the current time; the trio
is orthogonal (require-before / extend-after / suppress-after):

- **`sustained <duration>`** - true only after the input has been **continuously true for
  the duration** (a long-press / held-steady detector). Per-call-site state (the rising
  timestamp). This is the general form of per-sensor "held" semantics.
- **`linger <duration>`** - keep true for the duration **after the input goes true** (a
  retriggerable pulse stretcher): makes momentary events - an impact, a shake - actionable
  for a window. Per-call-site state (the last-true timestamp).
- **`cooldown <duration>`** - after passing a firing, **suppress for the duration** (a
  rate limit). Per-call-site state (the last-passed timestamp).

A pass-through `level` is the identity (the raw signal) and needs no shaper.

## Compositions

The set is kept small by composition; these idioms are part of the design, not accidents:

- **Falling edge**: `invert` then `once` fires exactly once when the signal *ends*
  (`WHEN button A pressed invert once` - on release).
- **Until**: `latch` then `invert` is true *until the first occurrence*
  (`WHEN see food latch invert` - while food has never been seen this page).
- `toggle` or `latch` directly after `once` is unchanged (both are edge-triggered
  already); the chain is legal and the `once` is a no-op.

## State lifecycle

**All per-call-site shaper state resets when the rule's page (re-)activates.** This is the
one lifecycle rule for the category: `once` forgets its previous level, `toggle` clears its
bit, `latch` releases its hold, and the timing shapers forget their timestamps. A `latch`
therefore holds until page re-entry; a duration/clear parameter is deferred design (see
Deferred).

## Enforcement

The category rules are compile-time validations, and the picker agrees with the compiler:

- The compiler rejects, with error-severity diagnostics: a shaper outside the WHEN side; a
  shaper with no preceding signal (the sole-WHEN-element and empty-WHEN-child cases); a
  required-WHEN-result consumer whose result availability the shaper removes (`invert`).
- The picker offers a shaper tile only where the compiler accepts it, and the
  suggestion-compiler consistency oracle covers the category in both directions.
- **Degraded documents:** degradation is fail-safe for this category only. A rule
  containing an unresolvable (missing-placeholder) or unparseable shaper tile is
  rejected with an error-severity diagnostic -- surfaced like every rule diagnostic --
  and does not fire; a shaper silently dropping out of a chain would change firing
  semantics, so the category never degrades pass-through. Other tile kinds keep the
  platform's degrade-and-run placeholder semantics. Shaper identity is part of the tile
  id, so a placeholder remains recognizable as a former shaper; that is what scopes the
  escalation to the category. A WHEN side left without a compilable signal never
  evaluates: the rule compiles to not fire, not to a partial evaluation.

## Sentence composition

Shapers are first-class in both of the editor's projections: the tile row and the
sentence. The sentence system's invariants bind the category's wording and rendering.

### Word and span

- **Each shaper is one word segment** in the sentence, carrying its tile's span. Its
  label and its `language.form` are one string: the sentence word (the form), and
  the candidate-chip label and typed handle (the label). A form may contain spaces
  ("just once" is one segment) but a shaper never owns two segments.
- A shaper's arguments are their own tiles and their own words, following the shaper's
  word in tile order. A duration-bearing form therefore **ends where the duration
  begins**: the form is the leading phrase and the duration literal is the next word
  ("held for" + "1s" reads "held for 1s"). Wordings that would place the duration inside
  the phrase are not expressible and are not used.
- Word order always equals tile order within the side; the caret and change-highlight
  layers depend on it.

### Rendering (the WHEN clause with shapers)

- The WHEN projection **splits structurally at the first shaper tile**: the sensor call
  renders through its frame template exactly as an unshaped rule does, and the shaper
  chain renders after it as suffix words -- each shaper's form plus its argument words --
  joined by the sentence-shaper glue entry: "When I see a carnivore just once, walk."
  This applies identically to the child-rule (subordinate-clause) projection.
- **The comma invariant.** In the sentence, a comma marks a clause boundary and nothing
  else: the trigger/action pivot and the subordinate-clause connective. The typed comma
  is the composer's pivot gesture, and every rendered comma must keep that one meaning.
  Shaper glue is intra-clause: in English it is a space, and no locale's sentence-shaper
  glue entry may introduce a comma. Shaper forms are worded to read as adverbial
  phrases so space-joining scans.
- **Negation reads inside the clause, not as a suffix.** `invert` carries a `negates`
  marker in its language metadata. When an invert-class shaper is the FIRST tile of the
  chain, template selection uses the frame's negated variant, and the `{negation}` slot
  is filled by the tile's own word -- so the tile keeps its word segment and its span:
  "When I do not see a carnivore, walk." An invert-class shaper NOT at the head of the
  chain falls back to the suffix reading (negating the whole base clause there would
  misread the semantics -- the `latch invert` "until" idiom); plain-but-faithful beats
  clever-but-wrong.
- Built-in forms ship in the tiles' registration metadata. Starting wordings, with final
  wording owned by the readability sweep under the idiom-over-polish posture:

  | shaper | form (sentence word) |
  | - | - |
  | `invert` | "not" (routed into the negated frame at chain head; suffix word otherwise) |
  | `once` | "just once" |
  | `toggle` | "on and off" |
  | `latch` | "and stay" |
  | `sustained` | "held for" (+ duration word) |
  | `linger` | "kept for" (+ duration word) |
  | `cooldown` | "at most every" (+ duration word) |

- Form rules: no leading articles, and the distinguishing word starts a word of the form
  (so typing it reaches the candidate by prefix or word-prefix match).
- A timing shaper whose duration is not yet placed reads with its bare completion
  (`language.bare`, e.g. "held for a moment"), the same mechanism argument-taking
  sensors use.

### Input (composing a shaped rule)

- The candidate strip is oracle-driven, so shapers are offered exactly where the
  compiler accepts them: after a complete signal on the WHEN side, at append, insert,
  and replace positions, including mid-chain. Shapers group under their own "Shapers"
  heading, ordered after Sensors.
- A shaper is typed by its form and committed like any word (Enter takes the top
  candidate; Space takes an exact or unique-prefix match); tapping the chip is the same
  commit. Chains compose by typing successive shaper words. Durations are typed as
  formatted numbers ("1s", "500ms"), minting the literal that reads back as typed.
- While shapers are offerable the composition stays on the WHEN side; the comma pivots
  to DO as usual, and the period settles the sentence. Both gate on the completed rule
  parsing cleanly, so a complete shaper chain parses with zero diagnostics.

### Selection and editing

- Each shaper word is a caret element; the gap before it inserts, tapping the word arms
  replace (the strip opens filtered to that position's valid tiles), and
  backspace/delete remove the tile through the normal command path. Chained shapers are
  individually selectable and replaceable; nothing special-cases repeats.
- Diagnostics do not render in the sentence; they surface on the tile row as badges. A
  missing (unresolvable) shaper reads by its fallback label in the sentence while the
  rule, per Enforcement, does not fire.

### Localization

Shaper forms localize under the tile-label context like every tile word; the
sentence-shaper glue and any negated-variant selection reuse the existing sentence
template entries. No shaper-specific localization machinery exists.

Negation localizes at two levels. The head-of-chain reading is a whole per-locale
negated template with a movable `{negation}` slot, so each language places (or
circumfixes) its negation freely -- glue may carry a fixed part (French "ne" in glue,
"pas" in the slot), and a language whose negation is morphological renders the negated
template periphrastically. The non-head suffix reading is a program marker in every
locale, not grammatical negation; a locale for which the trailing marker would mislead
(not merely read stiffly) resolves it through a projection-side reading for that
position, the same seam that separates typed handles from rendered readings elsewhere.
The per-locale readability pass is the final arbiter of both readings.

## The assistant (client-side considerations)

The assistant authors and inspects brains through the same client surfaces the person
uses: the catalog the app serves, the editor's validation, and the rehearsal machinery.
Shapers join each of those surfaces as a first-class citizen; the binding rule for the
category is that the assistant learns shapers from **registration data and structured
diagnostics**, never from per-shaper prose maintained by hand on the service side.

- **A first-class tile kind in the served catalog.** Shapers carry their own tile kind,
  and every client surface that switches over tile kinds treats it exhaustively: the
  catalog digest renders shaper tiles with their registration-sourced grammar (call
  spec, sentence form) under their own category, the description extraction serves
  their docs like any tile's, and each app's tile visuals map the kind deliberately. A
  shaper tile rendering through a default or fallback arm is a defect, not a
  degradation.
- **Grammar reaches the assistant from registration.** The position rules the compiler
  enforces -- WHEN-side only, after a signal, chainable with significant order, own
  modifiers and parameters -- travel to the assistant through the same registration
  data that drives the picker. What the picker knows, the served catalog states; no
  shaper ships whose placement rules exist only as compiler behavior the assistant
  must discover by refusal.
- **Validation parity extends to the assistant's tools.** Enforcement's "the picker
  agrees with the compiler" binds three surfaces, not two: the candidate strip, the
  tile suggestions served to the assistant, and proposed edits are all judged by the
  same oracle and the same compile-time validations, so they cannot disagree about
  where a shaper is legal. No shaper-specific proposal operation exists: shapers
  place, replace, and delete through the ordinary tile edit operations, at any chain
  position.
- **Refusals teach.** Each category diagnostic -- shaper outside the WHEN side, no
  preceding signal (including the empty-WHEN child case), a required-WHEN-result
  consumer under `invert`, an unresolvable shaper tile -- is a stable structured code,
  and a refused edit carries the code with the offending rule and tile identified. The
  assistant repairs against the code; it never has to rediscover a category rule by
  experiment.
- **Descriptions carry the un-derivable facts.** A shaper's name does not reveal its
  semantics, so each built-in's documentation leads with the facts no reader can
  derive: whether it acts on edges or levels, that its state is per call site, that
  all shaper state resets when the page (re-)activates, what the duration parameter
  measures, and that chain order matters. The composition idioms (falling edge is
  `invert` then `once`; until is `latch` then `invert`) are documented alongside the
  built-ins rather than left to be re-derived per session.
- **Rehearsal shows the shaped signal.** A rule fires on the final signal of the
  chain, so a trace shows the post-shaper firing pattern: a rule held quiet by
  `cooldown`, or not yet satisfied by `sustained`, is indistinguishable in the trace
  from one whose sensor stayed false. The documentation states this plainly --
  silence can be the shaper doing its job -- so the assistant diagnoses a quiet rule
  against the chain's semantics instead of concluding the sensor is broken.
- **Scenario staging exercises the category honestly.** Edge-triggered shapers
  (`once`, `toggle`, `latch`) are verified only by staged transitions -- a level that
  changes mid-run -- not by a level held for the whole scenario; and any scenario
  asserting a timing shaper's behavior runs past the shaper's duration, never staged
  exactly on the boundary. A rehearsal window shorter than a `cooldown` or
  `sustained` duration makes a working rule look dead.

## Relationship to per-sensor edge/level modifiers

Shapers subsume the per-sensor edge/level question: every sensor emits its one natural
(level) signal and `once`/`latch`/`toggle`/`invert` handle triggering uniformly. This
overlaps the button `held`/`pressed` modifiers. Stance: **coexist** - per-sensor modifiers
for ergonomics, shapers for power - with **canonical** (shapers as the one mechanism, one
signal per sensor) as the north star.

## Scope

Core language, target-agnostic, and a shared-surface feature for **both product apps**
(the micro:bit product and the sim/game product): brain compiler + language service +
editor tile category + the built-in intrinsics on each platform's runtime. Independent of
the device-surface work; sensors ship with their natural signal and shapers layer on.

## Defining shapers in ts-code (deferred surface; shape specified now)

User code defines a shaper the way it defines sensors, actuators, and conversions: a
`Shaper({...})` config, registered over the same action convention as the built-ins.

```ts
export default Shaper({
  name: "debounce",
  icon: "wave-square",
  docs: "Passes the signal only after it has held steady for the window.",
  args: [param("window", { type: NumberType })],
  onSignal(ctx: Context, signal: boolean, args: { window?: number }): boolean {
    // returns the transformed signal
  },
});
```

`Shaper` carries the same identity and presentation members as the other tile configs:
the auto-minted stable `id?`, `name`, and optional `label`, `icon`, `docs`, and `tags`,
feeding the picker and the docs panel exactly as they do for sensors and actuators.

- **`onSignal(ctx, signal, args) -> boolean`.** The body receives the upstream signal as a
  boolean - the truthiness/presence bit - plus `ctx` and the slot-indexed args. The body
  never sees or alters the upstream *value*: WHEN-result pass-through is runtime machinery
  (see The WHEN result of a shaped rule), so a shaper body cannot violate the
  result-delivery rules.
- **Synchronous.** `onSignal` returns the signal directly; a shaper is evaluated inside
  the WHEN and never parks (no `Promise`, no handles). An `async` or Promise-returning
  `onSignal` is rejected with a precise diagnostic.
- **State** uses the established user-code scoping: module-level `let` is per-call-site,
  which gives each chain position its own state with no new mechanism. Reconciliation to
  settle when this surface is built: the category's page-re-entry reset must hold for
  user-defined shaper state too, so per-call-site module state in a shaper body resets on
  page (re-)activation - whether that is the general user-code lifecycle or a
  shaper-specific reset is the open design point.
- Declaration, extraction, ambient typing, and diagnostics follow the same conventions as
  the other user-code tile configs, including a precise diagnostic for any config the
  surface cannot support.
- `language?: TileLanguageConfig` (the `form`/`frame`/`bare` group the other configs
  carry) is part of the surface, wired explicitly into the extractor with the same
  per-member diagnostics -- a user-defined shaper names its own sentence word.

## Deferred

- **User-defined shapers** - the `Shaper({...})` surface above; the built-ins ship first
  and the convention is bytecode-capable by construction, so the surface is a registration
  feature when a real library consumer needs it. `debounce` (pass changes only after the
  signal has held steady for a window) is the canonical user-defined example and is
  deliberately not core.
- **`every <n>`** - fire on every Nth rising edge (a divider). Real but has no named
  consumer yet; a small parameterized shaper whenever one appears.
- **`sometimes` / probability** - pass a firing with probability p. High play value, but
  it requires a deterministic seeded random service in the VM contract (both VMs must
  produce identical traces), so it waits on that service existing.
- **`latch` duration/clear parameter** - reset-after-a-duration or an explicit clear
  affordance, layered on the page-re-entry base semantics.
- **Canonical migration** of per-sensor edge/level modifiers (the button `held`/`pressed`
  rework), per the coexist stance above.
