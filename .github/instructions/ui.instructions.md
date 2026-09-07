---
applyTo: "packages/ui/**"
---

<!-- Last reviewed: 2026-03-07 -->
<!-- Sync: rules duplicated in copilot-instructions.md "Shared UI" section -->

# Shared UI Package -- Architecture & Conventions

`packages/ui` is a **source-only** React component library. There is no build step -- consuming
apps resolve the TypeScript source directly via Vite aliases and tsconfig path mappings.

## Key Constraints

- **No path aliases** within this package. Use relative imports only (e.g., `../ui/button`,
  `../lib/utils`). Consuming apps map `@wendoo/ui` to the source directory; internal
  aliases would not resolve through the host app's toolchain.
- **No app-specific types**. Types like `Archetype`, `Actor`, or other sim-specific concepts
  must not appear here. The brain editor is decoupled from app specifics via
  `BrainEditorProvider` context.
- **All shadcn/ui primitives live here**. Do not duplicate them in app directories.
- Follow the same Biome conventions as the rest of the monorepo (double quotes, semicolons,
  2-space indent, 120-char line width).

## Package Layout

```
src/
  index.ts                  Top-level barrel export
  lib/                      Utility functions
    utils.ts                cn() -- Tailwind class merge (clsx + tailwind-merge)
    color.ts                adjustColor(), saturateColor(), HSL helpers
    index.ts                Barrel
  ui/                       shadcn/ui primitives
    button.tsx, card.tsx, context-menu.tsx, dialog.tsx, dropdown-menu.tsx, input.tsx, slider.tsx
    index.ts                Barrel
  brain-editor/             Brain editor components
    index.ts                Barrel
    types.ts                TileVisual, TileColorDef
    ArmedTargetContext.tsx   Armed tile-picker target (arm/disarm state + matching predicates)
    BrainEditorContext.tsx   BrainEditorConfig interface, BrainEditorProvider, useBrainEditorConfig
    BrainEditorDialog.tsx    Full editor (page nav, toolbar, undo/redo, save/load)
    BrainEditorSidePanel.tsx The side region beside the rules, holding what the host put in it
    side-panel.ts            The side region's id, its lazy content latch, and the classes it lays out with
    BrainPageEditor.tsx      Page rules list with depth flattening
    BrainRuleEditor.tsx      WHEN/DO rule row
    BrainTile.tsx            Individual tile button with marquee overflow
    BrainTileEditor.tsx      Placed tile: tap arms the edit point, right-click/long-press opens its menu
    BrainCandidateStrip.tsx  Candidate offering laid over the rules below the armed one, plus the filter input its sentence line hosts
    edit-point.ts            Edit-point positions around a placed tile and the arming each one takes
    editor-layers.ts         The editor's stacking steps: rule content, card chrome, offering, side panel, dialog chrome
    TileValue.tsx            Renders literal values or variable names
    CreateVariableDialog.tsx   Dialog for naming a new variable
    CreateLiteralDialog.tsx    Dialog for app-specific custom literal types
    BrainPrintDialog.tsx     Print preview dialog (visual + text modes)
    BrainPrintView.tsx       Visual print layout
    BrainPrintTextView.tsx   Plain-text print layout
    rule-clipboard.ts        Serialize/deserialize rules for clipboard
    tile-clipboard.ts        Serialize/deserialize tiles for clipboard
    tile-badges.ts           Tile badge rendering helpers
    tile-offering.ts         Whether the oracle offers a tile at a side's end or at a position
    candidate-strip-model.ts Candidate grouping, filtering, commit keys, ranker seam
    hooks/
      useRuleCapabilities.ts   Rule capability detection
      useTileSelection.ts      Tile selection flow + factory tile handoff
      useCandidateStrip.ts     Oracle query + filter/offering/commit state for the strip
```

The editing command classes and `BrainCommandHistory` (undo/redo) live in
`packages/core/src/brain/model/commands/` and are imported from
`@wendoo/core/brain/model`; this package re-exports them from its
barrel for consuming apps.

## BrainEditorContext

The `BrainEditorProvider` context decouples the brain editor from app-specific concerns.
Host apps supply a `BrainEditorConfig` object with:

