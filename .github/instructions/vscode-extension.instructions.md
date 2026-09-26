---
applyTo: "apps/vscode-extension/**"
---

<!-- Last reviewed: 2026-09-26 -->

# VS Code Extension -- Rules & Patterns

VS Code extension with two operating modes, chosen by environment. In the web UI it runs
bridge mode: it pairs with a Wendoo app through the vscode-bridge service, exposes a
virtual `wendoo://` filesystem, and displays TypeScript diagnostics from the remote
compiler. On desktop it runs folder mode: it hosts the project's target app in a webview
tab and serves as that app's disk, keeping the project in a workspace folder.

## Tech Stack

`@wendoo/bridge-client` (Project, IFileSystem, FileSystemNotification),
`@wendoo/bridge-protocol` (typed message unions), `@wendoo/app-host`,
`@wendoo/bridge-app`, `@wendoo/service-api`, esbuild (bundler), Biome.

**Not used here:** `@wendoo/core`, `@wendoo/ui`.

The curated targets registry is `packages/cli/targets.json`, imported as JSON by
`services/target-registry.ts` and bundled at build time; it is validated on first use
and throws if invalid.

## Web Extension Constraint

`"browser"` entry point + esbuild `platform: "browser"`. **No Node.js APIs** (`fs`,
`path`, `net`, `process`, `crypto`, etc.) anywhere in `src/`. Only browser-compatible and
`vscode`-module APIs are permitted.

There is no `"main"` entry: desktop VS Code loads the same browser bundle, so folder
mode is under the same rule (`tsconfig.json` compiles against the `WebWorker` lib). It
reaches the disk only through `vscode.workspace.fs`, addressing machine paths as
`vscode.Uri.file(...)`, and the network only through `fetch`.

## Scripts

```
npm run dev        # esbuild watch (incremental rebuild)
npm run build      # esbuild production (minified, no sourcemaps)
npm run build:deps # build local @wendoo package deps in dependency order
npm run typecheck  # tsc --noEmit over src, then over the specs
npm run check      # biome check --write
npm test           # node:test over src/**/*.spec.ts via tsx
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
  extension.ts                         # activate(): mode selection, desktop wiring, test hooks
  wendoo-json.ts                       # WENDOO_JSON manifest filename
  commands/
    index.ts                           # bridge-mode command registrations
    folder-commands.ts                 # folder-mode commands: open, new, import, tiles, update target
  services/
    project-session.ts                 # ProjectSession: the Disposable each mode provides
    diagnostics-manager.ts             # DiagnosticCollection for compile errors (both modes)
    tile-scaffold.ts                   # sensor/actuator starter files (both modes)
    bridge-session.ts                  # bridge-mode activation: filesystem, views, commands
    project-manager.ts                 # bridge mode: central orchestrator
    bridge-pairing.ts                  # bridge mode: paired state + token saving from session signals
    session-recovery.ts                # bridge mode: recovery notification per session error code
    wendoo-fs-provider.ts              # bridge mode: FileSystemProvider + FileDecorationProvider
    build-membership-tracker.ts        # bridge mode: manifest files-list state and diagnostics
    project-presence.ts                # folder mode: wendoo.enabled follows root wendoo.json presence
    folder-session.ts                  # folder mode: session lifecycle, app tab, serializer restore
    folder-store-host.ts               # folder mode: host end of the folder-session protocol
    folder-target-resolver.ts          # folder mode: project folder discovery, target and app root
    folder-restore.ts                  # folder mode: restore resolution, RestoreFailureReason
    app-host-html.ts                   # folder mode: webview document hosting the target app
    project-affordances.ts             # folder mode: generated tsconfig, .libraries tree, .gitignore
    path-confinement.ts                # folder mode: project-relative path validation
    removable-volume.ts                # folder mode: write a file to a mounted removable volume
    external-document.ts               # folder mode: open app-generated HTML externally
    project-skeleton.ts                # folder mode: wendoo.devTarget descriptor, new-project skeleton
    target-registry.ts                 # folder mode: bundled registry, target resolution, seeds
    target-app-cache.ts                # folder mode: target app cache core (no vscode)
    target-app-cache-host.ts           # folder mode: cache over global storage, transport, releases
    target-update.ts                   # folder mode: Update Target choices and manifest edit
  providers/
    build-membership-codelens-provider.ts    # bridge mode: Add to / Remove from build lens
    build-membership-decoration-provider.ts  # bridge mode: "Not in build" badge
    wendoo-json-codelens-provider.ts         # bridge mode: wendoo.json lock lens
  state/context.ts                     # wendoo.enabled context key
  ui/statusBar.ts                      # bridge mode: status bar item
  views/
    wendooSessionsProvider.ts          # bridge mode: explorer tree view
    projectActions.ts                  # folder mode: explorer launcher items
    projectActionsProvider.ts          # folder mode: explorer tree view
```

