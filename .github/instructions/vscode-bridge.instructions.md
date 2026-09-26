---
applyTo: "apps/vscode-bridge/**"
---

<!-- Last reviewed: 2026-09-26 -->

# VSCode Bridge -- Rules & Patterns

Hono + Node.js WebSocket service pairing a Wendoo app with a VS Code extension and
routing the typed JSON messages they exchange. It is an adapter plus a deployment over
the session engine `@wendoo/bridge-session`, which owns every session rule; the
authoritative description of those rules is `docs/specs/session-management.md`. The
service contains no session logic: it owns its route surface, its message routing (the
engine's frame handler), its transport hardening, and its deployment identity.

This is a production service designed to run continuously for months or years without
restart. All code must be leak-free and operationally robust -- no unbounded caches, no
timers that outlive their purpose, no accumulating state from disconnected clients. Treat
every resource as something that must eventually be reclaimed: everything the server
creates is created per server instance and released by its `close()`.

## Tech Stack

Hono (HTTP + WS), @hono/node-ws, pino (logging), zod (env validation),
`@wendoo/bridge-session` (session engine and `TokenBucketMap`),
`@wendoo/bridge-protocol` (shared message types & schemas), Biome.

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
npm run build:deps # build the local @wendoo package deps (runs before test and typecheck)
npm run start      # runs compiled dist/
npm run typecheck  # tsc --noEmit (src + spec)
npm run check      # biome check --write
npm run test       # tsx --test src/**/*.spec.ts
```

## Architecture

### Entry Point

`src/index.ts` reads the environment, then calls `startBridgeServer()` (`src/server.ts`)
with the port, the binding secret, and the logger. It installs the fatal-error handlers
and the SIGINT/SIGTERM shutdown, and starts the REPL in dev mode when a TTY is present,
handing it the server's `admin` and a shutdown hook.

### Server

`startBridgeServer(options)` builds one `Relay` from the engine, the Hono app, and the
WebSocket upgrade, listens, and resolves a `BridgeServer` (`port`, `admin`, `close()`).
`admin` is the engine's inspection and administration surface (`sessions()`,
`endSession(id)`, `disconnectMember(id)`), typed `BridgeAdmin`. Its options (`host`,
`port`, `bindingSecret`, `logger`, and the engine timings, the engine's `RelayTimings`)
match the engine testkit's server starter, so the suite runs over this exact server (see
Tests). The timings exist for the test harness; `src/index.ts` never sets them, and the
environment exposes none.

### WebSocket Routes

Two fixed routes, each mapped onto the engine's `vscode` session kind
(`src/session-kind.ts`):

- `/app` -- Wendoo app clients, role `app`
- `/extension` -- VS Code extension clients, role `extension`

Each connection is handed to `relay.connect(SESSION_KIND, role, socket)`, and its frames
and close are reported back through the returned handler. The engine answers
`session:hello` with `session:joinCode`, welcomes both members once the extension's hello
pairs with the app's session, sends `session:counterpartAway` and a fresh
`session:joinCode` when a member drops, reclaims the session for a member returning with
its binding token, supersedes a member's older connection when the member binds back in
by its token (`SESSION_REPLACED` to the older connection), refuses a join code that opens
no vacant role (`JOIN_CODE_UNKNOWN`), ends the session on a member's `session:goodbye`
(`SESSION_ENDED` to the other member), rotates every join code in service every ten
minutes (the previous code still joins for two minutes), closes a connection that sends
nothing for a minute, and answers `control:ping`. The service sends none of these itself.

### Message Protocol

JSON shape: `{ type: string, id?: string, seq?: number, payload?: unknown }`.
`type` selects the handler. `id` correlates a request with its reply: the engine returns
the peer's reply to a message the service forwarded, verbatim, without consulting the
service. Types from `@wendoo/bridge-protocol`.

### Handler Pattern

The engine hands every message outside its control namespaces (`session`, `control`,
`error`) that is not a reply to the service's frame handler, `createFrameHandler()` in
`src/transport/ws/frame-router.ts`. The router picks the handler the sender's role
registers for the message's type and answers any other type, or a handler that throws,
with an `error` message.

Handlers live in `transport/ws/<side>/handlers/<domain>.handler.ts`. Each file exports a
`WsHandlerMap` (`Record<string, WsHandler>`), keyed by message type, which the router
spreads into its role's map.
Signature: `(frame: RelayFrame, logger: Logger) => void`. A handler settles its frame
through `frame.forward(data)` (to the sender's peer; returns `false` when there is none)
and `frame.reply(data)` (to the sender); a frame it does neither with is dropped.

To add a handler:
1. Create/edit `transport/ws/<side>/handlers/<domain>.handler.ts`
2. Export a `WsHandlerMap` with `"<domain>:<action>": handlerFn` entries
3. Spread it into its role's map in `frame-router.ts`

Current routing:
- **app side:** `compile:diagnostics`, `compile:status`, `filesystem:change`,
  `filesystem:sync` -- validated and forwarded to the extension as their parsed fields;
  one with an invalid payload is dropped.
- **extension side:** `filesystem:change` (validated) and `filesystem:sync` (forwarded
  without a payload). An invalid change, and either message while no app is connected,
  is answered with a code-less `session:error` carrying the message's id.

### Sessions and Credentials

Sessions, binding tokens, join codes, linger and sweep, explicit end, supersession, and
liveness belong to the engine; the service's only input is `BRIDGE_BINDING_SECRET`, which
signs binding tokens. Tokens carry no expiry and verify for as long as the secret is
unchanged, so a restart under the same secret keeps every binding. The join-code lifecycle,
rotation, its entry grace, the quarantine of retired codes, and the activity timeout are
unconditional engine behavior; the service configures none of them.

### Rate Limiting and Hardening

- Per-connection message rate: the engine's (a burst of 100, then 50 per second; the
  excess is answered with an `error` message and dropped).
- Per-address admission: `TokenBucketMap(10, 0.5)` on the `/app` and `/extension`
  upgrades; the excess is answered with status 429.
- `/health`: `TokenBucketMap(30, 2)` per address; the excess is answered with status 429.
- A binary frame, or a text frame over 1 MiB, is answered with an `error` message and not
  routed.

`getClientIp()` (`src/transport/http/client-ip.ts`) keys the per-address limits.

### HTTP Layer

- `GET /health` -- returns status, package name/version, uptime
- Request logger middleware, global error handler middleware (both built with the
  server's logger)

### Environment

Validated by zod in `src/config/env.ts`: `NODE_ENV`, `PORT` (default 3000), `LOG_LEVEL`
(default info), and `BRIDGE_BINDING_SECRET` (required).

### Graceful Shutdown

On SIGINT/SIGTERM the entry point calls `server.close()`, which closes every connection
with code 1001, stops listening, and disposes the engine, then exits; a 10-second timer
forces the exit. Fatal logging on uncaught exceptions/rejections.

### Dev REPL

`src/repl.ts` wraps `node:repl` around the command dispatcher `runReplCommand()`
(`src/repl-commands.ts`), which takes one input line and the server's `admin` and returns
the text to print. `startRepl({ admin, onExit, input?, output? })` calls `onExit` when the
console exits; the entry point passes a hook that shuts the service down as SIGTERM does.
Commands:

- `sessions` (alias `ls`) -- every session: session id, kind, join code (`(none)` while
  both roles are bound), and each role's state (`connected` with its member id and
  connection age, or `lingering` with how long ago it disconnected)
- `disconnect <member id>` -- close that member's connection; it returns by its token
- `kill <session id>` -- end that session at once, telling each member `SESSION_ENDED`
- `help` -- list the commands; `.exit` -- shut the service down

The answer to a line the console cannot carry out starts with a `ReplErrorCode` (`UNKNOWN_COMMAND`,
`MISSING_ID`, `NOT_FOUND`); a blank line prints nothing.

## Tests

`src/server.spec.ts` runs the engine testkit (`@wendoo/bridge-session/testing`) over this
service's own server: `startTestRelay({ server: startBridgeServer, probePath: "app" })`,
with scripted peers connecting at `app` and `extension`. Each spec starts its own server,
so per-address limits never carry across specs; rotation and liveness specs shorten the
engine's timings with the testkit's `rotationMs` and `activityTimeoutMs`, and the console
specs run REPL commands against the running server's `admin`. `src/repl-commands.spec.ts` pins every command at the dispatcher, and
`src/repl.spec.ts` pins the shell's line handling and exit hook over in-memory streams.
