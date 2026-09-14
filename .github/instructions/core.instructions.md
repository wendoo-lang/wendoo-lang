---
applyTo: "packages/core/**"
---

<!-- Last reviewed: 2026-03-04 -->
<!-- Sync: rules duplicated in copilot-instructions.md "Multi-Target Core" section -->

# Core Package -- Multi-Target Build & Conventions

**packages/core is a multi-target project** that builds for:

- Roblox-TS (Luau compilation)
- Node.js (CommonJS)
- ESM (ES Modules)

When making changes to `packages/core`:

- Consider platform compatibility across all three targets
- Avoid platform-specific APIs or Node.js-only features
- Be mindful of import/export patterns that work across all platforms
- Remember that Roblox-TS has different constraints than Node.js/browser environments
- **Prefer `List` and `Dict` containers** from `packages/core/src/platform` over native `Array` and `Map` for cross-platform compatibility
- Use `unknown` or `never` type instead of `any` to ensure Roblox compatibility

## After Making Code Changes

After making any code changes in `packages/core`, always run these commands in order from the `packages/core` directory:

1. `npm run check` -- lint and format
2. `npm run build` -- compiles all three targets (Roblox-TS, Node.js, ESM); a build error here means the change is not done
3. `npm test` -- runs the test suite

## Testing

**Run tests:** `cd packages/core && npm test`

Tests use `node:test` and `node:assert/strict` (Node.js built-ins, zero package dependencies). Test files are colocated with the code they test, using the `*.spec.ts` naming convention. All three build tsconfigs (`tsconfig.node.json`, `tsconfig.esm.json`, `tsconfig.rbx.json`) exclude `**/*.spec.ts`, so test files do not affect any build target.

The test runner is `tsx --test` (tsx is a devDependency). A `pretest` script runs `npm run build:node` before tests execute, because spec files use package imports (`@wendoo/core/brain`, etc.) that resolve to the built `dist/node/` output. This is required because platform modules (e.g., `platform/list.ts`) use ambient declarations with `.node.ts` implementations that only resolve after the build step copies them into place.

When adding new tests, follow this pattern:

- Use `describe`/`test`/`before` from `node:test` and `assert` from `node:assert/strict`
- Use package imports (`@wendoo/core`, `@wendoo/core/brain`, etc.) not relative imports to platform modules
- Place spec files next to the code they test (e.g., `parser.spec.ts` beside `parser.ts`)

## Roblox-TS Gotchas

The Roblox-TS compiler (`rbxtsc`) has restrictions beyond standard TypeScript. Watch for these:

1. **No global `Error`**: Use `import { Error } from "../../platform/error"` instead of the global `Error` class.
2. **No `typeof` operator**: Use `TypeUtils.isString()`, `TypeUtils.isNumber()`, `TypeUtils.isBoolean()` from `platform/types.ts` instead of `typeof x === "string"` etc.
3. **Luau reserved keywords cannot be used as identifiers**: This includes function names, parameter names, and variable names. Reserved words include: `and`, `break`, `do`, `else`, `elseif`, `end`, `false`, `for`, `function`, `if`, `in`, `local`, `nil`, `not`, `or`, `repeat`, `return`, `then`, `true`, `until`, `while`. For example, a function named `repeat()` or a parameter named `then` will fail the rbx build.
4. **No `globalThis`**: Platform-specific implementations in `.node.ts` files can use it, but shared code in `.ts` files cannot.
5. **No value-level circular imports**: Two modules may not form an import cycle unless every import in the cycle is type-only (`import type` / `export type`). Roblox-TS emits Luau `require` calls for value imports, and value-level cycles are not safe at module-init time on Luau (the second-required module sees a partially-initialized first module). Type-only imports are erased at compile time and may participate in cycles freely. When breaking a value cycle, prefer extracting the shared symbols into a third module that both sides import; switching one direction to `import type` only works if that side genuinely needs the symbol for types alone.

## Platform-Specific Implementation Pattern

Several modules in `packages/core/src/platform` use a platform-specific implementation pattern:

**File Structure:**