| Field                        | Type                          | Purpose                                                 |
| ---------------------------- | ----------------------------- | ------------------------------------------------------- |
| `dataTypeIcons`              | `ReadonlyMap<string, string>` | Type ID -> icon URL                                     |
| `dataTypeNames`              | `ReadonlyMap<string, string>` | Type ID -> display name                                 |
| `isAppVariableFactoryTileId` | `(id: string) => boolean`     | Identifies app-specific variable factory tiles          |
| `customLiteralTypes`         | `CustomLiteralType[]`         | Optional app-defined literal tile types (e.g., Vector2) |
| `getDefaultBrain`            | `() => IBrainDef`             | Optional factory for creating new empty brains          |

| `onTileDocs` | `(tileDef: IBrainTileDef) => void` | Optional callback opening a tile's documentation (docs integration) |
| `docsIntegration` | `{ isOpen, toggle, close }` | Optional docs sidebar controls for the editor toolbar |
| `sidePanel` | `{ isOpen, toggle, content, label? }` | Optional side region laid out beside the rules, holding host-supplied content; `label` is what the host calls the region, which its toggle takes its accessible name from |

### CustomLiteralType

Each entry defines a custom literal that `CreateLiteralDialog` names the value of,
both for a new tile and for one being edited in place:

| Field               | Type                                                                                  | Purpose                                                    |
| ------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `typeId`            | `string`                                                                              | The brain type system type ID                              |
| `description`       | `string`                                                                              | Description shown in the dialog                            |
| `nameBase`          | `string`                                                                              | Optional. The word this type's default names are numbered from ("image" -> "image 1"); falls back to the `dataTypeNames` entry, then to a generic word |
| `isValid`           | `(state: Record<string, string>) => boolean`                                          | Whether the current input state can be submitted           |
| `parseValue`        | `(state: Record<string, string>) => unknown`                                          | The runtime value the input state names                    |
| `toInputState`      | `(value: unknown) => Record<string, string>`                                          | The input state an existing value opens seeded with        |
| `renderInputFields` | `(state, onChange: (key, value) => void, onSubmit: () => void) => ReactNode`          | The input fields for this literal type                     |
| `formatValue`       | `(value: unknown) => string`                                                          | How the value reads in a tile                              |
| `renderValue`       | `(value: unknown) => ReactNode`                                                       | Optional. What a placed literal's value box draws instead of the `formatValue` text; `undefined`, as omitting it does, draws that text |

A placed literal offers value entries in its tile menu when a
`customLiteralTypes` entry matches its value type AND the edit-time tile catalog
holds a literal factory producing that type. `literalValueEditor` resolves that
pair and reads one more thing from the brain's own catalog: `editable`, true
only for a literal that catalog holds. The model behind the entries is
`brain-editor/tile-menu-model.ts`, and it offers two:

- **Edit Value...**, on an `editable` literal alone. `editLiteralValue` puts the
  submitted value and name on the literal: one carrying a `uniqueId` is edited
  in place through `EditLiteralCommand`, so the catalog entry and EVERY
  placement move together under one tile id and undo restores value and name
  everywhere; one whose id follows its content is replaced by a freshly minted
  literal, leaving other placements as they stand.
- **Duplicate...**, on both populations. `duplicateLiteralValue` always mints
  through the factory and replaces the placement, so a literal an environment
  catalog provides is forked rather than changed.

Every literal of a `customLiteralTypes` type also takes a NAME, which the dialog
stands its own field for (`literalTypeTakesName` decides, and the built-in text
and number forms take none). That field is REQUIRED: `literalNameAccepted`
refuses a name of nothing but whitespace, and the dialog takes no submission
while it does. What the field holds is trimmed on the way out --
`submittedLiteralName` drops the surrounding whitespace, so " rock " names
"rock" -- and a name that trims to nothing is unreachable, since the accept gate
above already refuses it. Hosts opening the dialog seed the field: an edit with the literal's current
word, and both a creation and a duplicate with `unusedNumberedName`
(`brain-editor/literal-naming.ts`) -- over the type's base word for a creation,
over the forked literal's own word for a duplicate. That one function is the
whole naming rule, and it is flat the way a filesystem is: it stems its word by
dropping a single trailing run of digits ("image 1" -> "image", "rock v2"
unchanged), then appends the smallest free number, counting from 2 where the
bare stem is itself taken and from 1 where it is not. So a creation is offered
"image 1", a fork of "rock" is offered "rock 2", and a fork of "image 1" is
offered "image 2" -- never "image 1 2", and a freed number is reused rather than
counted past. `takenLiteralNames` scans the environment catalogs AND the brain's
own, since a default name has to be free of both; `takenLiteralNamesAround`
takes those two apart -- the host config's `tileCatalogs` and the brain's own
catalog -- and is what every host calls, so no surface can scan one and forget
the other. Duplicate names are legal -- the defaults only steer toward unique
ones.