Specs sit beside their modules as `*.spec.ts`. The vscode-bound folder-mode modules
(`folder-session.ts`, `folder-store-host.ts`, `commands/folder-commands.ts`) have no
specs; their `vscode`-free cores (`folder-restore.ts`, `target-app-cache.ts`,
`target-update.ts`, `project-affordances.ts`, and the like) do.

## Operating Modes

`activate()` in `src/extension.ts` picks the mode once per activation from
`vscode.env.uiKind`: the web UI runs bridge mode only (`activateBridgeSession`), desktop
runs folder mode only. No code path switches modes. It sets the `wendoo.webHost` context
key, and the `package.json` when-clauses use it to show each mode's commands in the
Command Palette and each mode's explorer view (`wendoo.sessions` on web,
`wendoo.projectActions` on desktop).

| Concern | Bridge mode (web) | Folder mode (desktop) |
|---|---|---|
| Where the project lives | In the app, mirrored into the virtual `wendoo:` filesystem | In a workspace folder on disk; the app holds a mirror |
| Where the app runs | Another browser tab | A webview tab the extension hosts |
| Transport | WebSocket relay (`wendoo.bridgeUrl`), join code, binding token | Webview `postMessage`, folder-session protocol |
| Session owner | `ProjectManager` | `FolderProjectSession` (`services/folder-session.ts`) |
| Diagnostics URIs | `wendoo:/<path>` | `file:` URIs under the project folder |
| Status bar, build-membership lenses | Yes | No |
| Settings read | `wendoo.bridgeUrl` | `wendoo.devTarget` |

Shared: `DiagnosticsManager`, `tile-scaffold.ts`, `WENDOO_JSON`, `state/context.ts`, and
the `wendoo.openSettings` command. `wendoo.createSensor` and `wendoo.createActuator`
exist in both modes under the same ids with separate registrations
(`commands/index.ts` writes through the bridge; `commands/folder-commands.ts` writes to
disk).

## Bridge Mode

### ProjectManager

Central orchestrator (`src/services/project-manager.ts`). Owns the `Project` instance.

- Creates `Project<ExtensionClientMessage, ExtensionServerMessage>` with `wsPath: "extension"`.
- Reads `wendoo.bridgeUrl` from VS Code configuration for the bridge hostname.
- Restores the binding token from `context.globalState` key `"wendoo.bindingToken"` and
  presents it on connect; saves the token of every accepted `session:welcome` there.
- Reads the session's signals through a `BridgePairing`: the session is PAIRED from each
  accepted `session:welcome` until `session:counterpartAway` or a connection change. Each
  time it becomes paired, the manager syncs files and replays pending changes.
- Every coded session failure ends the connection without reconnecting, and the manager
  shows a warning offering the ways back in place, per `sessionRecoveryOffer` in
  `services/session-recovery.ts` (specs assert the offered action ids, never the wording):

  | Code | Actions |
  |---|---|
  | `SESSION_REPLACED` (another VS Code window re-bound with the same token) | Reconnect -- a join code cannot enter a role that is held |
  | `JOIN_CODE_UNKNOWN` (the entered code opens no vacant role) | Enter Join Code |
  | `SESSION_ENDED` (the app or an operator ended the session) | Enter Join Code, Reconnect (re-forms the session by the saved token) |
  | `OUTBOUND_QUEUE_OVERFLOW` (changes queued while offline outgrew the bound) | Reconnect |
  | `PROTOCOL_VERSION_MISMATCH` | Check for Updates, Reconnect |

