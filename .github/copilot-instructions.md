<!-- Last reviewed: 2026-07-17 -->
<!-- Sync: Multi-Target Core rules duplicated in .github/instructions/core.instructions.md;
     Shared UI rules duplicated in .github/instructions/ui.instructions.md. This file stays
     self-sufficient because inline completions do not load the instruction files. -->

# Copilot Instructions

Before working in any area of the codebase, list `.github/instructions/` and read `global.instructions.md` plus any files whose name matches the area you are working in.

These instructions apply to all Copilot features, including inline tab completions.

## Code Quality

- This code will be used for teaching; document to enable context-free understanding and keep the structure clean and modular.
- This is a production codebase; only suggest code that is correct, complete, and ready for production use. Do not suggest code that is incomplete, placeholder, or meant for prototyping or debugging.
- Never emit placeholder code. Do not use `TODO`, `FIXME`, `...`, `/* implementation */`,
  `throw new Error("Not implemented")`, or any other stub pattern unless the user has
  explicitly written a stub and is asking to fill it in.
- Never produce non-production statements such as `console.log("test")`,
  `console.log("here")`, hardcoded magic strings used only for debugging, or temporary
  workarounds presented as real code.
- Complete functions fully. If a complete implementation cannot be inferred from context,
  suggest the minimal correct skeleton rather than a placeholder body.
- Do not add comments that just restate what the code does. Only include comments that
  explain non-obvious intent, invariants, or constraints.
- Do not write stub or planning comments such as `// no implementation yet, but could add
  things like ...`, `// TODO: implement this function`, or `// implementation goes here`.
  Write the implementation, or leave the body blank if it cannot be inferred; never
  describe what code should be written instead of writing it.

## Import Style

- Never use inline `import()` type expressions (e.g., `import("./foo").Bar`) in `.ts` or
  `.tsx` files. Always use a top-level `import type` statement instead.
  - Exception: `.d.ts` ambient declaration files and Roblox `.rbx.ts` platform shims where
    top-level imports would break the ambient module context.

## Naming and Layout Conventions

- Match the naming and placement conventions already established in the area you are editing
  when creating new files, directories, test files, generated artifacts, or other repo
  entries.
- Before creating a new file, inspect nearby siblings and follow the dominant local pattern for
  separators (`-` vs `.` vs `_`), casing, prefixes, suffixes, and test file naming.
- Do not introduce a new naming pattern to an area of the repo unless the user explicitly asks
  for it or an existing tool/framework requires it.
- If you notice that a file or artifact you created does not match the repo's established naming
  convention, correct it proactively instead of leaving it in place just because validation still
  passes.

## Project-Specific Rules

### Multi-Target Core (`packages/core`)

- Avoid Node.js-only or browser-only APIs in shared code under `packages/core/src`.
- Prefer `List` and `Dict` from `packages/core/src/platform` over native `Array` and `Map`.
- Use `unknown` or specific types instead of `any`.
- Do not use the global `Error` class in shared code; import `Error` from
  `../../platform/error` (or the equivalent relative path).
- Do not use `typeof x === "string"` etc.; use `TypeUtils.isString()`,
  `TypeUtils.isNumber()`, `TypeUtils.isBoolean()` from `platform/types.ts`.
- Do not use Luau reserved words as identifiers: `and`, `break`, `do`, `else`, `elseif`,
  `end`, `false`, `for`, `function`, `if`, `in`, `local`, `nil`, `not`, `or`, `repeat`,
  `return`, `then`, `true`, `until`, `while`.
- Do not use `globalThis` in shared code; it is only allowed in `.node.ts` platform files.
- Do not introduce value-level circular imports between modules. Two modules may not
  form an import cycle unless every import in the cycle is type-only (`import type` /
  `export type`). Roblox-ts emits Luau `require` for value imports, and value cycles
  are unsafe at module-init time on Luau. To break a value cycle, extract the shared
  symbols into a third module.
- A Node-only subtree under `src` (`src/docs`, `src/tooling`) is allowed for code that
  reads this package's own build output or a consuming package's manifest. It must be
  excluded from `tsconfig.esm.json`, `tsconfig.rbx.json` and `build:rbx`'s wireit `files`;
  emit to its own `outDir` outside every language-output directory, because `readCoreBuild`
  hashes `dist/node`; and get an export entry declaring `"browser": null`. Its specs import
  their subject by relative path, not by package specifier.
- Co-locate types with their producers, except a serialization type whose producer sits in
  a Node-only subtree: that type goes in a browser-safe module beside the package's other
  public types (`src/build-identity.ts`), and that module imports nothing but types.

### Shared UI (`packages/ui`)

- This is a source-only package -- no build step. Consuming apps resolve the source
  directly via Vite aliases and tsconfig paths.
- Use relative imports within the package (no path aliases). Consuming apps map
  `@wendoo/ui` to the source directory.
- All shadcn/ui primitives live here. Do not duplicate them in app directories.
- The brain editor is decoupled from app-specific concepts via `BrainEditorProvider`
  context. App-specific tile visuals, data type icons, and custom literal types are
  injected through the config, not imported directly.
- Do not add app-specific types (e.g., Archetype, Actor) to this package.
- Touch targets are floored once, for both apps, in `src/ui.css` ("Coarse-pointer
  target floor"): 44px on both axes for controls and 1rem for fields, under
  `@media (pointer: coarse)`. Never detect the device or the user agent -- iPadOS
  Safari reports a macOS one. Floor with `min-h` / `min-w`, never `h` / `w`, so the
  floor survives `tailwind-merge`. A control that would deform is exempted in
  `ui.css` and reaches 44px another way; do not work around the floor at a call
  site.