The dialog's description is the type's own prose for a custom-typed literal, and
it renders VISUALLY HIDDEN there (`sr-only`), reaching the screen reader alone;
the built-in text and number forms still show theirs.

The name travels as the third argument of the dialog's `onSubmit` into
`manufactureLiteralTile`, which sets it on the literal it resolves to -- so a
factory ignoring the `displayName` manufacture option still yields a named
literal, and a name submitted for content the catalog already holds renames that
literal in place. Two facts bind anything touching this:

- **The name never takes part in the tile id.** `mkLiteralTileId` reads the
  value type, the value label and the display format alone, so renaming keeps a
  literal's identity and two literals may share one name.
- **The name is the literal's `metadata.label` AND its `metadata.language.form`.**
  The form is what `tileSentenceWord` reads, which is the word the sentence
  projection and the assistant see; the label is what `resolveTileVisualFrom`
  reads, which is the word the candidate strip's chips, the tile captions and
  the assistant transcript's chips show. Setting one without the other splits
  the word the reader sees from the word the model reads.

`renderValue` is resolved by the literal's value type alone, so a literal the
environment catalog provides and one a document catalog holds draw the same.
`TileValue` is the only surface that consults it, which covers the value box of
a placed tile and of a printed one; the candidate strip's chips and the
assistant transcript's chips carry a tile's label rather than its value box.
`customLiteralValueNode` (exported from `TileValue.tsx`) is the shared reading
of it. **Every value tile frames the same, at the same minimums:** the white
frame -- the element marked `kTileValueFrameAttribute`, a `border-[3px]` white
box -- is drawn around whatever the value box carries, text and node alike, with
no opt-out, and the value box (`min-h-16`) and the label line (`flex-1`) are
sized identically whichever it carries. That equality is what puts the label
lines of the value tiles on one rule at one height, so nothing may make either
minimum conditional on what the box draws. `literal-value-render.spec.tsx`
pins it by comparing the two elements' classes across a text tile and a
node-drawing tile.

`BrainTile` calls `customLiteralValueNode` for one decision about the same
tile, and one only:

- **A node is drawn on the panel token.** The frame's interior is the tile's own
  lighter fill behind text and `var(--color-panel)` behind a node, so a drawing
  floats on the app's plate color with the frame's own padding standing as
  margin around it, rather than on a bright tile tint. The white border and the
  inset ring are the same either way.

The geometry a node is drawn into follows from those minimums. The tile height
is fixed at `h-24`, which leaves 74px of content; the value box takes its 64px
minimum and the label line the 20px below it, overflowing into the tile's own
bottom padding exactly as a text tile does. The frame takes 14px of the box's
height and 22px of its width in border and padding, and across the tile's own
minimum width (`min-w-24`) the value box is 52px wide. So a node has 50px of
height, beyond which the value box clips it rather than let it push the label
out, and 30px of width before the tile widens toward `max-w-72` to carry it.

### The candidate strip's command chips

The offering leads with chips that act on the literal the armed position stands
on rather than placing a tile: `brain-editor/strip-commands.ts` decides which,
`useCandidateStrip` resolves the anchor tile and runs them, and
`BrainCandidateStrip` draws them at the head of the best-next listbox in the
app's `secondary` tokens, which is what separates them from the tile chips.

- `stripCommands` offers **edit** in replace mode over an `editable` literal
  alone, and **duplicate** in every mode -- replace unconditionally, insert and
  append only where the position takes a literal of that value type as it stands
  (`positionTakesLiteralOfType`). A position standing on no such literal offers
  none, which is why a built-in image tile shows duplicate and nothing else.
- **Duplicate is deferred.** It hands the value type's factory and a
  `LiteralCreationSeed` to the armed target's `onTileSelected`, which
  `routeTileSelection` turns into the same create-dialog deferral a factory tile
  gets. Nothing is minted, placed, or recorded on the command history until that
  dialog is submitted, so abandoning it leaves the brain byte-identical.