- `disconnect()` (the Disconnect commands) ends the session on purpose -- the app is told
  `SESSION_ENDED` -- then closes the Wendoo tabs and workspace folder and drops the saved
  binding token and project name.
- After a successful sync, adds `wendoo://` to `workspace.workspaceFolders`
  and calls `typescript.restartTsServer`.
- **Pending changes:** file writes that fail (app offline) go into a deduplication queue.
  When the session is paired again, the queue is replayed and then a full sync runs.
  - `write` / `delete` / `mkdir` / `rmdir` / `rename`: deduplicate by `action:path` (last wins)
  - `import`: always appended (no deduplication)

### WendooFileSystemProvider

- Read path uses `project.files.raw` (in-memory, no network traffic).
- Write path uses `project.files.toRemote` (notifying FS that triggers bridge sync).
- URI path convention: VS Code URIs have a leading `/`; strip it before passing to
  `IFileSystem` methods (`wendoo:///foo.ts` -> `"foo.ts"`).
- `ETAG_MISMATCH` on write: show user-facing error with a "Sync Now" action button.
- Readonly files (per `stat.isReadonly`) get a dimmed `disabledForeground` decoration.

### Status Bar States

Bridge mode only; folder mode has no status bar item.

| Condition | Text |
|---|---|
| disconnected | `$(debug-disconnect) Wendoo: Disconnected` |
| connecting | `$(sync~spin) Wendoo: Connecting...` |
| reconnecting | `$(sync~spin) Wendoo: Reconnecting...` |
| connected + paired | `$(pass-filled) Wendoo: Connected` (or the compile error/warning count) |
| connected + not paired + holds a binding token | `$(warning) Wendoo: Waiting for <project>` |
| connected + not paired + no binding token | `$(warning) Wendoo: No App` |

## Desktop Folder Mode

Folder mode hosts the project's target app -- the built webapp a target package ships --
in a webview tab and performs that app's project I/O against a workspace folder. There is
no relay, join code, or binding token. The app decides for itself that it is in folder
mode and opens the session; the extension answers.

### Session Lifecycle

`services/folder-session.ts` holds at most one `FolderProjectSession` (module state).

- A session is one workspace folder plus one app root: a `FolderStoreHost`, a
  `FileSystemWatcher` over `**/*` in the folder, and a `DiagnosticsManager` publishing on
  `file:` URIs. It belongs to the workspace and outlives its tab: closing the tab leaves
  the session running, and reopening the tab boots a fresh app instance that handshakes
  again against the same host.
- Opening the folder that is already open reveals (or recreates) its tab; opening a
  different folder disposes the running session first.
- Sessions start from:
  - activation (`autoOpenFolderSessionOnActivation`): only when no session runs, no
    `wendoo.folderApp` tab from the previous window is present, and exactly one workspace
    folder has a root `wendoo.json`; a project resolving no target opens nothing,
    silently;
  - `wendoo.openProjectFolder`, `wendoo.openEditor` (reveals the running session's tab
    first), `wendoo.newProject`, `wendoo.importProject`, and `wendoo.updateTarget`;
  - window reload: the panel serializer for view type `wendoo.folderApp` rebuilds a
    session into the restored tab, showing a loading page during resolution and a
    failure page naming a `RestoreFailureReason` (`services/folder-restore.ts`) when it
    cannot. Restore takes the first project folder without prompting.
- A session is disposed only when replaced, by Update Target, or with the extension's
  subscriptions. Removing its workspace folder does not dispose it.

### Target and App Resolution

`resolveFolderTargetDescriptor` in `services/folder-target-resolver.ts`, over
`resolveProjectTargetDescriptor` in `services/target-registry.ts`:

1. The `wendoo.devTarget` setting wins when it names an `appPath` or `appRef`
   (`readDevTargetDescriptor` in `services/project-skeleton.ts`); `appPath` takes
   precedence over `appRef`.
2. Otherwise the coordinates of the manifest's `targets` map are matched against the
   bundled registry by membership. Exactly one match hosts that entry's pinned `ref`;
   none fails `TARGET_RESOLUTION_NO_REGISTRY_MATCH`; more than one fails
   `TARGET_RESOLUTION_AMBIGUOUS_REGISTRY_MATCH`.

