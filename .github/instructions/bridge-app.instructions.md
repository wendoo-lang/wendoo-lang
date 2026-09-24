---
applyTo: "packages/bridge-app/**"
---

<!-- Last reviewed: 2026-09-24 -->

# bridge-app -- Rules & Patterns

The app side of the Wendoo bridge and its session protocols, plus the
app-level project services built on them. Apps (for example `apps/ecosim`, and
apps in consumer repositories) depend on this package rather than on
`bridge-client` or `bridge-protocol` directly. It has co-equal consumers in
more than one repository, so new public surface is kept minimal and named for
behavior.

It covers:

- The app-role bridge connection (`createAppBridge`) over the `"app"`
  WebSocket path.
- The folder-host session (`connectFolderHostSession`): an app embedded in a
  host that owns a workspace folder.
- The peer-session mechanism (`connectPeerSession`) that session
  kinds declared by consumers run on.
- The project services an app drives through those sessions: the
  environment host, the extension catalog, install and uninstall, installed
  extension snapshots, user-tile registration, brain diagnostics, and the
  workspace-folder project store.

## Build & Scripts

```
npm run build      # tsc --build (outputs to dist/)
npm run build:prod # wireit build of dist/ and its file: dependencies
npm run typecheck  # tsc --noEmit over src and specs
npm run check      # biome check --write
npm run check:only # biome check (no writes)
npm test           # node:test over src/**/*.spec.ts (pretest runs build:prod)
```

After changes, rebuild so downstream consumers see updated types and so the
apps' dev servers serve the new `dist/`. `npm test` runs the specs from
source, so a green suite does not prove `dist/` is current.

## Entry Points

`package.json` `exports`:

| Specifier | Source | Contents |
|---|---|---|
| `@wendoo/bridge-app` | `src/index.ts` | The public modules in the layout below; not the internal, subpath, or Node-only ones |
| `@wendoo/bridge-app/compilation` | `src/compilation.ts` | `createCompilationFeature`, `CompilationManager`, project compiler handles |
| `@wendoo/bridge-app/manifest-files` | `src/manifest-files.ts` | Queries and edits over a manifest's `files` list |
| `@wendoo/bridge-app/node` | `src/node.ts` | Node-only helpers: embedded-extension loading from disk and its Vite plugin |

A module that imports Node built-ins is exported only through `./node`, never
through the root barrel, so browser consumers can import the root.

## Source Layout

```
src/
  index.ts                           # root barrel
  node.ts                            # Node-only barrel
  app-bridge.ts                      # createAppBridge, AppBridge, AppBridgeFeature
  bridge-project.ts                  # BridgeProject: app-role Project, join code (internal)
  project-file-bridge.ts             # app-host <-> bridge-client file shapes (internal)
  compilation.ts                     # compile features and managers (subpath export)
  folder-host-session.ts             # folder-host session: port, session, errors
  peer-session.ts                    # peer-session mechanism: port, session, errors
  workspace-folder-project-store.ts  # ProjectStore persisted through a folder session
  app-environment-host.ts            # AppEnvironmentHost: project, environment, compiler, bridge
  extension-catalog.ts               # catalog, offers, shelf, compatibility, install actions
  extension-install.ts               # install closure, outcomes, diagnostics diffing
  extension-install-log.ts           # install log app-data record
  extension-report-presenter.ts      # transaction toasts
  embedded-extensions.ts             # extension resolution across embedded and fetched sources
  embedded-extension-id-gate.ts      # stable-id validation for embedded extensions
  embedded-extension-loader.ts       # builds embedded extensions from directories (Node)
  embedded-extension-vite-plugin.ts  # virtual module of embedded extensions (Node)
  fetched-extension-snapshots.ts     # installed extension snapshot records
  library-offer.ts                   # add an offered library
  library-uninstall-guard.ts         # uninstall impact on brains
  user-tile-registration.ts          # applying compiled user tiles
  brain-diagnostics.ts               # brain error and tile compile diagnostics
  vfs-asset-url-provider.ts          # asset URLs over the project file system
  core-extension.ts                  # core library coordinate and reference
  manifest-files.ts                  # manifest files-list helpers (subpath export)
```

