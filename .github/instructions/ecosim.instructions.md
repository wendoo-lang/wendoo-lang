---
applyTo: "apps/ecosim/**"
---

<!-- Last reviewed: 2026-08-08 -->

# Sim App -- Rules & Patterns

The sim app (`apps/ecosim/`) is a **Vite + React + Phaser 3** web application. It renders an
ecosystem simulation where actors (carnivores, herbivores, plants) are each driven by a
user-editable brain program from `packages/core`.

`apps/ecosim-rbx` mirrors this app's brain module for Roblox; when an ABI value here changes,
see `ecosim-rbx.instructions.md` for the mirroring rules.

## Tech Stack

Vite, React 19, Phaser 3 (Matter.js physics), Tailwind CSS v4, miniplex (ECS),
`@wendoo/ui` (source-only), `@wendoo/docs` (source-only), Biome.

## Path Aliases

- `@/*` -> `./src/*` -- prefer over deep relative paths across directory boundaries
- `@wendoo/ui` -> `../../packages/ui/src` (source-only, no build step)
- `@wendoo/docs` -> `../../packages/docs/src` (source-only, no build step)

`@wendoo/core` is not aliased: it resolves through the `file:` dependency to the
package's built output, so core changes require a rebuild.

## Build & Scripts

```
npm run dev         # build:deps, then Vite dev server
npm run build       # build:deps (prebuild), Vite production build, then build:headless (postbuild)
npm run build:deps  # builds the file: package dependencies in dependency order
npm run check       # Biome check (lint + format), autofix
npm run check:only  # Biome, read-only -- must print only the summary line
npm run typecheck   # tsc --noEmit over the app and its sibling tsconfigs
npm test            # build:deps + build:headless, then tsx --test over src/**/*.spec.ts
```

`build:deps` runs `scripts/build-packages.js`, which walks this app's `file:` dependencies and
builds each in dependency order. Changes to `packages/core` require rebuilding it; the `predev`
and `prebuild` scripts handle that.

## Adding New Sensors/Actuators

1. Add the action's stable ids to `brain/abi-ids.ts`: a member of `EcosimFuncId` and a record in
   `EcosimHostActions`. Ids are permanent -- append at the next free value, never renumber.
2. Create `brain/actions/<name>.ts`. It default-exports the action definition and named-exports
   its tile inputs:
   - Build `callDef` with `mkCallDef()` and resolve slot ids with `getSlotId()` at module scope.
   - Implement `exec` (and `onInitialized` when the call site needs state), reaching the actor
     through `getSelf(ctx)`.
   - `export default { ...EcosimHostActions.<Name>, callDef, fn, isAsync, metadata, ... }
     satisfies CreateHostSensorOptions` (or `CreateHostActuatorOptions`). Sensors also declare
     `outputType` and, when they feed the DO side, a `capabilities` bitset from
     `brain/tileids.ts`.
   - `export const modifiers: ModifierTileInput[]` and `export const parameters:
     ParameterTileInput[]` for the tiles the call spec references.
3. Add the tile id strings to `TileIds` in `brain/tileids.ts`.
4. Register in `brain/index.ts` `createEcosimModule`, keeping the existing order: types, engine
   context, brain context, `registerHostSensor` calls, `registerHostActuator` calls,
   `registerModifiers`, `registerParameters`, then `registerTiles`. Add the new action's
   `modifiers` / `parameters` arrays to the spread lists.
5. Mirror the change in `apps/ecosim-rbx` in the same slice and re-run its parity test.

### Modifier vs Parameter Tiles

- **Modifiers** are boolean flags. Use `mod()` from `@wendoo/core/app`.
- **Parameters** accept a typed value. Use `param()` from `@wendoo/core/app`.
- Do not mix them up -- the wrong helper causes slot lookup failures at startup.

### Call Spec Example

```typescript
import { bag, choice, getSlotId, mkCallDef, mod, optional, param } from "@wendoo/core/app";
import { TileIds } from "@/brain/tileids";

const Forward = mod(TileIds.Modifier.MovementForward);
const Toward = mod(TileIds.Modifier.MovementToward);
const Priority = param(TileIds.Parameter.Priority);
const callDef = mkCallDef(bag(optional(choice(Forward, Toward)), optional(Priority)));
const kForwardSlotId = getSlotId(callDef, Forward);
```

### ExecutionContext -> Actor Access

```typescript
const self = getSelf(ctx); // from brain/execution-context-types.ts
const other = getActor(ctx, otherActorId);
const target = getTargetActor(ctx);
```

## Key Architecture Notes

- Brain module: `brain/index.ts` exports `createEcosimModule()`, the single `WendooModule`
  holding this app's types, contexts, host actions, and tiles (module id `"wendoo.ecosim"`)
- Environment: `services/ecosim-environment-store.ts` builds it with
  `createWendooEnvironment({ modules: [coreModule(), createEcosimModule()] })` and owns the
  `AppEnvironmentHost` from `@wendoo/bridge-app`
- Brain editor config: `brain/editor/config.tsx` `buildBrainEditorConfig()` returns the
  `BrainEditorConfig`, wrapped in `BrainEditorProvider` in `App.tsx`
- Brain persistence: brains live in the project document, managed by the `ProjectManager` from
  `@wendoo/app-host` over an IndexedDB store; `localStorage` holds only app settings and
  UI preferences
- Phaser bridge: `PhaserGame.tsx` calls `StartGame()` from `game/main.ts`, passing the store
  through the Phaser registry and reporting scene brain state through a callback
- Physics: Matter.js, zero gravity, top-down 2D; actors use `Mover` from `brain/movement.ts`
  for steering
- Tile icons: SVGs in `public/assets/brain/icons/`, addressed through `ICON_BASE` from
  `brain/icon-base.ts`
- All brain edits go through the Command Pattern with undo/redo (`BrainCommandHistory` in core)
