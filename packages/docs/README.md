[![Publish @wendoo/docs](https://github.com/wendoo-lang/wendoo-lang/actions/workflows/publish-docs.yml/badge.svg)](https://github.com/wendoo-lang/wendoo-lang/actions/workflows/publish-docs.yml)

# @wendoo/docs

Shared documentation sidebar and rendering components for **Wendoo** web applications. This package provides a complete docs system -- sidebar, markdown rendering, brain-rule visualizations, and a standalone docs page -- designed to be consumed by any webapp in the monorepo.

## What's Included

- **Docs sidebar** (`DocsSidebar`, `DocsSidebarContext`) -- slide-out panel with tile, pattern, and concept tabs, deep-link support
- **Brain code blocks** (`BrainCodeBlock`, `DocsRule`) -- render brain rules and tiles inline in markdown docs
- **Markdown renderer** (`DocMarkdown`) -- renders markdown content with brain fence support
- **Print view** (`DocsPrintView`) -- printable documentation layout
- **Standalone docs page** (`DocsPage`) -- full-page documentation view with URL sync
- **Registry & factory** (`DocsRegistry`, `buildDocsRegistry`) -- central data store for tile, pattern, and concept entries with a generic factory for merging core and app-specific docs

## Usage

This is a **source-only package** -- there is no build step. Consuming apps resolve the source directly via Vite aliases and tsconfig path mappings.

For step-by-step setup instructions in your own project, see the [Integration Guide](https://github.com/wendoo-lang/wendoo-lang/blob/main/INTEGRATION.md).

### Vite config

```js
resolve: {
  alias: {
    "@wendoo/docs": path.resolve(__dirname, "../../packages/docs/src"),
  },
},
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "paths": {
      "@wendoo/docs": ["../../packages/docs/src/index.ts"],
      "@wendoo/docs/*": ["../../packages/docs/src/*"]
    }
  }
}
```

### Imports

```typescript
import { DocsSidebarProvider, DocsSidebar, useDocsSidebar } from "@wendoo/docs";
import { DocsPage, DocsRegistry, buildDocsRegistry } from "@wendoo/docs";
import type { AppTileDocMeta, AppPatternDocMeta } from "@wendoo/docs";
```

## Integration

Wrap your app in `DocsSidebarProvider` with a populated `DocsRegistry`, then render `DocsSidebar` as a sibling overlay. Use `useDocsSidebar()` to open/close the panel or deep-link to specific tiles.

```tsx
import { DocsSidebarProvider, DocsSidebar, buildDocsRegistry } from "@wendoo/docs";

const registry = buildDocsRegistry({
  appTiles: { meta: [...], content: new Map([...]) },
  appPatterns: { meta: [...], content: new Map([...]) },
});

<DocsSidebarProvider registry={registry}>
  <App />
  <DocsSidebar />
</DocsSidebarProvider>
```

To connect the docs sidebar to the brain editor, inject `onTileDocs` and `docsIntegration` into `BrainEditorConfig`:

```tsx
const { openDocsForTile, isOpen, toggle, close } = useDocsSidebar();
const config: BrainEditorConfig = {
  ...baseConfig,
  onTileDocs: openDocsForTile,
  docsIntegration: { isOpen, toggle, close },
};
```

See `apps/ecosim/src/App.tsx` for a working example.

## Package Layout

```
src/
  index.ts                Barrel export
  DocsRegistry.ts         DocsRegistry data store (tiles, patterns, concepts)
  DocsSidebarContext.tsx   DocsSidebarProvider, useDocsSidebar, DocTab
  DocsSidebar.tsx          Slide-out sidebar with tabbed navigation
  DocsPage.tsx             Standalone full-page docs view with URL sync
  DocMarkdown.tsx          Markdown renderer with brain fence support
  DocsRule.tsx             DocsRuleBlock, DocsTileChip, InlineTileIcon
  BrainCodeBlock.tsx       Brain code fence renderer (rules + tiles)
  brain-fence.ts           Brain code fence grammar: accepted shapes and meta tokens
  DocsPrintView.tsx        Printable documentation layout
  buildDocsRegistry.ts     buildDocsRegistry() factory, AppTileDocMeta, AppPatternDocMeta
```

## Dependencies

- **@wendoo/core** -- brain tile definitions, docs manifests, compiler services
- **@wendoo/ui** -- TileVisual, color utilities, glass effects, rule clipboard, toast notifications
- **lucide-react** -- icons
- **react-markdown + remark-gfm** -- markdown rendering
- **React 19** (peer dependency)

## Development

```bash
npm run check      # Biome lint + format check
npm run check      # Auto-fix
```
