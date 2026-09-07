---
applyTo: "apps/vscode-extension/**"
---

<!-- Last reviewed: 2026-04-02 -->

# VS Code Extension -- Rules & Patterns

VS Code web extension that connects to the vscode-bridge, exposes a virtual `wendoo://`
filesystem, and displays TypeScript diagnostics from the remote compiler.

## Tech Stack

`@wendoo/bridge-client` (Project, IFileSystem, FileSystemNotification),
`@wendoo/bridge-protocol` (typed message unions), esbuild (bundler), Biome.

**Not used here:** `bridge-app`, `@wendoo/core`, `@wendoo/ui`.

## Web Extension Constraint

`"browser"` entry point + esbuild `platform: "browser"`. **No Node.js APIs** (`fs`,
`path`, `net`, `process`, `crypto`, etc.) anywhere in `src/`. Only browser-compatible and
`vscode`-module APIs are permitted.

## Scripts

```
npm run dev        # esbuild watch (incremental rebuild)
npm run build      # esbuild production (minified, no sourcemaps)
npm run build:deps # build local @wendoo package deps in dependency order
npm run typecheck  # tsc --noEmit
npm run check      # biome check --write
```

## Release

Releases run entirely in GitHub Actions: the `release-vscode-extension.yml`
workflow (workflow_dispatch, `bump` input) builds the local `@wendoo` deps
from source via `scripts/build-packages.js`, runs lint/typecheck/tests,
bumps the version, commits and tags `wendoo-vscode-extension-v<version>`,
publishes to the Marketplace with the `VSCE_PAT` secret, and creates a
GitHub release. Trigger it with `npm run release:patch` (or from the
Actions tab). Nothing is published to npm for an extension release.

## Source Layout

```
src/
  extension.ts                       # activate() / deactivate()
  commands/index.ts                  # all command registrations
  services/
    project-manager.ts               # central orchestrator
    wendoo-fs-provider.ts         # FileSystemProvider + FileDecorationProvider
    diagnostics-manager.ts           # DiagnosticCollection for compile errors
  state/context.ts                   # wendoo.enabled context key
  ui/statusBar.ts                    # status bar item
  views/wendooSessionsProvider.ts # explorer tree view
```

## Architecture

### ProjectManager

Central orchestrator (`src/services/project-manager.ts`). Owns the `Project` instance.

- Creates `Project<ExtensionClientMessage, ExtensionServerMessage>` with `wsPath: "extension"`.
- Reads `wendoo.bridgeUrl` from VS Code configuration for the bridge hostname.
- Saves/restores the HMAC binding token via `context.globalState` key `"wendoo.bindingToken"`.
- After a successful sync, adds `wendoo://` to `workspace.workspaceFolders`
  and calls `typescript.restartTsServer`.
- `DiagnosticsManager` suppresses Wendoo's relayed `MC5002`
  TypeScript-checker diagnostics so the Problems panel shows the built-in
  TypeScript diagnostics once instead of duplicates.
- **Pending changes:** file writes that fail (app offline) go into a deduplication queue.
  On reconnect, the queue is replayed and then a full sync runs.
  - `write` / `delete` / `mkdir` / `rmdir` / `rename`: deduplicate by `action:path` (last wins)
  - `import`: always appended (no deduplication)

### WendooFileSystemProvider

- Read path uses `project.files.raw` (in-memory, no network traffic).
- Write path uses `project.files.toRemote` (notifying FS that triggers bridge sync).
- URI path convention: VS Code URIs have a leading `/`; strip it before passing to
  `IFileSystem` methods (`wendoo:///foo.ts` -> `"foo.ts"`).
- `ETAG_MISMATCH` on write: show user-facing error with a "Sync Now" action button.
- Readonly files (per `stat.isReadonly`) get a dimmed `disabledForeground` decoration.

### DiagnosticsManager

- Handles `CompileDiagnosticsPayload` from bridge-protocol.
- Bridge diagnostics use **1-based** line/column; VS Code `Range` expects **0-based**. Subtract 1.
- Versioned per file: drop deliveries where `version < lastVersion` to prevent races.

### Status Bar States

| Condition | Text |
|---|---|
| disconnected | `$(debug-disconnect) Wendoo: Disconnected` |
| connecting / reconnecting | `$(sync~spin) Wendoo: Connecting...` |
| connected + bound + clientConnected | `$(pass-filled) Wendoo: Connected` |
| connected + bound + client offline | `$(warning) Wendoo: App Offline (N pending)` |
| connected + not bound | `$(warning) Wendoo: No App` |

### Context Key

`setWendooEnabled()` in `state/context.ts` sets the `wendoo.enabled` context key,
which gates both explorer views (`wendoo.sessions` on web, `wendoo.projectActions`
on desktop). On desktop, `trackWorkspaceProjectPresence()` in
`services/project-presence.ts` keeps the key aligned with project presence: enabled
only while a workspace folder carries a root `wendoo.json`, recomputed on workspace
folder changes and `wendoo.json` create/delete.

## Adding a Command

1. Add the command entry to `package.json` `contributes.commands`.
2. Register it in `src/commands/index.ts` with `vscode.commands.registerCommand`.

## Adding a Message Handler

Add a case to the `project.session.onMessage` handler in `ProjectManager`. Use the
typed unions from `@wendoo/bridge-protocol`; do not invent ad-hoc message shapes.