The app root is `vscode.Uri.file(appPath)` for a local build (not checked up front; an
unreadable `index.html` shows the failure page in the tab), or the target app cache's
directory for an `appRef`. `appRef` is parsed as an extension reference:
`gh:<owner>/<repo>@<pin>` or `gh:<owner>/<repo>#<branch>` (the forms Update Target
writes).

### Hosting the App

`buildAppHostHtml` in `services/app-host-html.ts` makes the app's built `index.html` the
webview's own document (no nested frame) and injects three elements at the start of
`<head>`:

- a content-security policy admitting the webview-resource origin, a nonce'd bootstrap,
  runtime-injected styles, `blob:`/`data:` images, the umami script, and `https:` fetches;
- a `<base>` resolving the app's relative asset URLs against the app root;
- the bootstrap, which redefines `window.parent` as a shim forwarding `postMessage` to
  `acquireVsCodeApi()`, and sets `globalThis.__wendooHostMode = "folder"`
  (`FOLDER_HOST_MODE_GLOBAL` / `FOLDER_HOST_MODE_FOLDER` from `bridge-protocol`).

Tabs the extension creates carry `localResourceRoots: [appRoot]` and
`retainContextWhenHidden`; a restored tab is given `localResourceRoots` when adopted.

The app opens the session with `connectFolderHostSession` from `@wendoo/bridge-app`
when it finds the host-mode flag (the global, or the `wendooHostMode=folder` URL
parameter). An app that never checks the flag runs its standalone mode inside the tab,
and no session forms; `apps/ecosim` in this repository opens no folder session.

### The Folder-Host Session

`FolderStoreHost` (`services/folder-store-host.ts`) is the host end. Message types,
`FOLDER_SESSION_PROTOCOL_VERSION`, and `FolderSessionErrorCode` live in
`bridge-protocol` (`folder-session.ts`); the app end and its rules are in
`bridge-app.instructions.md`. Requests carry an `id`; the reply carries the same `id`.

| App -> host | Host action | Reply |
|---|---|---|
| `folder:hello` | Exact version check; reads `wendoo.json`; collects every file under `.libraries` | `folder:welcome` (`projectId` = folder URI string, manifest text + etag, `extensionsCache`), or `folder:error` (`PROTOCOL_VERSION_MISMATCH`, `PROJECT_MANIFEST_NOT_FOUND`) |
| `folder:loadFiles` | Walks the folder, skipping excluded paths, `wendoo.json`, and generated files | `folder:files` |
| `folder:change` | Validates against `filesystemNotificationSchema`; refuses `import` (`UNSUPPORTED_CHANGE`) and unsafe paths (`PATH_OUTSIDE_PROJECT`); applies the change unconditionally | `folder:ack`, or `folder:error` (`WRITE_FAILED`) |
| `folder:manifestWrite` | Writes `wendoo.json` | `folder:ack` / `folder:error` |
| `folder:volumeWrite` | Writes the file at the root of the named removable volume, searching `/Volumes`, `/media/<user>`, `/run/media/<user>` | `folder:ack`, or `folder:error` (`REMOVABLE_VOLUME_NOT_FOUND`, `WRITE_FAILED`) |
| `folder:openExternalDocument` | Writes the HTML to `.wendoo/print.html` in the project folder (adding `.wendoo/` to `.gitignore`), then opens it with `vscode.env.openExternal` | `folder:ack` / `folder:error` (`WRITE_FAILED`) |
| `folder:diagnostics` | Publishes through `DiagnosticsManager` | none |
| `folder:compilerFiles` | Reconciles the generated files (below) | none; a failure posts `folder:error` with no `id` and shows a VS Code error message |

Host -> app, unsolicited: `folder:externalChange`, one per watcher event. A created or
changed file is a `write` carrying its content and a `<mtime>-<size>` etag; a directory
is a `mkdir`; any deletion is a `delete`. Events on excluded paths, on generated files,
on a file whose etag matches the host's own last write, and on a path the host itself
last deleted are suppressed (the self-write log).

### Filesystem Authority

- The folder on disk is the source of truth. Edits made outside the app -- VS Code editor
  saves, git, other tools, and the extension's own tile scaffolds -- reach the app only as
  watcher events; unsaved editor buffers are invisible to it.
