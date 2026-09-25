---
applyTo: "packages/bridge-protocol/**"
---

<!-- Last reviewed: 2026-09-25 -->

# bridge-protocol -- Rules & Patterns

Protocol definition package for the Wendoo bridge WebSocket system: message types,
Zod schemas, and filesystem notification payloads. Shared by `bridge-client`,
`bridge-app`, and `apps/vscode-bridge`. Contains no runtime logic -- only types and
validation schemas.

## Build & Scripts

```
npm run build      # tsc --build (outputs to dist/)
npm run typecheck  # tsc --noEmit
npm run check      # biome check --write
```

No test files in this package. After changes, rebuild (`npm run build`) so downstream
consumers (`bridge-client`, `bridge-app`, `vscode-bridge`) see updated types.

## Source Layout

```
src/
  index.ts           # barrel (all public exports), PROTOCOL_VERSION, SessionRole
  schemas.ts         # base wsMessageSchema (Zod), BRIDGE_PROTOCOL_NAMESPACES
  notifications.ts   # FileSystemNotification + FilesystemSyncPayload (Zod)
  folder-session.ts  # folder-host session: messages, version, FolderSessionErrorCode
  peer-session.ts    # peer-session mechanism: generic hello shapes, PeerSessionErrorCode
  messages/
    index.ts         # re-exports all message modules
    shared.ts        # session control, errors (BridgeSessionErrorCode), ping/pong, filesystem messages
    app.ts           # app-role client/server message unions
    compile.ts       # compile:diagnostics + compile:status messages
    extension.ts     # extension-role client/server message unions
```

## Key Exports

- `SessionRole` -- `"app" | "extension"`, identifies the connecting client role.
- `wsMessageSchema` -- Zod schema for the base WebSocket message envelope
  (`type`, optional `id`, optional `payload`, optional `seq`).
- `filesystemNotificationSchema` -- Zod discriminated union on `action`:
  `write`, `delete`, `rename`, `mkdir`, `rmdir`, `import`.
- `filesystemSyncPayloadSchema` -- array of `[path, entry]` tuples for full filesystem
  snapshots.
- `sessionHelloPayloadSchema` -- Zod schema for the `session:hello` handshake payload.
- `BRIDGE_PROTOCOL_NAMESPACES` -- the namespaces of the message types this protocol
  defines: `session`, `control`, `filesystem`, `compile`, `error`. A message type's namespace
  is the text before its first `:`, or the whole type when it has none.
- `BridgeSessionErrorCode` -- constant object plus union type of the stable codes of
  bridge-session failures. `PROTOCOL_VERSION_MISMATCH` covers both directions: a client
  refusing its bridge's welcome, and a bridge refusing a client's hello. `SESSION_REPLACED`
  is reported by a bridge to the member a new claimant for its role displaced, before it
  closes that member's connection.
- `ErrorPayload` -- payload of `session:error` and `error`: a prose `message` and an
  optional `code` (`BridgeSessionErrorCode`).
- The folder-host session's and the peer-session mechanism's types, constants, and
  error codes (see `bridge-app.instructions.md` for their rules).

## Message Architecture

Messages are organized by role. Each role defines a `ClientMessage` union (sent by the
client) and a `ServerMessage` union (sent by the bridge server to that client).

### Shared messages (used by both roles)

| Type | Direction | Purpose |
|---|---|---|
| `session:hello` | client -> server | Initiate/authenticate session |
| `session:goodbye` | either | Graceful close |
| `session:error` | either | Session-scoped error; one carrying a `code` ends the session |
| `error` | either | General error |
| `control:ping` | client -> server | Heartbeat request |
| `control:pong` | server -> client | Heartbeat response |
| `filesystem:change` | either | Single file/dir operation |
| `filesystem:sync` | server -> client | Full filesystem snapshot |

### App-only messages

| Type | Direction | Purpose |
|---|---|---|
| `session:welcome` | server -> client | Session confirmation (sessionId, joinCode, bindingToken) |
| `session:joinCode` | server -> client | Updated join code |
| `session:counterpartAway` | server -> client | The session's counterpart disconnected; the session stays open |
| `compile:diagnostics` | client -> server | Per-file diagnostic list |
| `compile:status` | client -> server | Compilation result summary |

### Extension-only messages

| Type | Direction | Purpose |
|---|---|---|
| `session:welcome` | server -> client | Session confirmation (sessionId only) |
| `session:appStatus` | server -> client | App binding/connection status |
| `compile:diagnostics` | server -> client | Forwarded diagnostics from app |
| `compile:status` | server -> client | Forwarded compile status from app |

## Rules

- Types-and-schemas-only package. No runtime logic, no side effects. The package declares
  `"sideEffects": false`, so bundlers drop any module whose exports go unused; top-level
  statements are imports, exports, and declarations with literal or schema-building
  initializers.
- All exports go through `src/index.ts`. Consumers import from
  `@wendoo/bridge-protocol`.
- Use `import type` for type-only imports.
- Zod schemas live alongside their corresponding types. If a payload needs runtime
  validation, define a Zod schema; otherwise, a plain TypeScript type is sufficient.
- Message types follow the pattern `{ type: "namespace:action"; payload?: T }`.
  The `type` field is a string literal for discriminated unions.
- Every bridge WebSocket message type (the `messages/` folder) lies in a namespace listed in
  `BRIDGE_PROTOCOL_NAMESPACES`. A message in any other namespace is a payload message:
  endpoints carry it verbatim and never interpret it. Adding a namespace to the list is a
  wire change -- endpoints stop delivering that namespace's messages as payloads.
- A bridge-session failure the peer must be able to act on carries a
  `BridgeSessionErrorCode` in its `ErrorPayload.code`. `code` is optional and additive: an
  error without one keeps its existing meaning. A new failure adds a member whose JSDoc
  says who raises it.
- `session:welcome` means "the session is connected"; when a relay sends it is relay
  policy. The vscode-bridge relay welcomes a hello immediately. The Arcade relay
  (pxt-wendoo `apps/bridge`) answers a hello with `session:joinCode` at once and welcomes
  both members each time both roles of the pairing become bound: first when the pairing
  forms, and again whenever a member binds back in, so a still-connected member receives
  a further welcome on its open connection. A member returning with a binding token for
  the session is a status change of the same session (same session id, join code, and
  binding token). A hello for an occupied role without such a token is a new claimant:
  it ends the session, closing every member's connection, and a new session with a new
  session id and binding token opens under the same join code. A displaced member whose
  role is vacant rejoins by presenting that code; one presenting it for the newcomer's
  role is itself a new claimant. A session with no member also ends after a linger
  timeout. Clients treat each welcome as "connected", refresh their connection-scoped
  handshake on every welcome, and tolerate any of these timings, including a
  `session:joinCode` that arrives before any welcome.
- `session:counterpartAway` is the inverse of the welcome: "your session's counterpart
  disconnected". It carries no payload, and it is a status change of a live session, never
  its end: the receiver keeps its connection, join code, and binding token, and the next
  welcome means the counterpart is connected again. When a relay sends it is relay policy;
  the vscode-bridge relay does not send it.
- Role-specific message unions (`AppClientMessage`, `AppServerMessage`,
  `ExtensionClientMessage`, `ExtensionServerMessage`) aggregate shared + role-specific
  messages. Add new messages to the correct union(s).
- `bridge-client` and `bridge-app` depend on this package. Changes here require
  rebuilding downstream consumers.