- The chips are options of the best-next band: `StripOptionBand.commands`, which
  `visibleStripOptions` emits ahead of that band's tiles, so the cursor walks
  them first. Enter over one runs it through the reducer's `highlightedCommand`
  fact and `run-command` effect; the lead highlight still rests on the first
  tile chip, so Enter with nothing browsed still places a tile.
- The chips are additive. The tile menu's own entries stay, and they carry the
  keyboard path for a position the strip is not armed on.

## Color Token Contract

`src/ui.css` is the home of the shared token contract. Components reference token
NAMES only and never a palette literal for a role the contract covers; each app
supplies the VALUES in its own `globals.css`, which is imported after `ui.css` so
the app values win. The `--color-brain-*` group covers the editor: the page
canvas and the rule cards, which are GRADIENT PAIRS and have no flat token --
`desk-from` / `desk-to` / `desk-glow` and `rule-from` / `rule-to`, applied as a
`linear-gradient` in a style prop, so `bg-brain-desk` and `bg-brain-rule` do not
exist and resolve to nothing; `tile-border` and `armed`, `accent`
/ `accent-ink` / `on-accent`, `ink` and `recess`, `inline-ink` (the label an
inline chip carries in documentation prose), `amber` / `amber-ink` /
`amber-wash`, `warn` / `warn-edge` / `warn-ink` (the badge on a tile whose
reading is incomplete), `timed` / `timed-ink` (the badge on an action that may
take time; the ink draws both the chip's edge and its glyph), `capsule` /
`capsule-edge` / `capsule-ink`, and `pill` / `pill-hover` / `pill-edge` /
`pill-ink`.

Roles the whole design system already names are taken from it, not re-minted
under `--color-brain-*`: the editor's removal control and its badge for a tile
that does not parse read in `--color-destructive` /
`--color-destructive-foreground`.

Rules a theme must hold to:

- Amber is semantic. It marks a change -- a word whose tile just changed, text
  naming no tile that fits -- and is never used as an accent. Its three meanings
  are separately named: `amber` marks a change, `warn` badges an incomplete
  reading. Retuning one must not move the other.
- The accent and the two side hues a tile is filled in must stay mutually
  distinguishable.

Alpha steps stay on the utility (`text-brain-ink/70`), not in the token, so a
theme supplies one ink and the hierarchy of steps follows.

Side hues do NOT come through CSS: they arrive per tile as `TileVisual.colorDef`
from `BrainEditorConfig`.

Tile chrome derived from a tile's own hue lives in
`brain-editor/tile-visual-utils.ts` (`kDefaultTileHue`, `tileEdgeColor`,
`tileBorderColor`); `packages/docs` imports it so a documentation illustration
and a placed tile cannot drift. Custom properties inherit, so `packages/docs`
also picks up whichever host app renders it, with no threading and no config.

## Surface Insets -- the seam in `src/ui/surface-insets.ts`

A surface covering part of the viewport publishes its footprint through
`publishInset(property, value)`; an element that lays itself out around it
carries the footprint by calling `attachInsetSurface(element)` and reading the
property from its own CSS with `var()`. `withdrawInset(property)` stops
publishing and clears the property from every attached surface.

`DialogContent` (`src/ui/dialog.tsx`) is the only attached surface today: its
`useInsetSurfaceRef` attaches the portaled content element and passes the node
on to whatever ref the caller forwarded.

**Never publish an inset on `document.documentElement`, or on any other
ancestor of a large subtree.** Custom properties are inherited by default, so a
write on a shared ancestor invalidates style recalculation for every element
below it. Measured with the brain editor open on a 57-rule brain (10,673
elements under the dialog): a write on the root costs ~336ms, the same write on
the dialog itself ~20ms. The drag of the docs panel's resize separator
republishes per pointer event, which is what made that panel unusable on a
low-end Chromebook.

Two things make the scoped scheme correct:

- **Each property is registered `inherits: false` in `src/ui.css`.** That is
  what bounds the write: a non-inherited custom property cannot reach a
  descendant's computed style, so the recalculation stops at the surface
  element. Removing `inherits: false` silently restores the old cost.
  `surface-insets.spec.ts` pins the registration.
- **Attaching replays what is published.** A dialog opened while the docs panel
  is already open, and a dialog content remounted while it stays open, both
  take the current footprint at mount. The brain editor hits the second case on
  every panel open: it flips `modal`, Radix swaps content components, and the
  replacement must land already inset.

Registering a property also declares the `initial-value` every consumer falls
back to while nothing is published, which is the geometry an app with no docs
package installed lays out at.

### `--docs-panel-inset`

`DocsSidebar` in `packages/docs` publishes the share of the viewport width its
open desktop panel covers, as a CSS percentage. It publishes `0%` whenever the
panel covers nothing a desktop layout has to avoid -- closed, unmounted, or in
its mobile full-screen shape.

`DialogContent`'s `left` and `max-width` subtract it, so a dialog centres
itself in the width the panel leaves free. `BrainEditorDialog` repeats the same
subtraction in its own `sm:` overrides, because it replaces both properties.

- Read it with a `0%` fallback (`var(--docs-panel-inset,0%)`), matching the
  registered initial value.
- Keep it a percentage. The panel's own width is viewport-relative, so a
  window resize reflows both sides with no listener; a pixel value would go
  stale.
- The panel republishes on every pointer move of its resize separator,
  alongside the inline width it writes on its own `aside`, so consumers track a
  live drag with no React render per frame. Anything reading it must therefore
  work from CSS, not from a React render.
- Nothing in the type system checks this. A change on either side has to be
  matched by hand; `language-docs.instructions.md` carries the publisher's half.

### `--keyboard-inset`

`src/ui/keyboard-inset.ts` publishes, through the same seam,
`--keyboard-inset`: the height of the layout viewport's bottom edge that the
soft keyboard covers, written in CSS pixels. It reads `0px` whenever the whole
layout viewport is reachable.

`DialogContent` (`src/ui/dialog.tsx`) consumes it. Its `top` subtracts half the
inset, so a dialog centres itself in the height the keyboard leaves free
instead of sitting behind it. Every dialog that replaces `top` in its own
`sm:` overrides has to repeat the subtraction, and every one that pins a
height has to give up the covered height as well, or its lower half stays
behind the keyboard. Three do: `BrainEditorDialog` (its rules and candidate
strip), `ProjectPickerDialog` and `ExtensionBrowserDialog` (their search
fields).

Rules for this contract:

- Read it with a `0px` fallback (`var(--keyboard-inset,0px)`), matching the
  registered initial value. It is withdrawn whenever no dialog is open, and
  never published in an environment with no `visualViewport`.
- Keep it a length, not a percentage. Keyboard height has no relation to
  viewport height, and the publisher re-writes the property on every visual
  viewport `resize` and `scroll`, so nothing goes stale.
- **Derive it from occlusion, never from `visualViewport.height` alone.** The
  visual viewport also moves under pinch-zoom and under browser chrome
  collapsing on scroll; a height-only reading drifts on both and the dialog
  looks broken while nothing is wrong. `keyboardInsetPx` computes
  `innerHeight - (visualViewport.height * visualViewport.scale +
  visualViewport.offsetTop)`, clamped at zero: the scale factor puts the visual
  height back into layout pixels so a pinch-zoom reads `0`, and the offset
  cancels a viewport that has merely been scrolled. `keyboard-inset.spec.ts`
  pins those cases.
- There is no threshold. Measured on desktop Chrome, `innerHeight` and
  `visualViewport.height` agree exactly, so the property reads `0px` and
  desktop geometry is untouched. Add one only against a measured non-zero
  resting delta.
- The publisher is subscription-counted and lives inside the portaled dialog
  content, which mounts only while a dialog is open. Nested dialogs each hold a
  subscription; the last release detaches the listeners and removes the
  property. Anything else that needs the inset takes its own subscription
  rather than assuming a dialog is up.
- Nothing in the type system checks this. A change on either side has to be
  matched by hand.

## Dialogs, Portals and Focus

Two constraints here are not enforced by types and have each cost a bug.

**A controlled Radix `Dialog` with no `DialogTrigger` drops the keyboard on `document.body`
when it closes.** Radix composes an internal `onUnmountAutoFocus` that unconditionally
prevents the default and focuses `context.triggerRef.current`; with no trigger rendered
that ref is null, so focus falls to the body. Every dialog in this package is controlled
and trigger-less, so every one inherits the trap. Pass an explicit `onCloseAutoFocus`, or
make sure some other cleanup takes the keyboard back after the dialog unmounts.

This matters more than it looks: **focus moving to the body fires `focusout` but no
`focusin`**, so any mechanism listening for `focusin` to reclaim a stranded keyboard --
the brain editor's included -- is blind to that landing and cannot recover from it.

Two further facts make `onCloseAutoFocus` harder to write than it looks:

- **It also fires when the `modal` prop changes.** Radix picks a different content
  component per mode, so flipping `modal` unmounts one focus scope and mounts another
  while the dialog stays open, and the unmounted scope runs a full close pass. The brain
  editor flips `modal` whenever the documentation panel opens. A close pass must tell the
  two apart before it acts; the editor marks its content with `data-brain-editor-content`
  and reads whether a replacement is already standing. `isOpen` does NOT answer this: the
  pass runs from a `setTimeout(0)`, and a host that stops rendering the dialog on close
  never re-runs the effect that would have recorded the new value.
- **Restoring to the recorded opener needs a fallback that cannot be unmounted.** Checking
  `isConnected` and returning is what drops the keyboard on the body, because the
  restoration Radix then runs targets a null `triggerRef`. `brain-editor/editor-return-focus.ts`
  records the opener plus its ancestors, hands the keyboard to the nearest one still
  connected, and falls through to the document's `main` landmark.

**Portaled content cannot be server-rendered, so it cannot be asserted in a spec.**
`packages/ui` has no jsdom and specs render through `react-dom/server` only. Radix's
`Portal` renders `null` until a client layout effect gives it `document.body` as a
container, so `renderToStaticMarkup(<SomeDialog isOpen />)` returns the empty string --
no attribute, no marker, no text inside a dialog, menu, popover or tooltip ever reaches
server markup. Verify those surfaces in a browser; pin the module-level predicates behind
them instead, which is what `keyboard-hold.spec.ts` does.

## Touch Targets

Under a coarse pointer every control in the app chrome measures at least 44px on
both axes, and every field the keyboard types into is set at 1rem -- below 16px
iOS Safari zooms the page in when a field takes focus, and that applies to
`<select>` exactly as it does to `<input>`.

**The floor is shared, not per call site.** It lives in `src/ui.css` under
"Coarse-pointer target floor": a base-layer rule that floors `button`, `select`,
`textarea`, `input` and `a[href]`, plus a utilities-layer rule that sets the type
size on the three field elements. A new control in either app is covered the day
it is written, with nothing to remember.

Rules that bind anything touching this:

- **Never detect the device or the user agent.** iPadOS Safari reports a macOS
  user agent, so a UA check misses the exact device this floor exists for.
  `@media (pointer: coarse)` -- the `pointer-coarse:` variant in Tailwind -- is
  the only signal.
- **Floor with `min-h` / `min-w`, never `h` / `w`.** A minimum leaves the call
  site's own height describing the fine-pointer geometry, and it survives
  `tailwind-merge` when a caller overrides the size, which a matching `h-*` would
  not.
- **The size floor sits in the base layer**, so a call site that must stay
  smaller overrides it with a `pointer-coarse:min-h-*` / `pointer-coarse:min-w-*`
  utility.
- **The type floor sits in the utilities layer**, because a `text-sm` on the
  field would otherwise win over a base rule. It therefore outranks every
  font-size utility: a field that wants to read larger under a coarse pointer has
  to mark its own size important (`pointer-coarse:text-lg!`).
- **A control whose shape would break must be exempted in `ui.css`, not worked
  around at the call site**, and the exemption says what reaches 44px instead.
  Two stand today: everything inside `[data-brain-editor-content]`, which sizes
  its own controls, and `role="switch"`, whose pill would square off into a blob
  and which grows a `::before` hit area instead.
- **Primitives keep their own `pointer-coarse:` floors** even where the shared
  rule would repeat them, because the shared rule stops at the brain editor's
  edge and the editor uses `Button`, `Input` and the menu rows. Menu rows are not
  `<button>` at all -- Radix renders `div[role="menuitem"]` -- so
  `dropdown-menu.tsx` and `context-menu.tsx` carry the only floor those rows get.
- **`::before` insets are measured from the padding box.** A transparent border
  makes that box smaller than the rect you are aiming at, and the difference is
  silent -- the `Switch` pill's 2px border left its band at 40x40 while the
  intended target was 44x44. Subtract the border before choosing the inset.
- **A `::before` band paints over whatever sits under it, so it needs the space
  to be free.** The band belongs to a positioned element and its neighbours
  usually are not positioned, so it wins the hit test against them whatever the
  DOM order. A band is therefore only correct where the layout already leaves
  44px clear; where controls are packed closer, the spacing has to give first.
  `Slider` is the open case: its root box is the 8px track, since Radix
  positions the thumb absolutely, and neither the element floor nor a band
  reaches 44px for it today.

Geometry is unassertable here: `packages/ui` has no jsdom and specs render
through `react-dom/server`. Verify a coarse floor in a browser by replaying the
`@media (pointer: coarse)` blocks into the live page unconditionally, which
exercises the real cascade; measure with `getBoundingClientRect`, never a
screenshot.

## Adding UI Primitives

To add a new shadcn/ui component:

1. Create the component file in `src/ui/` following existing patterns
2. Export it from `src/ui/index.ts`
3. It will automatically be available via `import { ... } from "@wendoo/ui"` in consuming apps

## Documentation System

The documentation sidebar, registry, markdown renderer, and standalone docs page live in
`packages/docs` (`@wendoo/docs`). See `language-docs.instructions.md` for full details.

The brain editor integrates with docs via two optional `BrainEditorConfig` fields:

- `onTileDocs` -- callback invoked when a user opens a placed tile's documentation, either
  from the docs button the offering's position row stands or by selecting Docs in the
  tile's menu (right-click, or long-press on touch); see `BrainTileMenu.tsx`
- `docsIntegration` -- `{ isOpen, toggle, close }` for the docs toggle button in the
  brain editor toolbar, for Escape closing an open panel instead of the editor, and
  for close-on-exit behavior (used by `BrainEditorDialog.tsx`)

These are wired up by the host app (see `apps/ecosim/src/App.tsx` `DocsBrainEditorProvider`).

## Consuming This Package

In a new webapp, add these configurations:

**package.json**: `"@wendoo/ui": "file:../../packages/ui"`

**Vite config**:

```js
resolve: {
  alias: {
    "@wendoo/ui": path.resolve(__dirname, "../../packages/ui/src"),
  },
},
```

**DO NOT ADD `resolve.dedupe: ["react", "react-dom"]`.** `@vitejs/plugin-react` already sets it, so an
explicit copy duplicates a guarantee an existing layer provides. Verified 2026-08-02: with the line
removed, `resolve.dedupe` still resolves to `["react","react-dom"]`, and a production build contains
exactly one React, from the app's own `node_modules`.

**NEVER PUT THIS PACKAGE IN `optimizeDeps.exclude`.** That is the real hazard, and it caused a live
`Invalid hook call` in `apps/microbit-sim`:

- The package is ALIASED TO SOURCE, so Vite never prebundles it and the exclusion buys nothing.
- **IT IS NOT WHAT GIVES YOU HOT RELOAD.** That is the reason someone reaches for it, and it is
  wrong: the ALIAS is what makes Vite treat these files as project source, watched and hot-reloaded
  natively. `optimizeDeps` only governs prebundling of things resolved into `node_modules`.
  Confirmed 2026-08-02 -- HMR on `packages/ui` works with the exclusion removed, and `apps/ecosim`
  has run the whole project with the alias and WITHOUT the exclusion.
- But excluding it stops Vite's dependency SCANNER walking into that source, so the Radix packages it
  imports are missed on the first pass and discovered mid-load on the first page request.
- Vite then runs a SECOND optimize pass and reloads. Modules served inside that window get a second
  React instance -- `Invalid hook call`, naming whichever Radix component was late (it named
  `<DropdownMenu>`), healed by the reload that follows.

That is why the failure was cold-start-only, `--force`-only, and confined to one app: `apps/ecosim`
excludes only `@wendoo/core` and `zod`, and never saw it.

Two things worth knowing if you are diagnosing something similar:

- **Matching React versions does NOT fix a genuine duplication.** Hook dispatch lives in module-scoped
  state, so two copies of the SAME version are still two instances. Only single-instance resolution
  helps.
- **There is no `vite.config.*` at any package root.** Every script passes `--config vite/config.*.mjs`.
  Running bare `npx vite` therefore uses Vite's built-in defaults -- no aliases, no plugins, and so no
  `plugin-react` dedupe -- which reproduces this error for reasons that have nothing to do with the
  repo's real configuration.

**tsconfig.json**:

```json
{
  "compilerOptions": {
    "paths": {
      "@wendoo/ui": ["../../packages/ui/src/index.ts"],
      "@wendoo/ui/*": ["../../packages/ui/src/*"]
    }
  }
}
```