- Conflicts resolve last writer wins: the host ignores `expectedEtag` on every change.
- App writes stay inside the folder: `folder:change` and `folder:compilerFiles` paths must
  pass `isSafeRelativePath` (`services/path-confinement.ts`), and inbound watcher paths
  are taken relative to the folder with `containedRelativePath`. Two writes land outside
  the folder: removable-volume writes, and the target app cache.
- Never sent to the app by the snapshot or the watcher (`isExcludedPath`): any path with
  a segment starting with `.` (`.git`, `.libraries`, `.wendoo`, `.gitignore`) or named
  `node_modules`. The host does not refuse app writes to such paths. The `.libraries`
  tree reaches the app through the welcome's `extensionsCache` instead.
- `wendoo.json` is never in `folder:files`: the welcome delivers it, the app writes it
  only with `folder:manifestWrite`, and an external edit arrives as a
  `folder:externalChange` write.
- Files over `MAX_FILE_CONTENT_BYTES` (512 KiB) are skipped by the snapshot and the
  watcher. Content is text when the bytes are UTF-8, raw bytes otherwise.

### Generated Project Files

`ProjectAffordanceWriter` (`services/project-affordances.ts`) materializes each
`folder:compilerFiles` payload, reconciling in place (unchanged files are not rewritten):

- `tsconfig.json`, prefixed with a marker comment; it overwrites an existing root
  `tsconfig.json`;
- the `.libraries/` installed-extensions tree, plus `.libraries/installed.json` holding
  install provenance while any fetched dependency is installed; tree files that leave the
  set are deleted and emptied directories pruned;
- ambient declaration files outside the tree, deleted when they leave the set;
- a `# Wendoo generated files` block in `.gitignore` covering `.libraries/` and
  `tsconfig.json`, appended only for missing entries.

### Durable State

| State | Where | Owner |
|---|---|---|
| Project manifest, brains, and the app's own chunk | `wendoo.json` in the folder | the app, through `folder:manifestWrite` |
| Project source files | the folder | the app and any external editor |
| Generated files (above) | the folder | `ProjectAffordanceWriter` |
| Print scratch file | `.wendoo/print.html` in the folder | `FolderStoreHost` |
| Cached target apps | `context.globalStorageUri`, `targets/<owner>/<repo>/<specifier>/` | `target-app-cache.ts` |
| Hosted-app override | `wendoo.devTarget` setting | the user, and Update Target |
| One-time view expansion | `workspaceState` key `wendoo.projectActionsViewExpanded` | `extension.ts` |
| The open app tab | VS Code's webview panel state (`wendoo.folderApp`) | VS Code; restored by the serializer |

Folder mode keeps nothing in `globalState`.

### Target App Cache

`ensureCachedTargetAppInStore` (`services/target-app-cache.ts`, no `vscode` import) over
the global-storage binding in `services/target-app-cache-host.ts`:

- Only a `gh:` pin reference keys a cache lookup. A hit is a keyed directory whose
  `wendoo.json` parses and declares a `hostApp`; it touches no network.
- A miss fetches the snapshot, then every `hostApp.files` entry through the jsDelivr
  transport (at most 8 in flight, with a progress notification), validates every path
  first (`TARGET_APP_CACHE_SNAPSHOT_PATH_UNSAFE`, nothing written), writes the bundle, and
  writes `wendoo.json` last as the completion marker, so an interrupted population is a
  miss. Failures carry `TargetAppCacheErrorCode`.
- A `#branch` reference never hits: each resolve fetches the snapshot and the whole
  bundle, and fails offline.
- Entries are never evicted.

### New, Import, and Update Target

All in `commands/folder-commands.ts`:

- **New Project** refuses a folder that already has `wendoo.json`. With `wendoo.devTarget`
  set it seeds from the setting's `extensions` and `targets`; otherwise it quick-picks a
  registry target, caches its app, and seeds the coordinate as an `embedded:` library
  plus a `targets` entry at a caret range of the fetched manifest's version
  (`registryProjectSeed`). It writes the skeleton (`buildProjectSkeleton`) and opens the
  session.
- **Import Project** reads a `.wendoo` document (at most `DEFAULT_MAX_FILE_SIZE`),
  validates it with `parseWendooProjectDocument`, unpacks it with `buildUnpackedTree`,
  refuses any unsafe path before writing, writes the files and a manifest seeded by
  `seedProjectTargets` against the registry, then opens the session. It refuses a folder
  that already has `wendoo.json`.