- `module.ts` - Contains TypeScript declarations, interfaces, and `declare` statements for classes/functions
- `module.node.ts` - Contains Node.js/browser implementations (uses `Uint8Array`, standard Web APIs)
- `module.rbx.ts` - Contains Roblox implementations (uses `buffer`, Roblox-specific APIs)

**Build Process:**
The post-build scripts (`scripts/post-build-node.js`, `post-build-esm.js`, `post-build-rbx.js`) automatically:

1. Compile both `.ts` and `.node.ts` (or `.rbx.ts`) files
2. Copy the platform-specific implementation files, removing the suffix:
   - `module.node.{js,d.ts,d.ts.map}` -> `module.{js,d.ts,d.ts.map}` (for Node/ESM)
   - `module.rbx.{luau,d.ts,d.ts.map}` -> `module.{luau,d.ts,d.ts.map}` (for Roblox)

**Important Implementation Rules:**

1. **Declarations in `.ts` file must be complete**: Since the `.d.ts` file from the base module gets overwritten by the platform-specific `.d.ts`, ensure all exported functions, classes, and types are declared with `declare` or `export declare` in the base `.ts` file.

2. **Use `declare` for runtime implementations**: Functions/classes that will be implemented in platform files should use `declare` or `export declare` in the base `.ts` file. Example:

   ```typescript
   // module.ts
   export declare function platformSpecificFunc(param: SomeType): ReturnType;

   // module.node.ts
   export function platformSpecificFunc(param: SomeType): ReturnType {
     // Node implementation
   }
   ```

3. **Constructor signatures**: If a class is implemented in platform files, declare its constructor in the base `.ts` file:

   ```typescript
   export declare class MyClass {
     constructor(param?: OptionalType);
     // ... method declarations
   }
   ```

4. **Never use `any` type**: Roblox's type system chokes on `any`. Use `unknown` or proper types instead (prefer proper types).

5. **Platform-specific types**: Use `unknown` in base `.ts` declarations when the actual type differs by platform (e.g., `Uint8Array` in Node vs `buffer` in Roblox). Only use `unknown` when necessary.

6. **Don't cross-reference platform files**: The base `.ts` file must not import from `.node.ts` or `.rbx.ts` files, as these are excluded from different build configurations.

Current modules using this pattern: `dict`, `error`, `list`, `logger`, `math`,
`stream`, `string`, `task`, `time`, `types`, `uniqueset`, `vector2`, and
`vector3`.

## Node-Only Tooling Subtrees

A subtree under `src` may be Node-only when what it does is read this package's own build
output or the manifest of a package that consumes it. `src/docs` and `src/tooling` are the
two that exist. Such a subtree obeys all of these:

- Every build target that cannot run Node excludes it. `tsconfig.esm.json` and
  `tsconfig.rbx.json` exclude it by path, and `build:rbx`'s wireit `files` carries the
  matching `!src/<subtree>/**` so an edit inside it does not invalidate the Roblox build.
- It emits to its own `outDir`, outside every language-output directory. Nothing under
  `dist/node` may be build tooling: `readCoreBuild` hashes that directory, so tooling
  emitted into it would make the language hash change when only the hasher changed. A
  spec asserts the separation on the real emitted layout.
- It gets its own export entry, declaring `"browser": null` alongside the usual
  conditions, so a browser bundle is refused rather than served Node code.
- Its specs import their subject by relative path (`./core-build.js`), not by package
  specifier. This is the one exception to the package-import rule under Testing above, and
  it exists because the tooling entry emits separately from the language build the rest of
  the specs resolve against.

## Type Organization

**Co-locate types with their producers.** Interface types for serialization formats,
event payloads, and similar concerns belong in the same file as the class that creates or
consumes them -- not in standalone type-only files. This keeps related code together and
avoids single-purpose type modules that would be at odds with the project's organization
patterns.

**Exception: a serialization type whose producer is target-excluded.** When a type crosses
between packages but the code that produces it lives in a Node-only subtree, the type
belongs in a browser-safe module beside the package's other public types, not in the
producer's file -- otherwise the whole barrel would have to reach into a subtree that two
of the three build targets exclude. `src/build-identity.ts` holds `CoreBuild` and
`ClientBuild` on this rule; `src/tooling/core-build.ts` produces them. Such a module
imports nothing but types: a value import from it would be pulled into the tooling build's
output as well.