Specs sit beside their modules as `*.spec.ts`; `public-api.spec.ts` pins the
public contracts of the root and `./compilation` entry points.

## Session Kinds

A session kind is one wire surface between two parties, with one version.
This package owns the mechanism every kind runs on; the kinds themselves are
declared elsewhere.

- The MECHANISM lives here and in `bridge-protocol`, platform-clean:
  - `bridge-protocol` holds the generic hello shapes
    (`PeerSessionHelloPayload`, `PeerSessionHelloMessage<kind>`,
    whose message type is `<kind>:hello`) and the mechanism's error-code
    constant object with its union type (`PeerSessionErrorCode`).
  - `bridge-app` holds the session logic (`peer-session.ts`): the port
    interface (`PeerSessionPort`), the error class carrying the stable
    `code` (`PeerSessionError`), and `connectPeerSession`, which
    takes a kind spec -- the kind's name and the newest protocol version this
    build speaks for it (`PeerSessionKind`) -- and a port.
- A KIND declares its name, its message types, its protocol version
  constant, and a connect call binding the mechanism to the kind. A platform
  session kind lives with its platform integration, never in this package or
  in `bridge-protocol`.
- A kind's name is never one of the bridge protocol's reserved namespaces
  (`BRIDGE_PROTOCOL_NAMESPACES` in `bridge-protocol`); an app bridge never
  delivers such a kind's messages as payloads.
- Core packages contain no platform names. A search of `bridge-protocol/src`
  and `bridge-app/src` for a platform name finds nothing; mechanism specs run
  against a neutral fixture kind.

The folder-host session predates the mechanism and keeps its own shape:
message types, `FOLDER_SESSION_PROTOCOL_VERSION`, and
`FolderSessionErrorCode` in `bridge-protocol`; `FolderHostPort`,
`connectFolderHostSession`, and `FolderSessionError` here.

The root barrel re-exports the mechanism's hello message type and error-code
object from `bridge-protocol`, so a kind's package needs only
`@wendoo/bridge-app`. Session logic takes a port and never assumes how the
port reaches the peer.

## Version Rules

The folder-host session and the peer-session mechanism follow different
version rules. Do not carry one into the other.

| Surface | Rule | Rejection |
|---|---|---|
| Folder-host session | Exact match: the host's welcome must declare `FOLDER_SESSION_PROTOCOL_VERSION`; any other version, older or newer, is refused. | `FolderSessionErrorCode.PROTOCOL_VERSION_MISMATCH` |
| Peer-session mechanism (every kind built on it) | Adapt down: both parties send `<kind>:hello` declaring the version they speak; a receiver accepts any version up to its kind's `protocolVersion`, records it as `peerProtocolVersion`, and refuses only a newer one. The refusal's message tells the user to refresh or update the older side. | `PeerSessionErrorCode.PROTOCOL_VERSION_NEWER` |

For a peer session:

- A party sends nothing but its hello until it has received the peer's
  hello.
- A kind's payload messages carry no version of their own; they ride the
  kind's version, and the mechanism carries them verbatim.
- Payload messages received while no listener is attached are replayed to
  the next listener that attaches.
- One session covers one connection of the peer; open a new session when the
  peer reconnects.

## Rules

- App-role and session logic only. Generic client machinery (WebSocket
  lifecycle, in-memory file system, sync) belongs in `bridge-client`. Message
  types, version constants, and error codes belong in `bridge-protocol`.
- All public exports go through `src/index.ts` or one of the subpath entry
  points. Consumers import from `@wendoo/bridge-app` or its subpaths.
- Errors carry stable codes; specs assert codes, never message prose.
- Use `import type` for type-only imports.
- All unsubscribe functions return `() => void`.