- **Update Target** takes the coordinate from `wendoo.devTarget.appRef` when set, else
  from the registry match. It offers the registry-approved version, the highest published
  `x.y.z` release when newer (each listing request bounded at 15 s), and a specific tag,
  SHA, or `#branch` (fetched before anything changes). Applying it disposes the session,
  sets the manifest's `targets` range to `^<version>`, clears `devTarget.appRef`
  (approved) or writes it in `gh:` form (published, specific) at the scope where
  `devTarget` is defined (workspace when neither scope defines it), and reopens.
  Because `devTarget` wins target resolution, a written `appRef` governs every project
  folder in that scope until an approved update clears it.

### Gotchas

- **The version is exact-match on both ends.** The host refuses any hello other than
  `FOLDER_SESSION_PROTOCOL_VERSION`, and the app refuses any other welcome. A published
  target app is a pinned build with the version compiled in, so bumping the version
  strands every registry-pinned target app until it is republished and re-pinned.
- **The host never surfaces a handshake failure.** It posts `folder:error` to the app
  and does nothing else; what the tab shows is up to the app.
- **One session at a time.** Multi-root workspaces with several project folders open one
  at a time; New Project and Open Project Folder quick-pick the folder.
- **Desktop-only test hooks.** `activate()` registers `wendoo.testHooks.*` commands (not
  contributed in `package.json`) that drive folder-mode paths directly; the fake target
  transport they install replaces the jsDelivr transport for every target-app fetch.
- The desktop explorer view (`views/projectActions.ts`) is a flat list of command
  launchers. Its presence follows `wendoo.enabled`; the one-time `reveal` on its first
  render in a workspace only expands it.

## Shared Pieces

### DiagnosticsManager

- Handles `CompileDiagnosticsPayload` from bridge-protocol, in both modes. Its
  constructor takes the file-to-URI mapping: `wendoo:` URIs by default (bridge mode),
  `file:` URIs under the project folder in folder mode.
- Wendoo diagnostics use **1-based** line/column in both modes; VS Code `Range` expects
  **0-based**. Subtract 1.
- Versioned per file: deliveries where `version < lastVersion` are dropped.
- Suppresses Wendoo's relayed `MC5002` TypeScript-checker diagnostics; the built-in
  TypeScript extension reports the same errors, so removing the suppression duplicates
  them in the Problems panel.

### Context Keys

`setWendooEnabled()` in `state/context.ts` sets the `wendoo.enabled` context key,
which gates both explorer views (`wendoo.sessions` on web, `wendoo.projectActions`
on desktop). On desktop, `trackWorkspaceProjectPresence()` in
`services/project-presence.ts` keeps the key aligned with project presence: enabled
only while a workspace folder carries a root `wendoo.json`, recomputed on workspace
folder changes and `wendoo.json` create/delete. `activate()` awaits the first
computation before creating the desktop view.

`wendoo.webHost` is set once at activation: true in the web UI.

## Adding a Command

1. Add the command entry to `package.json` `contributes.commands`, and a
   `menus.commandPalette` entry whose `when` is `wendoo.webHost` (bridge mode) or
   `!wendoo.webHost` (folder mode) when it belongs to one mode.
2. Register it in `src/commands/index.ts` (bridge mode) or
   `src/commands/folder-commands.ts` (folder mode) with `vscode.commands.registerCommand`.

## Adding a Message Handler

Bridge mode: subscribe with `project.session.on(type, handler)` in
`ProjectManager.connect()` and push the unsubscribe onto `_unsubs`. Use the typed unions
from `@wendoo/bridge-protocol`; do not invent ad-hoc message shapes. Session status comes
from the session signals (`session:welcome`, `counterpartAway`, coded errors), never from
transport events.

Folder mode: a new message is a member of `FolderAppMessage` or `FolderHostMessage` in
`bridge-protocol`, a case in `FolderStoreHost.handleAppMessage`, and a method on the app
end in `bridge-app`. An incompatible change bumps `FOLDER_SESSION_PROTOCOL_VERSION` (see
Gotchas).
