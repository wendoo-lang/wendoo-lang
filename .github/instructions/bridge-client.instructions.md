---
applyTo: "packages/bridge-client/**"
---

<!-- Last reviewed: 2026-09-25 -->

# bridge-client -- Rules & Patterns

Client-side SDK for talking to a Wendoo bridge relay: WebSocket lifecycle,
in-memory filesystem, and bidirectional sync. Consumed by `bridge-app`,
`apps/ecosim`, and `apps/vscode-extension`. Message types and schemas live in
`bridge-protocol`.

## Build & Scripts

```
npm run build      # tsc --build (outputs to dist/)
npm run typecheck  # tsc --noEmit (src + spec)
npm run check      # biome check --write
npm run test       # tsx --test src/**/*.spec.ts
```

After changes, rebuild (`npm run build`) so downstream consumers see updated types.

## Source Layout

```
src/
  index.ts           # barrel (all public exports)
  error-codes.ts     # ErrorCode + ProtocolError
  ws-client.ts       # WsClient class (auto-reconnect WebSocket client)
  ws-client.spec.ts
  filesystem.ts      # FileSystem, NotifyingFileSystem, IFileSystem
  filesystem.spec.ts
  project/
    project.ts       # Project class (top-level entry point, owns Session + Files)
    project.spec.ts
    session.ts       # ProjectSession (WebSocket lifecycle, message handling, events)
    files.ts         # ProjectFiles (in-memory filesystem with remote change routing)
```

## Key Exports

- `WsClient` -- auto-reconnect WebSocket client (exponential backoff, request/response
  correlation via `id`, event listeners, message queuing while connecting or reconnecting,
  flushed in order on open). `sendImmediate` sends on an open connection ahead of the queue
  and never queues; called from `onOpen`, its message is the connection's first frame.
  `close()` is final: it closes the socket, open or still connecting, and discards the queue;
  the client then sends nothing, opens no socket, and fires no callback or listener, and
  `connect()` does nothing. A send that would grow the queue past `maxQueueSize` (default
  1000) closes the client the same way and then calls `onQueueOverflow`, its last callback.
- `ErrorCode` / `ProtocolError` -- error constants and typed error class
- `FileSystem` / `NotifyingFileSystem` -- in-memory filesystem with change notifications
- `Project` -- entry point. Constructed with `ProjectOptions`, owns Session + Files.
- `ProjectSession` -- WebSocket lifecycle, message handling, session events.
- `ProjectFiles` -- filesystem wrapper with bidirectional change routing.

Types re-exported: `IFileSystem`, `StatResult`, `FileTreeEntry`, `FileSystemSnapshot`,
`FileSystemSnapshotEntry`, `FileSystemSnapshotFileEntry`, `FileSystemSnapshotDirectoryEntry`,
`FileSystemNotification`, `ProjectOptions`,
`ConnectionStatus`, `SessionEventMap`.

## Project

- Generic over `<TClient, TServer>` (message types supplied by consumers like `bridge-app`).
- Constructed with `ProjectOptions` (bridgeUrl, wsPath,
  initialFileSnapshot, optional joinCode/bindingToken). Validates required fields, throws `ProtocolError`.
- Owns `ProjectSession` and `ProjectFiles` as subsystems.
- Sequence-number deduplication: `_outboundSeq` stamps outgoing changes; `_peerSeq`
  filters duplicate inbound messages after reconnection.

## ProjectSession

Three layers of message handling:

1. **WS message handlers** (`on` / `send` / `request`) -- typed against generic TClient/TServer.
   Handlers are stored locally and re-registered on each `WsClient` so they survive
   `start()`/`stop()` cycles. A `session:welcome` reaches `on` handlers only once the
   session has accepted it.

2. **Payload messages** (`sendPayload` / `onPayload`) -- messages whose type's namespace is
   not in `BRIDGE_PROTOCOL_NAMESPACES` (`bridge-protocol`), carried verbatim both ways.
   `onPayload` delivers every such inbound message except a reply to a pending `request()`.
   Nothing is buffered: a message arriving while no listener is subscribed is dropped, so
   subscribe before `start()`. Listeners survive `start()`/`stop()` cycles. `sendPayload`
   throws if the session is not started.

3. **Session events** (`addEventListener`) -- higher-level events typed via `SessionEventMap`:
   - `"status"` (`ConnectionStatus`). Deduplicated: does not fire if the value is unchanged.
   - `"error"` (`BridgeSessionErrorCode`) -- the stable code of the failure that ended the
     session. Fires before `"status"` becomes `"disconnected"`.
   - `"counterpartAway"` (no value) -- the bridge sent `session:counterpartAway`: the
     session's counterpart disconnected. The session, its connection, join code, and binding
     token are unaffected; the next accepted `session:welcome` means the counterpart is
     connected again.

Session handshake: every connection's first frame is a `session:hello` declaring
`PROTOCOL_VERSION`, sent via `sendImmediate`; messages sent while connecting or reconnecting
follow it in the order they were sent. The server responds with `session:welcome`
(protocolVersion, sessionId, joinCode, bindingToken). Each hello presents the latest join code
the session holds: the one passed to the constructor, replaced by any the bridge sends in an
accepted `session:welcome` or in a `session:joinCode`.

A session ends on any of these failures:

- A `session:welcome` declaring no protocol version, or one other than `PROTOCOL_VERSION`:
  `BridgeSessionErrorCode.PROTOCOL_VERSION_MISMATCH`.
- A `session:error` whose payload carries a `code`: that code. A `session:error` without a
  code leaves the session open.
- The `WsClient` queue overflowing while the connection is not open:
  `BridgeSessionErrorCode.OUTBOUND_QUEUE_OVERFLOW`. The queued messages are discarded and
  nothing is sent.

On a failing message, the session sends `session:goodbye`; on any failure, it closes the
connection without reconnecting, emits `"error"`, then `"status"` `"disconnected"`. The
failing message reaches no `on` handler, and nothing in a rejected welcome is adopted. A
later `start()` opens a new session.

## ProjectFiles

Two `NotifyingFileSystem` wrappers around a shared `FileSystem`:
- `toRemote` -- fires callback on local writes (outbound changes to send to bridge).
- `fromRemote` -- fires callback when applying inbound remote changes.
- `raw` -- direct access to underlying `FileSystem` (for export/import).

## Rules

- Pure types + client package. No server-side or framework-specific code.
- Message types belong in `bridge-protocol`, not here.
- All exports go through `src/index.ts`. Consumers import from `@wendoo/bridge-client`.
- Use `import type` for type-only imports within the package.
- All unsubscribe functions return `() => void`.
- `send()`, `sendPayload()`, and `request()` throw if the session is not started. `on()` and
  `onPayload()` do not -- handlers queue for the next start.
