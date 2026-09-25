---
applyTo: "apps/vscode-bridge/**"
---

<!-- Last reviewed: 2026-04-02 -->

# VSCode Bridge -- Rules & Patterns

Hono + Node.js WebSocket server bridging web app clients and VS Code extensions.
Routes typed JSON messages between both sides.

This is a production service designed to run continuously for months or years without
restart. All code must be leak-free and operationally robust -- no unbounded caches, no
timers that outlive their purpose, no accumulating state from disconnected clients. Treat
every resource as something that must eventually be reclaimed.

## Tech Stack

Hono (HTTP + WS), @hono/node-ws, pino (logging), zod (env validation),
`@wendoo/bridge-protocol` (shared message types & schemas), `@wendoo/join-codes`
(join-code generator), Biome.

## Path Aliases (Node.js subpath imports)

`#` subpath imports are defined in `package.json` `"imports"`. Pattern: `#<path>.js`
resolves to `src/<path>.ts` in dev and `dist/<path>.js` in production. Always use `.js`
extension with `#` imports.

Only use `#` imports when the alternative would require `..` segments. Same-directory and
child-directory imports use relative paths (`./foo.js`, `./sub/bar.js`).

## Scripts

```
npm run dev        # tsx watch with .env
npm run build      # tsc --build
npm run start      # runs compiled dist/
npm run typecheck  # tsc --noEmit (src + spec)
npm run check      # biome check --write
npm run test       # tsx --test src/**/*.spec.ts
```

## Architecture

### Entry Point

`src/index.ts` -> `initBindingSecret()` -> `createApp()` -> `startServer()` ->
`injectWebSocket()`. Starts a REPL in dev mode if TTY is present.

### WebSocket Routes

Two WS endpoints with independent upgrade, router, and handler layers:

- `/app` -- web app clients (sim, etc.)
- `/extension` -- VS Code extension clients

### Message Protocol

JSON shape: `{ type: string, id?: string, seq?: number, payload?: unknown }`.
`type` routes to a handler. `id` correlates request/response pairs.
Schema and types re-exported from `@wendoo/bridge-protocol` via
`transport/ws/types.ts`.

### Handler Pattern

Handlers live in `transport/ws/<side>/handlers/<domain>.handler.ts`.

Each file exports a `WsHandlerMap` (`Record<string, WsHandler>`). The router spreads all
maps into a single lookup.
Signature: `(ws: WSContext, payload: unknown, id?: string, seq?: number) => void`.

To add a handler:
1. Create/edit `transport/ws/<side>/handlers/<domain>.handler.ts`
2. Export a `WsHandlerMap` with `"<domain>:<action>": handlerFn` entries
3. Spread it into the router's `handlers` object in `router.ts`

Current handler domains:
- **app side:** session, control, filesystem
- **extension side:** session, control, vfs (filesystem), compile, debug, project

### Session Registry

`src/core/session-registry.ts` -- central in-memory session store.

- `AppSession` -- `id`, `ws`, `connectedAt`, `joinCode`, `bindingId`, optional metadata
  (`appName`)
- `ExtensionSession` -- `id`, `ws`, `connectedAt`, `appSessionId` (bound app),
  `pendingJoinCode`, `pendingBindingId`

Active sessions keyed by `WSContext`. Disconnected sessions cached by ID with a 5-minute
TTL for seamless reconnection. Swept every 60s; hard cap at 10k disconnected entries.

### Binding & Reconnection

Extensions connect via join code or binding token. On `session:hello`:
- Join code -> find matching app -> bind pair
- Binding token -> HMAC-verify -> reclaim previous session
- No match -> extension waits; auto-binds when a matching app arrives

Binding tokens are HMAC-SHA256 signed with `BRIDGE_BINDING_SECRET` (required env var,
validated by zod in `config/env.ts`). Verified with timing-safe comparison.

### Join Codes

Each `AppSession` gets a unique three-word fantasy slug (`generateTriplet` from
`@wendoo/join-codes`). Tracked in a Set for uniqueness, refreshed every 10 minutes. On
refresh, clients receive a `session:joinCode` push.

### Pending Requests

`src/core/pending-requests.ts` -- tracks extension-to-app request/response pairs with a
30-second timeout. If the app doesn't respond, the bridge auto-fails back to the extension.

### Rate Limiting

`src/core/throttle.ts` -- token-bucket rate limiter (`TokenBucket`, `TokenBucketMap`).
Used on the `/health` HTTP endpoint. Stale buckets swept every 60s.

### HTTP Layer

- `GET /health` -- returns status, package name/version, uptime
- Request logger middleware, global error handler middleware

### Sending Messages

Use `safeSend(ws, JSON.stringify({ type, id?, payload? }))` for all outbound messages.

### Environment

Validated by zod in `src/config/env.ts`: `NODE_ENV`, `PORT` (default 3000),
`LOG_LEVEL` (default info). `BRIDGE_BINDING_SECRET` read directly in
`core/binding-token.ts` (not in the zod schema).

### Graceful Shutdown

`src/server.ts` handles SIGINT/SIGTERM via `closeAllSessions()` then server close with
10-second forced exit timeout. Fatal logging on uncaught exceptions/rejections.

### Dev REPL

`src/repl.ts` -- interactive console in dev mode. Commands: `sessions` (list all),
`disconnect <id>` (close WS, allow reclaim), `kill <id>` (purge session).
